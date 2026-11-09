import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  createPrismaMock,
  createTxMock,
  testUser,
  type PrismaMock,
  type TxMock,
} from '../../test/utils/prisma-mock';
import { rawSql } from '../../test/utils/locking-read';
import type { PrismaService } from '../database/prisma.service';
import { ResourcesService } from './resources.service';

const NOW = new Date('2026-11-10T08:00:00.000Z');
const SCHOOL_ID = testUser().schoolId;
const TABLETS = '44444444-4444-4444-8444-444444444441';
const BUS = '44444444-4444-4444-8444-444444444442';
const TYPE_ID = '55555555-5555-4555-8555-555555555555';
const SITE_ID = '66666666-6666-4666-8666-666666666666';

const prismaError = (code: string): Prisma.PrismaClientKnownRequestError =>
  new Prisma.PrismaClientKnownRequestError(`Simulated ${code}`, {
    code,
    clientVersion: Prisma.prismaVersion.client,
  });

/** A resource row as the service's select returns it. */
const row = (patch: Record<string, unknown> = {}) => ({
  id: TABLETS,
  name: 'Surfplattor',
  resourceTypeId: TYPE_ID,
  quantity: 30,
  siteId: null,
  place: null,
  requiresApproval: false,
  resourceType: { name: 'Surfplattor' },
  ...patch,
});

/** The same row as the service answers it. */
const answer = (patch: Record<string, unknown> = {}) => ({
  id: TABLETS,
  name: 'Surfplattor',
  resourceTypeId: TYPE_ID,
  resourceTypeName: 'Surfplattor',
  quantity: 30,
  siteId: null,
  siteName: null,
  place: null,
  requiresApproval: false,
  ...patch,
});

describe('ResourcesService', () => {
  let service: ResourcesService;
  let tx: TxMock;
  let prisma: PrismaMock;

  beforeEach(() => {
    jest.useFakeTimers().setSystemTime(NOW);
    tx = createTxMock();
    prisma = createPrismaMock(tx);
    service = new ResourcesService(prisma as unknown as PrismaService);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  describe('list', () => {
    it('answers every resource by name, with its kind and the site it is kept on', async () => {
      tx.resource.findMany.mockResolvedValue([
        row({ id: BUS, name: 'Minibuss', quantity: 1, siteId: SITE_ID, place: 'Garaget', requiresApproval: true, resourceType: { name: 'Fordon' } }),
        row(),
      ]);
      tx.site.findMany.mockResolvedValue([{ id: SITE_ID, name: 'Norra skolan' }]);

      await expect(service.list(testUser())).resolves.toEqual([
        answer({ id: BUS, name: 'Minibuss', quantity: 1, siteId: SITE_ID, siteName: 'Norra skolan', place: 'Garaget', requiresApproval: true, resourceTypeName: 'Fordon' }),
        answer(),
      ]);
      expect(tx.resource.findMany.mock.calls[0]![0].orderBy).toEqual([{ name: 'asc' }]);
      expect(tx.site.findMany).toHaveBeenCalledWith({ where: { id: { in: [SITE_ID] } }, select: { id: true, name: true } });
    });

    it('asks the sites nothing when no resource names one, and names none when the site is gone', async () => {
      tx.resource.findMany.mockResolvedValue([row()]);
      await service.list(testUser());
      expect(tx.site.findMany).not.toHaveBeenCalled();

      tx.resource.findMany.mockResolvedValue([row({ siteId: SITE_ID })]);
      tx.site.findMany.mockResolvedValue([]);
      await expect(service.list(testUser())).resolves.toEqual([answer({ siteId: SITE_ID, siteName: null })]);
    });
  });

  describe('availability', () => {
    const from = '2026-11-12T08:00:00.000Z';
    const to = '2026-11-12T12:00:00.000Z';
    const booking = (resourceId: string, quantity: number, start: string, end: string) => ({
      resourceId,
      quantity,
      startsAt: new Date(start),
      endsAt: new Date(end),
    });

    it('subtracts the most that the active bookings hold at one moment of the window', async () => {
      tx.resource.findMany.mockResolvedValue([row(), row({ id: BUS, name: 'Minibuss', quantity: 2 })]);
      tx.resourceBooking.findMany.mockResolvedValue([
        // 10 + 5 overlap from 09:00 to 10:00: 15 held at most. The third is after the first two.
        booking(TABLETS, 10, '2026-11-12T08:00:00.000Z', '2026-11-12T10:00:00.000Z'),
        booking(TABLETS, 5, '2026-11-12T09:00:00.000Z', '2026-11-12T11:00:00.000Z'),
        booking(TABLETS, 8, '2026-11-12T11:00:00.000Z', '2026-11-12T12:00:00.000Z'),
      ]);

      const result = await service.availability(from, to, testUser());

      expect(result.map((resource) => [resource.name, resource.free])).toEqual([
        ['Surfplattor', 15],
        ['Minibuss', 2],
      ]);
      expect(result[0]).toMatchObject(answer());
    });

    it('lets a booking that ends when the window starts, or starts when it ends, hold nothing', async () => {
      tx.resource.findMany.mockResolvedValue([row()]);
      tx.resourceBooking.findMany.mockResolvedValue([
        booking(TABLETS, 30, '2026-11-12T06:00:00.000Z', from),
        booking(TABLETS, 30, to, '2026-11-12T14:00:00.000Z'),
      ]);

      await expect(service.availability(from, to, testUser())).resolves.toEqual([{ ...answer(), free: 30 }]);
    });

    it('never answers less than none free, when the bookings hold more than the quantity', async () => {
      tx.resource.findMany.mockResolvedValue([row({ quantity: 5 })]);
      tx.resourceBooking.findMany.mockResolvedValue([booking(TABLETS, 9, from, to)]);

      const [only] = await service.availability(from, to, testUser());

      expect(only!.free).toBe(0);
    });

    it('asks for the bookings that hold (PENDING and APPROVED) and share time with the window', async () => {
      tx.resource.findMany.mockResolvedValue([]);

      await service.availability(from, to, testUser());

      expect(tx.resourceBooking.findMany.mock.calls[0]![0].where).toEqual({
        status: { in: ['PENDING', 'APPROVED'] },
        startsAt: { lt: new Date(to) },
        endsAt: { gt: new Date(from) },
      });
    });

    it.each([
      ['an end before the start', from, '2026-11-12T07:00:00.000Z'],
      ['an end equal to the start', from, from],
      ['a start that is not a date', 'tomorrow-ish', to],
      ['an end that is not a date', from, 'later'],
    ])('refuses %s with a 400 before reading anything', async (_label, start, end) => {
      await expect(service.availability(start, end, testUser())).rejects.toThrow(new BadRequestException('to must be after from.'));
      expect(prisma.withRls).not.toHaveBeenCalled();
    });

    it('refuses a window longer than 400 days and takes one of exactly 400', async () => {
      // 2026-01-01 to 2027-02-05 is 400 days, to 2027-02-06 is 401.
      await expect(service.availability('2026-01-01T00:00:00.000Z', '2027-02-06T00:00:00.000Z', testUser())).rejects.toThrow(
        new BadRequestException('The window is at most 400 days.'),
      );
      tx.resource.findMany.mockResolvedValue([]);
      await expect(service.availability('2026-01-01T00:00:00.000Z', '2027-02-05T00:00:00.000Z', testUser())).resolves.toEqual([]);
    });
  });

  describe('create', () => {
    it('stamps the tenant from the principal and defaults quantity to 1, the site and the place to none', async () => {
      tx.resource.create.mockResolvedValue(row({ quantity: 1 }));

      await expect(service.create({ name: '  Surfplattor ', resourceTypeId: TYPE_ID }, testUser())).resolves.toEqual(answer({ quantity: 1 }));

      expect(tx.resource.create.mock.calls[0]![0].data).toEqual({
        schoolId: SCHOOL_ID,
        name: 'Surfplattor',
        resourceTypeId: TYPE_ID,
        quantity: 1,
        siteId: null,
        place: null,
      });
    });

    it('writes what it is given: quantity, site, a trimmed place and the approval requirement, false included', async () => {
      tx.resource.create.mockResolvedValue(row({ siteId: SITE_ID, place: 'Skåp 3', requiresApproval: false }));
      tx.site.findMany.mockResolvedValue([{ id: SITE_ID, name: 'Norra' }]);

      const result = await service.create(
        { name: 'Surfplattor', resourceTypeId: TYPE_ID, quantity: 30, siteId: SITE_ID, place: ' Skåp 3 ', requiresApproval: false },
        testUser(),
      );

      expect(result).toEqual(answer({ siteId: SITE_ID, siteName: 'Norra', place: 'Skåp 3' }));
      expect(tx.resource.create.mock.calls[0]![0].data).toMatchObject({ quantity: 30, siteId: SITE_ID, place: 'Skåp 3', requiresApproval: false });
    });

    it('stores a blank place as none', async () => {
      tx.resource.create.mockResolvedValue(row());

      await service.create({ name: 'X', resourceTypeId: TYPE_ID, place: '   ' }, testUser());

      expect(tx.resource.create.mock.calls[0]![0].data.place).toBeNull();
    });

    it('rejects a principal with no school before touching the database', async () => {
      await expect(service.create({ name: 'X', resourceTypeId: TYPE_ID }, { ...testUser(), schoolId: undefined })).rejects.toThrow('No school');
      expect(prisma.withRls).not.toHaveBeenCalled();
    });

    it('maps a name the school has (P2002) to 409 and a kind or site that is not its own (P2003) to 409', async () => {
      tx.resource.create.mockRejectedValueOnce(prismaError('P2002'));
      await expect(service.create({ name: 'X', resourceTypeId: TYPE_ID }, testUser())).rejects.toBeInstanceOf(ConflictException);

      tx.resource.create.mockRejectedValueOnce(prismaError('P2003'));
      await expect(service.create({ name: 'X', resourceTypeId: TYPE_ID }, testUser())).rejects.toBeInstanceOf(ConflictException);
    });
  });

  describe('update', () => {
    it('changes only the fields it is given, null clearing the site and a blank clearing the place', async () => {
      tx.resource.update.mockResolvedValue(row());

      await service.update(TABLETS, { siteId: null, place: ' ' }, testUser());

      expect(tx.resource.update.mock.calls[0]![0]).toMatchObject({ where: { id: TABLETS }, data: { siteId: null, place: null } });
      expect(tx.resource.update.mock.calls[0]![0].data).not.toHaveProperty('name');
      expect(tx.resource.update.mock.calls[0]![0].data).not.toHaveProperty('quantity');
      expect(tx.resourceBooking.findMany).not.toHaveBeenCalled();
    });

    it('writes every field it is given, trimmed', async () => {
      tx.resource.update.mockResolvedValue(row({ name: 'Plattor' }));

      await service.update(
        TABLETS,
        { name: ' Plattor ', resourceTypeId: TYPE_ID, quantity: 40, siteId: SITE_ID, place: ' Skåp ', requiresApproval: true },
        testUser(),
      );

      expect(tx.resource.update.mock.calls[0]![0].data).toEqual({
        name: 'Plattor',
        resourceTypeId: TYPE_ID,
        quantity: 40,
        siteId: SITE_ID,
        place: 'Skåp',
        requiresApproval: true,
      });
    });

    describe('a lower quantity', () => {
      const later = (quantity: number, start: string, end: string) => ({ quantity, startsAt: new Date(start), endsAt: new Date(end) });

      it('is refused when a later booking already holds more, naming how many', async () => {
        tx.resourceBooking.findMany.mockResolvedValue([
          later(20, '2026-11-12T08:00:00.000Z', '2026-11-12T10:00:00.000Z'),
          later(5, '2026-11-12T09:00:00.000Z', '2026-11-12T11:00:00.000Z'),
        ]);

        await expect(service.update(TABLETS, { quantity: 24 }, testUser())).rejects.toThrow(
          new BadRequestException('Det finns bokningar som håller upp till 25 av resursen. Antalet kan inte vara lägre än så.'),
        );
        expect(tx.resource.update).not.toHaveBeenCalled();
        expect(tx.resourceBooking.findMany.mock.calls[0]![0]).toEqual({
          where: { resourceId: TABLETS, status: { in: ['PENDING', 'APPROVED'] }, endsAt: { gt: NOW } },
          select: { quantity: true, startsAt: true, endsAt: true },
        });
      });

      it('is taken when it equals what the bookings hold at most, bookings that follow each other not adding up', async () => {
        tx.resourceBooking.findMany.mockResolvedValue([
          later(20, '2026-11-12T08:00:00.000Z', '2026-11-12T10:00:00.000Z'),
          later(20, '2026-11-12T10:00:00.000Z', '2026-11-12T12:00:00.000Z'),
        ]);
        tx.resource.update.mockResolvedValue(row({ quantity: 20 }));

        await expect(service.update(TABLETS, { quantity: 20 }, testUser())).resolves.toEqual(answer({ quantity: 20 }));
      });

      it('is taken when nothing is booked ahead', async () => {
        tx.resource.update.mockResolvedValue(row({ quantity: 1 }));

        await expect(service.update(TABLETS, { quantity: 1 }, testUser())).resolves.toEqual(answer({ quantity: 1 }));
      });

      it('takes the resource’s advisory lock, the one the booking trigger takes, before it reads the bookings', async () => {
        tx.resource.update.mockResolvedValue(row({ quantity: 20 }));

        await service.update(TABLETS, { quantity: 20 }, testUser());

        expect(tx.$executeRaw).toHaveBeenCalledTimes(1);
        const call = tx.$executeRaw.mock.calls[0]!;
        expect(rawSql(call)).toContain('pg_advisory_xact_lock(hashtextextended(');
        expect(call.slice(1)).toEqual([`ResourceBookings:${TABLETS}`]);
        expect(tx.$executeRaw.mock.invocationCallOrder[0]!).toBeLessThan(tx.resourceBooking.findMany.mock.invocationCallOrder[0]!);
        expect(tx.resourceBooking.findMany.mock.invocationCallOrder[0]!).toBeLessThan(tx.resource.update.mock.invocationCallOrder[0]!);
      });

      it('takes no lock when the quantity is not what changes', async () => {
        tx.resource.update.mockResolvedValue(row());

        await service.update(TABLETS, { place: 'Skåp 4' }, testUser());

        expect(tx.$executeRaw).not.toHaveBeenCalled();
      });

      it('counts a booking that is running now, since it holds until it ends', async () => {
        tx.resourceBooking.findMany.mockResolvedValue([later(12, '2026-11-10T07:00:00.000Z', '2026-11-10T09:00:00.000Z')]);

        await expect(service.update(TABLETS, { quantity: 11 }, testUser())).rejects.toBeInstanceOf(BadRequestException);
      });
    });

    it('maps an unknown or cross-tenant id (P2025) to 404 and a taken name (P2002) to 409', async () => {
      tx.resource.update.mockRejectedValueOnce(prismaError('P2025'));
      await expect(service.update(TABLETS, { name: 'X' }, testUser())).rejects.toBeInstanceOf(NotFoundException);

      tx.resource.update.mockRejectedValueOnce(prismaError('P2002'));
      await expect(service.update(TABLETS, { name: 'X' }, testUser())).rejects.toBeInstanceOf(ConflictException);
    });
  });

  describe('remove', () => {
    it('deletes a resource nobody lets out', async () => {
      tx.externalBooking.count.mockResolvedValue(0);

      await expect(service.remove(TABLETS, testUser())).resolves.toBeUndefined();

      expect(tx.externalBooking.count).toHaveBeenCalledWith({ where: { resourceId: TABLETS } });
      expect(tx.resource.delete).toHaveBeenCalledWith({ where: { id: TABLETS } });
    });

    it('refuses a resource that is let out, saying how many series, and deletes nothing', async () => {
      tx.externalBooking.count.mockResolvedValue(2);

      const error = await service.remove(TABLETS, testUser()).catch((e: unknown) => e);

      expect(error).toBeInstanceOf(ConflictException);
      expect((error as ConflictException).getResponse()).toMatchObject({
        code: 'RESOURCE_IS_LET_OUT',
        message: 'Resursen hyrs ut i 2 serie(r) av externa bokningar. Ta bort dem först.',
      });
      expect(tx.resource.delete).not.toHaveBeenCalled();
    });

    it('maps an unknown id (P2025) to 404 and a key that refuses (P2003) to 409', async () => {
      tx.resource.delete.mockRejectedValueOnce(prismaError('P2025'));
      await expect(service.remove(TABLETS, testUser())).rejects.toBeInstanceOf(NotFoundException);

      tx.resource.delete.mockRejectedValueOnce(prismaError('P2003'));
      await expect(service.remove(TABLETS, testUser())).rejects.toBeInstanceOf(ConflictException);
    });
  });
});
