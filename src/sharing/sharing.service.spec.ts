import { NotFoundException } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { createPrismaMock, createTxMock, testUser, type PrismaMock, type TxMock } from '../../test/utils/prisma-mock';
import type { PrismaService } from '../database/prisma.service';
import { SCHOOL_NOT_SIBLING, SharingService, schoolPair } from './sharing.service';

/**
 * What a school shares with the other schools of its huvudman (Delade
 * lokaler och lärare, 20261217090000). Who reads which rows is the
 * database's (RLS sections 275–279); this is what the service adds: the
 * other schools with the minutes to each and who wrote them, the shared
 * teachers by their own row's name, and a figure written signed with the
 * school, the pair lower id first.
 */

const SCHOOL_ID = '33333333-3333-4333-8333-333333333333';
const LOWER = '10000000-0000-4000-8000-000000000001';
const HIGHER = '90000000-0000-4000-8000-000000000009';
const ANNA = 'a0000000-0000-4000-8000-00000000000a';
const BERTIL = 'b0000000-0000-4000-8000-00000000000b';

/** The SQL text of a raw call: the template's parts, joined. */
const sqlOf = (call: unknown[]): string => ((call[0] as Prisma.Sql).strings ?? []).join('?');

describe('SharingService', () => {
  let prisma: PrismaMock;
  let tx: TxMock;
  let service: SharingService;
  let siblings: Array<{ school_id: string; name: string }>;
  let shared: Array<{ teacher_id: string; school_id: string; school_name: string }>;

  beforeEach(() => {
    tx = createTxMock();
    prisma = createPrismaMock(tx);
    service = new SharingService(prisma as unknown as PrismaService);
    siblings = [
      { school_id: HIGHER, name: 'Östra skolan' },
      { school_id: LOWER, name: 'Björkskolan' },
    ];
    shared = [];
    tx.$queryRaw.mockImplementation(async (sql: Prisma.Sql) => {
      const text = sql.strings.join('?');
      if (text.includes('app.sibling_schools()')) return siblings;
      if (text.includes('app.shared_teachers()')) return shared;
      return [];
    });
  });

  describe('schoolPair', () => {
    it('stores the pair lower id first, whichever school asks', () => {
      expect(schoolPair(HIGHER, LOWER)).toEqual({ schoolAId: LOWER, schoolBId: HIGHER });
      expect(schoolPair(LOWER, HIGHER)).toEqual({ schoolAId: LOWER, schoolBId: HIGHER });
    });
  });

  describe('view', () => {
    it('lists the other schools by name with the minutes to each, and who wrote them', async () => {
      tx.schoolTravelTime.findMany.mockResolvedValue([
        // Written by this school, which is the higher id of the pair.
        { schoolAId: LOWER, schoolBId: SCHOOL_ID, minutes: 15, setBySchoolId: SCHOOL_ID },
      ]);

      const view = await service.view(testUser());

      expect(view.schools).toEqual([
        { id: LOWER, name: 'Björkskolan', travelMinutes: 15, travelSetByUs: true },
        { id: HIGHER, name: 'Östra skolan', travelMinutes: null, travelSetByUs: null },
      ]);
      expect(prisma.withRls).toHaveBeenCalledTimes(1);
    });

    it('says the other school wrote a figure it signed, on either end of the pair', async () => {
      tx.schoolTravelTime.findMany.mockResolvedValue([
        { schoolAId: SCHOOL_ID, schoolBId: HIGHER, minutes: 30, setBySchoolId: HIGHER },
        { schoolAId: LOWER, schoolBId: SCHOOL_ID, minutes: 0, setBySchoolId: LOWER },
      ]);

      const view = await service.view(testUser());

      expect(view.schools).toEqual([
        { id: LOWER, name: 'Björkskolan', travelMinutes: 0, travelSetByUs: false },
        { id: HIGHER, name: 'Östra skolan', travelMinutes: 30, travelSetByUs: false },
      ]);
    });

    it('ignores a pair that is not the school\'s own', async () => {
      tx.schoolTravelTime.findMany.mockResolvedValue([
        { schoolAId: LOWER, schoolBId: HIGHER, minutes: 45, setBySchoolId: LOWER },
      ]);

      const view = await service.view(testUser());

      expect(view.schools.every((school) => school.travelMinutes === null)).toBe(true);
    });

    it('names the shared teachers by the school\'s own rows, their schools grouped and by name, the teachers by last name', async () => {
      shared = [
        { teacher_id: ANNA, school_id: HIGHER, school_name: 'Östra skolan' },
        { teacher_id: ANNA, school_id: LOWER, school_name: 'Björkskolan' },
        { teacher_id: BERTIL, school_id: LOWER, school_name: 'Björkskolan' },
      ];
      tx.user.findMany.mockResolvedValue([
        { id: ANNA, firstName: 'Anna', lastName: 'Öberg' },
        { id: BERTIL, firstName: 'Bertil', lastName: 'Andersson' },
      ]);

      const view = await service.view(testUser());

      expect(tx.user.findMany).toHaveBeenCalledWith({
        where: { id: { in: [ANNA, BERTIL] }, schoolId: SCHOOL_ID },
        select: { id: true, firstName: true, lastName: true },
      });
      expect(view.teachers).toEqual([
        { teacherId: BERTIL, firstName: 'Bertil', lastName: 'Andersson', schools: [{ id: LOWER, name: 'Björkskolan' }] },
        {
          teacherId: ANNA,
          firstName: 'Anna',
          lastName: 'Öberg',
          schools: [
            { id: LOWER, name: 'Björkskolan' },
            { id: HIGHER, name: 'Östra skolan' },
          ],
        },
      ]);
    });

    it('reads no person when nobody is shared, and a school without a huvudman has no other schools', async () => {
      siblings = [];

      await expect(service.view(testUser())).resolves.toEqual({ schools: [], teachers: [] });
      expect(tx.user.findMany).not.toHaveBeenCalled();
      expect(tx.$queryRaw.mock.calls.map(sqlOf)).toEqual([
        expect.stringContaining('app.sibling_schools()'),
        expect.stringContaining('app.shared_teachers()'),
      ]);
    });
  });

  describe('putTravel', () => {
    it('refuses a school that is not another school of the huvudman with a 404, and writes nothing', async () => {
      const call = service.putTravel('70000000-0000-4000-8000-000000000007', 10, testUser());

      await expect(call).rejects.toBeInstanceOf(NotFoundException);
      await expect(service.putTravel('70000000-0000-4000-8000-000000000007', 10, testUser())).rejects.toMatchObject({
        response: { code: SCHOOL_NOT_SIBLING },
      });
      expect(tx.schoolTravelTime.create).not.toHaveBeenCalled();
      expect(tx.schoolTravelTime.update).not.toHaveBeenCalled();
      expect(tx.schoolTravelTime.deleteMany).not.toHaveBeenCalled();
    });

    it('adds a figure signed with the school, the pair lower id first', async () => {
      tx.schoolTravelTime.findUnique.mockResolvedValue(null);

      await service.putTravel(LOWER, 20, testUser());

      expect(tx.schoolTravelTime.findUnique).toHaveBeenCalledWith({
        where: { schoolAId_schoolBId: { schoolAId: LOWER, schoolBId: SCHOOL_ID } },
        select: { minutes: true },
      });
      expect(tx.schoolTravelTime.create).toHaveBeenCalledWith({
        data: { schoolAId: LOWER, schoolBId: SCHOOL_ID, minutes: 20, setBySchoolId: SCHOOL_ID },
      });
      expect(tx.schoolTravelTime.update).not.toHaveBeenCalled();
    });

    it('changes the figure the other school wrote, and signs it with this one', async () => {
      tx.schoolTravelTime.findUnique.mockResolvedValue({ minutes: 15 });

      await service.putTravel(HIGHER, 25, testUser());

      expect(tx.schoolTravelTime.update).toHaveBeenCalledWith({
        where: { schoolAId_schoolBId: { schoolAId: SCHOOL_ID, schoolBId: HIGHER } },
        data: { minutes: 25, setBySchoolId: SCHOOL_ID },
      });
      expect(tx.schoolTravelTime.create).not.toHaveBeenCalled();
    });

    it('removes the figure on null, and answers the view read after the write', async () => {
      tx.schoolTravelTime.findMany.mockResolvedValue([]);

      const view = await service.putTravel(HIGHER, null, testUser());

      expect(tx.schoolTravelTime.deleteMany).toHaveBeenCalledWith({ where: { schoolAId: SCHOOL_ID, schoolBId: HIGHER } });
      expect(tx.schoolTravelTime.findUnique).not.toHaveBeenCalled();
      expect(view.schools.map((school) => school.travelMinutes)).toEqual([null, null]);
      expect(prisma.withRls).toHaveBeenCalledTimes(1);
    });
  });
});
