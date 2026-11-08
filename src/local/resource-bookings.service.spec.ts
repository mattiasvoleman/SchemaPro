import { BadRequestException, ConflictException, ForbiddenException, Logger, NotFoundException } from '@nestjs/common';
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
import { isQuantityExhausted, ResourceBookingsService } from './resource-bookings.service';

const NOW = new Date('2026-11-10T08:00:00.000Z');
const RESOURCE_ID = '44444444-4444-4444-8444-444444444444';
const BOOKING_ID = '55555555-5555-4555-8555-555555555555';
const OWNER_ID = '22222222-2222-4222-8222-222222222222';
const OTHER_ID = '66666666-6666-4666-8666-666666666666';
const SCHOOL_ID = testUser().schoolId;

const QUANTITY_KEPT = 'ResourceBookings_quantity_is_kept';

const knownError = (code: string, message: string, meta?: Record<string, unknown>) =>
  new Prisma.PrismaClientKnownRequestError(message, { code, clientVersion: Prisma.prismaVersion.client, meta });

/** What the pg driver adapter hands over for the quantity trigger's 23P01 (see isQuantityExhausted). */
const quantityUsed = () =>
  knownError('P2039', `Database error. Code: \`23P01\`. Message: \`ResourceBookings_quantity_is_kept: 31 of 30 held\``);

const teacher = (patch = {}) => testUser({ role: Role.TEACHER, userId: OWNER_ID, ...patch });

describe('isQuantityExhausted', () => {
  it('knows the trigger by the constraint name in the message', () => {
    expect(isQuantityExhausted(quantityUsed())).toBe(true);
  });

  it('knows it by the name in the error’s meta, where the adapter puts the cause', () => {
    expect(isQuantityExhausted(knownError('P2010', 'Raw query failed', { driverAdapterError: { cause: { message: QUANTITY_KEPT } } }))).toBe(true);
  });

  it('knows an error that carries no meta as not it, and so any other database error', () => {
    expect(isQuantityExhausted(knownError('P2039', 'Database error. Code: `23P01`.'))).toBe(false);
    expect(isQuantityExhausted(knownError('P2002', 'Unique constraint failed'))).toBe(false);
  });

  it('is not fooled by a plain error or a value that is no error at all', () => {
    expect(isQuantityExhausted(new Error(QUANTITY_KEPT))).toBe(false);
    expect(isQuantityExhausted(QUANTITY_KEPT)).toBe(false);
    expect(isQuantityExhausted(undefined)).toBe(false);
  });
});

describe('ResourceBookingsService', () => {
  let service: ResourceBookingsService;
  let tx: TxMock;
  let prisma: PrismaMock;
  let notifications: { notifyUsers: jest.Mock };

  beforeEach(() => {
    jest.useFakeTimers().setSystemTime(NOW);
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    tx = createTxMock();
    prisma = createPrismaMock(tx);
    notifications = { notifyUsers: jest.fn().mockResolvedValue(1) };
    service = new ResourceBookingsService(prisma as unknown as PrismaService, notifications as unknown as NotificationsService);
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  describe('create', () => {
    const dto = (patch: Record<string, unknown> = {}) => ({
      resourceId: RESOURCE_ID,
      title: '  Matteprov ',
      startsAt: '2026-11-12T08:00:00.000Z',
      endsAt: '2026-11-12T10:00:00.000Z',
      ...patch,
    });

    const arrange = (resource: Record<string, unknown> | null = { id: RESOURCE_ID, requiresApproval: false, quantity: 30 }) => {
      tx.resource.findUnique.mockResolvedValue(resource);
      tx.resourceBooking.create.mockImplementation(({ data }: { data: { status: string } }) => Promise.resolve({ id: BOOKING_ID, status: data.status }));
    };

    it('books one of a resource that needs no approval as APPROVED, for the caller, with the title trimmed', async () => {
      arrange();

      await expect(service.create(dto() as never, teacher())).resolves.toEqual({ id: BOOKING_ID, status: 'APPROVED' });

      expect(tx.resource.findUnique).toHaveBeenCalledWith({ where: { id: RESOURCE_ID }, select: { id: true, requiresApproval: true, quantity: true } });
      expect(tx.resourceBooking.create).toHaveBeenCalledWith({
        data: {
          schoolId: SCHOOL_ID,
          resourceId: RESOURCE_ID,
          bookedById: OWNER_ID,
          title: 'Matteprov',
          quantity: 1,
          startsAt: new Date('2026-11-12T08:00:00.000Z'),
          endsAt: new Date('2026-11-12T10:00:00.000Z'),
          status: 'APPROVED',
        },
        select: { id: true, status: true },
      });
    });

    it('starts PENDING for staff when the resource requires approval, and APPROVED for an administrator', async () => {
      arrange({ id: RESOURCE_ID, requiresApproval: true, quantity: 30 });

      await expect(service.create(dto({ quantity: 12 }) as never, teacher())).resolves.toEqual({ id: BOOKING_ID, status: 'PENDING' });
      expect(tx.resourceBooking.create.mock.calls[0]![0].data).toMatchObject({ quantity: 12, status: 'PENDING' });

      await expect(service.create(dto() as never, testUser())).resolves.toEqual({ id: BOOKING_ID, status: 'APPROVED' });
    });

    it('takes exactly the whole quantity', async () => {
      arrange();

      await expect(service.create(dto({ quantity: 30 }) as never, teacher())).resolves.toMatchObject({ id: BOOKING_ID });
    });

    it('refuses more than there are, saying how many there are, and writes nothing', async () => {
      arrange();

      await expect(service.create(dto({ quantity: 31 }) as never, teacher())).rejects.toThrow(
        new BadRequestException('Det finns bara 30 av resursen.'),
      );
      expect(tx.resourceBooking.create).not.toHaveBeenCalled();
    });

    it('refuses a resource that is not the school’s (or does not exist) as a 400', async () => {
      arrange(null);

      await expect(service.create(dto() as never, teacher())).rejects.toThrow(new BadRequestException('Resource not found.'));
      expect(tx.resourceBooking.create).not.toHaveBeenCalled();
    });

    it.each([
      ['an end equal to the start', { endsAt: '2026-11-12T08:00:00.000Z' }, 'endsAt must be after startsAt.'],
      ['an end before the start', { endsAt: '2026-11-12T07:00:00.000Z' }, 'endsAt must be after startsAt.'],
      ['a booking that has ended', { startsAt: '2026-11-10T06:00:00.000Z', endsAt: '2026-11-10T07:59:59.000Z' }, 'Bookings must be in the future.'],
    ])('refuses %s with a 400 before reading anything', async (_label, patch, message) => {
      arrange();

      await expect(service.create(dto(patch) as never, teacher())).rejects.toThrow(new BadRequestException(message));
      expect(prisma.withRls).not.toHaveBeenCalled();
    });

    it('takes a booking that has begun and has not ended', async () => {
      arrange();

      await expect(service.create(dto({ startsAt: '2026-11-10T07:00:00.000Z', endsAt: '2026-11-10T09:00:00.000Z' }) as never, teacher())).resolves.toMatchObject({
        id: BOOKING_ID,
      });
    });

    it('answers 409 RESOURCE_QUANTITY_USED when the trigger says the quantity is used up', async () => {
      arrange();
      tx.resourceBooking.create.mockRejectedValue(quantityUsed());

      const error = await service.create(dto() as never, teacher()).catch((e: unknown) => e);

      expect(error).toBeInstanceOf(ConflictException);
      expect((error as ConflictException).getResponse()).toMatchObject({ code: 'RESOURCE_QUANTITY_USED' });
    });

    it('lets any other database error through as it is', async () => {
      arrange();
      const other = knownError('P2002', 'Unique constraint failed');
      tx.resourceBooking.create.mockRejectedValue(other);

      await expect(service.create(dto() as never, teacher())).rejects.toBe(other);
    });

    it('refuses a principal with no school, and one with no user row, before anything else', async () => {
      await expect(service.create(dto() as never, { ...teacher(), schoolId: undefined })).rejects.toBeInstanceOf(ForbiddenException);
      await expect(service.create(dto() as never, { ...teacher(), userId: undefined })).rejects.toBeInstanceOf(ForbiddenException);
      expect(prisma.withRls).not.toHaveBeenCalled();
    });
  });

  describe('cancel', () => {
    const arrange = (status: string, bookedById = OWNER_ID) => {
      tx.resourceBooking.findUnique.mockResolvedValue({ id: BOOKING_ID, bookedById, status, externalBookingId: null });
      tx.resourceBooking.update.mockResolvedValue({ id: BOOKING_ID, status: 'CANCELLED' });
    };

    it.each(['PENDING', 'APPROVED'])('lets the owner cancel a %s booking', async (status) => {
      arrange(status);

      await expect(service.cancel(BOOKING_ID, teacher())).resolves.toEqual({ id: BOOKING_ID, status: 'CANCELLED' });

      expect(tx.resourceBooking.update).toHaveBeenCalledWith({
        where: { id: BOOKING_ID },
        data: { status: 'CANCELLED' },
        select: { id: true, status: true },
      });
    });

    it('lets an administrator cancel somebody else’s', async () => {
      arrange('APPROVED', OTHER_ID);

      await expect(service.cancel(BOOKING_ID, testUser())).resolves.toEqual({ id: BOOKING_ID, status: 'CANCELLED' });
    });

    it('refuses a member of staff who is not the booker, and changes nothing', async () => {
      arrange('APPROVED', OTHER_ID);

      await expect(service.cancel(BOOKING_ID, teacher())).rejects.toThrow(new ForbiddenException('Only the booker may cancel this booking.'));
      expect(tx.resourceBooking.update).not.toHaveBeenCalled();
    });

    it.each(['CANCELLED', 'REJECTED'])('refuses a booking that is already %s', async (status) => {
      arrange(status);

      await expect(service.cancel(BOOKING_ID, teacher())).rejects.toThrow(new BadRequestException('Booking is already closed.'));
      expect(tx.resourceBooking.update).not.toHaveBeenCalled();
    });

    it('answers 404 for a booking the caller cannot see', async () => {
      tx.resourceBooking.findUnique.mockResolvedValue(null);

      await expect(service.cancel(BOOKING_ID, teacher())).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('decide', () => {
    const waiting = (patch: Record<string, unknown> = {}) => ({
      id: BOOKING_ID,
      schoolId: SCHOOL_ID,
      bookedById: OWNER_ID,
      title: 'Matteprov',
      startsAt: new Date('2026-11-12T08:00:00.000Z'),
      status: 'PENDING',
      resource: { name: 'Surfplattor' },
      ...patch,
    });

    beforeEach(() => {
      tx.resourceBooking.update.mockImplementation(({ data }: { data: { status: string } }) => Promise.resolve({ id: BOOKING_ID, status: data.status }));
    });

    it('approves a waiting booking, records who and when, and tells the booker', async () => {
      tx.resourceBooking.findUnique.mockResolvedValue(waiting());

      await expect(service.decide(BOOKING_ID, { status: 'APPROVED' }, testUser({ userId: OTHER_ID }))).resolves.toEqual({
        id: BOOKING_ID,
        status: 'APPROVED',
      });

      expect(tx.resourceBooking.update).toHaveBeenCalledWith({
        where: { id: BOOKING_ID },
        data: { status: 'APPROVED', decidedById: OTHER_ID, decidedAt: NOW, decisionNote: null },
        select: { id: true, status: true },
      });
      expect(notifications.notifyUsers).toHaveBeenCalledWith(tx, {
        schoolId: SCHOOL_ID,
        userIds: [OWNER_ID],
        type: 'ROOM_BOOKING_DECIDED',
        meta: { status: 'APPROVED', resourceName: 'Surfplattor', title: 'Matteprov', startsAt: '2026-11-12T08:00:00.000Z', note: null },
        email: expect.objectContaining({ subject: 'Resource booking approved / Resursbokning godkänd' }),
      });
    });

    it('rejects with a note, which goes into the row and into the notice', async () => {
      tx.resourceBooking.findUnique.mockResolvedValue(waiting());

      await service.decide(BOOKING_ID, { status: 'REJECTED', note: 'Bussen är på verkstad' }, testUser());

      expect(tx.resourceBooking.update.mock.calls[0]![0].data).toMatchObject({ status: 'REJECTED', decisionNote: 'Bussen är på verkstad' });
      const notice = notifications.notifyUsers.mock.calls[0]![1];
      expect(notice.meta).toMatchObject({ status: 'REJECTED', note: 'Bussen är på verkstad' });
      expect(notice.email.body).toContain('Note: Bussen är på verkstad');
    });

    it('records no decider for a principal without a user id', async () => {
      tx.resourceBooking.findUnique.mockResolvedValue(waiting());

      await service.decide(BOOKING_ID, { status: 'APPROVED' }, { ...testUser(), userId: undefined });

      expect(tx.resourceBooking.update.mock.calls[0]![0].data.decidedById).toBeNull();
    });

    it('decides a booking once: an approved one is refused, and nobody is told', async () => {
      tx.resourceBooking.findUnique.mockResolvedValue(waiting({ status: 'APPROVED' }));

      await expect(service.decide(BOOKING_ID, { status: 'REJECTED' }, testUser())).rejects.toThrow(new BadRequestException('Booking is already decided.'));
      expect(tx.resourceBooking.update).not.toHaveBeenCalled();
      expect(notifications.notifyUsers).not.toHaveBeenCalled();
    });

    it('answers 404 for a booking the caller cannot see', async () => {
      tx.resourceBooking.findUnique.mockResolvedValue(null);

      await expect(service.decide(BOOKING_ID, { status: 'APPROVED' }, testUser())).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('list', () => {
    const entry = (patch: Record<string, unknown> = {}) => ({
      id: BOOKING_ID,
      resourceId: RESOURCE_ID,
      bookedById: OWNER_ID,
      title: 'Matteprov',
      quantity: 3,
      startsAt: new Date('2026-11-12T08:00:00.000Z'),
      endsAt: new Date('2026-11-12T10:00:00.000Z'),
      status: 'APPROVED',
      decidedAt: null,
      decisionNote: null,
      createdAt: new Date('2026-11-09T12:00:00.000Z'),
      externalBookingId: null,
      resource: { name: 'Surfplattor' },
      ...patch,
    });

    it('gives a teacher their own bookings and nobody’s name, whatever they ask for', async () => {
      tx.resourceBooking.findMany.mockResolvedValue([entry({ decidedAt: new Date('2026-11-09T13:00:00.000Z'), decisionNote: 'Gärna' })]);

      const result = await service.list(teacher(), { mine: false });

      expect(result).toEqual([
        {
          id: BOOKING_ID,
          resourceId: RESOURCE_ID,
          resourceName: 'Surfplattor',
          title: 'Matteprov',
          quantity: 3,
          startsAt: '2026-11-12T08:00:00.000Z',
          endsAt: '2026-11-12T10:00:00.000Z',
          status: 'APPROVED',
          decidedAt: '2026-11-09T13:00:00.000Z',
          decisionNote: 'Gärna',
          createdAt: '2026-11-09T12:00:00.000Z',
          bookedByName: null,
          external: false,
        },
      ]);
      expect(tx.resourceBooking.findMany.mock.calls[0]![0].where).toEqual({ bookedById: OWNER_ID });
      expect(tx.user.findMany).not.toHaveBeenCalled();
      expect(tx.personProtection.findMany).not.toHaveBeenCalled();
    });

    it('gives an administrator every booking of the school, the newest first, 200 at most, with the booker’s name', async () => {
      tx.resourceBooking.findMany.mockResolvedValue([entry(), entry({ id: 'second', bookedById: OTHER_ID })]);
      tx.personProtection.findMany.mockResolvedValue([]);
      tx.user.findMany.mockResolvedValue([
        { id: OWNER_ID, firstName: 'Anna', lastName: 'Lind' },
        { id: OTHER_ID, firstName: 'Bo', lastName: 'Ek' },
      ]);

      const result = await service.list(testUser(), {});

      expect(result.map((booking) => booking.bookedByName)).toEqual(['Anna Lind', 'Bo Ek']);
      const query = tx.resourceBooking.findMany.mock.calls[0]![0];
      expect(query.where).toEqual({});
      expect(query.orderBy).toEqual([{ createdAt: 'desc' }, { id: 'asc' }]);
      expect(query.take).toBe(200);
    });

    it('lets an administrator ask for their own, and for one status', async () => {
      tx.resourceBooking.findMany.mockResolvedValue([]);

      await service.list(testUser(), { mine: true, status: 'PENDING' });

      expect(tx.resourceBooking.findMany.mock.calls[0]![0].where).toEqual({ status: 'PENDING', bookedById: testUser().userId });
    });

    it('names nobody who has a protected identity, and does not say that anyone was left out', async () => {
      tx.resourceBooking.findMany.mockResolvedValue([entry(), entry({ id: 'second', bookedById: OTHER_ID })]);
      tx.personProtection.findMany.mockResolvedValue([{ userId: OTHER_ID }]);
      tx.user.findMany.mockResolvedValue([
        { id: OWNER_ID, firstName: 'Anna', lastName: 'Lind' },
        { id: OTHER_ID, firstName: 'Bo', lastName: 'Ek' },
      ]);

      const result = await service.list(testUser(), {});

      expect(result.map((booking) => booking.bookedByName)).toEqual(['Anna Lind', null]);
      expect(result).toHaveLength(2);
    });

    it('names no booker of a day of an external hire, which has none to name, and does not even ask for them', async () => {
      tx.resourceBooking.findMany.mockResolvedValue([entry({ externalBookingId: '77777777-7777-4777-8777-777777777777' }), entry({ id: 'plain', bookedById: OTHER_ID })]);
      tx.user.findMany.mockResolvedValue([
        { id: OWNER_ID, firstName: 'Anna', lastName: 'Lind' },
        { id: OTHER_ID, firstName: 'Bo', lastName: 'Ek' },
      ]);

      const result = await service.list(testUser(), {});

      expect(result.map((booking) => [booking.bookedByName, booking.external])).toEqual([
        [null, true],
        ['Bo Ek', false],
      ]);
      expect(tx.user.findMany.mock.calls[0]![0].where).toEqual({ id: { in: [OTHER_ID] } });
    });

    it('reads no names when there are no bookings', async () => {
      tx.resourceBooking.findMany.mockResolvedValue([]);

      await expect(service.list(testUser(), {})).resolves.toEqual([]);
      expect(tx.personProtection.findMany).not.toHaveBeenCalled();
      expect(tx.user.findMany).not.toHaveBeenCalled();
    });

    it('answers a name as none when the person is gone from the school', async () => {
      tx.resourceBooking.findMany.mockResolvedValue([entry()]);
      tx.user.findMany.mockResolvedValue([]);

      const [only] = await service.list(testUser(), {});

      expect(only!.bookedByName).toBeNull();
    });

    it('refuses a principal with no school, and a teacher with no user row', async () => {
      await expect(service.list({ ...testUser(), schoolId: undefined }, {})).rejects.toBeInstanceOf(ForbiddenException);
      await expect(service.list({ ...teacher(), userId: undefined }, {})).rejects.toBeInstanceOf(ForbiddenException);
    });
  });
});
