import type { PrismaClient } from '@prisma/client';
import { createTxMock, type TxMock } from '../../test/utils/prisma-mock';
import { otherSchoolFinding } from './other-school-finding';
import type { GateLesson } from './publication-gates.reader';

/**
 * PUB_OTHER_SCHOOL as a publish reads it: the school's own lessons in the
 * window against the other school's (by times and weeks only) and the loans
 * between them, labelled with the school's own names.
 */

const SCHOOL = '33333333-3333-4333-8333-333333333333';
const NORRA = '44444444-4444-4444-8444-444444444444';
const SYD = '55555555-5555-4555-8555-555555555555';
const ANNA = 'a0000000-0000-4000-8000-000000000001';
const HALL = 'b0000000-0000-4000-8000-000000000002';
const LOCAL = 'c0000000-0000-4000-8000-000000000003';

const time = (clock: string) => new Date(`1970-01-01T${clock}:00.000Z`);
const date = (day: string) => new Date(`${day}T00:00:00.000Z`);
const YEAR = '99999999-9999-4999-8999-999999999999';
const WINDOW = { from: '2030-08-19', to: '2031-06-13', yearId: YEAR, yearStart: '2030-08-15', yearEnd: '2031-06-15' };

const lesson = (patch: Partial<GateLesson>): GateLesson => ({
  id: 'L1',
  subjectId: 's',
  studentGroupId: 'g',
  teacherId: ANNA,
  coTeacherId: null,
  roomId: null,
  dayOfWeek: 2,
  startTime: '09:00',
  endTime: '10:00',
  recurrence: 'ALL_WEEKS',
  startDate: null,
  endDate: null,
  isParked: false,
  extraGroupIds: [],
  studentIds: [],
  subjectName: 'Matematik',
  groupName: '7B',
  ...patch,
});

describe('otherSchoolFinding', () => {
  let tx: TxMock;
  const find = (lessons: GateLesson[]) => otherSchoolFinding(tx as unknown as PrismaClient, SCHOOL, lessons, WINDOW);
  const sharing = (busy: unknown[], siblings = [{ school_id: NORRA, name: 'Norraskolan' }]) =>
    tx.$queryRaw.mockImplementation(async (query: unknown) => {
      const text = typeof query === 'object' && query !== null && 'sql' in query ? String((query as { sql: string }).sql) : '';
      if (text.includes('app.sibling_schools()')) return siblings;
      if (text.includes('app.shared_teacher_busy(')) return busy;
      return [];
    });

  beforeEach(() => {
    tx = createTxMock();
    tx.user.findMany.mockResolvedValue([{ id: ANNA, firstName: 'Anna', lastName: 'Lind' }]);
    tx.room.findMany.mockResolvedValue([
      { id: HALL, name: 'Idrottshallen' },
      { id: LOCAL, name: 'Idrottshallen (Norraskolan)' },
    ]);
  });

  it('reads no teacher’s times for a school without another school of its huvudman, and finds nothing with no loan', async () => {
    tx.$queryRaw.mockResolvedValue([]);
    await expect(find([lesson({})])).resolves.toEqual({ code: 'PUB_OTHER_SCHOOL', count: 0 });
    expect(tx.$queryRaw).toHaveBeenCalledTimes(1);
    expect(tx.roomLoan.findMany).toHaveBeenCalledTimes(1);
  });

  it('names a lesson in its room lent to a school that has left, for an owner with no other school left', async () => {
    tx.$queryRaw.mockResolvedValue([]);
    tx.roomLoan.findMany.mockResolvedValue([
      {
        id: 'lent',
        status: 'APPROVED',
        ownerSchoolId: SCHOOL,
        borrowerSchoolId: 'f0000000-0000-4000-8000-00000000000f',
        roomId: HALL,
        localRoomId: 'x0000000-0000-4000-8000-000000000009',
        dayOfWeek: 2,
        startTime: time('09:30'),
        endTime: time('11:00'),
        startDate: date('2030-08-19'),
        endDate: date('2031-06-13'),
      },
    ]);
    const finding = await find([lesson({ id: 'in-lent', teacherId: null, roomId: HALL })]);
    expect(finding.entries).toEqual([
      {
        label: 'Matematik · 7B, tis 09:00–10:00: Idrottshallen är utlånad till en skola som har lämnat huvudmannen tis 09:30–11:00',
        masterLessonId: 'in-lent',
      },
    ]);
  });

  it('names a shared teacher’s lesson that meets the teacher’s lesson at the other school, the walk counted', async () => {
    sharing([
      {
        teacher_id: ANNA,
        school_id: NORRA,
        day_of_week: 2,
        start_time: time('10:10'),
        end_time: time('11:00'),
        recurrence: 'ALL_WEEKS',
        start_date: date('2030-08-15'),
        end_date: date('2031-06-15'),
        travel_minutes: 15,
      },
    ]);
    const finding = await find([lesson({}), lesson({ id: 'parked', isParked: true })]);
    expect(finding).toEqual({
      code: 'PUB_OTHER_SCHOOL',
      count: 1,
      entries: [
        {
          label: 'Matematik · 7B, tis 09:00–10:00: Anna Lind har en lektion på Norraskolan tis 10:10–11:00, restid 15 min',
          masterLessonId: 'L1',
          teacherId: ANNA,
        },
      ],
    });
    // The window bounds the other school's lessons it asks for.
    const asked = tx.$queryRaw.mock.calls.map((call) => call[0] as { sql: string; values: unknown[] }).find((q) => q.sql.includes('shared_teacher_busy'));
    expect(asked!.values).toEqual(['2030-08-19', '2031-06-13']);
  });

  it('names the shared teacher as a lesson’s co-teacher too', async () => {
    sharing([
      {
        teacher_id: ANNA,
        school_id: NORRA,
        day_of_week: 2,
        start_time: time('09:30'),
        end_time: time('10:30'),
        recurrence: 'ALL_WEEKS',
        start_date: date('2030-08-15'),
        end_date: date('2031-06-15'),
        travel_minutes: null,
      },
    ]);
    const finding = await find([lesson({ teacherId: 'b0000000-0000-4000-8000-00000000000b', coTeacherId: ANNA })]);
    expect(finding.count).toBe(1);
    expect(finding.entries?.[0]).toMatchObject({ masterLessonId: 'L1', teacherId: ANNA });
  });

  it('names a lesson in a lent room in the window and one in a borrowed room outside the loan', async () => {
    sharing([]);
    tx.roomLoan.findMany.mockResolvedValue([
      {
        id: 'lent',
        status: 'APPROVED',
        ownerSchoolId: SCHOOL,
        borrowerSchoolId: NORRA,
        roomId: HALL,
        localRoomId: 'x0000000-0000-4000-8000-000000000009',
        dayOfWeek: 2,
        startTime: time('09:30'),
        endTime: time('11:00'),
        startDate: date('2030-08-19'),
        endDate: date('2031-06-13'),
      },
      {
        id: 'borrowed',
        status: 'APPROVED',
        ownerSchoolId: NORRA,
        borrowerSchoolId: SCHOOL,
        roomId: 'y0000000-0000-4000-8000-000000000008',
        localRoomId: LOCAL,
        dayOfWeek: 3,
        startTime: time('08:00'),
        endTime: time('09:00'),
        startDate: date('2030-08-19'),
        endDate: date('2031-06-13'),
      },
    ]);
    const finding = await find([
      lesson({ id: 'in-lent', teacherId: null, roomId: HALL }),
      lesson({ id: 'in-borrowed-ok', teacherId: null, roomId: LOCAL, dayOfWeek: 3, startTime: '08:00', endTime: '09:00' }),
      lesson({ id: 'in-borrowed-late', teacherId: null, roomId: LOCAL, dayOfWeek: 3, startTime: '08:30', endTime: '09:30' }),
    ]);
    expect(finding.entries).toEqual([
      { label: 'Matematik · 7B, tis 09:00–10:00: Idrottshallen är utlånad till Norraskolan tis 09:30–11:00', masterLessonId: 'in-lent' },
      {
        label: 'Matematik · 7B, ons 08:30–09:30: Idrottshallen (Norraskolan) är lånad av Norraskolan, och inget godkänt lån täcker lektionen',
        masterLessonId: 'in-borrowed-late',
      },
    ]);
  });

  it('needs no loan of a borrowed room on its group’s lov: the publish writes nothing then', async () => {
    sharing([]);
    const term = (id: string, startDate: string, endDate: string) => ({
      id,
      status: 'APPROVED',
      ownerSchoolId: NORRA,
      borrowerSchoolId: SCHOOL,
      roomId: 'y0000000-0000-4000-8000-000000000008',
      localRoomId: LOCAL,
      dayOfWeek: 2,
      startTime: time('08:00'),
      endTime: time('10:00'),
      startDate: date(startDate),
      endDate: date(endDate),
    });
    tx.roomLoan.findMany.mockResolvedValue([term('ht', '2030-08-19', '2030-12-20'), term('vt', '2031-01-08', '2031-06-13')]);
    tx.studentGroup.findMany.mockResolvedValue([{ id: 'g', gradeLevel: 7 }]);
    const jullov = (min: number | null, max: number | null) => [
      { startDate: date('2030-12-21'), endDate: date('2031-01-07'), minGradeLevel: min, maxGradeLevel: max },
    ];
    const inHall = () => find([lesson({ id: 'all-year', teacherId: null, roomId: LOCAL })]);
    // The jullov of the whole school, or of the group's årskurs: covered.
    tx.schoolBreak.findMany.mockResolvedValue(jullov(null, null));
    expect((await inHall()).count).toBe(0);
    tx.schoolBreak.findMany.mockResolvedValue(jullov(7, 9));
    expect((await inHall()).count).toBe(0);
    // A lov of other years: the group is in school, and the room not lent.
    tx.schoolBreak.findMany.mockResolvedValue(jullov(1, 6));
    expect((await inHall()).count).toBe(1);
    expect(tx.studentGroup.findMany).toHaveBeenLastCalledWith({ where: { id: { in: ['g'] } }, select: { id: true, gradeLevel: true } });
  });

  describe('a borrowed room on the lov of its group’s årskurs', () => {
    const term = (id: string, startDate: string, endDate: string) => ({
      id,
      status: 'APPROVED',
      ownerSchoolId: NORRA,
      borrowerSchoolId: SCHOOL,
      roomId: 'y0000000-0000-4000-8000-000000000008',
      localRoomId: LOCAL,
      dayOfWeek: 2,
      startTime: time('08:00'),
      endTime: time('10:00'),
      startDate: date(startDate),
      endDate: date(endDate),
    });
    // An autumn and a spring loan with the jullov between, and a lov of some
    // årskurs over it: the loans cover the year only for a group that lov covers.
    const jullov = (min: number | null, max: number | null) => [
      { startDate: date('2030-12-21'), endDate: date('2031-01-07'), minGradeLevel: min, maxGradeLevel: max },
    ];
    const arrange = (gradeLevel: number | null, breaks: unknown[]) => {
      sharing([]);
      tx.roomLoan.findMany.mockResolvedValue([term('ht', '2030-08-19', '2030-12-20'), term('vt', '2031-01-08', '2031-06-13')]);
      tx.studentGroup.findMany.mockResolvedValue([{ id: 'g', gradeLevel }]);
      tx.schoolBreak.findMany.mockResolvedValue(breaks);
      return find([lesson({ id: 'all-year', teacherId: null, roomId: LOCAL })]);
    };

    it.each([
      ['åk 7–9', 7, 9],
      ['åk 8 alone', 8, 8],
      ['åk 1–12', 1, 12],
      // A bound left open is no number for a group without an årskurs to be
      // measured against, whichever one is read in its place.
      ['åk 9 and below', null, 9],
      ['åk 7 and above', 7, null],
    ])('is no lov of a teaching group, which has no årskurs: its lesson runs through a lov of %s', async (_name, min, max) => {
      // A group of åk 8 is off on those days: nothing is written, and the two
      // loans cover every day its lesson runs.
      expect((await arrange(8, jullov(min, max))).count).toBe(0);
      // A group with no årskurs is shown to be inside no årskurs's lov, so the
      // calendar writes its lesson on those days, which the loans leave open.
      expect((await arrange(null, jullov(min, max))).count).toBe(1);
    });
  });

  it('reads the lov of the publish’s own year, as the calendar does', async () => {
    sharing([]);
    tx.roomLoan.findMany.mockResolvedValue([
      {
        id: 'ht',
        status: 'APPROVED',
        ownerSchoolId: NORRA,
        borrowerSchoolId: SCHOOL,
        roomId: 'y0000000-0000-4000-8000-000000000008',
        localRoomId: LOCAL,
        dayOfWeek: 2,
        startTime: time('08:00'),
        endTime: time('10:00'),
        startDate: date('2030-08-19'),
        endDate: date('2030-12-20'),
      },
    ]);
    tx.studentGroup.findMany.mockResolvedValue([{ id: 'g', gradeLevel: 7 }]);
    await find([lesson({ id: 'all-year', teacherId: null, roomId: LOCAL })]);
    expect(tx.schoolBreak.findMany).toHaveBeenCalledTimes(1);
    expect(tx.schoolBreak.findMany).toHaveBeenCalledWith({
      where: { academicYearId: YEAR, startDate: { lte: date('2031-06-13') }, endDate: { gte: date('2030-08-19') } },
      select: { startDate: true, endDate: true, minGradeLevel: true, maxGradeLevel: true },
    });
  });

  describe('a hall lent in an autumn and a spring window', () => {
    // The ids run against the dates, so that what orders the windows is the date.
    const lentTerm = (id: string, borrower: string, startDate: string, endDate: string, from = '09:30', to = '11:00') => ({
      id,
      status: 'APPROVED',
      ownerSchoolId: SCHOOL,
      borrowerSchoolId: borrower,
      roomId: HALL,
      localRoomId: 'x0000000-0000-4000-8000-000000000009',
      dayOfWeek: 2,
      startTime: time(from),
      endTime: time(to),
      startDate: date(startDate),
      endDate: date(endDate),
    });
    const inHall = [lesson({ id: 'all-year', teacherId: null, roomId: HALL }), lesson({ id: 'spring', teacherId: null, roomId: HALL, startDate: '2031-01-08' })];

    it('is named once per lesson, and counted once', async () => {
      sharing([]);
      tx.roomLoan.findMany.mockResolvedValue([
        lentTerm('a-spring', NORRA, '2031-01-08', '2031-06-13'),
        lentTerm('b-autumn', NORRA, '2030-08-19', '2030-12-20'),
      ]);
      const finding = await find(inHall);
      expect(finding.count).toBe(2);
      expect(finding.entries).toEqual([
        { label: 'Matematik · 7B, tis 09:00–10:00: Idrottshallen är utlånad till Norraskolan tis 09:30–11:00', masterLessonId: 'all-year' },
        { label: 'Matematik · 7B, tis 09:00–10:00: Idrottshallen är utlånad till Norraskolan tis 09:30–11:00', masterLessonId: 'spring' },
      ]);
    });

    it('names the school of every window, with the term of each, when the windows say different things', async () => {
      sharing([], [
        { school_id: NORRA, name: 'Norraskolan' },
        { school_id: SYD, name: 'Sydskolan' },
      ]);
      tx.roomLoan.findMany.mockResolvedValue([
        lentTerm('a-spring', SYD, '2031-01-08', '2031-06-13', '09:00', '09:45'),
        lentTerm('b-autumn', NORRA, '2030-08-19', '2030-12-20'),
      ]);
      const finding = await find([inHall[0]]);
      expect(finding.count).toBe(1);
      expect(finding.entries).toEqual([
        {
          label:
            'Matematik · 7B, tis 09:00–10:00: Idrottshallen är utlånad till ' +
            'Norraskolan tis 09:30–11:00 (2030-08-19–2030-12-20) och Sydskolan tis 09:00–09:45 (2031-01-08–2031-06-13)',
          masterLessonId: 'all-year',
        },
      ]);
    });
  });

  it('names a teacher with an autumn and a spring row at the other school once, and counts it once', async () => {
    const row = (start: string, end: string, school = NORRA, from = '10:10', to = '11:00') => ({
      teacher_id: ANNA,
      school_id: school,
      day_of_week: 2,
      start_time: time(from),
      end_time: time(to),
      recurrence: 'ALL_WEEKS',
      start_date: date(start),
      end_date: date(end),
      travel_minutes: 15,
    });
    sharing([row('2031-01-08', '2031-06-15'), row('2030-08-15', '2030-12-20')]);
    const same = await find([lesson({})]);
    expect(same.count).toBe(1);
    expect(same.entries).toEqual([
      {
        label: 'Matematik · 7B, tis 09:00–10:00: Anna Lind har en lektion på Norraskolan tis 10:10–11:00, restid 15 min',
        masterLessonId: 'L1',
        teacherId: ANNA,
      },
    ]);
    // Rows that say different things are all said, and dated.
    sharing(
      [row('2031-01-08', '2031-06-15', SYD, '10:00', '11:00'), row('2030-08-15', '2030-12-20')],
      [
        { school_id: NORRA, name: 'Norraskolan' },
        { school_id: SYD, name: 'Sydskolan' },
      ],
    );
    const apart = await find([lesson({})]);
    expect(apart.count).toBe(1);
    expect(apart.entries).toEqual([
      {
        label:
          'Matematik · 7B, tis 09:00–10:00: Anna Lind har en lektion på ' +
          'Norraskolan tis 10:10–11:00, restid 15 min (2030-08-15–2030-12-20) och på Sydskolan tis 10:00–11:00, restid 15 min (2031-01-08–2031-06-15)',
        masterLessonId: 'L1',
        teacherId: ANNA,
      },
    ]);
  });

  it('reads a request not yet approved as no room of the school\'s: it holds nothing, and names no lesson', async () => {
    sharing([]);
    tx.roomLoan.findMany.mockResolvedValue([
      {
        id: 'waiting',
        status: 'PENDING',
        ownerSchoolId: NORRA,
        borrowerSchoolId: SCHOOL,
        roomId: 'y0000000-0000-4000-8000-000000000008',
        localRoomId: null,
        dayOfWeek: 3,
        startTime: time('08:00'),
        endTime: time('09:00'),
        startDate: date('2030-08-19'),
        endDate: date('2031-06-13'),
      },
    ]);
    const finding = await find([lesson({ id: 'anywhere', teacherId: null, roomId: LOCAL, dayOfWeek: 3, startTime: '10:00', endTime: '11:00' })]);
    expect(finding).toEqual({ code: 'PUB_OTHER_SCHOOL', count: 0 });
  });
});
