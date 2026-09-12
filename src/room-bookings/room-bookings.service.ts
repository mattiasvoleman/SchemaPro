import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Prisma, type PrismaClient, type RoomBookingStatus } from '@prisma/client';
import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';
import { Role } from '../auth/enums/role.enum';
import { PrismaService } from '../database/prisma.service';
import { NotificationsService } from '../notifications/notifications.service';
import { requireSchoolId, requireUserId } from '../common/utils/request-context';
import type {
  CreateRoomBookingDto,
  DecideRoomBookingDto,
} from './dto/room-booking.dto';

export interface RoomBookingResult {
  id: string;
  status: RoomBookingStatus;
}

/**
 * The exclusion constraint that stops two active bookings holding one room at
 * the same time — see migration
 * 20260822131500_a_room_holds_one_thing_at_a_time. Prisma has no error code
 * for SQLSTATE 23P01 and hands the whole PostgreSQL message back inside an
 * unknown-request error, so the constraint is recognised by name.
 */
const ROOM_HELD_ONCE = 'RoomBookings_room_is_held_once';

function isRoomAlreadyHeld(error: unknown): boolean {
  return (
    error instanceof Prisma.PrismaClientUnknownRequestError &&
    error.message.includes(ROOM_HELD_ONCE)
  );
}

/**
 * Self-service room bookings (Skola24 Lokal parity). Teachers reserve free
 * rooms themselves; bookings coexist with lessons in conflict checking.
 * Bookings on "special" rooms (requiresApproval) start PENDING until an admin
 * decides; ordinary rooms auto-approve. RLS enforces tenancy and ownership;
 * this service adds friendly validation.
 *
 * Availability itself is the database's rule, not this service's: a booking is
 * written first, because that write is what the exclusion constraint judges and
 * what takes the room's advisory lock, and only then is the room asked about.
 * A check made before the write can be overtaken between the SELECT and the
 * INSERT; one made after it cannot.
 */
@Injectable()
export class RoomBookingsService {
  private readonly logger = new Logger(RoomBookingsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationsService,
  ) {}

  async create(
    dto: CreateRoomBookingDto,
    user: AuthenticatedUser,
  ): Promise<RoomBookingResult> {
    const schoolId = requireSchoolId(user);
    const bookedById = requireUserId(user);
    const startsAt = new Date(dto.startsAt);
    const endsAt = new Date(dto.endsAt);
    if (endsAt <= startsAt) {
      throw new BadRequestException('endsAt must be after startsAt.');
    }
    if (endsAt <= new Date()) {
      throw new BadRequestException('Bookings must be in the future.');
    }

    return this.prisma.withRls(user, async (tx) => {
      const room = await tx.room.findUnique({
        where: { id: dto.roomId },
        select: { id: true, requiresApproval: true },
      });
      if (!room) {
        throw new BadRequestException('Room not found.');
      }

      // Special rooms need admin approval; admins booking directly skip it.
      const status: RoomBookingStatus =
        room.requiresApproval && user.role !== Role.SCHOOL_ADMIN
          ? 'PENDING'
          : 'APPROVED';

      const booking = await tx.roomBooking
        .create({
          data: {
            schoolId,
            roomId: dto.roomId,
            bookedById,
            title: dto.title,
            startsAt,
            endsAt,
            status,
          },
          select: { id: true, status: true },
        })
        .catch((error: unknown) => {
          if (isRoomAlreadyHeld(error)) {
            throw new ConflictException(
              'That room is already booked for this time.',
            );
          }
          throw error;
        });

      // The row above is written, so this reads a room nobody else can claim
      // until we commit. Throwing takes the booking back out with the
      // transaction.
      await this.assertNoLessonUsesRoom(tx, dto.roomId, startsAt, endsAt);

      this.logger.log(`Room booked [booking=${booking.id}, status=${status}]`);
      return booking;
    });
  }

  /** The owner or an admin cancels a booking that isn't already closed. */
  async cancel(id: string, user: AuthenticatedUser): Promise<RoomBookingResult> {
    return this.prisma.withRls(user, async (tx) => {
      const booking = await tx.roomBooking.findUnique({
        where: { id },
        select: { id: true, bookedById: true, status: true, endsAt: true },
      });
      if (!booking) throw new NotFoundException('Booking not found.');
      if (
        user.role !== Role.SCHOOL_ADMIN &&
        booking.bookedById !== user.userId
      ) {
        throw new ForbiddenException('Only the booker may cancel this booking.');
      }
      if (booking.status === 'CANCELLED' || booking.status === 'REJECTED') {
        throw new BadRequestException('Booking is already closed.');
      }

      const updated = await tx.roomBooking.update({
        where: { id },
        data: { status: 'CANCELLED' },
        select: { id: true, status: true },
      });
      this.logger.log(`Room booking cancelled [booking=${id}]`);
      return updated;
    });
  }

  /** Admin approves or rejects a pending booking and notifies the requester. */
  async decide(
    id: string,
    dto: DecideRoomBookingDto,
    user: AuthenticatedUser,
  ): Promise<RoomBookingResult> {
    return this.prisma.withRls(user, async (tx) => {
      const booking = await tx.roomBooking.findUnique({
        where: { id },
        select: {
          id: true,
          schoolId: true,
          roomId: true,
          bookedById: true,
          title: true,
          startsAt: true,
          endsAt: true,
          status: true,
          room: { select: { name: true } },
        },
      });
      if (!booking) throw new NotFoundException('Booking not found.');
      if (booking.status !== 'PENDING') {
        throw new BadRequestException('Booking is already decided.');
      }

      const updated = await tx.roomBooking.update({
        where: { id },
        data: {
          status: dto.status,
          decidedById: user.userId ?? null,
          decidedAt: new Date(),
          decisionNote: dto.note ?? null,
        },
        select: { id: true, status: true },
      });

      // Approval is a second claim on the slot, so it asks again: a lesson may
      // have taken the room while the request waited. Only a competing booking
      // could not have — the constraint refused it the moment this one was
      // written. Ordered after the UPDATE for the same reason create() is:
      // that write holds the room until we commit.
      if (dto.status === 'APPROVED') {
        await this.assertNoLessonUsesRoom(
          tx,
          booking.roomId,
          booking.startsAt,
          booking.endsAt,
        );
      }

      const when = booking.startsAt.toISOString();
      await this.notifications.notifyUsers(tx, {
        schoolId: booking.schoolId,
        userIds: [booking.bookedById],
        type: 'ROOM_BOOKING_DECIDED',
        meta: {
          status: dto.status,
          roomName: booking.room.name,
          title: booking.title,
          startsAt: when,
          note: dto.note ?? null,
        },
        email: {
          subject: `Room booking ${dto.status === 'APPROVED' ? 'approved' : 'rejected'} / Lokalbokning ${dto.status === 'APPROVED' ? 'godkänd' : 'avslagen'}`,
          body:
            `Your booking of ${booking.room.name} (${booking.title}) at ${when} was ${dto.status.toLowerCase()}.` +
            (dto.note ? `\nNote: ${dto.note}` : '') +
            `\n\nDin bokning av ${booking.room.name} (${booking.title}) ${when} ${dto.status === 'APPROVED' ? 'godkändes' : 'avslogs'}.`,
        },
      });

      this.logger.log(`Room booking decided [booking=${id}, status=${dto.status}]`);
      return updated;
    });
  }

  /**
   * Rejects the slot when a scheduled lesson occupies the room over
   * [startsAt, endsAt). Uses the same half-open overlap test the calendar
   * lesson conflict checks use.
   *
   * Other bookings are deliberately not looked at here. Two active bookings of
   * one room cannot both exist any more, and unlike a query in this file the
   * constraint that says so cannot be forgotten by the next call site.
   */
  private async assertNoLessonUsesRoom(
    tx: PrismaClient,
    roomId: string,
    startsAt: Date,
    endsAt: Date,
  ): Promise<void> {
    const lessonClash = await tx.calendarLesson.findFirst({
      where: {
        roomId,
        status: 'SCHEDULED',
        startsAt: { lt: endsAt },
        endsAt: { gt: startsAt },
      },
      select: { id: true },
    });
    if (lessonClash) {
      throw new ConflictException('A scheduled lesson already uses that room then.');
    }
  }
}
