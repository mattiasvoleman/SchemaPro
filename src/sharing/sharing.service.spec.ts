import { NotFoundException } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { createPrismaMock, createTxMock, testUser, type PrismaMock, type TxMock } from '../../test/utils/prisma-mock';
import type { PrismaService } from '../database/prisma.service';
import { SCHOOL_NOT_SIBLING, SHARED_TEACHER_NOT_STAFF, SharingService, schoolPair } from './sharing.service';

/**
 * What a school shares with the other schools of its huvudman (Delade
 * lokaler och lärare, 20261217090000). Who reads which rows is the
 * database's (RLS sections 275–279); this is what the service adds: the
 * other schools with the minutes to each and who wrote them, the school's
 * marked teachers by their own row's name and whether the other school has
 * marked back, a mark made or taken back for the school's own active staff
 * towards another school of the huvudman, and a figure written signed with
 * the school, the pair lower id first.
 */

const SCHOOL_ID = '33333333-3333-4333-8333-333333333333';
const LOWER = '10000000-0000-4000-8000-000000000001';
const HIGHER = '90000000-0000-4000-8000-000000000009';
const ANNA = 'a0000000-0000-4000-8000-00000000000a';
const BERTIL = 'b0000000-0000-4000-8000-00000000000b';
const LEFT = '70000000-0000-4000-8000-000000000007';

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

    it('names the marked teachers by the school\'s own rows, each school marked back as shared, the teachers by last name', async () => {
      tx.sharedTeacherMark.findMany.mockResolvedValue([
        { teacherId: ANNA, withSchoolId: HIGHER },
        { teacherId: ANNA, withSchoolId: LOWER },
        { teacherId: BERTIL, withSchoolId: LOWER },
        // Towards a school that has left the huvudman: shares nothing, not shown.
        { teacherId: BERTIL, withSchoolId: LEFT },
      ]);
      // Östra skolan has marked its row of Anna back; Björkskolan neither.
      shared = [{ teacher_id: ANNA, school_id: HIGHER, school_name: 'Östra skolan' }];
      tx.user.findMany
        .mockResolvedValueOnce([
          { id: ANNA, firstName: 'Anna', lastName: 'Öberg' },
          { id: BERTIL, firstName: 'Bertil', lastName: 'Andersson' },
        ])
        .mockResolvedValueOnce([
          { id: ANNA, firstName: 'Anna', lastName: 'Öberg' },
          { id: BERTIL, firstName: 'Bertil', lastName: 'Andersson' },
        ]);

      const view = await service.view(testUser());

      expect(tx.sharedTeacherMark.findMany).toHaveBeenCalledWith({
        where: { schoolId: SCHOOL_ID },
        select: { teacherId: true, withSchoolId: true },
      });
      expect(tx.user.findMany).toHaveBeenNthCalledWith(1, {
        where: { id: { in: [ANNA, BERTIL] }, schoolId: SCHOOL_ID },
        select: { id: true, firstName: true, lastName: true },
      });
      expect(tx.user.findMany).toHaveBeenNthCalledWith(2, {
        where: { schoolId: SCHOOL_ID, isActive: true, role: { in: ['TEACHER', 'SCHOOL_ADMIN'] } },
        select: { id: true, firstName: true, lastName: true },
      });
      expect(view.teachers).toEqual([
        {
          teacherId: BERTIL,
          firstName: 'Bertil',
          lastName: 'Andersson',
          schools: [{ id: LOWER, name: 'Björkskolan', shared: false }],
        },
        {
          teacherId: ANNA,
          firstName: 'Anna',
          lastName: 'Öberg',
          schools: [
            { id: LOWER, name: 'Björkskolan', shared: false },
            { id: HIGHER, name: 'Östra skolan', shared: true },
          ],
        },
      ]);
      expect(view.staff.map((person) => person.lastName)).toEqual(['Andersson', 'Öberg']);
    });

    it('leaves out a teacher marked only towards a school that has left the huvudman', async () => {
      tx.sharedTeacherMark.findMany.mockResolvedValue([{ teacherId: BERTIL, withSchoolId: LEFT }]);
      tx.user.findMany.mockResolvedValue([{ id: BERTIL, firstName: 'Bertil', lastName: 'Andersson' }]);

      const view = await service.view(testUser());

      expect(view.teachers).toEqual([]);
    });

    it('reads no mark and no person for a school without a huvudman, which has no other schools', async () => {
      siblings = [];

      await expect(service.view(testUser())).resolves.toEqual({ schools: [], teachers: [], staff: [] });
      expect(tx.user.findMany).not.toHaveBeenCalled();
      expect(tx.sharedTeacherMark.findMany).not.toHaveBeenCalled();
      expect(tx.$queryRaw.mock.calls.map(sqlOf)).toEqual([
        expect.stringContaining('app.sibling_schools()'),
        expect.stringContaining('app.shared_teachers()'),
      ]);
    });
  });

  describe('markTeacher', () => {
    it('marks the school\'s own active teacher towards another school of the huvudman, once', async () => {
      tx.user.findFirst.mockResolvedValue({ id: ANNA });

      await service.markTeacher(ANNA, HIGHER, true, testUser());

      expect(tx.user.findFirst).toHaveBeenCalledWith({
        where: { id: ANNA, schoolId: SCHOOL_ID, isActive: true, role: { in: ['TEACHER', 'SCHOOL_ADMIN'] } },
        select: { id: true },
      });
      expect(tx.sharedTeacherMark.createMany).toHaveBeenCalledWith({
        data: [{ schoolId: SCHOOL_ID, teacherId: ANNA, withSchoolId: HIGHER }],
        skipDuplicates: true,
      });
      expect(prisma.withRls).toHaveBeenCalledTimes(1);
    });

    it('refuses a row that is not one of the school\'s active teachers or administrators with a 404', async () => {
      tx.user.findFirst.mockResolvedValue(null);

      await expect(service.markTeacher(ANNA, HIGHER, true, testUser())).rejects.toMatchObject({
        status: 404,
        response: { code: SHARED_TEACHER_NOT_STAFF },
      });
      expect(tx.sharedTeacherMark.createMany).not.toHaveBeenCalled();
    });

    it('refuses a school that is not another school of the huvudman with a 404, either way', async () => {
      for (const shared of [true, false]) {
        await expect(service.markTeacher(ANNA, LEFT, shared, testUser())).rejects.toMatchObject({
          status: 404,
          response: { code: SCHOOL_NOT_SIBLING },
        });
      }
      expect(tx.sharedTeacherMark.createMany).not.toHaveBeenCalled();
      expect(tx.sharedTeacherMark.deleteMany).not.toHaveBeenCalled();
    });

    it('takes the school\'s own mark back, whatever the row has become', async () => {
      await service.markTeacher(ANNA, LOWER, false, testUser());

      expect(tx.user.findFirst).not.toHaveBeenCalled();
      expect(tx.sharedTeacherMark.deleteMany).toHaveBeenCalledWith({
        where: { schoolId: SCHOOL_ID, teacherId: ANNA, withSchoolId: LOWER },
      });
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
