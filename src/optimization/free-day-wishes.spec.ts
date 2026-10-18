import {
  TEACHER_FREE_DAY_WISH_NOT_KEPT,
  freeDayWishMessage,
  unkeptFreeDayWishes,
  type FreeDayWish,
  type TeachersOnDay,
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

  it('names a wish a lesson she leads breaks, in a conflict’s shape, naming the rule and nobody', () => {
    expect(unkeptFreeDayWishes([wish()], [lesson({ teacherId: EVA, dayOfWeek: 5 })])).toEqual([
      {
        category: 'AVAILABILITY',
        code: TEACHER_FREE_DAY_WISH_NOT_KEPT,
        params: { rule: RULE_EVA, day: 5 },
        message: freeDayWishMessage(RULE_EVA, 5),
        requirementIds: [],
        roomIds: [],
        constraintIds: [],
        resourceIds: [RULE_EVA],
        resourceNames: [],
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

    expect(notes.map((note) => note.params)).toEqual([
      { rule: '77777777-ffff-4fff-8fff-777777777770', day: 1 },
      { rule: RULE_EVA, day: 3 },
      { rule: RULE_OLLE, day: 3 },
    ]);
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
  ])('names weekday %i as %s', (day, name) => {
    expect(freeDayWishMessage(RULE_EVA, day)).toBe(
      `The teacher working-time rule ${RULE_EVA} wishes ${name} free, and the new timetable gives the teacher ` +
        `lessons that day. A wish is weighed against the rest of the week and gives way where keeping it would ` +
        `cost more.`,
    );
  });

  it('names a day outside the week by its number, as the catalogue’s other branch does', () => {
    expect(freeDayWishMessage(RULE_EVA, 8)).toContain('wishes day 8 free');
  });
});
