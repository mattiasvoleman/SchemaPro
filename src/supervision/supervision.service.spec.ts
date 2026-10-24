import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { createPrismaMock, createTxMock, testUser, type PrismaMock, type TxMock } from '../../test/utils/prisma-mock';
import { recordedReads } from '../../test/utils/recorded-reads';
import type { PrismaService } from '../database/prisma.service';
import {
  MAX_AREAS,
  MAX_SHIFTS_PER_YEAR,
  SUPERVISION_AREA_LIMIT,
  SUPERVISION_AREA_NAME_TAKEN,
  SUPERVISION_AREA_NOT_FOUND,
  SUPERVISION_SHIFT_CLASH,
  SUPERVISION_SHIFT_LIMIT,
  SUPERVISION_SHIFT_NOT_FOUND,
  SUPERVISION_SITE_NOT_FOUND,
  SUPERVISION_YEAR_NOT_FOUND,
  SupervisionService,
} from './supervision.service';

/**
 * Rastvaktsschema (20261202090000): what the service adds to what the
 * database holds (RLS sections 200–203 run the table rules): a name trimmed,
 * a span both ends or neither, a pass in whole minutes inside its läsår and
 * in one place at a time, named when it is not, and the schedule read laid
 * over the breaks and recorded in the läslogg.
 */

const SCHOOL_ID = '33333333-3333-4333-8333-333333333333';
const YEAR_ID = '44444444-4444-4444-8444-444444444444';
const GARDEN = '50000000-0000-4000-8000-000000000001';
const HALL = '50000000-0000-4000-8000-000000000002';
const SITE = '60000000-0000-4000-8000-000000000001';
const ANNA = '70000000-0000-4000-8000-000000000001';
const BO = '70000000-0000-4000-8000-000000000002';
const SHIFT = '80000000-0000-4000-8000-000000000001';

const time = (value: string) => new Date(`1970-01-01T${value}:00.000Z`);
const day = (value: string) => new Date(`${value}T00:00:00.000Z`);
const YEAR = { startDate: day('2026-08-17'), endDate: day('2027-06-11') };

const prismaError = (code: string, meta?: Record<string, unknown>) =>
  new Prisma.PrismaClientKnownRequestError(`Simulated ${code}`, { code, clientVersion: Prisma.prismaVersion.client, meta });

const storedArea = (rest: Record<string, unknown> = {}) => ({
  id: GARDEN,
  schoolId: SCHOOL_ID,
  name: 'Skolgården',
  siteId: null,
  minGradeLevel: null,
  maxGradeLevel: null,
  duringRasts: true,
  duringLunch: false,
  guardsNeeded: 1,
  countsAsTeaching: false,
  createdAt: new Date(),
  updatedAt: new Date(),
  ...rest,
});
const storedShift = (rest: Record<string, unknown> = {}) => ({
  id: SHIFT,
  schoolId: SCHOOL_ID,
  academicYearId: YEAR_ID,
  areaId: GARDEN,
  userId: ANNA,
  dayOfWeek: 1,
  startTime: time('10:00'),
  endTime: time('10:20'),
  validFrom: null,
  validTo: null,
  note: null,
  createdAt: new Date(),
  updatedAt: new Date(),
  ...rest,
});
const PASS = {
  academicYearId: YEAR_ID,
  areaId: GARDEN,
  userId: ANNA,
  dayOfWeek: 1,
  startTime: '10:00',
  endTime: '10:20',
};

describe('SupervisionService', () => {
  let prisma: PrismaMock;
  let tx: TxMock;
  let service: SupervisionService;

  beforeEach(() => {
    tx = createTxMock();
    prisma = createPrismaMock(tx);
    service = new SupervisionService(prisma as unknown as PrismaService);
    tx.$executeRaw.mockResolvedValue(1);
  });

  /** lockStaffRow's role, then the year's bounds read FOR SHARE: both $queryRaw. */
  const givenStaffAndYear = (role = 'TEACHER', year: unknown = YEAR) => {
    tx.$queryRaw.mockResolvedValueOnce([{ role }]).mockResolvedValueOnce(year ? [year] : []);
  };

  describe('areas', () => {
    it('lists the areas by name with the passes each holds', async () => {
      tx.supervisionArea.findMany.mockResolvedValue([
        storedArea({ id: HALL, name: 'Matsalen', _count: { shifts: 0 } }),
        storedArea({ _count: { shifts: 3 } }),
      ]);
      const listed = await service.listAreas(testUser());
      expect(listed.map((row) => [row.name, row.shiftCount])).toEqual([
        ['Matsalen', 0],
        ['Skolgården', 3],
      ]);
      expect(tx.supervisionArea.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { schoolId: SCHOOL_ID } }));
      // An area names nobody: nothing in the läslogg.
      expect(recordedReads(tx)).toEqual([]);
    });

    it('creates an area trimmed, with the defaults, under the school’s lock', async () => {
      tx.supervisionArea.count.mockResolvedValue(0);
      tx.supervisionArea.create.mockImplementation(({ data }: { data: Record<string, unknown> }) =>
        Promise.resolve(storedArea({ ...data })),
      );
      const created = await service.createArea({ name: '  Skolgården ' }, testUser());
      expect(tx.supervisionArea.create).toHaveBeenCalledWith({
        data: {
          schoolId: SCHOOL_ID,
          name: 'Skolgården',
          siteId: null,
          minGradeLevel: null,
          maxGradeLevel: null,
          duringRasts: true,
          duringLunch: false,
          guardsNeeded: 1,
          countsAsTeaching: false,
        },
      });
      expect(created).toMatchObject({ name: 'Skolgården', shiftCount: 0 });
      const lock = tx.$executeRaw.mock.calls[0]![0] as { values: unknown[] };
      expect(lock.values).toEqual([`SupervisionAreas:${SCHOOL_ID}`]);
    });

    it('refuses a blank name, a half span and an inverted one before it writes', async () => {
      await expect(service.createArea({ name: '   ' }, testUser())).rejects.toBeInstanceOf(BadRequestException);
      await expect(service.createArea({ name: 'Gården', minGradeLevel: 1 }, testUser())).rejects.toThrow(/ange båda/);
      await expect(service.createArea({ name: 'Gården', minGradeLevel: 4, maxGradeLevel: 3 }, testUser())).rejects.toThrow(
        /årskurs 4 ligger efter/,
      );
      expect(prisma.withRls).not.toHaveBeenCalled();
    });

    it('answers the limit, a site not the school’s and a taken name with their codes', async () => {
      tx.supervisionArea.count.mockResolvedValue(MAX_AREAS);
      await expect(service.createArea({ name: 'X' }, testUser())).rejects.toMatchObject({
        response: expect.objectContaining({ code: SUPERVISION_AREA_LIMIT }),
      });
      tx.supervisionArea.count.mockResolvedValue(0);
      tx.site.findFirst.mockResolvedValue(null);
      await expect(service.createArea({ name: 'X', siteId: SITE }, testUser())).rejects.toMatchObject({
        response: expect.objectContaining({ code: SUPERVISION_SITE_NOT_FOUND }),
      });
      expect(tx.site.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { id: SITE, schoolId: SCHOOL_ID } }));
      tx.site.findFirst.mockResolvedValue({ id: SITE });
      tx.supervisionArea.create.mockRejectedValue(prismaError('P2002'));
      await expect(service.createArea({ name: 'X', siteId: SITE }, testUser())).rejects.toMatchObject({
        response: expect.objectContaining({ code: SUPERVISION_AREA_NAME_TAKEN }),
      });
    });

    it('updates with the span as it will end up, and says when the area is gone', async () => {
      tx.supervisionArea.findFirst.mockResolvedValue(storedArea({ minGradeLevel: 0, maxGradeLevel: 3 }));
      tx.supervisionArea.update.mockImplementation(({ data }: { data: Record<string, unknown> }) =>
        Promise.resolve(storedArea({ ...data, _count: { shifts: 2 } })),
      );
      await expect(service.updateArea(GARDEN, { minGradeLevel: 5 }, testUser())).rejects.toThrow(/årskurs 5 ligger efter/);
      const updated = await service.updateArea(GARDEN, { maxGradeLevel: 6, guardsNeeded: 2, siteId: null }, testUser());
      expect(tx.supervisionArea.update).toHaveBeenLastCalledWith(
        expect.objectContaining({ data: { siteId: null, minGradeLevel: 0, maxGradeLevel: 6, guardsNeeded: 2 } }),
      );
      expect(updated).toMatchObject({ minGradeLevel: 0, maxGradeLevel: 6, guardsNeeded: 2, shiftCount: 2 });
      tx.supervisionArea.findFirst.mockResolvedValue(null);
      await expect(service.updateArea(GARDEN, { name: 'X' }, testUser())).rejects.toMatchObject({
        response: expect.objectContaining({ code: SUPERVISION_AREA_NOT_FOUND }),
      });
    });

    it('removes an area of the school, and 404s one that is not', async () => {
      tx.supervisionArea.deleteMany.mockResolvedValue({ count: 1 });
      await service.removeArea(GARDEN, testUser());
      expect(tx.supervisionArea.deleteMany).toHaveBeenCalledWith({ where: { id: GARDEN, schoolId: SCHOOL_ID } });
      tx.supervisionArea.deleteMany.mockResolvedValue({ count: 0 });
      await expect(service.removeArea(GARDEN, testUser())).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('passes', () => {
    beforeEach(() => {
      tx.supervisionArea.findUnique.mockResolvedValue({ id: GARDEN });
      tx.supervisionShift.count.mockResolvedValue(0);
      tx.supervisionShift.findFirst.mockResolvedValue(null);
      tx.supervisionShift.create.mockImplementation(({ data }: { data: Record<string, unknown> }) =>
        Promise.resolve(storedShift({ ...data })),
      );
    });

    it('writes a pass of a teacher, in whole minutes, inside its year, and hands it back in clocks', async () => {
      givenStaffAndYear();
      const created = await service.createShift({ ...PASS, validFrom: '2027-01-07', note: '  Norra delen ' }, testUser());
      expect(tx.supervisionShift.create).toHaveBeenCalledWith({
        data: {
          schoolId: SCHOOL_ID,
          areaId: GARDEN,
          note: 'Norra delen',
          academicYearId: YEAR_ID,
          userId: ANNA,
          dayOfWeek: 1,
          startTime: time('10:00'),
          endTime: time('10:20'),
          validFrom: day('2027-01-07'),
          validTo: null,
        },
      });
      expect(created).toEqual(
        expect.objectContaining({ startTime: '10:00', endTime: '10:20', validFrom: '2027-01-07', validTo: null, note: 'Norra delen' }),
      );
      // The schedule's lock first, then the teacher's row and the year.
      const lock = tx.$executeRaw.mock.calls[0]![0] as { values: unknown[] };
      expect(lock.values).toEqual([`SupervisionShifts:${YEAR_ID}`]);
    });

    it('refuses seconds, an end not after the start and Till before Från before it opens a transaction', async () => {
      await expect(service.createShift({ ...PASS, startTime: '10:00:30' }, testUser())).rejects.toThrow(/hela minuter/);
      await expect(service.createShift({ ...PASS, endTime: '10:00' }, testUser())).rejects.toThrow(/innan eller när/);
      await expect(
        service.createShift({ ...PASS, validFrom: '2027-01-07', validTo: '2027-01-06' }, testUser()),
      ).rejects.toThrow(/ligger före Från/);
      expect(prisma.withRls).not.toHaveBeenCalled();
    });

    it('measures the dates against the year, and says when the year or the area is not there', async () => {
      givenStaffAndYear();
      await expect(service.createShift({ ...PASS, validTo: '2027-06-30' }, testUser())).rejects.toThrow(/utanför läsåret/);
      givenStaffAndYear('TEACHER', null);
      await expect(service.createShift(PASS, testUser())).rejects.toMatchObject({
        response: expect.objectContaining({ code: SUPERVISION_YEAR_NOT_FOUND }),
      });
      givenStaffAndYear();
      tx.supervisionArea.findUnique.mockResolvedValue(null);
      await expect(service.createShift(PASS, testUser())).rejects.toMatchObject({
        response: expect.objectContaining({ code: 'SUPERVISION_AREA_NOT_FOUND' }),
      });
    });

    it('gives a pass only to staff', async () => {
      givenStaffAndYear('STUDENT');
      await expect(service.createShift(PASS, testUser())).rejects.toThrow(/Ett rastvaktspass hör till en lärare/);
    });

    it('names the other pass a teacher already has at a minute of this one, on dates both run', async () => {
      givenStaffAndYear();
      tx.supervisionShift.findFirst.mockResolvedValue(
        storedShift({ id: 'other', areaId: HALL, startTime: time('10:15'), endTime: time('10:45'), area: { name: 'Matsalen' } }),
      );
      const refused = service.createShift({ ...PASS, validFrom: '2027-01-07' }, testUser());
      await expect(refused).rejects.toBeInstanceOf(ConflictException);
      await expect(refused).rejects.toMatchObject({
        response: {
          code: SUPERVISION_SHIFT_CLASH,
          message: 'Läraren har redan rastvakt i Matsalen måndag 10:15–10:45. En rastvakt är på ett ställe i taget.',
        },
      });
      expect(tx.supervisionShift.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            academicYearId: YEAR_ID,
            userId: ANNA,
            dayOfWeek: 1,
            startTime: { lt: time('10:20') },
            endTime: { gt: time('10:00') },
            // Only Från is stated: the other pass must not have ended before it.
            AND: [{ OR: [{ validTo: null }, { validTo: { gte: day('2027-01-07') } }] }],
          },
        }),
      );
    });

    it('answers the EXCLUDE constraint a racing save meets as the same clash, and the year’s limit', async () => {
      givenStaffAndYear();
      tx.supervisionShift.create.mockRejectedValue(
        prismaError('P2010', { driverAdapterError: { cause: { originalCode: '23P01', originalMessage: 'conflicting key value' } } }),
      );
      await expect(service.createShift(PASS, testUser())).rejects.toMatchObject({
        response: expect.objectContaining({ code: SUPERVISION_SHIFT_CLASH }),
      });
      givenStaffAndYear();
      tx.supervisionShift.count.mockResolvedValue(MAX_SHIFTS_PER_YEAR);
      await expect(service.createShift(PASS, testUser())).rejects.toMatchObject({
        response: expect.objectContaining({ code: SUPERVISION_SHIFT_LIMIT }),
      });
    });

    it('updates a pass as it will end up, judging the clash without itself and the year only when a date moves', async () => {
      tx.supervisionShift.findUnique.mockResolvedValue(storedShift());
      tx.$queryRaw.mockResolvedValueOnce([{ role: 'TEACHER' }]);
      tx.supervisionShift.update.mockImplementation(({ data }: { data: Record<string, unknown> }) =>
        Promise.resolve(storedShift({ ...data })),
      );
      const moved = await service.updateShift(SHIFT, { endTime: '10:30', userId: BO }, testUser());
      expect(moved).toMatchObject({ startTime: '10:00', endTime: '10:30', userId: BO });
      expect(tx.supervisionShift.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({ where: expect.objectContaining({ id: { not: SHIFT }, userId: BO }) }),
      );
      // One $queryRaw: the teacher's row. No date moved, so no year read.
      expect(tx.$queryRaw).toHaveBeenCalledTimes(1);

      tx.$queryRaw.mockResolvedValueOnce([{ role: 'TEACHER' }]).mockResolvedValueOnce([YEAR]);
      await expect(service.updateShift(SHIFT, { validFrom: '2026-08-01' }, testUser())).rejects.toThrow(/utanför läsåret/);
      await expect(service.updateShift(SHIFT, { startTime: '10:20' }, testUser())).rejects.toThrow(/innan eller när/);

      tx.supervisionShift.findUnique.mockResolvedValue(null);
      await expect(service.updateShift(SHIFT, { endTime: '10:30' }, testUser())).rejects.toMatchObject({
        response: expect.objectContaining({ code: SUPERVISION_SHIFT_NOT_FOUND }),
      });
    });

    it('removes a pass, and 404s one RLS does not reach', async () => {
      tx.supervisionShift.deleteMany.mockResolvedValue({ count: 1 });
      await service.removeShift(SHIFT, testUser());
      tx.supervisionShift.deleteMany.mockResolvedValue({ count: 0 });
      await expect(service.removeShift(SHIFT, testUser())).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('the schedule', () => {
    beforeEach(() => {
      tx.academicYear.findUnique.mockResolvedValue({ startDate: day('2026-09-07'), endDate: day('2026-10-04') });
      tx.supervisionArea.findMany.mockResolvedValue([
        storedArea({ _count: { shifts: 1 } }),
        storedArea({ id: HALL, name: 'Matsalen', duringRasts: false, duringLunch: true, guardsNeeded: 0, countsAsTeaching: true, _count: { shifts: 1 } }),
      ]);
      tx.supervisionShift.findMany.mockResolvedValue([
        storedShift(),
        storedShift({ id: 'hall', areaId: HALL, dayOfWeek: 3, startTime: time('11:00'), endTime: time('11:30') }),
      ]);
      tx.rast.findMany.mockResolvedValue([
        { name: 'Förmiddagsrast', minGradeLevel: 0, maxGradeLevel: 6, dayOfWeek: null, startTime: time('10:00'), endTime: time('10:20') },
      ]);
      tx.lunchSetting.findUnique.mockResolvedValue({ lunchEnabled: true, lunchStartTime: time('11:00'), lunchEndTime: time('12:00') });
      tx.lunchServing.findMany.mockResolvedValue([]);
      tx.schoolBreak.findMany.mockResolvedValue([]);
      tx.studentGroup.findMany.mockResolvedValue([{ gradeLevel: 1 }, { gradeLevel: 4 }]);
      tx.teacherDuty.findMany.mockResolvedValue([
        { userId: ANNA, kind: 'RASTVAKT', minutesPerWeek: 60, countsAsTeaching: false, validFrom: null, validTo: null },
        { userId: BO, kind: 'RASTVAKT', minutesPerWeek: 40, countsAsTeaching: false, validFrom: null, validTo: null },
      ]);
    });

    it('lays the passes over the breaks, names the unwatched ones and each teacher’s minutes beside the ram', async () => {
      const rota = await service.rota(YEAR_ID, testUser({ channel: 'WEB' }));
      expect(rota.year).toEqual({ startDate: '2026-09-07', endDate: '2026-10-04' });
      expect(rota.areas.map((row) => row.name)).toEqual(['Matsalen', 'Skolgården']);
      expect(rota.shifts.map((row) => [row.areaId, row.dayOfWeek, row.startTime])).toEqual([
        [GARDEN, 1, '10:00'],
        [HALL, 3, '11:00'],
      ]);
      // The yard Monday to Friday, the hall at lunch; the hall needs nobody.
      expect(rota.breaks.filter((row) => row.areaId === GARDEN && row.dayOfWeek === 1)).toEqual([
        expect.objectContaining({ startTime: '10:00', endTime: '10:20', names: ['Förmiddagsrast'], shiftIds: [SHIFT] }),
      ]);
      expect(rota.breaks.filter((row) => row.areaId === HALL)).toHaveLength(5);
      expect(rota.gaps.map((row) => [row.dayOfWeek, row.shortFrom, row.shortTo])).toEqual([
        [2, '10:00', '10:20'],
        [3, '10:00', '10:20'],
        [4, '10:00', '10:20'],
        [5, '10:00', '10:20'],
      ]);
      expect(rota.teachers).toEqual([
        expect.objectContaining({ userId: ANNA, shiftCount: 2, minutesPerWeek: 50, countedMinutesPerWeek: 30, ramMinutesPerWeek: 60, ramCountedMinutesPerWeek: 0 }),
        // A ram and no pass yet: still counted whole.
        expect.objectContaining({ userId: BO, shiftCount: 0, minutesPerWeek: 0, ramMinutesPerWeek: 40, ramCountedMinutesPerWeek: 40 }),
      ]);
      expect(tx.teacherDuty.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { academicYearId: YEAR_ID, kind: 'RASTVAKT' } }),
      );
      // Whose rastvakt and ram it handed out: EMPLOYMENT, in its one transaction.
      expect(recordedReads(tx)).toEqual([{ kind: 'EMPLOYMENT', channel: 'WEB', ids: [ANNA, BO] }]);
      expect(prisma.withRls).toHaveBeenCalledTimes(1);
    });

    it('asks no sitting of a school whose lunch is off, and 404s a year RLS hides', async () => {
      tx.lunchSetting.findUnique.mockResolvedValue({ lunchEnabled: false, lunchStartTime: time('11:00'), lunchEndTime: time('12:00') });
      const rota = await service.rota(YEAR_ID, testUser());
      expect(tx.lunchServing.findMany).not.toHaveBeenCalled();
      expect(rota.breaks.filter((row) => row.areaId === HALL)).toEqual([]);
      tx.academicYear.findUnique.mockResolvedValue(null);
      await expect(service.rota(YEAR_ID, testUser())).rejects.toMatchObject({
        response: expect.objectContaining({ code: SUPERVISION_YEAR_NOT_FOUND }),
      });
    });
  });
});
