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
  SUPERVISION_TEACHER_INACTIVE,
  SUPERVISION_YEAR_NOT_FOUND,
  SupervisionService,
} from './supervision.service';

/**
 * Rastvaktsschema (20261207090000): what the service adds to what the
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
/** One row of the rota's statement: an area, and one of its passes this year or none. */
const rotaRow = (
  area: ReturnType<typeof storedArea>,
  shiftCount: number,
  shift: ReturnType<typeof storedShift> | null,
  inactiveFrom: Date | null = null,
) => ({
  areaId: area.id,
  name: area.name,
  siteId: area.siteId,
  minGradeLevel: area.minGradeLevel,
  maxGradeLevel: area.maxGradeLevel,
  duringRasts: area.duringRasts,
  duringLunch: area.duringLunch,
  guardsNeeded: area.guardsNeeded,
  countsAsTeaching: area.countsAsTeaching,
  shiftCount,
  shiftId: shift?.id ?? null,
  userId: shift?.userId ?? null,
  dayOfWeek: shift?.dayOfWeek ?? null,
  startTime: shift?.startTime ?? null,
  endTime: shift?.endTime ?? null,
  validFrom: shift?.validFrom ?? null,
  validTo: shift?.validTo ?? null,
  note: shift?.note ?? null,
  inactiveFrom,
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
      // Från Thursday 7 January: the Monday pass runs first on the 11th, and is stored so.
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
          validFrom: day('2027-01-11'),
          validTo: null,
        },
      });
      expect(created).toEqual(
        expect.objectContaining({
          startTime: '10:00',
          endTime: '10:20',
          validFrom: '2027-01-11',
          validTo: null,
          note: 'Norra delen',
          inactiveFrom: null,
          lessonClashes: [],
        }),
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

    it('keeps a pass inside one day, and refuses dates its weekday never falls between', async () => {
      for (const window of [{ startTime: '23:00', endTime: '24:30' }, { startTime: '10:00', endTime: '10:60' }, { startTime: '25:00', endTime: '26:00' }]) {
        await expect(service.createShift({ ...PASS, ...window }, testUser())).rejects.toThrow(/mellan 00:00 och 23:59/);
      }
      // A Monday pass dated Tuesday 2027-01-05 to Friday 2027-01-08.
      givenStaffAndYear();
      await expect(
        service.createShift({ ...PASS, validFrom: '2027-01-05', validTo: '2027-01-08' }, testUser()),
      ).rejects.toThrow(/ingen måndag ligger mellan 2027-01-05 och 2027-01-08/);
      // An empty Till is the year's last day: a Monday pass from Tuesday 8
      // June, in a year that ends Friday 11 June, never runs either.
      givenStaffAndYear();
      await expect(service.createShift({ ...PASS, validFrom: '2027-06-08' }, testUser())).rejects.toThrow(
        /ingen måndag ligger mellan 2027-06-08 och 2027-06-11/,
      );
      expect(tx.supervisionShift.create).not.toHaveBeenCalled();
      // The same dates on a Wednesday are a pass, of that one Wednesday.
      givenStaffAndYear();
      await expect(
        service.createShift({ ...PASS, dayOfWeek: 3, validFrom: '2027-01-05', validTo: '2027-01-08' }, testUser()),
      ).resolves.toMatchObject({ dayOfWeek: 3, validFrom: '2027-01-06', validTo: '2027-01-06' });
    });

    it('charges a pass for the days it runs: a Monday pass from Tuesday 1 September to Monday 7 September is the 7th', async () => {
      givenStaffAndYear();
      await service.createShift({ ...PASS, validFrom: '2026-09-01', validTo: '2026-09-07' }, testUser());
      expect(tx.supervisionShift.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ validFrom: day('2026-09-07'), validTo: day('2026-09-07') }),
      });
    });

    it('meets no clash between two Monday passes that never share a Monday', async () => {
      // A: Mondays until Wednesday 6 January, stored until Monday the 4th.
      givenStaffAndYear();
      await service.createShift({ ...PASS, validTo: '2027-01-06' }, testUser());
      expect(tx.supervisionShift.create).toHaveBeenLastCalledWith({
        data: expect.objectContaining({ validFrom: null, validTo: day('2027-01-04') }),
      });
      // B: Mondays from Tuesday 5 January, asked about (and stored) from Monday the 11th,
      // so A, ended on the 4th, is no clash — the EXCLUDE reads the same stored dates.
      givenStaffAndYear();
      await service.createShift({ ...PASS, validFrom: '2027-01-05' }, testUser());
      expect(tx.supervisionShift.findFirst).toHaveBeenLastCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ AND: [{ OR: [{ validTo: null }, { validTo: { gte: day('2027-01-11') } }] }] }),
        }),
      );
      expect(tx.supervisionShift.create).toHaveBeenLastCalledWith({
        data: expect.objectContaining({ validFrom: day('2027-01-11'), validTo: null }),
      });
    });

    it('gives no new pass to a deactivated teacher, nor hands one on to them, and lets their own pass be ended', async () => {
      tx.user.findUnique.mockResolvedValue({ isActive: false });
      // Refused at the teacher's row, before the year is read.
      tx.$queryRaw.mockResolvedValueOnce([{ role: 'TEACHER' }]);
      await expect(service.createShift(PASS, testUser())).rejects.toMatchObject({
        response: expect.objectContaining({ code: SUPERVISION_TEACHER_INACTIVE }),
      });
      expect(tx.supervisionShift.create).not.toHaveBeenCalled();

      tx.supervisionShift.findUnique.mockResolvedValue(storedShift());
      tx.supervisionShift.update.mockImplementation(({ data }: { data: Record<string, unknown> }) =>
        Promise.resolve(storedShift({ ...data })),
      );
      tx.$queryRaw.mockResolvedValueOnce([{ role: 'TEACHER' }]);
      await expect(service.updateShift(SHIFT, { userId: BO }, testUser())).rejects.toMatchObject({
        response: expect.objectContaining({ code: SUPERVISION_TEACHER_INACTIVE }),
      });
      // Anna, deactivated on 18 January: her own pass is given a Till.
      tx.$queryRaw
        .mockResolvedValueOnce([{ role: 'TEACHER' }])
        .mockResolvedValueOnce([YEAR])
        .mockResolvedValueOnce([{ inactiveFrom: day('2027-01-18') }]);
      const ended = await service.updateShift(SHIFT, { validTo: '2027-01-17' }, testUser());
      expect(ended).toMatchObject({ validTo: '2027-01-11', inactiveFrom: '2027-01-18' });
      expect(tx.user.findUnique).toHaveBeenCalledTimes(2);
    });

    it('saves a pass during the teacher’s own lesson, and names the lesson', async () => {
      givenStaffAndYear();
      tx.masterLesson.findMany.mockResolvedValue([
        {
          teacherId: ANNA,
          coTeacherId: null,
          dayOfWeek: 1,
          startTime: time('10:00'),
          endTime: time('11:00'),
          startDate: null,
          endDate: null,
          subject: { name: 'Matematik' },
          studentGroup: { name: '8A' },
        },
        // Bo's, and Anna co-teaches it: also hers.
        {
          teacherId: BO,
          coTeacherId: ANNA,
          dayOfWeek: 1,
          startTime: time('09:00'),
          endTime: time('10:05'),
          startDate: null,
          endDate: null,
          subject: { name: 'Svenska' },
          studentGroup: { name: '7B' },
        },
      ]);
      const created = await service.createShift(PASS, testUser());
      expect(tx.supervisionShift.create).toHaveBeenCalled();
      expect(created.lessonClashes).toEqual([
        { subject: 'Svenska', group: '7B', dayOfWeek: 1, startTime: '09:00', endTime: '10:05' },
        { subject: 'Matematik', group: '8A', dayOfWeek: 1, startTime: '10:00', endTime: '11:00' },
      ]);
      expect(tx.masterLesson.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            academicYearId: YEAR_ID,
            isParked: false,
            dayOfWeek: { in: [1] },
            OR: [{ teacherId: { in: [ANNA] } }, { coTeacherId: { in: [ANNA] } }],
          },
        }),
      );
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
      const refused = service.createShift({ ...PASS, validFrom: '2027-01-11' }, testUser());
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
            AND: [{ OR: [{ validTo: null }, { validTo: { gte: day('2027-01-11') } }] }],
          },
        }),
      );
    });

    it('answers the EXCLUDE constraint a racing save meets as the same clash, and the year’s limit', async () => {
      givenStaffAndYear();
      tx.supervisionShift.create.mockRejectedValue(
        // adapter-pg hands an SQLSTATE Prisma has no code for over as P2039, the code in the cause.
        prismaError('P2039', { driverAdapterError: { cause: { originalCode: '23P01', originalMessage: 'conflicting key value' } } }),
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
      // The teacher's row, and their state for the answer. No date or day moved, so no year read.
      const statements = tx.$queryRaw.mock.calls.map((call) => (call[0] as readonly string[]).join('?'));
      expect(statements).toHaveLength(2);
      expect(statements.some((sql) => sql.includes('"AcademicYears"'))).toBe(false);

      tx.$queryRaw.mockResolvedValueOnce([{ role: 'TEACHER' }]).mockResolvedValueOnce([YEAR]);
      await expect(service.updateShift(SHIFT, { validFrom: '2026-08-01' }, testUser())).rejects.toThrow(/utanför läsåret/);
      await expect(service.updateShift(SHIFT, { startTime: '10:20' }, testUser())).rejects.toThrow(/innan eller när/);

      tx.supervisionShift.findUnique.mockResolvedValue(null);
      await expect(service.updateShift(SHIFT, { endTime: '10:30' }, testUser())).rejects.toMatchObject({
        response: expect.objectContaining({ code: SUPERVISION_SHIFT_NOT_FOUND }),
      });
    });

    it('moves the stored dates onto a new weekday', async () => {
      tx.supervisionShift.findUnique.mockResolvedValue(storedShift({ validFrom: day('2027-01-11'), validTo: day('2027-03-01') }));
      tx.supervisionShift.update.mockImplementation(({ data }: { data: Record<string, unknown> }) =>
        Promise.resolve(storedShift({ ...data })),
      );
      tx.$queryRaw.mockResolvedValueOnce([{ role: 'TEACHER' }]).mockResolvedValueOnce([YEAR]);
      // Monday 11 January to Monday 1 March, now on Wednesdays: the 13th to 3 March, the same weeks.
      const moved = await service.updateShift(SHIFT, { dayOfWeek: 3 }, testUser());
      expect(moved).toMatchObject({ dayOfWeek: 3, validFrom: '2027-01-13', validTo: '2027-03-03' });
      // And back: Wednesdays to Mondays lose no first week either.
      tx.supervisionShift.findUnique.mockResolvedValue(storedShift({ dayOfWeek: 3, validFrom: day('2027-01-13'), validTo: day('2027-01-13') }));
      tx.$queryRaw.mockResolvedValueOnce([{ role: 'TEACHER' }]).mockResolvedValueOnce([YEAR]);
      expect(await service.updateShift(SHIFT, { dayOfWeek: 1 }, testUser())).toMatchObject({ validFrom: '2027-01-11', validTo: '2027-01-11' });
      // A date the PATCH retypes is the admin's, moved onto the day as typed.
      tx.$queryRaw.mockResolvedValueOnce([{ role: 'TEACHER' }]).mockResolvedValueOnce([YEAR]);
      expect(await service.updateShift(SHIFT, { dayOfWeek: 1, validTo: '2027-02-05' }, testUser())).toMatchObject({
        validFrom: '2027-01-11',
        validTo: '2027-02-01',
      });
      // The first week: Friday 21 August moved to Monday is the 17th, the year's first day.
      tx.supervisionShift.findUnique.mockResolvedValue(storedShift({ dayOfWeek: 5, validFrom: day('2026-08-21'), validTo: null }));
      tx.$queryRaw.mockResolvedValueOnce([{ role: 'TEACHER' }]).mockResolvedValueOnce([YEAR]);
      expect(await service.updateShift(SHIFT, { dayOfWeek: 1 }, testUser())).toMatchObject({ validFrom: '2026-08-17' });
      // A year that starts on a Wednesday: Friday 21 August to Monday would be the 17th, before
      // it; the pass then runs from the first Monday inside the year, the 24th.
      tx.$queryRaw.mockResolvedValueOnce([{ role: 'TEACHER' }]).mockResolvedValueOnce([{ ...YEAR, startDate: day('2026-08-19') }]);
      expect(await service.updateShift(SHIFT, { dayOfWeek: 1 }, testUser())).toMatchObject({ validFrom: '2026-08-24' });
    });

    it('says a pass that never runs at the date the admin wrote: Från when Till is the year’s own', async () => {
      givenStaffAndYear();
      await expect(service.createShift({ ...PASS, validFrom: '2027-06-08' }, testUser())).rejects.toThrow(/^validFrom: ingen måndag/);
      givenStaffAndYear();
      await expect(service.createShift({ ...PASS, validFrom: '2027-01-05', validTo: '2027-01-08' }, testUser())).rejects.toThrow(
        /^validTo: ingen måndag/,
      );
    });

    it('removes a pass, and 404s one RLS does not reach', async () => {
      tx.supervisionShift.deleteMany.mockResolvedValue({ count: 1 });
      await service.removeShift(SHIFT, testUser());
      tx.supervisionShift.deleteMany.mockResolvedValue({ count: 0 });
      await expect(service.removeShift(SHIFT, testUser())).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('the schedule', () => {
    const HALL_AREA = storedArea({ id: HALL, name: 'Matsalen', duringRasts: false, duringLunch: true, guardsNeeded: 0, countsAsTeaching: true });
    /** The statement's rows: the yard with Anna's Monday, the hall with her Wednesday lunch. */
    const givenRota = (annaInactiveFrom: Date | null = null) => {
      tx.$queryRaw.mockResolvedValueOnce([
        rotaRow(storedArea(), 1, storedShift(), annaInactiveFrom),
        rotaRow(HALL_AREA, 1, storedShift({ id: 'hall', areaId: HALL, dayOfWeek: 3, startTime: time('11:00'), endTime: time('11:30') }), annaInactiveFrom),
      ]);
    };

    beforeEach(() => {
      tx.academicYear.findUnique.mockResolvedValue({ startDate: day('2026-09-07'), endDate: day('2026-10-04') });
      givenRota();
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
      // Areas, passes and whether each pass's teacher is active: one statement, one snapshot.
      const sql = (tx.$queryRaw.mock.calls[0]![0] as readonly string[]).join('?');
      expect(sql).toMatch(/FROM "SupervisionAreas" a[\s\S]*LEFT JOIN "SupervisionShifts" s[\s\S]*LEFT JOIN "Users" u/);
      expect(tx.supervisionArea.findMany).not.toHaveBeenCalled();
      expect(tx.supervisionShift.findMany).not.toHaveBeenCalled();
      expect(rota.areas.map((row) => [row.name, row.shiftCount])).toEqual([
        ['Matsalen', 1],
        ['Skolgården', 1],
      ]);
      expect(rota.shifts[0]).toMatchObject({ inactiveFrom: null, lessonClashes: [] });
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

    it('lets a deactivated teacher’s pass watch until the day before, and says from when', async () => {
      // Anna was deactivated on Monday 21 September.
      tx.$queryRaw.mockReset().mockResolvedValue([]);
      givenRota(day('2026-09-21'));
      const rota = await service.rota(YEAR_ID, testUser());
      // Her Monday on the yard is listed, and the Monday is short from the 21st, not all year.
      expect(rota.breaks.find((row) => row.areaId === GARDEN && row.dayOfWeek === 1)!.shiftIds).toEqual([SHIFT]);
      expect(rota.gaps.find((row) => row.dayOfWeek === 1)).toMatchObject({
        from: '2026-09-21',
        to: '2026-09-28',
        fromYearStart: false,
        toYearEnd: true,
      });
      expect(rota.shifts.find((row) => row.id === SHIFT)).toMatchObject({ inactiveFrom: '2026-09-21' });
      // Her minutes beside the ram are charged as the load charges them: two weeks of the four.
      expect(rota.teachers.find((row) => row.userId === ANNA)).toMatchObject({ shiftCount: 2, hoursPerYear: 1.7 });
    });

    it('names the teacher’s lessons each pass runs during', async () => {
      tx.masterLesson.findMany.mockResolvedValue([
        {
          teacherId: ANNA,
          coTeacherId: null,
          dayOfWeek: 1,
          startTime: time('10:00'),
          endTime: time('11:00'),
          startDate: null,
          endDate: null,
          subject: { name: 'Matematik' },
          studentGroup: { name: '8A' },
        },
      ]);
      const rota = await service.rota(YEAR_ID, testUser());
      expect(rota.shifts.map((row) => row.lessonClashes)).toEqual([
        [{ subject: 'Matematik', group: '8A', dayOfWeek: 1, startTime: '10:00', endTime: '11:00' }],
        [],
      ]);
    });

    it('reads a tioårig läsår’s classes and lov in NIOARIG, as the school-wide spans are stated', async () => {
      // Lågstadiegården watches 0–3. In 2028/29 (TIOARIG) the old åk 3 is åk 4.
      tx.academicYear.findUnique.mockResolvedValue({ startDate: day('2028-08-21'), endDate: day('2029-06-15'), gradeNumbering: 'TIOARIG' });
      const lower = storedArea({ minGradeLevel: 0, maxGradeLevel: 3 });
      tx.$queryRaw.mockReset().mockResolvedValue([rotaRow(lower, 0, null)]);
      tx.rast.findMany.mockResolvedValue([
        { name: 'Lågstadiets rast', minGradeLevel: 0, maxGradeLevel: 3, dayOfWeek: null, startTime: time('10:00'), endTime: time('10:20') },
        { name: 'Mellanstadiets rast', minGradeLevel: 4, maxGradeLevel: 6, dayOfWeek: null, startTime: time('10:30'), endTime: time('10:50') },
      ]);
      tx.studentGroup.findMany.mockResolvedValue([{ gradeLevel: 4 }]);
      const rota = await service.rota(YEAR_ID, testUser());
      expect(rota.breaks.filter((row) => row.dayOfWeek === 1).map((row) => row.names)).toEqual([['Lågstadiets rast']]);
      // A lov for the year's åk 1–4, all year: every årskurs of the yard, read in NIOARIG (0–3).
      tx.schoolBreak.findMany.mockResolvedValue([
        { startDate: day('2028-08-21'), endDate: day('2029-06-15'), minGradeLevel: 1, maxGradeLevel: 4 },
      ]);
      expect((await service.rota(YEAR_ID, testUser())).gaps).toEqual([]);
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
