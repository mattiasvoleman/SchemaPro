import { BadRequestException, NotFoundException } from '@nestjs/common';
import { createPrismaMock, createTxMock, testUser, type TxMock } from '../../test/utils/prisma-mock';
import type { PrismaService } from '../database/prisma.service';
import {
  FamilyScheduleService,
  STUDENT_NOT_FOUND,
  WEEK_OUT_OF_RANGE,
  isRealDay,
  isoWeekLabel,
  schoolClock,
} from './family-schedule.service';

const CHILD = '55555555-5555-4555-8555-555555555555';
const HOME = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const TG = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const OTHER = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const SIBLING_GROUP = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';

const day = (value: string) => new Date(`${value}T00:00:00.000Z`);
/** 08:00 Stockholm on a date in October 2026 before the 25th is 06:00Z. */
const at = (date: string, utc: string) => new Date(`${date}T${utc}:00.000Z`);

interface LessonRow {
  id: string;
  date: Date;
  startsAt: Date;
  endsAt: Date;
  status: string;
  subjectId: string;
  studentGroupId: string;
  subject: { name: string; color: string | null };
  room: { name: string } | null;
  extraGroups: { studentGroupId: string }[];
  participants: { studentId: string }[];
  note?: string;
  cancelCause?: string;
  teachers?: unknown;
}

const lesson = (id: string, date: string, overrides: Partial<LessonRow> = {}): LessonRow => ({
  id,
  date: day(date),
  startsAt: at(date, '06:00'),
  endsAt: at(date, '06:45'),
  status: 'SCHEDULED',
  subjectId: 'subject-ma',
  studentGroupId: HOME,
  subject: { name: 'Matematik', color: '#123456' },
  room: { name: 'B204' },
  extraGroups: [],
  participants: [],
  ...overrides,
});

describe('FamilyScheduleService', () => {
  let tx: TxMock;
  let prisma: ReturnType<typeof createPrismaMock>;
  let service: FamilyScheduleService;
  let staffRows: Array<{ lesson_id: string; substitute: boolean; labels: string[] | null }>;
  let staffCalls: unknown[][];
  let today: string | null;
  const guardian = testUser({ role: 'GUARDIAN' as never });

  beforeEach(() => {
    tx = createTxMock();
    prisma = createPrismaMock(tx);
    service = new FamilyScheduleService(prisma as unknown as PrismaService);
    staffRows = [];
    staffCalls = [];
    today = '2026-10-14';
    tx.user.findFirst.mockResolvedValue({ id: CHILD, firstName: 'Ella', studentGroupId: HOME });
    tx.school.findUnique.mockResolvedValue({ timezone: 'Europe/Stockholm' });
    tx.academicYear.findFirst.mockResolvedValue({ endDate: day('2027-06-11') });
    tx.studentGroupMember.findMany.mockResolvedValue([{ studentGroupId: TG }]);
    tx.studentEnrollment.findMany.mockResolvedValue([{ validFrom: day('2026-08-17'), validTo: null }]);
    tx.calendarLunch.findMany.mockResolvedValue([]);
    tx.calendarRast.findMany.mockResolvedValue([]);
    tx.$queryRaw = jest.fn((first: unknown, ...rest: unknown[]) => {
      if (Array.isArray(first)) return Promise.resolve(today === null ? [] : [{ today }]);
      staffCalls.push([first, ...rest]);
      return Promise.resolve(staffRows);
    });
  });

  const run = (week?: string) => service.week({ studentId: CHILD, ...(week ? { week } : {}) }, guardian);

  it('answers the week of the school today by default, in one transaction under the caller', async () => {
    const result = await run();
    expect(result.week).toEqual({ from: '2026-10-12', to: '2026-10-18', isoWeek: '2026-W42' });
    expect(result.student).toEqual({ id: CHILD, firstName: 'Ella' });
    expect(result.timezone).toBe('Europe/Stockholm');
    expect(prisma.withRls).toHaveBeenCalledTimes(1);
    expect(prisma.withRls.mock.calls[0][0]).toBe(guardian);
    expect(tx.user.findFirst).toHaveBeenCalledWith({
      where: { id: CHILD, role: 'STUDENT', isActive: true },
      select: { id: true, firstName: true, studentGroupId: true },
    });
  });

  it('falls back to the school clock when the database names no day', async () => {
    today = null;
    const result = await run('2026-10-13');
    expect(result.week.from).toBe('2026-10-12');
  });

  it('answers one identical 404 for any pupil the caller cannot see', async () => {
    tx.user.findFirst.mockResolvedValue(null);
    const error = await run().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(NotFoundException);
    expect((error as NotFoundException).getResponse()).toEqual({ message: 'Eleven finns inte.', code: STUDENT_NOT_FOUND });
    expect(tx.calendarLesson.findMany).not.toHaveBeenCalled();
  });

  it('refuses a date that does not exist before reading anything', async () => {
    await expect(run('2026-02-30')).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.withRls).not.toHaveBeenCalled();
  });

  it.each([
    ['a week that ended more than seven days ago', '2026-09-30'],
    ['a week after the active year', '2027-06-14'],
  ])('refuses %s with WEEK_OUT_OF_RANGE', async (_name, week) => {
    const error = await run(week).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(BadRequestException);
    expect((error as BadRequestException).getResponse()).toEqual({
      message: 'Veckan ligger utanför det som går att visa.',
      code: WEEK_OUT_OF_RANGE,
    });
    expect(tx.calendarLesson.findMany).not.toHaveBeenCalled();
  });

  it('names the school’s today and the first and last week that may be asked for', async () => {
    const result = await run('2026-10-13');
    expect(result.today).toBe('2026-10-14');
    expect(result.bounds).toEqual({ earliest: '2026-10-05', latest: '2027-06-07' });
    // A Monday today: today − 7 is itself a Monday, and its week is the first.
    today = '2026-10-12';
    expect((await run()).bounds.earliest).toBe('2026-10-05');
    // A Sunday today: today − 7 is the Sunday of the week before last.
    today = '2026-10-18';
    expect((await run()).bounds.earliest).toBe('2026-10-05');
    tx.academicYear.findFirst.mockResolvedValue(null);
    expect((await run()).bounds.latest).toBeNull();
  });

  it('answers today’s own week empty, not 400, when the school’s today is past the active year (the summer)', async () => {
    today = '2027-07-01';
    const result = await run();
    expect(result.week).toEqual({ from: '2027-06-28', to: '2027-07-04', isoWeek: '2027-W26' });
    expect(result.lessons).toEqual([]);
    expect(result.lunches).toEqual([]);
    expect(result.rasts).toEqual([]);
    // Nothing either side may be asked for: last week is past the year too.
    expect(result.bounds).toEqual({ earliest: '2027-06-28', latest: '2027-06-28' });
    // Nothing past the year is read: the viewer's rule, a week past the year has nothing published.
    expect(tx.calendarLesson.findMany).not.toHaveBeenCalled();
    expect(tx.calendarLunch.findMany).not.toHaveBeenCalled();
    // The same week asked by name answers the same; the week before or after does not.
    await expect(run('2027-06-30')).resolves.toMatchObject({ week: { from: '2027-06-28' }, lessons: [] });
    await expect(run('2027-06-21')).rejects.toBeInstanceOf(BadRequestException);
    await expect(run('2027-07-05')).rejects.toBeInstanceOf(BadRequestException);
  });

  it('lets the first week past the year step back to the year’s last week', async () => {
    today = '2027-06-14';
    const result = await run();
    expect(result.week.from).toBe('2027-06-14');
    expect(result.bounds).toEqual({ earliest: '2027-06-07', latest: '2027-06-14' });
    await expect(run('2027-06-07')).resolves.toMatchObject({ week: { from: '2027-06-07' } });
  });

  it('shows last week, and the year’s last week, and any week without an active year', async () => {
    await expect(run('2026-10-05')).resolves.toMatchObject({ week: { from: '2026-10-05' } });
    await expect(run('2027-06-07')).resolves.toMatchObject({ week: { from: '2027-06-07' } });
    tx.academicYear.findFirst.mockResolvedValue(null);
    await expect(run('2028-01-05')).resolves.toMatchObject({ week: { from: '2028-01-03' } });
  });

  it('asks for the union of the home class, the teaching groups and the child by name, never RESCHEDULED', async () => {
    await run('2026-10-13');
    const args = tx.calendarLesson.findMany.mock.calls[0][0];
    expect(args.where).toEqual({
      date: { gte: day('2026-10-12'), lte: day('2026-10-18') },
      status: { in: ['SCHEDULED', 'COMPLETED', 'CANCELLED'] },
      OR: [
        { studentGroupId: { in: [HOME, TG] } },
        { extraGroups: { some: { studentGroupId: { in: [HOME, TG] } } } },
        { participants: { some: { studentId: CHILD } } },
      ],
    });
    expect(args.select).not.toHaveProperty('note');
    expect(args.select).not.toHaveProperty('cancelCause');
    expect(args.select).not.toHaveProperty('teachers');
    // Only this child's own participant row is read.
    expect(args.select.participants).toEqual({ where: { studentId: CHILD }, select: { studentId: true } });
  });

  it('keeps this child’s lessons and drops a sibling’s that the guardian’s RLS also returns', async () => {
    tx.calendarLesson.findMany.mockResolvedValue([
      lesson('l-home', '2026-10-13'),
      lesson('l-tg', '2026-10-13', { studentGroupId: TG }),
      lesson('l-extra', '2026-10-13', { studentGroupId: OTHER, extraGroups: [{ studentGroupId: TG }] }),
      lesson('l-named', '2026-10-13', { studentGroupId: OTHER, participants: [{ studentId: CHILD }] }),
      lesson('l-sibling', '2026-10-13', { studentGroupId: SIBLING_GROUP }),
      lesson('l-sibling-extra', '2026-10-13', { studentGroupId: OTHER, extraGroups: [{ studentGroupId: SIBLING_GROUP }] }),
    ]);
    const result = await run('2026-10-13');
    expect(result.lessons.map((l) => l.id)).toEqual(['l-home', 'l-tg', 'l-extra', 'l-named']);
    expect(staffCalls).toHaveLength(1);
    expect(staffCalls[0][0]).toMatchObject({ values: [['l-home', 'l-tg', 'l-extra', 'l-named']] });
  });

  it('whitelists every key, recursively: no note, cause, teacher id or roster', async () => {
    tx.calendarLesson.findMany.mockResolvedValue([
      lesson('l-1', '2026-10-13', { note: 'Inställd: Friluftsdag', cancelCause: 'EVENT', status: 'CANCELLED', teachers: [{ teacherId: 't' }] }),
    ]);
    tx.calendarLunch.findMany.mockResolvedValue([
      { id: 'm-1', date: day('2026-10-13'), startsAt: at('2026-10-13', '09:20'), endsAt: at('2026-10-13', '09:50'), studentGroupId: HOME },
    ]);
    tx.calendarRast.findMany.mockResolvedValue([
      { id: 'r-1', date: day('2026-10-13'), startsAt: at('2026-10-13', '07:40'), endsAt: at('2026-10-13', '08:00'), name: 'Förmiddagsrast' },
    ]);
    staffRows = [{ lesson_id: 'l-1', substitute: false, labels: [] }];
    const result = await run('2026-10-13');
    const keysOf = (value: unknown, path = ''): string[] =>
      value && typeof value === 'object'
        ? Object.entries(value as Record<string, unknown>).flatMap(([key, inner]) =>
            Array.isArray(value) ? keysOf(inner, path) : [`${path}${key}`, ...keysOf(inner, `${path}${key}.`)],
          )
        : [];
    expect(new Set(keysOf(result))).toEqual(
      new Set([
        'student', 'student.id', 'student.firstName',
        'week', 'week.from', 'week.to', 'week.isoWeek',
        'today', 'bounds', 'bounds.earliest', 'bounds.latest',
        'timezone',
        'lessons', 'lessons.id', 'lessons.date', 'lessons.start', 'lessons.end', 'lessons.startsAt', 'lessons.endsAt',
        'lessons.subjectId', 'lessons.subject', 'lessons.subjectColor', 'lessons.room', 'lessons.teachers', 'lessons.status',
        'lessons.substitute',
        'lunches', 'lunches.id', 'lunches.date', 'lunches.start', 'lunches.end',
        'rasts', 'rasts.id', 'rasts.date', 'rasts.start', 'rasts.end', 'rasts.name',
      ]),
    );
    expect(JSON.stringify(result)).not.toContain('Friluftsdag');
    expect(result.lessons[0]).toMatchObject({ status: 'CANCELLED', teachers: [], substitute: false });
    expect(result.lunches).toEqual([{ id: 'm-1', date: '2026-10-13', start: '11:20', end: '11:50' }]);
    expect(result.rasts).toEqual([{ id: 'r-1', date: '2026-10-13', start: '09:40', end: '10:00', name: 'Förmiddagsrast' }]);
  });

  it('names teachers and the substitute only as app.family_lesson_staff says', async () => {
    tx.calendarLesson.findMany.mockResolvedValue([lesson('l-1', '2026-10-13'), lesson('l-2', '2026-10-14'), lesson('l-3', '2026-10-15')]);
    staffRows = [
      { lesson_id: 'l-1', substitute: false, labels: ['ERJO'] },
      { lesson_id: 'l-2', substitute: true, labels: null },
    ];
    const result = await run('2026-10-13');
    expect(result.lessons.map((l) => [l.id, l.teachers, l.substitute])).toEqual([
      ['l-1', ['ERJO'], false],
      ['l-2', [], true],
      ['l-3', [], false],
    ]);
    const sql = staffCalls[0][0] as { strings: string[] };
    expect(sql.strings.join('?')).toContain('app.family_lesson_staff(');
  });

  it('does not ask for staff when the week has no lessons, and reads no meals for a child without a class', async () => {
    tx.user.findFirst.mockResolvedValue({ id: CHILD, firstName: 'Ella', studentGroupId: null });
    const result = await run('2026-10-13');
    expect(staffCalls).toHaveLength(0);
    expect(tx.calendarLunch.findMany).not.toHaveBeenCalled();
    expect(tx.studentEnrollment.findMany).not.toHaveBeenCalled();
    expect(tx.calendarLesson.findMany.mock.calls[0][0].where.OR).toEqual([
      { studentGroupId: { in: [TG] } },
      { extraGroups: { some: { studentGroupId: { in: [TG] } } } },
      { participants: { some: { studentId: CHILD } } },
    ]);
    expect(result).toMatchObject({ lessons: [], lunches: [], rasts: [] });
  });

  it('asks only by name for a child in no group at all', async () => {
    tx.user.findFirst.mockResolvedValue({ id: CHILD, firstName: 'Ella', studentGroupId: null });
    tx.studentGroupMember.findMany.mockResolvedValue([]);
    await run('2026-10-13');
    expect(tx.calendarLesson.findMany.mock.calls[0][0].where.OR).toEqual([{ participants: { some: { studentId: CHILD } } }]);
  });

  it('keeps a home-class lesson only on the days the class history names that class (a move on Wednesday)', async () => {
    tx.studentEnrollment.findMany.mockResolvedValue([{ validFrom: day('2026-10-14'), validTo: null }]);
    tx.calendarLesson.findMany.mockResolvedValue([
      lesson('mon-home', '2026-10-12'),
      lesson('tue-home-extra', '2026-10-13', { studentGroupId: OTHER, extraGroups: [{ studentGroupId: HOME }] }),
      lesson('tue-tg', '2026-10-13', { studentGroupId: TG }),
      lesson('tue-named', '2026-10-13', { studentGroupId: OTHER, participants: [{ studentId: CHILD }] }),
      lesson('wed-home', '2026-10-14'),
    ]);
    tx.calendarLunch.findMany.mockResolvedValue([
      { id: 'm-tue', date: day('2026-10-13'), startsAt: at('2026-10-13', '09:20'), endsAt: at('2026-10-13', '09:50') },
      { id: 'm-wed', date: day('2026-10-14'), startsAt: at('2026-10-14', '09:20'), endsAt: at('2026-10-14', '09:50') },
    ]);
    const result = await run('2026-10-13');
    expect(result.lessons.map((l) => l.id)).toEqual(['tue-tg', 'tue-named', 'wed-home']);
    expect(result.lunches.map((m) => m.id)).toEqual(['m-wed']);
    expect(tx.studentEnrollment.findMany).toHaveBeenCalledWith({
      where: {
        studentId: CHILD,
        studentGroupId: HOME,
        validFrom: { lte: day('2026-10-18') },
        OR: [{ validTo: null }, { validTo: { gt: day('2026-10-12') } }],
      },
      select: { validFrom: true, validTo: true },
    });
  });

  it('ends a segment the day before its validTo', async () => {
    tx.studentEnrollment.findMany.mockResolvedValue([{ validFrom: day('2026-08-17'), validTo: day('2026-10-14') }]);
    tx.calendarLesson.findMany.mockResolvedValue([lesson('tue', '2026-10-13'), lesson('wed', '2026-10-14')]);
    const result = await run('2026-10-13');
    expect(result.lessons.map((l) => l.id)).toEqual(['tue']);
  });

  it('gives times on the school clock across the change to winter time', async () => {
    tx.calendarLesson.findMany.mockResolvedValue([]);
    await run('2026-10-20');
    expect(schoolClock(at('2026-10-23', '06:00'), 'Europe/Stockholm')).toBe('08:00');
    expect(schoolClock(at('2026-10-26', '07:00'), 'Europe/Stockholm')).toBe('08:00');
    expect(schoolClock(at('2026-10-25', '00:30'), 'Europe/Stockholm')).toBe('02:30');
    expect(schoolClock(at('2026-10-25', '01:30'), 'Europe/Stockholm')).toBe('02:30');
    expect(schoolClock(at('2026-10-24', '22:05'), 'Europe/Stockholm')).toBe('00:05');
  });

  it('labels ISO weeks, including week 53 and a week that begins in December', () => {
    expect(isoWeekLabel('2026-10-12')).toBe('2026-W42');
    expect(isoWeekLabel('2026-12-28')).toBe('2026-W53');
    expect(isoWeekLabel('2027-01-04')).toBe('2027-W01');
    expect(isoWeekLabel('2024-12-30')).toBe('2025-W01');
    expect(isoWeekLabel('2021-01-04')).toBe('2021-W01');
  });

  it('knows a real day', () => {
    expect(isRealDay('2026-10-13')).toBe(true);
    expect(isRealDay('2028-02-29')).toBe(true);
    expect(isRealDay('2026-02-29')).toBe(false);
    expect(isRealDay('2026-13-01')).toBe(false);
    expect(isRealDay('20261013')).toBe(false);
  });
});
