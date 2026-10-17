import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { createPrismaMock, createTxMock, testUser, type PrismaMock, type TxMock } from '../../test/utils/prisma-mock';
import type { PrismaService } from '../database/prisma.service';
import { SITE_NAME_TAKEN, SITE_NOT_FOUND, SITE_TRAVEL_PAIR_INVALID, SitesService } from './sites.service';

/**
 * The school's skolområden and the minutes between them (20261124090000).
 * The database holds the rules a row must keep (the pair in id order, the
 * range, the school's own sites); RLS sections 180–183 run them. This is what
 * the service adds: a name trimmed, a pair in either order, and the travel
 * times saved whole under one school-wide lock.
 */

const SCHOOL_ID = '33333333-3333-4333-8333-333333333333';
const NORRA = '10000000-0000-4000-8000-000000000001';
const SODRA = '20000000-0000-4000-8000-000000000002';
const HALLEN = '30000000-0000-4000-8000-000000000003';

const prismaError = (code: string) =>
  new Prisma.PrismaClientKnownRequestError(`Simulated ${code}`, { code, clientVersion: Prisma.prismaVersion.client });

describe('SitesService', () => {
  let prisma: PrismaMock;
  let tx: TxMock;
  let service: SitesService;

  beforeEach(() => {
    tx = createTxMock();
    prisma = createPrismaMock(tx);
    service = new SitesService(prisma as unknown as PrismaService);
    tx.$executeRaw.mockResolvedValue(1);
  });

  describe('list', () => {
    it('lists the sites by name with their rooms, the pairs, and the rooms on no site', async () => {
      tx.site.findMany.mockResolvedValue([
        { id: SODRA, name: 'Södra' },
        { id: NORRA, name: 'Norra' },
      ]);
      tx.siteTravelTime.findMany.mockResolvedValue([{ siteAId: NORRA, siteBId: SODRA, minutes: 15 }]);
      tx.room.groupBy.mockResolvedValue([
        { siteId: NORRA, _count: { _all: 4 } },
        { siteId: null, _count: { _all: 2 } },
      ]);

      await expect(service.list(testUser())).resolves.toEqual({
        sites: [
          { id: NORRA, name: 'Norra', roomCount: 4 },
          { id: SODRA, name: 'Södra', roomCount: 0 },
        ],
        travelTimes: [{ siteAId: NORRA, siteBId: SODRA, minutes: 15 }],
        roomsWithoutSite: 2,
      });
      expect(tx.site.findMany).toHaveBeenCalledWith({ where: { schoolId: SCHOOL_ID }, select: { id: true, name: true } });
    });
  });

  describe('create and rename', () => {
    it('stores the name trimmed, under the school’s lock', async () => {
      tx.site.create.mockResolvedValue({ id: NORRA, name: 'Norra' });

      await expect(service.create({ name: '  Norra ' }, testUser())).resolves.toEqual({ id: NORRA, name: 'Norra', roomCount: 0 });

      expect(tx.site.create).toHaveBeenCalledWith({ data: { schoolId: SCHOOL_ID, name: 'Norra' }, select: { id: true, name: true } });
      expect(tx.$executeRaw).toHaveBeenCalled();
    });

    it('refuses a blank name, and maps a name the school already has to 409 SITE_NAME_TAKEN', async () => {
      await expect(service.create({ name: '   ' }, testUser())).rejects.toBeInstanceOf(BadRequestException);
      tx.site.create.mockRejectedValue(prismaError('P2002'));
      await expect(service.create({ name: 'Norra' }, testUser())).rejects.toMatchObject({
        response: { code: SITE_NAME_TAKEN },
      });
      await expect(service.create({ name: 'Norra' }, testUser())).rejects.toBeInstanceOf(ConflictException);
    });

    it('renames only the school’s own site, and says how many rooms stand on it', async () => {
      tx.site.findFirst.mockResolvedValueOnce(null);
      await expect(service.update(NORRA, { name: 'Nya Norra' }, testUser())).rejects.toBeInstanceOf(NotFoundException);
      expect(tx.site.update).not.toHaveBeenCalled();

      tx.site.findFirst.mockResolvedValueOnce({ id: NORRA });
      tx.site.update.mockResolvedValue({ id: NORRA, name: 'Nya Norra' });
      tx.room.count.mockResolvedValue(3);
      await expect(service.update(NORRA, { name: 'Nya Norra' }, testUser())).resolves.toEqual({
        id: NORRA,
        name: 'Nya Norra',
        roomCount: 3,
      });
      expect(tx.site.findFirst).toHaveBeenLastCalledWith({ where: { id: NORRA, schoolId: SCHOOL_ID }, select: { id: true } });
    });

    it('removes the school’s own site, and answers 404 for any other', async () => {
      tx.site.deleteMany.mockResolvedValueOnce({ count: 1 });
      await expect(service.remove(NORRA, testUser())).resolves.toBeUndefined();
      expect(tx.site.deleteMany).toHaveBeenCalledWith({ where: { id: NORRA, schoolId: SCHOOL_ID } });
      tx.site.deleteMany.mockResolvedValueOnce({ count: 0 });
      await expect(service.remove(NORRA, testUser())).rejects.toMatchObject({ response: { code: SITE_NOT_FOUND } });
    });
  });

  describe('putTravelTimes', () => {
    beforeEach(() => {
      tx.site.findMany.mockResolvedValue([{ id: NORRA }, { id: SODRA }, { id: HALLEN }]);
    });

    it('stores each pair in id order, whichever way it came, and writes only what changed', async () => {
      tx.siteTravelTime.findMany.mockResolvedValue([
        { siteAId: NORRA, siteBId: SODRA, minutes: 15 },
        { siteAId: NORRA, siteBId: HALLEN, minutes: 30 },
      ]);

      const saved = await service.putTravelTimes(
        { times: [{ siteIds: [SODRA, NORRA], minutes: 15 }, { siteIds: [HALLEN, SODRA], minutes: 20 }] },
        testUser(),
      );

      expect(saved).toEqual([
        { siteAId: NORRA, siteBId: SODRA, minutes: 15 },
        { siteAId: SODRA, siteBId: HALLEN, minutes: 20 },
      ]);
      // Norra–Hallen was left out: its figure goes. Norra–Södra is unchanged: not written.
      expect(tx.siteTravelTime.delete).toHaveBeenCalledTimes(1);
      expect(tx.siteTravelTime.delete).toHaveBeenCalledWith({
        where: { siteAId_siteBId: { siteAId: NORRA, siteBId: HALLEN } },
      });
      expect(tx.siteTravelTime.upsert).toHaveBeenCalledTimes(1);
      expect(tx.siteTravelTime.upsert).toHaveBeenCalledWith({
        where: { siteAId_siteBId: { siteAId: SODRA, siteBId: HALLEN } },
        create: { schoolId: SCHOOL_ID, siteAId: SODRA, siteBId: HALLEN, minutes: 20 },
        update: { minutes: 20 },
      });
      expect(tx.$executeRaw).toHaveBeenCalled();
    });

    it('refuses a pair named twice, either way round, and a site paired with itself', async () => {
      await expect(
        service.putTravelTimes(
          { times: [{ siteIds: [NORRA, SODRA], minutes: 15 }, { siteIds: [SODRA, NORRA], minutes: 10 }] },
          testUser(),
        ),
      ).rejects.toMatchObject({ response: { code: SITE_TRAVEL_PAIR_INVALID } });
      await expect(
        service.putTravelTimes({ times: [{ siteIds: [NORRA, NORRA.toUpperCase()], minutes: 0 }] }, testUser()),
      ).rejects.toMatchObject({ response: { code: SITE_TRAVEL_PAIR_INVALID } });
      expect(prisma.withRls).not.toHaveBeenCalled();
    });

    it('refuses a site the school does not have, before writing anything', async () => {
      tx.siteTravelTime.findMany.mockResolvedValue([]);
      await expect(
        service.putTravelTimes(
          { times: [{ siteIds: [NORRA, '40000000-0000-4000-8000-000000000004'], minutes: 5 }] },
          testUser(),
        ),
      ).rejects.toMatchObject({ response: { code: SITE_NOT_FOUND } });
      expect(tx.siteTravelTime.upsert).not.toHaveBeenCalled();
      expect(tx.siteTravelTime.delete).not.toHaveBeenCalled();
    });

    it('empties the school’s figures with an empty list', async () => {
      tx.siteTravelTime.findMany.mockResolvedValue([{ siteAId: NORRA, siteBId: SODRA, minutes: 15 }]);
      await expect(service.putTravelTimes({ times: [] }, testUser())).resolves.toEqual([]);
      expect(tx.siteTravelTime.delete).toHaveBeenCalledTimes(1);
    });
  });
});
