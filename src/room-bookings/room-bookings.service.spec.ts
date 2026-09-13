import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  createPrismaMock,
  createTxMock,
  testUser,
  type PrismaMock,
  type TxMock,
} from '../../test/utils/prisma-mock';
import { Role } from '../auth/enums/role.enum';
import type { PrismaService } from '../database/prisma.service';
import type { NotificationsService } from '../notifications/notifications.service';
import { RoomBookingsService } from './room-bookings.service';

const NOW = new Date('2026-08-05T08:00:00.000Z');
const ROOM_ID = '44444444-4444-4444-8444-444444444444';
const BOOKING_ID = '55555555-5555-4555-8555-555555555555';
const OWNER_ID = '22222222-2222-4222-8222-222222222222';

describe('RoomBookingsService', () => {
  let service: RoomBookingsService;
  let tx: TxMock;
  let prisma: PrismaMock;
  let notifications: { notifyUsers: jest.Mock };

  beforeEach(() => {
    jest.useFakeTimers().setSystemTime(NOW);
    tx = createTxMock();
    prisma = createPrismaMock(tx);
    notifications = { notifyUsers: jest.fn().mockResolvedValue(1) };
    service = new RoomBookingsService(
      prisma as unknown as PrismaService,
      notifications as unknown as NotificationsService,
    );
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  /** A valid future slot: 2026-08-05 10:00–11:00Z. */
  const dto = (overrides: Partial<Record<string, string>> = {}) => ({
    roomId: ROOM_ID,
    title: 'Rehearsal',
    startsAt: '2026-08-05T10:00:00.000Z',
    endsAt: '2026-08-05T11:00:00.000Z',
    ...overrides,
  });

  /** Default happy path: room exists, nothing clashes, create succeeds. */
  const arrangeFreeRoom = (requiresApproval = false) => {
    tx.room.findUnique.mockResolvedValue({ id: ROOM_ID, requiresApproval });
    tx.calendarLesson.findFirst.mockResolvedValue(null);
    tx.roomBooking.create.mockImplementation(({ data }: any) =>
      Promise.resolve({ id: BOOKING_ID, status: data.status }),
    );
  };

  /**
   * What PostgreSQL sends back when the exclusion constraint refuses a second
   * active booking of the room, as Prisma re-wraps it: no error code of its
   * own, the SQLSTATE and the constraint name buried in the message.
   */
  const roomHeldOnce = () =>
    new Prisma.PrismaClientUnknownRequestError(
      'Error occurred during query execution:\nConnectorError(ConnectorError ' +
        '{ kind: QueryError(PostgresError { code: "23P01", message: ' +
        '"conflicting key value violates exclusion constraint ' +
        '\\"RoomBookings_room_is_held_once\\"" }) })',
      { clientVersion: '0.0.0' },
    );

  describe('create', () => {
    it('books an ordinary free room as APPROVED', async () => {
      arrangeFreeRoom();

      await expect(
        service.create(dto() as any, testUser({ role: Role.TEACHER })),
      ).resolves.toEqual({ id: BOOKING_ID, status: 'APPROVED' });
    });

    it('persists the tenant from the principal, never from the payload', async () => {
      arrangeFreeRoom();
      const user = testUser({ role: Role.TEACHER, schoolId: 'school-A' });

      await service.create(dto() as any, user);

      expect(tx.roomBooking.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            schoolId: 'school-A',
            bookedById: OWNER_ID,
            startsAt: new Date('2026-08-05T10:00:00.000Z'),
            endsAt: new Date('2026-08-05T11:00:00.000Z'),
          }),
        }),
      );
    });

    it('holds a special room as PENDING for a teacher', async () => {
      arrangeFreeRoom(true);

      await expect(
        service.create(dto() as any, testUser({ role: Role.TEACHER })),
      ).resolves.toEqual({ id: BOOKING_ID, status: 'PENDING' });
    });

    it('lets an admin book a special room straight to APPROVED', async () => {
      arrangeFreeRoom(true);

      await expect(
        service.create(dto() as any, testUser({ role: Role.SCHOOL_ADMIN })),
      ).resolves.toEqual({ id: BOOKING_ID, status: 'APPROVED' });
    });

    it('rejects a principal with no user identity before touching the database', async () => {
      // bookedById is a required column. The route admits TEACHER and
      // SCHOOL_ADMIN, whose userId always comes from the Users row, so no HTTP
      // caller arrives without one; the service still refuses up front rather
      // than leave the invariant to the route's @Roles.
      await expect(
        service.create(dto() as any, testUser({ userId: undefined })),
      ).rejects.toThrow(
        new ForbiddenException('No user identity is associated with this account.'),
      );
      expect(prisma.withRls).not.toHaveBeenCalled();
      expect(tx.roomBooking.create).not.toHaveBeenCalled();
    });

    it('rejects a principal with no school', async () => {
      await expect(
        service.create(dto() as any, testUser({ schoolId: undefined })),
      ).rejects.toThrow(ForbiddenException);
      expect(prisma.withRls).not.toHaveBeenCalled();
    });

    it('rejects an inverted range', async () => {
      await expect(
        service.create(
          dto({
            startsAt: '2026-08-05T11:00:00.000Z',
            endsAt: '2026-08-05T10:00:00.000Z',
          }) as any,
          testUser(),
        ),
      ).rejects.toThrow('endsAt must be after startsAt.');
    });

    it('rejects a zero-length range', async () => {
      await expect(
        service.create(
          dto({ endsAt: '2026-08-05T10:00:00.000Z' }) as any,
          testUser(),
        ),
      ).rejects.toThrow(BadRequestException);
    });

    it('rejects a booking that has already ended', async () => {
      await expect(
        service.create(
          dto({
            startsAt: '2026-08-05T06:00:00.000Z',
            endsAt: '2026-08-05T07:00:00.000Z',
          }) as any,
          testUser(),
        ),
      ).rejects.toThrow('Bookings must be in the future.');
    });

    it('rejects an unknown room before touching availability', async () => {
      tx.room.findUnique.mockResolvedValue(null);

      await expect(service.create(dto() as any, testUser())).rejects.toThrow(
        'Room not found.',
      );
      expect(tx.calendarLesson.findFirst).not.toHaveBeenCalled();
    });

    it('rejects a slot occupied by a scheduled lesson', async () => {
      arrangeFreeRoom();
      tx.calendarLesson.findFirst.mockResolvedValue({ id: 'lesson-1' });

      // The row is written before the room is asked about — that is what makes
      // the answer hold — and the throw is what takes it back out again.
      await expect(service.create(dto() as any, testUser())).rejects.toThrow(
        ConflictException,
      );
    });

    it('asks about the room only after the booking is written', async () => {
      arrangeFreeRoom();
      const order: string[] = [];
      tx.roomBooking.create.mockImplementation(({ data }: any) => {
        order.push('create');
        return Promise.resolve({ id: BOOKING_ID, status: data.status });
      });
      tx.calendarLesson.findFirst.mockImplementation(() => {
        order.push('check');
        return Promise.resolve(null);
      });

      await service.create(dto() as any, testUser());

      expect(order).toEqual(['create', 'check']);
    });

    it('turns the exclusion constraint into the conflict the caller expects', async () => {
      arrangeFreeRoom();
      tx.roomBooking.create.mockRejectedValue(roomHeldOnce());

      await expect(service.create(dto() as any, testUser())).rejects.toThrow(
        'That room is already booked for this time.',
      );
    });

    it('passes any other database failure through untranslated', async () => {
      arrangeFreeRoom();
      tx.roomBooking.create.mockRejectedValue(new Error('connection reset'));

      await expect(service.create(dto() as any, testUser())).rejects.toThrow(
        'connection reset',
      );
    });

    it('uses a half-open overlap window so back-to-back slots do not clash', async () => {
      arrangeFreeRoom();

      await service.create(dto() as any, testUser());

      // startsAt < endsAt AND endsAt > startsAt — an adjoining lesson that
      // ends exactly at 10:00 must not match.
      expect(tx.calendarLesson.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            roomId: ROOM_ID,
            status: 'SCHEDULED',
            startsAt: { lt: new Date('2026-08-05T11:00:00.000Z') },
            endsAt: { gt: new Date('2026-08-05T10:00:00.000Z') },
          }),
        }),
      );
    });
  });

  describe('cancel', () => {
    const arrangeBooking = (overrides: Record<string, unknown> = {}) => {
      tx.roomBooking.findUnique.mockResolvedValue({
        id: BOOKING_ID,
        bookedById: OWNER_ID,
        status: 'APPROVED',
        endsAt: new Date('2026-08-05T11:00:00.000Z'),
        ...overrides,
      });
      tx.roomBooking.update.mockResolvedValue({
        id: BOOKING_ID,
        status: 'CANCELLED',
      });
    };

    it('lets the booker cancel their own booking', async () => {
      arrangeBooking();

      await expect(
        service.cancel(BOOKING_ID, testUser({ role: Role.TEACHER })),
      ).resolves.toEqual({ id: BOOKING_ID, status: 'CANCELLED' });
    });

    it('lets an admin cancel someone else’s booking', async () => {
      arrangeBooking({ bookedById: 'someone-else' });

      await expect(
        service.cancel(BOOKING_ID, testUser({ role: Role.SCHOOL_ADMIN })),
      ).resolves.toEqual({ id: BOOKING_ID, status: 'CANCELLED' });
    });

    it('forbids a teacher cancelling someone else’s booking', async () => {
      arrangeBooking({ bookedById: 'someone-else' });

      await expect(
        service.cancel(BOOKING_ID, testUser({ role: Role.TEACHER })),
      ).rejects.toThrow(ForbiddenException);
      expect(tx.roomBooking.update).not.toHaveBeenCalled();
    });

    it('404s on an unknown booking', async () => {
      tx.roomBooking.findUnique.mockResolvedValue(null);

      await expect(service.cancel(BOOKING_ID, testUser())).rejects.toThrow(
        NotFoundException,
      );
    });

    it.each(['CANCELLED', 'REJECTED'])(
      'refuses to re-close a %s booking',
      async (status) => {
        arrangeBooking({ status });

        await expect(service.cancel(BOOKING_ID, testUser())).rejects.toThrow(
          'Booking is already closed.',
        );
      },
    );

    it('allows cancelling a still-PENDING booking', async () => {
      arrangeBooking({ status: 'PENDING' });

      await expect(
        service.cancel(BOOKING_ID, testUser()),
      ).resolves.toMatchObject({ status: 'CANCELLED' });
    });
  });

  describe('decide', () => {
    const pending = (overrides: Record<string, unknown> = {}) => ({
      id: BOOKING_ID,
      schoolId: 'school-A',
      roomId: ROOM_ID,
      bookedById: OWNER_ID,
      title: 'Rehearsal',
      startsAt: new Date('2026-08-05T10:00:00.000Z'),
      endsAt: new Date('2026-08-05T11:00:00.000Z'),
      status: 'PENDING',
      room: { name: 'Aula' },
      ...overrides,
    });

    const arrangePending = (overrides: Record<string, unknown> = {}) => {
      tx.roomBooking.findUnique.mockResolvedValue(pending(overrides));
      tx.calendarLesson.findFirst.mockResolvedValue(null);
      tx.roomBooking.update.mockImplementation(({ data }: any) =>
        Promise.resolve({ id: BOOKING_ID, status: data.status }),
      );
    };

    it('approves a pending booking and records the decider', async () => {
      arrangePending();

      await expect(
        service.decide(BOOKING_ID, { status: 'APPROVED' }, testUser()),
      ).resolves.toEqual({ id: BOOKING_ID, status: 'APPROVED' });

      expect(tx.roomBooking.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            status: 'APPROVED',
            decidedById: OWNER_ID,
            decidedAt: NOW,
            decisionNote: null,
          }),
        }),
      );
    });

    it('re-checks the room for a lesson at approval time', async () => {
      arrangePending();

      await service.decide(BOOKING_ID, { status: 'APPROVED' }, testUser());

      expect(tx.calendarLesson.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            roomId: ROOM_ID,
            status: 'SCHEDULED',
            startsAt: { lt: new Date('2026-08-05T11:00:00.000Z') },
            endsAt: { gt: new Date('2026-08-05T10:00:00.000Z') },
          }),
        }),
      );
    });

    it('refuses approval when a lesson claimed the slot while pending', async () => {
      arrangePending();
      tx.calendarLesson.findFirst.mockResolvedValue({ id: 'lesson-1' });

      // The approval is written before the room is asked about, so the throw is
      // what undoes it; nothing is announced to the requester either.
      await expect(
        service.decide(BOOKING_ID, { status: 'APPROVED' }, testUser()),
      ).rejects.toThrow(ConflictException);
      expect(notifications.notifyUsers).not.toHaveBeenCalled();
    });

    it('skips the availability check when rejecting', async () => {
      arrangePending();

      await expect(
        service.decide(BOOKING_ID, { status: 'REJECTED' }, testUser()),
      ).resolves.toEqual({ id: BOOKING_ID, status: 'REJECTED' });
      expect(tx.calendarLesson.findFirst).not.toHaveBeenCalled();
    });

    it('notifies the requester with the room and slot', async () => {
      arrangePending();

      await service.decide(
        BOOKING_ID,
        { status: 'APPROVED', note: 'Enjoy' },
        testUser(),
      );

      expect(notifications.notifyUsers).toHaveBeenCalledWith(
        tx,
        expect.objectContaining({
          schoolId: 'school-A',
          userIds: [OWNER_ID],
          type: 'ROOM_BOOKING_DECIDED',
          meta: expect.objectContaining({
            status: 'APPROVED',
            roomName: 'Aula',
            title: 'Rehearsal',
            startsAt: '2026-08-05T10:00:00.000Z',
            note: 'Enjoy',
          }),
        }),
      );
    });

    it('carries the decision note through to the stored row', async () => {
      arrangePending();

      await service.decide(
        BOOKING_ID,
        { status: 'REJECTED', note: 'Double-booked' },
        testUser(),
      );

      expect(tx.roomBooking.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ decisionNote: 'Double-booked' }),
        }),
      );
    });

    it('404s on an unknown booking', async () => {
      tx.roomBooking.findUnique.mockResolvedValue(null);

      await expect(
        service.decide(BOOKING_ID, { status: 'APPROVED' }, testUser()),
      ).rejects.toThrow(NotFoundException);
    });

    it.each(['APPROVED', 'REJECTED', 'CANCELLED'])(
      'refuses to re-decide a %s booking',
      async (status) => {
        arrangePending({ status });

        await expect(
          service.decide(BOOKING_ID, { status: 'APPROVED' }, testUser()),
        ).rejects.toThrow('Booking is already decided.');
      },
    );
  });
});
