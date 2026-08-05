import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import type { PrismaClient, RoomBookingStatus } from '@prisma/client';
import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';
import { Role } from '../auth/enums/role.enum';
import { PrismaService } from '../database/prisma.service';
import { NotificationsService } from '../notifications/notifications.service';
import { requireSchoolId } from '../common/utils/request-context';
import type {
  CreateRoomBookingDto,
  DecideRoomBookingDto,
} from './dto/room-booking.dto';

export interface RoomBookingResult {
  id: string;
  status: RoomBookingStatus;
}

/**
 * Self-service room bookings (Skola24 Lokal parity). Teachers reserve free
 * rooms themselves; bookings coexist with lessons in conflict checking.
 * Bookings on "special" rooms (requiresApproval) start PENDING until an admin
 * decides; ordinary rooms auto-approve. RLS enforces tenancy and ownership;
 * this service adds friendly validation and the availability check.
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

      await this.assertRoomFree(tx, dto.roomId, startsAt, endsAt);

      // Special rooms need admin approval; admins booking directly skip it.
      const status: RoomBookingStatus =
        room.requiresApproval && user.role !== Role.SCHOOL_ADMIN
          ? 'PENDING'
          : 'APPROVED';

      const booking = await tx.roomBooking.create({
        data: {
          schoolId,
          roomId: dto.roomId,
          bookedById: user.userId as string,
          title: dto.title,
          startsAt,
          endsAt,
          status,
        },
        select: { id: true, status: true },
      });
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

      // Re-check availability at approval time in case a lesson or another
      // booking claimed the slot while this request was pending.
      if (dto.status === 'APPROVED') {
        await this.assertRoomFree(
          tx,
          booking.roomId,
          booking.startsAt,
          booking.endsAt,
          booking.id,
        );
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
   * Rejects the slot when the room is occupied by a scheduled lesson or an
   * active (pending/approved) booking overlapping [startsAt, endsAt). Uses the
   * same half-open overlap test the calendar lesson conflict checks use.
   */
  private async assertRoomFree(
    tx: PrismaClient,
    roomId: string,
    startsAt: Date,
    endsAt: Date,
    excludeBookingId?: string,
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

    const bookingClash = await tx.roomBooking.findFirst({
      where: {
        ...(excludeBookingId ? { id: { not: excludeBookingId } } : {}),
        roomId,
        status: { in: ['PENDING', 'APPROVED'] },
        startsAt: { lt: endsAt },
        endsAt: { gt: startsAt },
      },
      select: { id: true },
    });
    if (bookingClash) {
      throw new ConflictException('That room is already booked for this time.');
    }
  }
}
