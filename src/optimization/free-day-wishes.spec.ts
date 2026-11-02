import {
  TEACHER_FREE_DAY_WISH_NOT_KEPT,
  freeDayWishMessage,
  timetableWith,
  unkeptFreeDayWishes,
  type FreeDayWish,
  type TeachersOnDay,
  type TimedLesson,
} from './free-day-wishes';

const EVA = '22222222-ffff-4fff-8fff-222222222222';
const OLLE = '33333333-ffff-4fff-8fff-333333333333';
const RULE_EVA = '77777777-ffff-4fff-8fff-777777777771';
const RULE_OLLE = '77777777-ffff-4fff-8fff-777777777772';

const wish = (overrides: Partial<FreeDayWish> = {}): FreeDayWish => ({
  ruleId: RULE_EVA,
  userId: EVA,
  day: 5,
  ...overrides,
});
const lesson = (overrides: Partial<TeachersOnDay> = {}): TeachersOnDay => ({
  teacherId: OLLE,
  coTeacherId: null,
  dayOfWeek: 1,
  ...overrides,
});

describe('unkeptFreeDayWishes', () => {
  it('keeps a wish no lesson of the teacher’s lands on', () => {
    expect(
      unkeptFreeDayWishes(
        [wish()],
        [
          // Eva on another day, and somebody else on her Friday.
          lesson({ teacherId: EVA, dayOfWeek: 4 }),
          lesson({ teacherId: OLLE, dayOfWeek: 5 }),
        ],
      ),
    ).toEqual([]);
  });

  it('names a wish a lesson she leads breaks, in a conflict’s shape: the day in the sentence, Eva beside it, nobody named', () => {
    expect(unkeptFreeDayWishes([wish()], [lesson({ teacherId: EVA, dayOfWeek: 5 })])).toEqual([
      {
        category: 'AVAILABILITY',
        code: TEACHER_FREE_DAY_WISH_NOT_KEPT,
        params: { day: 5 },
        message: freeDayWishMessage(5),
        requirementIds: [],
        roomIds: [],
        constraintIds: [],
        resourceIds: [RULE_EVA],
        resourceNames: [],
        // Server-only: the job view names her from it when the run is read.
        subjectIds: [EVA],
      },
    ]);
  });

  it('counts a lesson she co-teaches: it takes her day as surely', () => {
    expect(
      unkeptFreeDayWishes([wish()], [lesson({ teacherId: OLLE, coTeacherId: EVA, dayOfWeek: 5 })]),
    ).toHaveLength(1);
  });

  it('keeps every wish when the school has no lesson at all', () => {
    expect(unkeptFreeDayWishes([wish(), wish({ ruleId: RULE_OLLE, userId: OLLE })], [])).toEqual([]);
  });

  it('says them in weekday order, then by rule', () => {
    const notes = unkeptFreeDayWishes(
      [
        wish({ ruleId: RULE_OLLE, userId: OLLE, day: 3 }),
        wish({ ruleId: RULE_EVA, userId: EVA, day: 3 }),
        wish({ ruleId: '77777777-ffff-4fff-8fff-777777777770', userId: EVA, day: 1 }),
      ],
      [
        lesson({ teacherId: EVA, dayOfWeek: 1 }),
        lesson({ teacherId: EVA, dayOfWeek: 3 }),
        lesson({ teacherId: OLLE, dayOfWeek: 3 }),
      ],
    );

    expect(notes.map((note) => [note.params, note.resourceIds, note.subjectIds])).toEqual([
      [{ day: 1 }, ['77777777-ffff-4fff-8fff-777777777770'], [EVA]],
      [{ day: 3 }, [RULE_EVA], [EVA]],
      [{ day: 3 }, [RULE_OLLE], [OLLE]],
    ]);
  });
});

describe('timetableWith', () => {
  const window = { recurrence: 'ALL_WEEKS' as const, startDate: null, endDate: null };
  const rows = [
    { id: 'req-ma', teacherId: EVA, coTeacherId: OLLE, ...window },
    { id: 'req-sv', teacherId: null, coTeacherId: null, ...window },
  ];
  /** A kept lesson with an hour, as the fetch reads it. */
  const kept = (overrides: Partial<TimedLesson> = {}): TimedLesson => ({
    id: 'kept-1',
    teacherId: OLLE,
    coTeacherId: null,
    dayOfWeek: 1,
    startMinutes: 8 * 60,
    endMinutes: 9 * 60,
    ...window,
    ...overrides,
  });
  /** A solved lesson as the engine answers it. */
  const solved = (overrides: Record<string, unknown>) => ({
    startTime: '08:00:00',
    endTime: '09:00:00',
    ...overrides,
  });

  it('is the kept lessons and each solved lesson with its post’s two adults, as the apply stamps them', () => {
    expect(
      timetableWith([kept({ dayOfWeek: 2 })], rows, [
        solved({ requirementId: 'req-ma', dayOfWeek: 5 }) as never,
        solved({ requirementId: 'req-sv', dayOfWeek: 1, startTime: '10:00', endTime: '11:30' }) as never,
      ]).map(({ id: _id, ...rest }) => rest),
    ).toEqual([
      { teacherId: OLLE, coTeacherId: null, dayOfWeek: 2, startMinutes: 480, endMinutes: 540, ...window },
      { teacherId: EVA, coTeacherId: OLLE, dayOfWeek: 5, startMinutes: 480, endMinutes: 540, ...window },
      { teacherId: null, coTeacherId: null, dayOfWeek: 1, startMinutes: 600, endMinutes: 690, ...window },
    ]);
  });

  it('gives a solved lesson the window of its post and not the engine’s, as the apply stamps it', () => {
    const dated = [
      {
        id: 'req-ma',
        teacherId: EVA,
        coTeacherId: null,
        recurrence: 'ODD_WEEKS' as const,
        startDate: new Date('2026-08-17T00:00:00.000Z'),
        endDate: new Date('2026-12-18T00:00:00.000Z'),
      },
    ];
    expect(
      timetableWith([], dated, [solved({ requirementId: 'req-ma', dayOfWeek: 3 }) as never]),
    ).toMatchObject([{ recurrence: 'ODD_WEEKS', startDate: '2026-08-17', endDate: '2026-12-18' }]);
  });

  it('delade lektioner: gives a shared post’s lesson its own teacher and the post’s medlärare', () => {
    const BO = 'bo-share';
    expect(
      timetableWith([], rows, [solved({ requirementId: 'req-ma', dayOfWeek: 4, teacherId: BO }) as never]),
    ).toMatchObject([{ teacherId: BO, coTeacherId: OLLE, dayOfWeek: 4 }]);
    // Eva's Thursday wish is kept: the lesson that day is Bo's.
    expect(
      unkeptFreeDayWishes(
        [wish({ userId: EVA, day: 4 })],
        timetableWith([], rows, [solved({ requirementId: 'req-ma', dayOfWeek: 4, teacherId: BO }) as never]),
      ),
    ).toEqual([]);
  });

  it('leaves out a lesson whose post it was not given, which the demand guard refuses before it is stored', () => {
    expect(timetableWith([], rows, [solved({ requirementId: 'req-gone', dayOfWeek: 5 }) as never])).toEqual([]);
  });

  it('breaks Olle’s wish by a lesson he co-teaches only through the post, as unkeptFreeDayWishes reads it', () => {
    const timetable = timetableWith([], rows, [solved({ requirementId: 'req-ma', dayOfWeek: 3 }) as never]);
    expect(unkeptFreeDayWishes([wish({ userId: OLLE, ruleId: RULE_OLLE, day: 3 })], timetable)).toHaveLength(1);
  });
});

describe('freeDayWishMessage', () => {
  it.each([
    [1, 'Mondays'],
    [2, 'Tuesdays'],
    [3, 'Wednesdays'],
    [4, 'Thursdays'],
    [5, 'Fridays'],
    [6, 'Saturdays'],
    [7, 'Sundays'],
  ])('names weekday %i as %s, and no rule', (day, name) => {
    expect(freeDayWishMessage(day)).toBe(
      `A teacher wishes ${name} free, and the new timetable gives them lessons that day. A wish is weighed ` +
        `against the rest of the week and gives way where keeping it would cost more.`,
    );
  });

  it('names a day outside the week by its number, as the catalogue’s other branch does', () => {
    expect(freeDayWishMessage(8)).toContain('wishes day 8 free');
  });
});
