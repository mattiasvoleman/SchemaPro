import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Prisma, type RoomBookingStatus } from '@prisma/client';
import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';
import { Role } from '../auth/enums/role.enum';
import { PrismaService } from '../database/prisma.service';
import { NotificationsService } from '../notifications/notifications.service';
import { requireSchoolId, requireUserId } from '../common/utils/request-context';
import { markedIds } from '../users/person-protections';
import { decisionNotice, initialStatus } from '../room-bookings/booking-decision';
import type { CreateResourceBookingDto, DecideResourceBookingDto } from './dto/resource-booking.dto';
import type { ResourceBookingResponse, ResourceBookingResult } from './local-types';

/**
 * The trigger that keeps two active bookings of one resource to its quantity
 * (migration 20270131091000). It raises SQLSTATE 23P01, which the pg driver
 * adapter has no Prisma code for, so it arrives as an unknown-code error with
 * PostgreSQL's message, and the constraint's name in it is how it is recognised.
 */
const QUANTITY_KEPT = 'ResourceBookings_quantity_is_kept';

export function isQuantityExhausted(error: unknown): boolean {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    (error.message.includes(QUANTITY_KEPT) || JSON.stringify(error.meta ?? {}).includes(QUANTITY_KEPT))
  );
}

const LIST_LIMIT = 200;

/**
 * Bookings of resources that are not rooms. The flow is a room booking's:
 * personnel book for themselves, a resource that requires approval starts
 * PENDING until Drift decides (booking-decision.ts holds what the two share), the
 * owner or an administrator cancels, and the booker is told of the decision.
 * What a room's constraint does for a room (nobody else holds it) the
 * ResourceBookings trigger does for a quantity (nobody holds more than there is).
 */
@Injectable()
export class ResourceBookingsService {
  private readonly logger = new Logger(ResourceBookingsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationsService,
  ) {}

  async create(dto: CreateResourceBookingDto, user: AuthenticatedUser): Promise<ResourceBookingResult> {
    const schoolId = requireSchoolId(user);
    const bookedById = requireUserId(user);
    const startsAt = new Date(dto.startsAt);
    const endsAt = new Date(dto.endsAt);
    if (endsAt <= startsAt) throw new BadRequestException('endsAt must be after startsAt.');
    if (endsAt <= new Date()) throw new BadRequestException('Bookings must be in the future.');
    const quantity = dto.quantity ?? 1;

    return this.prisma.withRls(user, async (tx) => {
      const resource = await tx.resource.findUnique({
        where: { id: dto.resourceId },
        select: { id: true, requiresApproval: true, quantity: true },
      });
      if (!resource) throw new BadRequestException('Resource not found.');
      if (quantity > resource.quantity) {
        throw new BadRequestException(`Det finns bara ${resource.quantity} av resursen.`);
      }
      const status = initialStatus(resource.requiresApproval, user.role);
      const booking = await tx.resourceBooking
        .create({
          data: { schoolId, resourceId: dto.resourceId, bookedById, title: dto.title.trim(), quantity, startsAt, endsAt, status },
          select: { id: true, status: true },
        })
        .catch((error: unknown) => {
          if (isQuantityExhausted(error)) {
            throw new ConflictException({
              message: 'Resursen är redan bokad för så många då.',
              code: 'RESOURCE_QUANTITY_USED',
            });
          }
          throw error;
        });
      this.logger.log(`Resource booked [booking=${booking.id}, status=${status}]`);
      return booking;
    });
  }

  /** The owner or an administrator cancels a booking that isn't already closed. */
  async cancel(id: string, user: AuthenticatedUser): Promise<ResourceBookingResult> {
    return this.prisma.withRls(user, async (tx) => {
      const booking = await tx.resourceBooking.findUnique({
        where: { id },
        select: { id: true, bookedById: true, status: true, externalBookingId: true },
      });
      if (!booking) throw new NotFoundException('Booking not found.');
      if (user.role !== Role.SCHOOL_ADMIN && booking.bookedById !== user.userId) {
        throw new ForbiddenException('Only the booker may cancel this booking.');
      }
      if (booking.status === 'CANCELLED' || booking.status === 'REJECTED') {
        throw new BadRequestException('Booking is already closed.');
      }
      const updated = await tx.resourceBooking.update({
        where: { id },
        data: { status: 'CANCELLED' },
        select: { id: true, status: true },
      });
      this.logger.log(`Resource booking cancelled [booking=${id}]`);
      return updated;
    });
  }

  /** Drift approves or rejects a booking that waits, and the booker is told. */
  async decide(id: string, dto: DecideResourceBookingDto, user: AuthenticatedUser): Promise<ResourceBookingResult> {
    return this.prisma.withRls(user, async (tx) => {
      const booking = await tx.resourceBooking.findUnique({
        where: { id },
        select: {
          id: true,
          schoolId: true,
          bookedById: true,
          title: true,
          startsAt: true,
          status: true,
          resource: { select: { name: true } },
        },
      });
      if (!booking) throw new NotFoundException('Booking not found.');
      if (booking.status !== 'PENDING') throw new BadRequestException('Booking is already decided.');

      // The trigger counts a PENDING booking as holding, so approving takes nothing more.
      const updated = await tx.resourceBooking.update({
        where: { id },
        data: { status: dto.status, decidedById: user.userId ?? null, decidedAt: new Date(), decisionNote: dto.note ?? null },
        select: { id: true, status: true },
      });
      const notice = decisionNotice({
        status: dto.status,
        targetName: booking.resource.name,
        targetKey: 'resourceName',
        title: booking.title,
        startsAt: booking.startsAt,
        note: dto.note,
      });
      await this.notifications.notifyUsers(tx, {
        schoolId: booking.schoolId,
        userIds: [booking.bookedById],
        type: 'ROOM_BOOKING_DECIDED',
        meta: notice.meta,
        email: notice.email,
      });
      this.logger.log(`Resource booking decided [booking=${id}, status=${dto.status}]`);
      return updated;
    });
  }

  /**
   * The newest bookings first, 200 at most. An administrator reads every booking
   * of the school and sees who made it; a teacher reads their own and nobody
   * else's (the policy lets them read the school's, for the quantity left, but a
   * list of colleagues' titles is not what this answers). A booker with a
   * protected identity is named by nobody.
   */
  async list(user: AuthenticatedUser, filter: { status?: RoomBookingStatus; mine?: boolean }): Promise<ResourceBookingResponse[]> {
    const schoolId = requireSchoolId(user);
    const admin = user.role === Role.SCHOOL_ADMIN;
    const mine = !admin || filter.mine === true;
    return this.prisma.withRls(user, async (tx) => {
      const rows = await tx.resourceBooking.findMany({
        where: {
          ...(filter.status ? { status: filter.status } : {}),
          ...(mine ? { bookedById: requireUserId(user) } : {}),
        },
        orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
        take: LIST_LIMIT,
        select: {
          id: true,
          resourceId: true,
          bookedById: true,
          title: true,
          quantity: true,
          startsAt: true,
          endsAt: true,
          status: true,
          decidedAt: true,
          decisionNote: true,
          createdAt: true,
          externalBookingId: true,
          resource: { select: { name: true } },
        },
      });
      const names = new Map<string, string>();
      if (admin && rows.length > 0) {
        const marked = await markedIds(tx, schoolId);
        const people = await tx.user.findMany({
          where: { id: { in: [...new Set(rows.filter((row) => !row.externalBookingId).map((row) => row.bookedById))] } },
          select: { id: true, firstName: true, lastName: true },
        });
        for (const person of people) if (!marked.has(person.id)) names.set(person.id, `${person.firstName} ${person.lastName}`);
      }
      return rows.map((row) => ({
        id: row.id,
        resourceId: row.resourceId,
        resourceName: row.resource.name,
        title: row.title,
        quantity: row.quantity,
        startsAt: row.startsAt.toISOString(),
        endsAt: row.endsAt.toISOString(),
        status: row.status,
        decidedAt: row.decidedAt ? row.decidedAt.toISOString() : null,
        decisionNote: row.decisionNote,
        createdAt: row.createdAt.toISOString(),
        bookedByName: row.externalBookingId ? null : (names.get(row.bookedById) ?? null),
        external: row.externalBookingId !== null,
      }));
    });
  }
}
