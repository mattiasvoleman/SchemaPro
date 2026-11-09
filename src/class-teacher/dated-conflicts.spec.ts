import { createTxMock, type TxMock } from '../../test/utils/prisma-mock';
import { landingContextOf } from '../publication/draft-publish';
import { readBoardFacts } from '../swaps/board-rules';
import { datedConflicts, localMinutes, type DatedContext, type DatedPlacement } from './dated-conflicts';

jest.mock('../publication/draft-publish', () => ({ landingContextOf: jest.fn() }));
jest.mock('../swaps/board-rules', () => ({ ...jest.requireActual('../swaps/board-rules'), readBoardFacts: jest.fn() }));

const time = (value: string): Date => new Date(`1970-01-01T${value}:00.000Z`);
const noLand = { breakDays: new Map(), closuresByDate: new Map(), gradeOfGroup: new Map([['class-1', 4]]), timezone: 'Europe/Stockholm' };
const noBoard = { frames: [], sittings: new Map(), gradeRules: [], spans: new Map() };

// Tuesday 23 March 2027, CET (UTC+1): 10:00-11:00 on the school's clock is 09:00-10:00 UTC.
const placement = (over: Partial<DatedPlacement> = {}): DatedPlacement => ({
  lessonId: 'lesson-1',
  academicYearId: 'year-1',
  schoolId: 'school-1',
  subjectId: 'subject-1',
  date: '2027-03-23',
  startsAt: new Date('2027-03-23T09:00:00.000Z'),
  endsAt: new Date('2027-03-23T10:00:00.000Z'),
  roomId: 'room-1',
  studentGroupId: 'class-1',
  teacherIds: ['teacher-1'],
  extraGroupIds: [],
  participantIds: [],
  timezone: 'Europe/Stockholm',
  ...over,
});

/** A dated lesson of the day, 10:30-11:30 on the school's clock. */
const other = (over: Record<string, unknown> = {}) => ({
  id: 'cl-2',
  roomId: null,
  startsAt: new Date('2027-03-23T09:30:00.000Z'),
  endsAt: new Date('2027-03-23T10:30:00.000Z'),
  subjectId: 'subject-9',
  studentGroupId: 'class-9',
  studentGroup: { name: '5B' },
  subject: { name: 'Svenska' },
  teachers: [],
  extraGroups: [],
  participants: [],
  ...over,
});

function setup() {
  const tx: TxMock = createTxMock();
  (landingContextOf as jest.Mock).mockResolvedValue(noLand);
  (readBoardFacts as jest.Mock).mockReset().mockResolvedValue(noBoard);
  const masters = { findConflicts: jest.fn().mockResolvedValue([]) };
  const context = { masters, basis: { kind: 'CURRENT' }, gradeNumbering: 'NIOARIG' } as unknown as DatedContext;
  return { tx, masters, context };
}

describe('localMinutes', () => {
  it('is the wall clock of the school, winter and summer', () => {
    expect(localMinutes(new Date('2027-03-23T09:00:00.000Z'), 'Europe/Stockholm')).toBe(600);
    expect(localMinutes(new Date('2027-06-15T08:00:00.000Z'), 'Europe/Stockholm')).toBe(600);
    expect(localMinutes(new Date('2027-03-23T23:30:00.000Z'), 'Europe/Stockholm')).toBe(30);
  });
});

describe('datedConflicts', () => {
  it('finds nothing in an empty day', async () => {
    const { tx, context } = setup();
    expect(await datedConflicts(tx as never, context, placement())).toEqual([]);
  });

  it('asks the editor’s clash rule about the placement as a candidate of its weekday and hours, held against the date’s lessons and not the template’s', async () => {
    const { tx, masters, context } = setup();
    await datedConflicts(
      tx as never,
      context,
      placement({ teacherIds: ['teacher-1', 'teacher-2'], extraGroupIds: ['class-2'], participantIds: ['pupil-1'] }),
    );
    const [given, basis, identity, candidate, options] = masters.findConflicts.mock.calls[0]!;
    expect(given).toBe(tx);
    expect(basis).toEqual({ kind: 'CURRENT' });
    expect(identity).toEqual({ id: null, academicYearId: 'year-1', studentGroupId: 'class-1', subjectId: 'subject-1' });
    expect(candidate).toEqual({
      dayOfWeek: 2,
      startMinutes: 600,
      endMinutes: 660,
      teacherId: 'teacher-1',
      coTeacherId: 'teacher-2',
      roomId: 'room-1',
      extraGroupIds: ['class-2'],
      studentIds: ['pupil-1'],
    });
    expect(options).toEqual({ against: [] });
    // The date's lessons, whole: a lesson just outside the hour can still be one the pupils are changing for.
    expect(tx['calendarLesson']!['findMany']!.mock.calls[0]![0].where).toEqual({
      id: { not: 'lesson-1' },
      date: new Date('2027-03-23T00:00:00.000Z'),
      status: { in: ['SCHEDULED', 'COMPLETED'] },
    });
  });

  it('hands the rule each lesson of the date as the rule reads a lesson, on the school’s clock, with every teacher asked', async () => {
    const { tx, masters, context } = setup();
    tx['calendarLesson']!['findMany']!.mockResolvedValue([
      other({
        id: 'cl-2',
        roomId: 'room-2',
        subjectId: 'subject-9',
        teachers: [{ teacherId: 't-a' }, { teacherId: 't-b' }, { teacherId: 't-b' }, { teacherId: 't-c' }],
        extraGroups: [{ studentGroupId: 'class-2' }],
        participants: [{ studentId: 'pupil-3' }],
      }),
    ]);
    await datedConflicts(tx as never, context, placement());
    const against = masters.findConflicts.mock.calls[0]![4].against;
    // Two teachers on the lesson, the third as a lesson of the same hour of their own.
    expect(against).toHaveLength(2);
    expect(against[0]).toMatchObject({
      id: 'cl-2',
      teacherId: 't-a',
      coTeacherId: 't-b',
      roomId: 'room-2',
      studentGroupId: 'class-9',
      subjectId: 'subject-9',
      recurrence: 'ALL_WEEKS',
      startDate: null,
      endDate: null,
      subject: { name: 'Svenska' },
      extraGroups: [{ studentGroupId: 'class-2' }],
      participants: [{ studentId: 'pupil-3' }],
    });
    expect(against[0].startTime).toEqual(time('10:30'));
    expect(against[0].endTime).toEqual(time('11:30'));
    expect(against[1]).toMatchObject({ id: 'cl-2', teacherId: 't-c', coTeacherId: null });
  });

  it('names a clash by what clashes and with which lesson of the date, and an unavailable hour by nothing but its kind', async () => {
    const { tx, masters, context } = setup();
    tx['calendarLesson']!['findMany']!.mockResolvedValue([other({ teachers: [{ teacherId: 'teacher-1' }], roomId: 'room-1' })]);
    masters.findConflicts.mockResolvedValue([
      { kind: 'TEACHER', message: 'x', masterLessonId: 'cl-2' },
      { kind: 'ROOM', message: 'y', masterLessonId: 'cl-2' },
      { kind: 'AVAILABILITY', message: 'z' },
    ]);
    const found = await datedConflicts(tx as never, context, placement());
    expect(found).toEqual([
      { kind: 'TEACHER', other: { className: '5B', subjectName: 'Svenska', date: '2027-03-23', start: '10:30', end: '11:30' } },
      { kind: 'ROOM', other: { className: '5B', subjectName: 'Svenska', date: '2027-03-23', start: '10:30', end: '11:30' } },
      { kind: 'AVAILABILITY' },
    ]);
    // Nobody is named: no teacher id or name in what is told.
    expect(JSON.stringify(found)).not.toContain('teacher-1');
  });

  it('tells a clash once, however many ways the rule found it', async () => {
    const { tx, masters, context } = setup();
    tx['calendarLesson']!['findMany']!.mockResolvedValue([other()]);
    masters.findConflicts.mockResolvedValue([
      { kind: 'GROUP', message: 'a', masterLessonId: 'cl-2' },
      { kind: 'GROUP', message: 'b', masterLessonId: 'cl-2' },
      { kind: 'GROUP', message: 'c', masterLessonId: 'cl-2' },
    ]);
    expect(await datedConflicts(tx as never, context, placement())).toHaveLength(1);
  });

  it('tells two lessons that clash the same way as two clashes, one for each', async () => {
    const { tx, masters, context } = setup();
    tx['calendarLesson']!['findMany']!.mockResolvedValue([
      other({ id: 'cl-2' }),
      other({ id: 'cl-3', studentGroupId: 'class-8', studentGroup: { name: '5A' }, subject: { name: 'Engelska' }, startsAt: new Date('2027-03-23T08:00:00.000Z'), endsAt: new Date('2027-03-23T09:30:00.000Z') }),
    ]);
    masters.findConflicts.mockResolvedValue([
      { kind: 'GROUP', message: 'a', masterLessonId: 'cl-2' },
      { kind: 'GROUP', message: 'b', masterLessonId: 'cl-3' },
    ]);
    const found = await datedConflicts(tx as never, context, placement());
    expect(found.map((view) => view.other?.className)).toEqual(['5B', '5A']);
  });

  it('is blocked by an approved booking of the room, and only an approved one, and only of a room', async () => {
    const { tx, context } = setup();
    tx['roomBooking']!['findFirst']!.mockResolvedValue({ id: 'booking-1' });
    expect(await datedConflicts(tx as never, context, placement())).toEqual([{ kind: 'BOOKING' }]);
    expect(tx['roomBooking']!['findFirst']).toHaveBeenCalledWith({
      where: {
        roomId: 'room-1',
        status: 'APPROVED',
        startsAt: { lt: new Date('2027-03-23T10:00:00.000Z') },
        endsAt: { gt: new Date('2027-03-23T09:00:00.000Z') },
      },
      select: { id: true },
    });
    tx['roomBooking']!['findFirst']!.mockClear();
    await datedConflicts(tx as never, context, placement({ roomId: null }));
    expect(tx['roomBooking']!['findFirst']).not.toHaveBeenCalled();
  });

  it('is blocked by an hour made unavailable for this date, of the teacher, the room or the class, and not by one for another date or hour', async () => {
    const dated = (from: string, to: string) => ({ startTime: time(from), endTime: time(to) });
    for (const [constraint, blocks] of [
      [dated('08:00', '10:30'), true],
      [dated('10:30', '11:30'), true],
      [dated('11:00', '12:00'), false],
      [dated('10:00', '10:00'), false],
      [dated('08:00', '10:00'), false],
    ] as const) {
      const { tx, context } = setup();
      tx['availabilityConstraint']!['findMany']!.mockResolvedValue([constraint]);
      const found = await datedConflicts(tx as never, context, placement());
      expect(found.some((view) => view.kind === 'AVAILABILITY')).toBe(blocks);
    }
    // Touching is not overlapping (10:00-11:00 against 11:00-12:00).
    const { tx, context } = setup();
    await datedConflicts(tx as never, context, placement({ roomId: null, teacherIds: [] }));
    expect(tx['availabilityConstraint']!['findMany']!.mock.calls[0]![0].where).toEqual({
      type: 'UNAVAILABLE',
      date: new Date('2027-03-23T00:00:00.000Z'),
      AND: [expect.any(Object)],
      OR: [{ studentGroupId: { in: ['class-1'] } }],
    });
    await datedConflicts(tx as never, context, placement({ extraGroupIds: ['class-2'] }));
    expect(tx['availabilityConstraint']!['findMany']!.mock.calls[1]![0].where.OR).toEqual([
      { userId: { in: ['teacher-1'] } },
      { roomId: 'room-1' },
      { studentGroupId: { in: ['class-1', 'class-2'] } },
    ]);
  });

  it('is blocked by a lov, or by the class being closed, as a publish is', async () => {
    const { tx, context } = setup();
    (landingContextOf as jest.Mock).mockResolvedValue({
      ...noLand,
      breakDays: new Map([['2027-03-23', [{ startDate: new Date('2027-03-22'), endDate: new Date('2027-03-26'), minGradeLevel: null, maxGradeLevel: null }]]]),
    });
    expect(await datedConflicts(tx as never, context, placement())).toEqual([{ kind: 'BREAK' }]);
    expect(landingContextOf).toHaveBeenCalledWith(tx, 'year-1', '2027-03-23', '2027-03-23', 'Europe/Stockholm');
  });

  describe('the board’s hard rules', () => {
    const facts = (over: Record<string, unknown>) => ({ ...noBoard, spans: new Map([['class-1', [4, 4]]]), ...over });

    it('reads the board for the class and the classes joining on the weekday of the date, with the school’s clock for the date’s meal', async () => {
      const { tx, context } = setup();
      await datedConflicts(tx as never, context, placement({ extraGroupIds: ['class-2'] }));
      const [given, input] = (readBoardFacts as jest.Mock).mock.calls[0]!;
      expect(given).toBe(tx);
      expect(input).toMatchObject({ academicYearId: 'year-1', schoolId: 'school-1', gradeNumbering: 'NIOARIG', basis: { kind: 'CURRENT' }, groupIds: ['class-1', 'class-2'], weekday: 2 });
      expect(input.date.day).toBe('2027-03-23');
      expect(input.date.localMinutes(new Date('2027-03-23T09:00:00.000Z'))).toBe(600);
    });

    it('is a FRAME, LUNCH or GRADE_RULE conflict by its kind, with no lesson named', async () => {
      for (const [expected, board, start, end] of [
        // The stage is taught 08:00-15:00; 15:30-16:30 is outside it (14:30Z-15:30Z).
        ['FRAME', facts({ frames: [{ min: 1, max: 6, day: null, start: 480, end: 900 }] }), '2027-03-23T14:30:00.000Z', '2027-03-23T15:30:00.000Z'],
        ['LUNCH', facts({ sittings: new Map([['class-1|2', [{ studentGroupId: 'class-1', dayOfWeek: 2, startMinutes: 630, endMinutes: 660 }]]]) }), '2027-03-23T09:30:00.000Z', '2027-03-23T10:30:00.000Z'],
        ['GRADE_RULE', facts({ gradeRules: [{ resourceType: 'GRADE_LEVEL', minGradeLevel: 1, maxGradeLevel: 6, dayOfWeek: 2, startMinutes: 600, endMinutes: 720 }] }), '2027-03-23T09:00:00.000Z', '2027-03-23T10:00:00.000Z'],
      ] as const) {
        const { tx, context } = setup();
        (readBoardFacts as jest.Mock).mockResolvedValue(board);
        expect(await datedConflicts(tx as never, context, placement({ startsAt: new Date(start), endsAt: new Date(end) }))).toEqual([{ kind: expected }]);
      }
    });

    it('lets a placement inside the board through', async () => {
      const { tx, context } = setup();
      (readBoardFacts as jest.Mock).mockResolvedValue(facts({ frames: [{ min: 1, max: 6, day: null, start: 480, end: 900 }] }));
      expect(await datedConflicts(tx as never, context, placement())).toEqual([]);
    });
  });
});
