import { ForbiddenException } from '@nestjs/common';
import { createPrismaMock, createTxMock, testUser, type TxMock } from '../../test/utils/prisma-mock';
import type { PrismaService } from '../database/prisma.service';
import { byShare, monthOf, ReportingRateService, type ReportingRateTeacherView } from './reporting-rate.service';

const admin = testUser({ schoolId: 'school-1' });
const teacher = testUser({ role: 'TEACHER' as never, userId: 'teacher-1', schoolId: 'school-1' });

type Statement = { strings: string[]; values: unknown[] };
const sql = (statement: unknown) => (statement as Statement).strings.join('?');

interface Stand {
  /** What app.school_today() answers; none = the stand-in answers nothing. */
  today?: string | null;
  open?: Array<Record<string, unknown>>;
}

function setup(stand: Stand = {}) {
  const tx = createTxMock();
  const prisma = createPrismaMock(tx);
  const statements: string[] = [];
  tx.$queryRaw = jest.fn(async (statement: unknown) => {
    const text = sql(statement);
    statements.push(text);
    if (text.includes('app.school_today()')) return stand.today === null ? [] : [{ today: stand.today ?? '2026-10-21' }];
    if (text.includes('app.reporting_open_lessons(')) return stand.open ?? [];
    return [];
  });
  // An empty table, as a fresh database gives: no days, and no last day.
  tx['teacherReportingDay']!['groupBy']!.mockResolvedValue([]);
  tx['teacherReportingDay']!['aggregate']!.mockResolvedValue({ _max: { day: null }, _sum: { held: null, reported: null } });
  const service = new ReportingRateService(prisma as unknown as PrismaService);
  return { tx, prisma, service, statements };
}

const day = (value: string) => new Date(`${value}T00:00:00.000Z`);
const grouped = (teacherId: string, held: number | null, reported: number | null) => ({ teacherId, _sum: { held, reported } });
const person = (id: string, firstName: string, lastName: string) => ({ id, firstName, lastName });
const model = (tx: TxMock, name: string, method: string) => tx[name]![method]!;
const reads = (tx: TxMock) =>
  tx.$executeRaw.mock.calls.map(([statement]) => ({
    sql: sql(statement),
    values: (statement as Statement).values,
  }));

describe('monthOf', () => {
  it.each([
    ['a month of 31 days', '2026-10-21', '2026-10-01', '2026-10-31'],
    ['a month of 30 days', '2026-09-30', '2026-09-01', '2026-09-30'],
    ['february', '2027-02-14', '2027-02-01', '2027-02-28'],
    ['february in a leap year', '2028-02-29', '2028-02-01', '2028-02-29'],
    ['the first of a month', '2026-11-01', '2026-11-01', '2026-11-30'],
    ['december, ending the year', '2026-12-31', '2026-12-01', '2026-12-31'],
    ['january, starting it', '2027-01-01', '2027-01-01', '2027-01-31'],
  ])('%s', (_label, anchor, from, to) => {
    expect(monthOf(anchor)).toEqual({ from, to });
  });
});

describe('byShare', () => {
  const t = (teacherId: string, held: number, reported: number, firstName = 'A', lastName = 'B'): ReportingRateTeacherView => ({
    teacherId,
    firstName,
    lastName,
    held,
    reported,
  });

  it('puts the lowest share first, compared without rounding', () => {
    // 1/3 < 2/5 < 1/2 < 4/5 < 1; a division rounded to a whole percent would tie 1/3 and 33/100.
    const rows = [t('a', 5, 4), t('b', 2, 1), t('c', 3, 1), t('d', 5, 2), t('e', 4, 4), t('f', 100, 33)];
    expect(rows.sort(byShare).map((row) => row.teacherId)).toEqual(['f', 'c', 'd', 'b', 'a', 'e']);
  });

  it('takes the same share by last name, then first name, then id, in Swedish order', () => {
    const rows = [
      t('4', 10, 5, 'Åsa', 'Lind'),
      t('3', 4, 2, 'Anna', 'Öberg'),
      t('2', 10, 5, 'Britt', 'Lind'),
      t('1', 2, 1, 'Anna', 'Lind'),
      t('0', 6, 3, 'Anna', 'Lind'),
      t('9', 6, 3, 'Anna', 'Ek'),
    ];
    // Ek, Lind (Anna x2 by id, Britt, Åsa), Öberg: Å and Ö come after Z in Swedish.
    expect(rows.sort(byShare).map((row) => row.teacherId)).toEqual(['9', '0', '1', '2', '4', '3']);
  });
});

describe('ReportingRateService', () => {
  describe('overview', () => {
    it('is the school’s week on the school’s today without a period or an anchor', async () => {
      const { tx, service, statements } = setup({ today: '2026-10-21' });
      const view = await service.overview({}, admin);
      expect(statements.filter((text) => text.includes('app.school_today()'))).toHaveLength(1);
      expect(view).toMatchObject({
        period: 'WEEK',
        anchor: '2026-10-21',
        from: '2026-10-19',
        to: '2026-10-25',
        yearName: null,
        previousAnchor: '2026-10-18',
        nextAnchor: '2026-10-26',
        through: null,
        total: { held: 0, reported: 0 },
        teachers: [],
      });
      expect(model(tx, 'teacherReportingDay', 'groupBy')).toHaveBeenCalledWith({
        by: ['teacherId'],
        where: { schoolId: 'school-1', day: { gte: day('2026-10-19'), lte: day('2026-10-25') } },
        _sum: { held: true, reported: true },
      });
    });

    it('does not ask for the school’s today when it is told an anchor', async () => {
      const { service, statements } = setup();
      const view = await service.overview({ period: 'WEEK', anchor: '2026-03-04' }, admin);
      expect(statements).toEqual([]);
      expect(view.anchor).toBe('2026-03-04');
    });

    it('falls back on the instant when the database says nothing of its today', async () => {
      const { service } = setup({ today: null });
      const view = await service.overview({}, admin, new Date('2026-05-06T10:00:00Z'));
      expect(view.anchor).toBe('2026-05-06');
      expect(view.from).toBe('2026-05-04');
    });

    it.each([
      ['a Monday', '2026-11-02', '2026-11-02', '2026-11-08'],
      ['a Sunday', '2026-11-08', '2026-11-02', '2026-11-08'],
      ['a week across the turn of a month', '2026-09-30', '2026-09-28', '2026-10-04'],
      ['a week across the turn of a year, in december', '2026-12-31', '2026-12-28', '2027-01-03'],
      ['a week across the turn of a year, in january', '2027-01-01', '2026-12-28', '2027-01-03'],
      ['a week across a leap day', '2028-03-01', '2028-02-28', '2028-03-05'],
      ['the week of the spring clock change', '2026-03-29', '2026-03-23', '2026-03-29'],
    ])('reads the ISO week of %s from Monday to Sunday', async (_label, anchor, from, to) => {
      const { tx, service } = setup();
      const view = await service.overview({ period: 'WEEK', anchor }, admin);
      expect(view).toMatchObject({ from, to });
      expect(model(tx, 'teacherReportingDay', 'groupBy')).toHaveBeenLastCalledWith(
        expect.objectContaining({ where: { schoolId: 'school-1', day: { gte: day(from), lte: day(to) } } }),
      );
    });

    it.each([
      ['a month of 31 days', '2026-10-21', '2026-10-01', '2026-10-31'],
      ['february', '2027-02-15', '2027-02-01', '2027-02-28'],
      ['february in a leap year', '2028-02-10', '2028-02-01', '2028-02-29'],
      ['december', '2026-12-31', '2026-12-01', '2026-12-31'],
    ])('reads the calendar month of %s', async (_label, anchor, from, to) => {
      const { tx, service } = setup();
      const view = await service.overview({ period: 'MONTH', anchor }, admin);
      expect(view).toMatchObject({ period: 'MONTH', from, to, yearName: null });
      expect(model(tx, 'teacherReportingDay', 'groupBy')).toHaveBeenLastCalledWith(
        expect.objectContaining({ where: { schoolId: 'school-1', day: { gte: day(from), lte: day(to) } } }),
      );
    });

    it('steps from the first day of a period to the day before it and from the last to the day after, across the turn of a year', async () => {
      const { service } = setup();
      const month = await service.overview({ period: 'MONTH', anchor: '2027-01-15' }, admin);
      expect(month).toMatchObject({ previousAnchor: '2026-12-31', nextAnchor: '2027-02-01' });
      const week = await service.overview({ period: 'WEEK', anchor: '2027-01-01' }, admin);
      expect(week).toMatchObject({ previousAnchor: '2026-12-27', nextAnchor: '2027-01-04' });
    });

    it('reads the läsår holding the anchor, the active one before an inactive one, and names it', async () => {
      const { tx, service } = setup();
      model(tx, 'academicYear', 'findFirst').mockResolvedValue({
        name: '2026/2027',
        startDate: day('2026-08-17'),
        endDate: day('2027-06-11'),
      });
      const view = await service.overview({ period: 'YEAR', anchor: '2026-10-21' }, admin);
      expect(view).toMatchObject({
        period: 'YEAR',
        from: '2026-08-17',
        to: '2027-06-11',
        yearName: '2026/2027',
        previousAnchor: '2026-08-16',
        nextAnchor: '2027-06-12',
      });
      expect(model(tx, 'academicYear', 'findFirst')).toHaveBeenCalledWith({
        where: { startDate: { lte: day('2026-10-21') }, endDate: { gte: day('2026-10-21') } },
        orderBy: [{ isActive: 'desc' }, { startDate: 'desc' }, { id: 'asc' }],
        select: { name: true, startDate: true, endDate: true },
      });
      expect(model(tx, 'teacherReportingDay', 'groupBy')).toHaveBeenCalledWith(
        expect.objectContaining({ where: { schoolId: 'school-1', day: { gte: day('2026-08-17'), lte: day('2027-06-11') } } }),
      );
    });

    it('has no period, no figures and no neighbours for a day the school has no läsår for', async () => {
      const { tx, service } = setup();
      model(tx, 'academicYear', 'findFirst').mockResolvedValue(null);
      model(tx, 'teacherReportingDay', 'aggregate').mockResolvedValue({ _max: { day: day('2026-10-20') } });
      const view = await service.overview({ period: 'YEAR', anchor: '2031-01-01' }, admin);
      expect(view).toEqual({
        period: 'YEAR',
        anchor: '2031-01-01',
        from: null,
        to: null,
        yearName: null,
        previousAnchor: null,
        nextAnchor: null,
        through: '2026-10-20',
        total: { held: 0, reported: 0 },
        teachers: [],
      });
      expect(model(tx, 'teacherReportingDay', 'groupBy')).not.toHaveBeenCalled();
      expect(tx.$executeRaw).not.toHaveBeenCalled();
    });

    it('adds the days up in the database: one row per teacher, never the days', async () => {
      const { tx, service } = setup();
      model(tx, 'teacherReportingDay', 'groupBy').mockResolvedValue([grouped('t1', 40, 38)]);
      model(tx, 'user', 'findMany').mockResolvedValue([person('t1', 'Anna', 'Ek')]);
      await service.overview({ period: 'MONTH', anchor: '2026-10-21' }, admin);
      expect(model(tx, 'teacherReportingDay', 'findMany')).not.toHaveBeenCalled();
      expect(model(tx, 'teacherReportingDay', 'groupBy')).toHaveBeenCalledTimes(1);
    });

    it('sums the school, lists the teachers with the lowest share first, and names them', async () => {
      const { tx, service } = setup();
      model(tx, 'teacherReportingDay', 'groupBy').mockResolvedValue([
        grouped('t1', 40, 38),
        grouped('t2', 30, 12),
        grouped('t3', 10, 10),
        grouped('t4', 30, 12),
      ]);
      model(tx, 'user', 'findMany').mockResolvedValue([
        person('t1', 'Anna', 'Ek'),
        person('t2', 'Britt', 'Lind'),
        person('t3', 'Carl', 'Berg'),
        person('t4', 'Anna', 'Lind'),
      ]);
      model(tx, 'teacherReportingDay', 'aggregate').mockResolvedValue({ _max: { day: day('2026-10-20') } });
      const view = await service.overview({ period: 'MONTH', anchor: '2026-10-21' }, admin);
      expect(view.total).toEqual({ held: 110, reported: 72 });
      expect(view.through).toBe('2026-10-20');
      expect(view.teachers).toEqual([
        { teacherId: 't4', firstName: 'Anna', lastName: 'Lind', held: 30, reported: 12 },
        { teacherId: 't2', firstName: 'Britt', lastName: 'Lind', held: 30, reported: 12 },
        { teacherId: 't1', firstName: 'Anna', lastName: 'Ek', held: 40, reported: 38 },
        { teacherId: 't3', firstName: 'Carl', lastName: 'Berg', held: 10, reported: 10 },
      ]);
      expect(model(tx, 'user', 'findMany')).toHaveBeenCalledWith({
        where: { id: { in: ['t1', 't2', 't3', 't4'] } },
        select: { id: true, firstName: true, lastName: true },
      });
    });

    it('lists only teachers with a held lesson, and reads a sum that is null as nothing', async () => {
      const { tx, service } = setup();
      model(tx, 'teacherReportingDay', 'groupBy').mockResolvedValue([grouped('t1', 0, 0), grouped('t2', null, null), grouped('t3', 4, null)]);
      model(tx, 'user', 'findMany').mockResolvedValue([person('t3', 'Carl', 'Berg')]);
      const view = await service.overview({ period: 'WEEK', anchor: '2026-10-21' }, admin);
      expect(view.teachers).toEqual([{ teacherId: 't3', firstName: 'Carl', lastName: 'Berg', held: 4, reported: 0 }]);
      expect(view.total).toEqual({ held: 4, reported: 0 });
      expect(model(tx, 'user', 'findMany')).toHaveBeenCalledWith(expect.objectContaining({ where: { id: { in: ['t3'] } } }));
    });

    it('keeps a teacher whose row it cannot read in the figures, without a name', async () => {
      const { tx, service } = setup();
      model(tx, 'teacherReportingDay', 'groupBy').mockResolvedValue([grouped('t1', 10, 5)]);
      model(tx, 'user', 'findMany').mockResolvedValue([]);
      const view = await service.overview({ period: 'WEEK', anchor: '2026-10-21' }, admin);
      expect(view.teachers).toEqual([{ teacherId: 't1', firstName: '', lastName: '', held: 10, reported: 5 }]);
      expect(view.total).toEqual({ held: 10, reported: 5 });
    });

    it('reads no person when the school has no teacher with a held lesson in the period', async () => {
      const { tx, service } = setup();
      model(tx, 'teacherReportingDay', 'groupBy').mockResolvedValue([]);
      await expect(service.overview({ period: 'WEEK', anchor: '2026-10-21' }, admin)).resolves.toMatchObject({ teachers: [], total: { held: 0, reported: 0 } });
      expect(model(tx, 'user', 'findMany')).not.toHaveBeenCalled();
    });

    it('records the read as employment and as people, about every teacher it hands out, for the channel of the reader', async () => {
      const { tx, service } = setup();
      model(tx, 'teacherReportingDay', 'groupBy').mockResolvedValue([grouped('t1', 10, 5), grouped('t2', 10, 9)]);
      model(tx, 'user', 'findMany').mockResolvedValue([person('t1', 'Anna', 'Ek'), person('t2', 'Britt', 'Lind')]);
      await service.overview({ period: 'WEEK', anchor: '2026-10-21' }, { ...admin, channel: 'WEB' });
      const rows = reads(tx);
      expect(rows).toHaveLength(2);
      expect(rows.every((row) => row.sql.includes('app.personal_data_read'))).toBe(true);
      expect(rows.map((row) => row.values[0])).toEqual(['EMPLOYMENT', 'PEOPLE']);
      expect(rows.map((row) => row.values[1])).toEqual(['WEB', 'WEB']);
      expect(rows.map((row) => row.values[2])).toEqual([['t1', 't2'], ['t1', 't2']]);
    });

    it('records nothing for a period nobody taught in, and nothing else', async () => {
      const { tx, service } = setup();
      await service.overview({ period: 'WEEK', anchor: '2026-10-21' }, admin);
      expect(tx.$executeRaw).not.toHaveBeenCalled();
    });

    it('is a school’s alone: a caller with no school is refused before anything is read', async () => {
      const { prisma, service } = setup();
      await expect(service.overview({}, testUser({ schoolId: undefined }))).rejects.toBeInstanceOf(ForbiddenException);
      expect(prisma.withRls).not.toHaveBeenCalled();
    });
  });

  describe('settings', () => {
    it('says both switches off and a limit of two days for a school with no row', async () => {
      const { tx, service } = setup();
      model(tx, 'reportingSetting', 'findUnique').mockResolvedValue(null);
      await expect(service.settings(admin)).resolves.toEqual({ teacherReminders: false, rektorDigest: false, openAfterDays: 2 });
      expect(model(tx, 'reportingSetting', 'findUnique')).toHaveBeenCalledWith({ where: { schoolId: 'school-1' } });
    });

    it('says what the school chose, and nothing of the dates the database stamps', async () => {
      const { tx, service } = setup();
      model(tx, 'reportingSetting', 'findUnique').mockResolvedValue({
        schoolId: 'school-1',
        teacherReminders: true,
        teacherRemindersOn: day('2026-10-01'),
        rektorDigest: false,
        rektorDigestOn: null,
        openAfterDays: 5,
        updatedAt: new Date(),
      });
      await expect(service.settings(admin)).resolves.toEqual({ teacherReminders: true, rektorDigest: false, openAfterDays: 5 });
    });
  });

  describe('updateSettings', () => {
    it('upserts only what the save names, for the school of the caller, and answers what is stored', async () => {
      const { tx, service } = setup();
      model(tx, 'reportingSetting', 'findUnique').mockResolvedValue({ teacherReminders: true, rektorDigest: false, openAfterDays: 7 });
      const view = await service.updateSettings({ teacherReminders: true, openAfterDays: 7 }, admin);
      expect(model(tx, 'reportingSetting', 'upsert')).toHaveBeenCalledWith({
        where: { schoolId: 'school-1' },
        create: { schoolId: 'school-1', teacherReminders: true, openAfterDays: 7 },
        update: { teacherReminders: true, openAfterDays: 7 },
      });
      expect(view).toEqual({ teacherReminders: true, rektorDigest: false, openAfterDays: 7 });
    });

    it('can turn a switch off, and takes a limit of 1 and of 30', async () => {
      const { tx, service } = setup();
      await service.updateSettings({ rektorDigest: false, teacherReminders: false }, admin);
      expect(model(tx, 'reportingSetting', 'upsert')).toHaveBeenLastCalledWith(
        expect.objectContaining({ update: { rektorDigest: false, teacherReminders: false } }),
      );
      await service.updateSettings({ openAfterDays: 1 }, admin);
      expect(model(tx, 'reportingSetting', 'upsert')).toHaveBeenLastCalledWith(expect.objectContaining({ update: { openAfterDays: 1 } }));
      await service.updateSettings({ openAfterDays: 30 }, admin);
      expect(model(tx, 'reportingSetting', 'upsert')).toHaveBeenLastCalledWith(expect.objectContaining({ update: { openAfterDays: 30 } }));
    });

    it('keeps a value the save does not name, or names as null', async () => {
      const { tx, service } = setup();
      await service.updateSettings({ rektorDigest: true, teacherReminders: null as never, openAfterDays: null as never }, admin);
      expect(model(tx, 'reportingSetting', 'upsert')).toHaveBeenCalledWith({
        where: { schoolId: 'school-1' },
        create: { schoolId: 'school-1', rektorDigest: true },
        update: { rektorDigest: true },
      });
    });

    it('writes nothing for a save that names nothing, and answers what is stored', async () => {
      const { tx, service } = setup();
      model(tx, 'reportingSetting', 'findUnique').mockResolvedValue({ teacherReminders: true, rektorDigest: false, openAfterDays: 4 });
      await expect(service.updateSettings({}, admin)).resolves.toEqual({ teacherReminders: true, rektorDigest: false, openAfterDays: 4 });
      await expect(service.updateSettings({ rektorDigest: null as never }, admin)).resolves.toEqual({
        teacherReminders: true,
        rektorDigest: false,
        openAfterDays: 4,
      });
      expect(model(tx, 'reportingSetting', 'upsert')).not.toHaveBeenCalled();
    });

    it('never takes the school from anywhere but the caller', async () => {
      const { tx, service } = setup();
      await service.updateSettings({ teacherReminders: true, schoolId: 'school-2' } as never, admin);
      const call = model(tx, 'reportingSetting', 'upsert').mock.calls[0]![0] as { where: { schoolId: string }; create: { schoolId: string } };
      expect(call.where.schoolId).toBe('school-1');
      expect(call.create.schoolId).toBe('school-1');
    });
  });

  describe('mine', () => {
    const openRow = (overrides: Record<string, unknown> = {}) => ({
      lesson_id: 'lesson-1',
      day: '2026-10-16',
      starts_at: new Date('2026-10-16T06:15:00Z'),
      ends_at: '2026-10-16T07:00:00.000Z',
      subject_name: 'Matematik',
      group_name: '7A',
      overdue: true,
      ...overrides,
    });

    it('hands the teacher their open lessons, their limit, and their week, month and läsår', async () => {
      const { tx, service, statements } = setup({ today: '2026-10-21', open: [openRow(), openRow({ lesson_id: 'lesson-2', day: '2026-10-20', overdue: false })] });
      model(tx, 'reportingSetting', 'findUnique').mockResolvedValue({ openAfterDays: 3 });
      model(tx, 'academicYear', 'findFirst').mockResolvedValue({ name: '2026/2027', startDate: day('2026-08-17'), endDate: day('2027-06-11') });
      const figures = [{ held: 12, reported: 11 }, { held: 40, reported: 30 }, { held: 90, reported: 80 }];
      const aggregate = model(tx, 'teacherReportingDay', 'aggregate');
      aggregate.mockImplementation(async (args: { _max?: unknown }) =>
        args._max ? { _max: { day: day('2026-10-20') } } : { _sum: figures.shift() },
      );
      const view = await service.mine(teacher);
      expect(view).toEqual({
        openAfterDays: 3,
        through: '2026-10-20',
        open: [
          {
            lessonId: 'lesson-1',
            date: '2026-10-16',
            startsAt: '2026-10-16T06:15:00.000Z',
            endsAt: '2026-10-16T07:00:00.000Z',
            subjectName: 'Matematik',
            groupName: '7A',
            overdue: true,
          },
          expect.objectContaining({ lessonId: 'lesson-2', date: '2026-10-20', overdue: false }),
        ],
        week: { from: '2026-10-19', to: '2026-10-25', held: 12, reported: 11 },
        month: { from: '2026-10-01', to: '2026-10-31', held: 40, reported: 30 },
        year: { name: '2026/2027', from: '2026-08-17', to: '2027-06-11', held: 90, reported: 80 },
      });
      expect(statements.some((text) => text.includes('app.reporting_open_lessons('))).toBe(true);
      expect(statements.filter((text) => text.includes('app.school_today()'))).toHaveLength(1);
    });

    it('reads only the teacher’s own days, for the school and the periods holding today', async () => {
      const { tx, service } = setup({ today: '2027-01-01' });
      model(tx, 'academicYear', 'findFirst').mockResolvedValue({ name: '2026/2027', startDate: day('2026-08-17'), endDate: day('2027-06-11') });
      await service.mine(teacher);
      const aggregate = model(tx, 'teacherReportingDay', 'aggregate');
      const wheres = aggregate.mock.calls.map(([args]) => args.where);
      expect(wheres).toEqual(
        expect.arrayContaining([
          { schoolId: 'school-1', teacherId: 'teacher-1' },
          { schoolId: 'school-1', teacherId: 'teacher-1', day: { gte: day('2026-12-28'), lte: day('2027-01-03') } },
          { schoolId: 'school-1', teacherId: 'teacher-1', day: { gte: day('2027-01-01'), lte: day('2027-01-31') } },
          { schoolId: 'school-1', teacherId: 'teacher-1', day: { gte: day('2026-08-17'), lte: day('2027-06-11') } },
        ]),
      );
      expect(wheres).toHaveLength(4);
      expect(model(tx, 'teacherReportingDay', 'groupBy')).not.toHaveBeenCalled();
      expect(model(tx, 'teacherReportingDay', 'findMany')).not.toHaveBeenCalled();
    });

    it('is two days, nothing open and no year for a teacher at a school with no row, no läsår and no night yet', async () => {
      const { tx, service } = setup({ today: '2026-10-21' });
      model(tx, 'reportingSetting', 'findUnique').mockResolvedValue(null);
      model(tx, 'academicYear', 'findFirst').mockResolvedValue(null);
      model(tx, 'teacherReportingDay', 'aggregate').mockResolvedValue({ _sum: { held: null, reported: null }, _max: { day: null } });
      const view = await service.mine(teacher);
      expect(view).toEqual({
        openAfterDays: 2,
        through: null,
        open: [],
        week: { from: '2026-10-19', to: '2026-10-25', held: 0, reported: 0 },
        month: { from: '2026-10-01', to: '2026-10-31', held: 0, reported: 0 },
        year: null,
      });
      // Only the week, the month and the last day: the läsår is not asked of the days.
      expect(model(tx, 'teacherReportingDay', 'aggregate')).toHaveBeenCalledTimes(3);
    });

    it('reads an open lesson’s instants whether the driver hands them as dates or as text', async () => {
      const { service } = setup({ open: [openRow({ starts_at: '2026-10-16T08:00:00+02:00', ends_at: new Date('2026-10-16T07:00:00Z') })] });
      const view = await service.mine(teacher);
      expect(view.open[0]).toMatchObject({ startsAt: '2026-10-16T06:00:00.000Z', endsAt: '2026-10-16T07:00:00.000Z' });
    });

    it('writes nothing to the read log: a teacher reads no one’s data but their own', async () => {
      const { tx, service } = setup({ open: [openRow()] });
      await service.mine(teacher);
      expect(tx.$executeRaw).not.toHaveBeenCalled();
    });

    it('is refused without a school or without a person', async () => {
      const { prisma, service } = setup();
      await expect(service.mine(testUser({ role: 'TEACHER' as never, schoolId: undefined }))).rejects.toBeInstanceOf(ForbiddenException);
      await expect(service.mine(testUser({ role: 'TEACHER' as never, userId: undefined }))).rejects.toBeInstanceOf(ForbiddenException);
      expect(prisma.withRls).not.toHaveBeenCalled();
    });

    it('falls back on the instant when the database says nothing of its today', async () => {
      const { service } = setup({ today: null });
      const view = await service.mine(teacher, new Date('2026-05-06T10:00:00Z'));
      expect(view.week).toMatchObject({ from: '2026-05-04', to: '2026-05-10' });
    });
  });
});
