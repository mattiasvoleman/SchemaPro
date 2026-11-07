import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { createPrismaMock, createTxMock, testUser, type TxMock } from '../../test/utils/prisma-mock';
import type { PrismaService } from '../database/prisma.service';
import { AbsenceStatsService, periodOf, type WindowView } from './absence-stats.service';

const admin = testUser({ schoolId: 'school-1' });
const teacher = testUser({ role: 'TEACHER' as never, userId: 'teacher-1', schoolId: 'school-1' });
const reader = testUser({ schoolId: 'school-1', userId: undefined, adminProfile: 'LASARE', huvudman: { id: 'h1', name: 'Kommunen', memberId: 'm1', role: 'PLANERARE' } as never });

type Statement = { strings: string[]; values: unknown[] };
const sql = (statement: unknown) => (statement as Statement).strings.join('?');

const WINDOW = { first_month: '2024-08-01', today: '2026-11-07', year_name: '2026/27', year_start: '2026-08-01', year_end: '2027-07-31' };

const fig = (recorded: number | null, valid = 0, absent = 0, late = 0, lateCount = 0) =>
  recorded === null
    ? { recorded_minutes: null, valid_minutes: null, absent_minutes: null, late_minutes: null, late_count: null }
    : { recorded_minutes: recorded, valid_minutes: valid, absent_minutes: absent, late_minutes: late, late_count: lateCount };

interface Stand {
  window?: Array<Record<string, unknown>>;
  series?: Array<Record<string, unknown>>;
  classes?: Array<Record<string, unknown>>;
  pupils?: Array<Record<string, unknown>>;
  head?: Array<Record<string, unknown>>;
  months?: Array<Record<string, unknown>>;
  patterns?: Array<Record<string, unknown>>;
}

function setup(stand: Stand = {}) {
  const tx = createTxMock();
  const prisma = createPrismaMock(tx);
  const calls: Array<{ text: string; values: unknown[] }> = [];
  tx.$queryRaw = jest.fn(async (statement: unknown) => {
    const text = sql(statement);
    calls.push({ text, values: (statement as Statement).values });
    if (text.includes('app.absence_stats_window(')) return stand.window ?? [WINDOW];
    if (text.includes('app.absence_stats_series(')) return stand.series ?? [];
    if (text.includes('app.absence_stats_classes(')) return stand.classes ?? [];
    if (text.includes('app.absence_stats_class_pupils(')) return stand.pupils ?? [];
    if (text.includes('app.absence_stats_pupil_head(')) return stand.head ?? [];
    if (text.includes('app.absence_stats_pupil(')) return stand.months ?? [];
    if (text.includes('app.absence_stats_patterns(')) return stand.patterns ?? [];
    return [];
  });
  const service = new AbsenceStatsService(prisma as unknown as PrismaService);
  return { tx, prisma, service, calls };
}

const reads = (tx: TxMock) => tx.$executeRaw.mock.calls.map(([statement]) => ({ sql: sql(statement), values: (statement as Statement).values }));
const recorded = (tx: TxMock) => reads(tx).map((read) => ({ kind: read.values[0], ids: read.values[2] }));

const seriesRow = (month: string, over: Record<string, unknown> = {}) => ({
  month,
  through_day: `${month.slice(0, 7)}-28`,
  class_id: 'class-1',
  class_name: '8A',
  pupils: 24,
  pupils_registered: 24,
  ...fig(1000, 50, 20, 10, 1),
  lessons_held: 100,
  lessons_reported: 90,
  ...over,
});

const pupilHead = (over: Record<string, unknown> = {}) => ({
  student_id: 'pupil-1',
  first_name: 'Elev',
  last_name: 'Ett',
  class_id: 'class-1',
  class_name: '8A',
  first_day: '2024-09-02',
  last_day: '2026-11-06',
  is_protected: false,
  ...over,
});

describe('periodOf', () => {
  const window = (year: WindowView['year']): WindowView => ({ firstMonth: '2024-08-01', today: '2026-11-07', year, minGroup: 5 });
  it('is the läsår holding today, up to yesterday, without a period asked for', () => {
    expect(periodOf({}, window({ name: '2026/27', from: '2026-08-01', to: '2027-07-31' }))).toEqual({ from: '2026-08-01', to: '2026-11-06' });
  });
  it('is the whole window without a läsår', () => {
    expect(periodOf({}, window(null))).toEqual({ from: '2024-08-01', to: '2026-11-06' });
  });
  it('is the window when the läsår has not begun by the end asked for', () => {
    expect(periodOf({ to: '2026-07-01' }, window({ name: '2026/27', from: '2026-08-01', to: '2027-07-31' }))).toEqual({ from: '2024-08-01', to: '2026-07-01' });
  });
  it('is what was asked for, either end', () => {
    expect(periodOf({ from: '2025-09-01', to: '2025-12-19' }, window(null))).toEqual({ from: '2025-09-01', to: '2025-12-19' });
    expect(periodOf({ from: '2025-09-01' }, window(null))).toEqual({ from: '2025-09-01', to: '2026-11-06' });
  });
  it('knows yesterday across a month and a year', () => {
    expect(periodOf({}, { ...window(null), today: '2027-01-01' }).to).toBe('2026-12-31');
    expect(periodOf({}, { ...window(null), today: '2028-03-01' }).to).toBe('2028-02-29');
  });
});

describe('AbsenceStatsService', () => {
  describe('window', () => {
    it('is the first month, the school’s today and the läsår holding it, and the smallest group', async () => {
      const { service } = setup();
      await expect(service.window(admin)).resolves.toEqual({
        firstMonth: '2024-08-01',
        today: '2026-11-07',
        year: { name: '2026/27', from: '2026-08-01', to: '2027-07-31' },
        minGroup: 5,
      });
    });

    it('has no läsår for a school with none', async () => {
      const { service } = setup({ window: [{ ...WINDOW, year_name: null, year_start: null, year_end: null }] });
      await expect(service.window(admin)).resolves.toMatchObject({ year: null });
    });

    it('says so if the database answers nothing, which it never does', async () => {
      const { service } = setup({ window: [] });
      await expect(service.window(admin)).rejects.toThrow('app.absence_stats_window answered nothing');
    });

    it('is refused without a school', async () => {
      const { service, prisma } = setup();
      await expect(service.window(testUser({ schoolId: undefined }))).rejects.toBeInstanceOf(ForbiddenException);
      expect(prisma.withRls).not.toHaveBeenCalled();
    });

    it('turns the database’s refusal into the API’s', async () => {
      const { service, tx } = setup();
      tx.$queryRaw = jest.fn().mockRejectedValue(
        new Prisma.PrismaClientKnownRequestError('Raw query failed.', {
          code: 'P2010',
          clientVersion: Prisma.prismaVersion.client,
          meta: { driverAdapterError: { cause: { originalCode: 'AS403', originalMessage: 'ABSENCE_STATS_NOT_YOURS' } } },
        }),
      );
      await expect(service.window(teacher)).rejects.toBeInstanceOf(ForbiddenException);
    });
  });

  describe('school', () => {
    it('is the school’s months, each with the same month a year before, asked for no class', async () => {
      const { service, calls, tx } = setup({
        series: [seriesRow('2025-10-01', { class_id: null, class_name: null, ...fig(1000, 0, 100) }), seriesRow('2026-10-01', { class_id: null, class_name: null, ...fig(1000, 0, 40) })],
      });
      const view = await service.school(admin);
      expect(view.window.minGroup).toBe(5);
      expect(view.series.map((month) => month.month)).toEqual(['2025-10-01', '2026-10-01']);
      expect(view.series[1]).toMatchObject({
        classNames: [],
        figures: { invalidPct: 4 },
        reporting: { held: 100, reported: 90, ratePct: 90 },
        previousYear: { month: '2025-10-01', figures: { invalidPct: 10 } },
      });
      expect(calls.find((call) => call.text.includes('app.absence_stats_series('))?.values).toEqual([null]);
      // The sums name nobody: nothing is recorded in the read log.
      expect(tx.$executeRaw).not.toHaveBeenCalled();
    });

    it('shows a month with fewer than five pupils behind it as one without figures', async () => {
      const { service } = setup({ series: [seriesRow('2026-08-01', { class_id: null, ...fig(null), pupils_registered: 3 })] });
      const view = await service.school(admin);
      expect(view.series[0]).toMatchObject({ figures: null, pupilsRegistered: 3, reporting: { ratePct: 90 } });
    });
  });

  describe('classes', () => {
    it('adds the months of the period for each class, and asks for the läsår so far without one', async () => {
      const { service, calls } = setup({
        classes: [
          {
            class_id: 'c1', class_name: '8A', year_name: '2026/27', months_counted: 3, pupils: 24, pupils_registered: 24,
            recorded_minutes: 3000, valid_minutes: 150, absent_minutes: 60, late_minutes: 30, late_count: 3, lessons_held: 300, lessons_reported: 240,
          },
          {
            class_id: 'c2', class_name: '8B', year_name: null, months_counted: 0, pupils: 6, pupils_registered: 2,
            recorded_minutes: null, valid_minutes: null, absent_minutes: null, late_minutes: null, late_count: null, lessons_held: 20, lessons_reported: 20,
          },
        ],
      });
      const view = await service.classes({}, admin);
      expect(view.period).toEqual({ from: '2026-08-01', to: '2026-11-06' });
      expect(view.classes[0]).toMatchObject({
        classId: 'c1', className: '8A', monthsCounted: 3, figures: { totalPct: 8, invalidPct: 3 }, reporting: { ratePct: 80 },
      });
      expect(view.classes[1]).toMatchObject({ classId: 'c2', figures: null, reporting: { ratePct: 100 } });
      expect(calls.find((call) => call.text.includes('app.absence_stats_classes('))?.values).toEqual(['2026-08-01', '2026-11-06']);
    });

    it('asks for the period it is given', async () => {
      const { service, calls } = setup();
      await service.classes({ from: '2025-08-01', to: '2025-12-19' }, teacher);
      expect(calls.find((call) => call.text.includes('app.absence_stats_classes('))?.values).toEqual(['2025-08-01', '2025-12-19']);
    });
  });

  describe('classView', () => {
    it('is the class and its predecessors month by month, and its patterns, and records nothing: sums name nobody', async () => {
      const { service, calls, tx } = setup({
        series: [seriesRow('2025-09-01', { class_name: '7A' }), seriesRow('2026-09-01')],
        patterns: [
          { dimension: 'WEEKDAY', key: '1', label: '', group_size: 24, suppressed: false, ...fig(500, 0, 50) },
          { dimension: 'SLOT', key: '08:00', label: '', group_size: 24, suppressed: false, ...fig(500, 0, 50) },
          { dimension: 'SUBJECT', key: 's1', label: 'Idrott', group_size: 24, suppressed: false, ...fig(500, 0, 25) },
        ],
      });
      const view = await service.classView('class-1', {}, teacher);
      expect(view.classId).toBe('class-1');
      expect(view.series.map((month) => month.classNames)).toEqual([['7A'], ['8A']]);
      expect(view.patterns).toMatchObject({ groupSize: 24, suppressed: false });
      expect(view.patterns.weekdays[0]).toMatchObject({ key: '1', figures: { invalidPct: 10 } });
      expect(view.patterns.subjects[0]).toMatchObject({ key: 's1', label: 'Idrott' });
      expect(calls.find((call) => call.text.includes('app.absence_stats_series('))?.values).toEqual(['class-1']);
      expect(calls.find((call) => call.text.includes('app.absence_stats_patterns('))?.values).toEqual(['class-1', null, '2026-08-01', '2026-11-06']);
      expect(tx.$executeRaw).not.toHaveBeenCalled();
    });

    it('says a class of fewer than five has no pattern', async () => {
      const { service } = setup({ patterns: [{ dimension: 'ALL', key: '', label: '', group_size: 3, suppressed: true, ...fig(null) }] });
      const view = await service.classView('class-1', {}, admin);
      expect(view.patterns).toEqual({ groupSize: 3, suppressed: true, weekdays: [], slots: [], subjects: [] });
    });
  });

  describe('classPupils', () => {
    const rows = [
      { student_id: 'p1', first_name: 'Anna', last_name: 'Ek', is_protected: false, ...fig(3100, 0, 200) },
      { student_id: 'p2', first_name: 'Bo', last_name: 'Lind', is_protected: false, ...fig(0) },
      { student_id: null, first_name: null, last_name: null, is_protected: true, ...fig(null) },
    ];

    it('names the pupils with their sums, leaves the marked one out and tells an administrator how many, and records the read', async () => {
      const { service, tx } = setup({ pupils: rows });
      const view = await service.classPupils('class-1', {}, admin);
      expect(view.pupils.map((pupil) => [pupil.studentId, pupil.firstName, pupil.lastName])).toEqual([
        ['p1', 'Anna', 'Ek'],
        ['p2', 'Bo', 'Lind'],
      ]);
      expect(view.pupils[0]?.figures).toMatchObject({ recordedMinutes: 3100, invalidMinutes: 200, invalidPct: 6.5 });
      expect(view.pupils[1]?.figures).toMatchObject({ recordedMinutes: 0, totalPct: null });
      expect(view.heldOut).toBe(1);
      expect(recorded(tx)).toEqual([
        { kind: 'ATTENDANCE', ids: ['p1', 'p2'] },
        { kind: 'PEOPLE', ids: ['p1', 'p2'] },
      ]);
    });

    it('tells a mentor nothing about who is left out: a count would point at the pupil', async () => {
      const { service } = setup({ pupils: rows.slice(0, 2) });
      const view = await service.classPupils('class-1', {}, teacher);
      expect(view.heldOut).toBeNull();
      expect(view.pupils).toHaveLength(2);
    });

    it('records nothing about an empty class', async () => {
      const { service, tx } = setup({ pupils: [] });
      await expect(service.classPupils('class-1', {}, admin)).resolves.toMatchObject({ pupils: [], heldOut: 0 });
      expect(tx.$executeRaw).not.toHaveBeenCalled();
    });

    it('is not for the huvudman’s reader, and does not ask the database', async () => {
      const { service, prisma } = setup({ pupils: rows });
      await expect(service.classPupils('class-1', {}, reader)).rejects.toMatchObject({ response: { code: 'ABSENCE_STATS_NO_PUPILS_FOR_THE_READER' } });
      expect(prisma.withRls).not.toHaveBeenCalled();
    });
  });

  describe('pupil', () => {
    const marks = [
      { month: '2025-09-01', ...fig(3300, 0, 200), lessons: 66 },
      { month: '2026-09-01', ...fig(3100, 150, 0, 15, 1), lessons: 62 },
    ];

    it('is the pupil’s months over the window, the class beside, the patterns, and is recorded as ATTENDANCE and PEOPLE', async () => {
      const { service, calls, tx } = setup({
        head: [pupilHead()],
        months: marks,
        series: [seriesRow('2025-09-01', { class_name: '7A' }), seriesRow('2026-09-01')],
        patterns: [{ dimension: 'WEEKDAY', key: '1', label: '', group_size: 1, suppressed: false, ...fig(200, 0, 50) }],
      });
      const view = await service.pupil('pupil-1', {}, teacher);
      expect(view.student).toEqual({ id: 'pupil-1', firstName: 'Elev', lastName: 'Ett', classId: 'class-1', className: '8A', isProtected: false });
      expect(view.marksFrom).toBe('2024-09-02');
      expect(view.marksTo).toBe('2026-11-06');
      // Every month of the window to yesterday, the ones with no mark as nothing.
      expect(view.months).toHaveLength(28);
      expect(view.months[0]).toMatchObject({ month: '2024-08-01', figures: null, lessons: 0, previousYear: null });
      const september = view.months.find((month) => month.month === '2026-09-01');
      expect(september).toMatchObject({ figures: { recordedMinutes: 3100, validPct: 4.8, invalidPct: 0.5 }, lessons: 62 });
      expect(september?.previousYear).toMatchObject({ month: '2025-09-01', figures: { invalidPct: 6.1 } });
      expect(view.total).toMatchObject({ recordedMinutes: 6400, validMinutes: 150, absentMinutes: 200, lateMinutes: 15 });
      expect(view.classSeries?.map((month) => month.month)).toEqual(['2025-09-01', '2026-09-01']);
      expect(view.patterns.weekdays).toHaveLength(1);
      expect(view.period).toEqual({ from: '2026-08-01', to: '2026-11-06' });
      expect(calls.find((call) => call.text.includes('app.absence_stats_pupil('))?.values).toEqual(['pupil-1', '2024-08-01', '2026-11-06']);
      expect(calls.find((call) => call.text.includes('app.absence_stats_series('))?.values).toEqual(['class-1']);
      expect(calls.find((call) => call.text.includes('app.absence_stats_patterns('))?.values).toEqual([null, 'pupil-1', '2026-08-01', '2026-11-06']);
      expect(recorded(tx)).toEqual([
        { kind: 'ATTENDANCE', ids: ['pupil-1'] },
        { kind: 'PEOPLE', ids: ['pupil-1'] },
      ]);
    });

    it('cuts a window longer than the database reads at once from its front', async () => {
      const { service, calls } = setup({
        window: [{ ...WINDOW, first_month: '2022-01-01' }],
        head: [pupilHead()],
      });
      await service.pupil('pupil-1', {}, admin);
      expect(calls.find((call) => call.text.includes('app.absence_stats_pupil('))?.values).toEqual(['pupil-1', '2023-07-25', '2026-11-06']);
    });

    it('has no class series for a pupil in no class, and says the pupil is marked to an administrator', async () => {
      const { service, calls } = setup({ head: [pupilHead({ class_id: null, class_name: null, first_day: null, last_day: null, is_protected: true })] });
      const view = await service.pupil('pupil-1', {}, admin);
      expect(view.classSeries).toBeNull();
      expect(view.marksFrom).toBeNull();
      expect(view.student.isProtected).toBe(true);
      expect(view.total).toBeNull();
      expect(calls.some((call) => call.text.includes('app.absence_stats_series('))).toBe(false);
    });

    it('is not for the huvudman’s reader, and does not ask the database', async () => {
      const { service, prisma } = setup({ head: [pupilHead()] });
      await expect(service.pupil('pupil-1', {}, reader)).rejects.toBeInstanceOf(ForbiddenException);
      expect(prisma.withRls).not.toHaveBeenCalled();
    });

    it('answers a pupil the database let in and could not name as a pupil who is not there', async () => {
      const { service, tx } = setup({ head: [] });
      await expect(service.pupil('pupil-1', {}, admin)).rejects.toBeInstanceOf(NotFoundException);
      expect(tx.$executeRaw).not.toHaveBeenCalled();
    });

    it('turns a mentor’s refusal for another class’s pupil into a 403 and records nothing', async () => {
      const { service, tx } = setup();
      tx.$queryRaw = jest.fn(async (statement: unknown) => {
        if (sql(statement).includes('app.absence_stats_window(')) return [WINDOW];
        throw new Prisma.PrismaClientKnownRequestError('Raw query failed.', {
          code: 'P2010',
          clientVersion: Prisma.prismaVersion.client,
          meta: { driverAdapterError: { cause: { originalCode: 'AS403', originalMessage: 'ABSENCE_STATS_NOT_YOURS' } } },
        });
      });
      await expect(service.pupil('someone-elses', {}, teacher)).rejects.toMatchObject({ response: { code: 'ABSENCE_STATS_NOT_YOURS' } });
      expect(tx.$executeRaw).not.toHaveBeenCalled();
    });
  });
});
