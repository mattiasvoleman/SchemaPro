import type { TeacherDayRule } from '../common/teacher-day';
import {
  classLunchWarningsOf,
  mealsCover,
  noRoomWarningsOf,
  placementWarningsOf,
  teacherDayWarningsOf,
  type FixedItem,
  type HandMeal,
  type LunchRule,
  type RoomFacts,
} from './placement-warnings';

const NO_LIMITS: TeacherDayRule = {
  maxTeachingMinutesPerDay: null,
  maxTeachingDaysPerWeek: null,
  maxConsecutiveTeachingMinutes: null,
  consecutiveBreakMinutes: null,
};
const cap = (minutes: number): TeacherDayRule => ({ ...NO_LIMITS, maxTeachingMinutesPerDay: minutes });
const days = (n: number): TeacherDayRule => ({ ...NO_LIMITS, maxTeachingDaysPerWeek: n });
const stretch = (max: number, pause: number): TeacherDayRule => ({ ...NO_LIMITS, maxConsecutiveTeachingMinutes: max, consecutiveBreakMinutes: pause });

const at = (h: number, m = 0): number => h * 60 + m;

/** One lesson of the fixed week. A `row` makes it a förläggning to warn about; `pin` that it has no room. */
function item(partial: Partial<FixedItem> & { dayOfWeek: number; startMinutes: number; endMinutes: number }): FixedItem {
  return {
    row: null,
    pin: false,
    teacherIds: ['anna'],
    groupIds: ['7A'],
    subjectId: 'ma',
    roomId: 'r1',
    recurrence: 'ALL_WEEKS',
    startDate: null,
    endDate: null,
    ...partial,
  };
}

const rulesOf = (rule: TeacherDayRule): Map<string, TeacherDayRule> => new Map([['anna', rule]]);

describe("teacherDayWarningsOf: the teacher's day over the fixed week", () => {
  it('warns every row of a day over the cap, with the most the day holds, and not a day at the cap', () => {
    const items = [
      item({ row: 0, dayOfWeek: 1, startMinutes: at(8), endMinutes: at(10) }),
      item({ row: 1, dayOfWeek: 1, startMinutes: at(10), endMinutes: at(12, 30) }),
      item({ row: 2, dayOfWeek: 2, startMinutes: at(8), endMinutes: at(12) }),
    ];
    const { warnings } = teacherDayWarningsOf(items, rulesOf(cap(240)), true);
    expect([...warnings.keys()].sort()).toEqual([0, 1]);
    expect(warnings.get(0)).toEqual([{ code: 'TEACHER_DAY_TOO_LONG', refuses: false, params: { day: 1, minutes: 270, cap: 240 } }]);
    // The same day at the cap exactly: 240 is not over 240.
    expect(teacherDayWarningsOf(items.slice(2), rulesOf(cap(240)), true).warnings.size).toBe(0);
  });

  it('counts the lessons Generera keeps, and says nothing about a week the rows are no part of', () => {
    const kept = [
      item({ dayOfWeek: 1, startMinutes: at(8), endMinutes: at(11), roomId: 'r2' }),
      item({ dayOfWeek: 1, startMinutes: at(11), endMinutes: at(14), roomId: 'r2' }),
    ];
    // Six hours kept on Monday, over a cap of five: the school made it, a row on Tuesday does not repeat it.
    expect(teacherDayWarningsOf([...kept, item({ row: 0, dayOfWeek: 2, startMinutes: at(8), endMinutes: at(9) })], rulesOf(cap(300)), true).warnings.size).toBe(0);
    // A row on the same Monday joins it.
    const joined = teacherDayWarningsOf([...kept, item({ row: 0, dayOfWeek: 1, startMinutes: at(14), endMinutes: at(15) })], rulesOf(cap(300)), true);
    expect(joined.warnings.get(0)).toEqual([{ code: 'TEACHER_DAY_TOO_LONG', refuses: false, params: { day: 1, minutes: 420, cap: 300 } }]);
  });

  it('counts a medlärare as teaching, and a teacher with no rule not at all', () => {
    const items = [
      item({ row: 0, teacherIds: ['bo', 'anna'], dayOfWeek: 1, startMinutes: at(8), endMinutes: at(11) }),
      item({ row: 1, teacherIds: ['bo'], dayOfWeek: 1, startMinutes: at(11), endMinutes: at(14) }),
    ];
    const warnings = teacherDayWarningsOf(items, new Map([['anna', cap(150)]]), true).warnings;
    expect([...warnings.keys()]).toEqual([0]);
    expect(teacherDayWarningsOf(items, new Map(), true).warnings.size).toBe(0);
  });

  describe('whether Generera refuses', () => {
    const locked = item({ dayOfWeek: 1, startMinutes: at(8), endMinutes: at(11), roomId: 'r2' });
    it('never for a week of locks and kept lessons: the engine takes them as they are', () => {
      const items = [locked, item({ row: 0, dayOfWeek: 1, startMinutes: at(11), endMinutes: at(13), roomId: 'r1' })];
      expect(teacherDayWarningsOf(items, rulesOf(cap(240)), true).warnings.get(0)![0]!.refuses).toBe(false);
    });
    it('for a pin that does not fit what the locks leave of the cap, and not for one that does', () => {
      const over = [locked, item({ row: 0, pin: true, roomId: null, dayOfWeek: 1, startMinutes: at(11), endMinutes: at(13) })];
      expect(teacherDayWarningsOf(over, rulesOf(cap(240)), true).warnings.get(0)![0]!.refuses).toBe(true);
      // The cap holds the day: three hours locked and a pin of an hour is four, the cap. No warning at all.
      const fits = [locked, item({ row: 0, pin: true, roomId: null, dayOfWeek: 1, startMinutes: at(11), endMinutes: at(12) })];
      expect(teacherDayWarningsOf(fits, rulesOf(cap(240)), true).warnings.size).toBe(0);
    });
    it('for a pin on a day whose locks are over the cap alone: nothing is left for it', () => {
      const items = [
        locked,
        item({ dayOfWeek: 1, startMinutes: at(11), endMinutes: at(14), roomId: 'r2' }),
        item({ row: 0, pin: true, roomId: null, dayOfWeek: 1, startMinutes: at(14), endMinutes: at(15) }),
      ];
      expect(teacherDayWarningsOf(items, rulesOf(cap(300)), true).warnings.get(0)![0]!.refuses).toBe(true);
    });
  });

  describe('the days', () => {
    it('warns the rows of a week over the limit, with the post’s figure to a reader with HR-läs and without it to one without', () => {
      const items = [1, 2, 3].map((day, row) => item({ row, dayOfWeek: day, startMinutes: at(8), endMinutes: at(9) }));
      const shown = teacherDayWarningsOf(items, rulesOf(days(2)), true);
      expect(shown.warnings.get(0)).toEqual([{ code: 'TEACHER_WEEK_TOO_MANY_DAYS', refuses: false, params: { days: 3, max: 2 } }]);
      expect(shown.hrTold).toEqual(['anna']);
      const hidden = teacherDayWarningsOf(items, rulesOf(days(2)), false);
      expect(hidden.warnings.get(0)).toEqual([{ code: 'TEACHER_WEEK_TOO_MANY_DAYS_HIDDEN', refuses: false }]);
      // A reader without HR-läs is told there is a limit, which is a read of the post as well.
      expect(hidden.hrTold).toEqual(['anna']);
    });
    it('says nothing of a week inside the limit', () => {
      const items = [1, 2].map((day, row) => item({ row, dayOfWeek: day, startMinutes: at(8), endMinutes: at(9) }));
      expect(teacherDayWarningsOf(items, rulesOf(days(2)), true).warnings.size).toBe(0);
    });
    it('refuses when the pins take more days than the limit leaves beside the locks', () => {
      const kept = [1, 2].map((day) => item({ dayOfWeek: day, startMinutes: at(8), endMinutes: at(9), roomId: 'r2' }));
      // Locks on Monday and Tuesday, a limit of two: a pin on Wednesday has no day.
      const wednesday = item({ row: 0, pin: true, roomId: null, dayOfWeek: 3, startMinutes: at(8), endMinutes: at(9) });
      expect(teacherDayWarningsOf([...kept, wednesday], rulesOf(days(2)), true).warnings.get(0)![0]!.refuses).toBe(true);
      // A pin on a day the locks already hold adds none: three locked days over a limit of two is the school's own.
      const third = item({ dayOfWeek: 3, startMinutes: at(8), endMinutes: at(9), roomId: 'r2' });
      const onMonday = item({ row: 0, pin: true, roomId: null, dayOfWeek: 1, startMinutes: at(10), endMinutes: at(11) });
      expect(teacherDayWarningsOf([...kept, third, onMonday], rulesOf(days(2)), true).warnings.get(0)![0]!.refuses).toBe(false);
    });
  });

  describe('teaching in a row', () => {
    const items = [
      item({ row: 0, dayOfWeek: 1, startMinutes: at(8), endMinutes: at(10) }),
      item({ row: 1, dayOfWeek: 1, startMinutes: at(10), endMinutes: at(12) }),
    ];
    it('warns, worded for the reader, and never refuses (the generator keeps the limit as a wish)', () => {
      const shown = teacherDayWarningsOf(items, rulesOf(stretch(180, 30)), true).warnings.get(0)!;
      expect(shown).toEqual([{ code: 'TEACHER_STRETCH_TOO_LONG', refuses: false, params: { day: 1, minutes: 240, max: 180, breakMinutes: 30 } }]);
      expect(teacherDayWarningsOf(items, rulesOf(stretch(180, 30)), false).warnings.get(0)).toEqual([{ code: 'TEACHER_STRETCH_TOO_LONG_HIDDEN', refuses: false }]);
    });
  });

  describe('in the weeks lessons run, over a läsår of many periods', () => {
    // Four terms' worth of dated lessons cut the year into at least eight periods; the teacher's year-long Monday lesson
    // is over the cap with each of them, and that is one cause in every period it spans: every row of it is warned once.
    const terms = [
      ['2026-08-17', '2026-10-30'],
      ['2026-11-02', '2026-12-18'],
      ['2027-01-11', '2027-03-19'],
      ['2027-03-22', '2027-06-05'],
    ] as const;
    const dated = terms.map(([startDate, endDate], row) => item({ row: row + 1, dayOfWeek: 1, startMinutes: at(10), endMinutes: at(12), startDate, endDate }));
    const wholeYear = item({ row: 0, dayOfWeek: 1, startMinutes: at(8), endMinutes: at(10) });

    it('warns each row of a cause that spans several periods, once', () => {
      const { warnings } = teacherDayWarningsOf([wholeYear, ...dated], rulesOf(cap(200)), true);
      expect([...warnings.keys()].sort()).toEqual([0, 1, 2, 3, 4]);
      for (const row of [0, 1, 2, 3, 4]) expect(warnings.get(row)).toHaveLength(1);
      expect(warnings.get(2)![0]!.params).toEqual({ day: 1, minutes: 240, cap: 200 });
    });

    it('does not add up lessons of different terms that never run in the same week', () => {
      // Two hours in the autumn and two in the spring on the same Monday: a cap of 200 holds in every week there is.
      const { warnings } = teacherDayWarningsOf([dated[0]!, dated[2]!, dated[3]!], rulesOf(cap(130)), true);
      expect(warnings.size).toBe(0);
    });

    it('reads odd and even weeks apart: a Monday hour of each is one Monday hour in any week', () => {
      const odd = item({ row: 0, dayOfWeek: 1, startMinutes: at(8), endMinutes: at(11), recurrence: 'ODD_WEEKS' });
      const even = item({ row: 1, dayOfWeek: 1, startMinutes: at(8), endMinutes: at(11), recurrence: 'EVEN_WEEKS' });
      // Six hours in two weeks is three in each: a cap of four holds, and a cap of two names the three.
      expect(teacherDayWarningsOf([odd, even], rulesOf(cap(240)), true).warnings.size).toBe(0);
      expect(teacherDayWarningsOf([odd, even], rulesOf(cap(120)), true).warnings.get(0)![0]!.params).toEqual({ day: 1, minutes: 180, cap: 120 });
    });
  });
});

describe("classLunchWarningsOf: the class's lunch over its own fixed lessons", () => {
  // A school of the engine's kind: lunch 10:30-13:00, thirty minutes, on the five-minute grid.
  const lunch: LunchRule = { startMinutes: at(10, 30), endMinutes: at(13), minutes: 30 };
  const year = { startDate: '2026-08-17', endDate: '2027-06-11' };
  const classes = new Set(['7A']);
  const run = (items: FixedItem[], meals: HandMeal[] = [], span = year) => classLunchWarningsOf(items, lunch, classes, meals, span);
  const lesson = (from: number, to: number, extra: Partial<FixedItem> = {}) => item({ dayOfWeek: 2, startMinutes: from, endMinutes: to, ...extra });

  it('warns when the class’s lessons leave the break no start in the window', () => {
    const warnings = run([lesson(at(10, 30), at(11, 45), { row: 0 }), lesson(at(11, 45), at(13), { row: 1 })]);
    expect([...warnings.keys()].sort()).toEqual([0, 1]);
    expect(warnings.get(0)).toEqual([{ code: 'CLASS_HAS_NO_LUNCH', refuses: true, params: { day: 2, windowStart: '10:30', windowEnd: '13:00', minutes: 30 } }]);
  });

  it('says nothing when one start is left, on the grid and at the edge of the window', () => {
    // The last start is 12:30 (12:30 + 30 = 13:00): a lesson that ends at 12:30 leaves it.
    expect(run([lesson(at(10, 30), at(12, 30), { row: 0 })]).size).toBe(0);
    // Five minutes later and the last start is taken: 12:35 is past the window's last start.
    expect(run([lesson(at(10, 30), at(12, 35), { row: 0 })]).size).toBe(1);
    // And the first: a lesson that begins at 11:00 leaves 10:30, the window's first start; one at 10:55 does not.
    expect(run([lesson(at(11), at(13), { row: 0 })]).size).toBe(0);
    expect(run([lesson(at(10, 55), at(13), { row: 0 })]).size).toBe(1);
  });

  it('finds a start off the quarter hour: the slot grid is five minutes', () => {
    // A lesson to 11:05 and the next from 11:35: the thirty minutes between them start at 11:05, which only a grid of five finds.
    expect(run([lesson(at(10, 30), at(11, 5), { row: 0 }), lesson(at(11, 35), at(13))]).size).toBe(0);
    // Twenty-five minutes between them is not thirty.
    expect(run([lesson(at(10, 30), at(11, 5), { row: 0 }), lesson(at(11, 30), at(13))]).size).toBe(1);
  });

  it('counts the lessons Generera keeps beside the rows, and an extra group the lesson was opened to', () => {
    const kept = lesson(at(10, 30), at(12, 0), { groupIds: ['7B', '7A'], roomId: 'r2' });
    expect(run([kept, lesson(at(12, 0), at(13), { row: 0 })]).size).toBe(1);
    expect(run([lesson(at(10, 30), at(12, 0), { groupIds: ['7B'] }), lesson(at(12, 0), at(13), { row: 0 })]).size).toBe(0);
  });

  it('reads odd and even weeks together, as the meal is every week’s', () => {
    const items = [
      lesson(at(10, 30), at(11, 45), { row: 0, recurrence: 'ODD_WEEKS' }),
      lesson(at(11, 45), at(13), { row: 1, recurrence: 'EVEN_WEEKS' }),
    ];
    expect(run(items).size).toBe(2);
  });

  it('is rescued by a meal the school placed by hand in all the weeks the lessons run together', () => {
    const items = [lesson(at(10, 30), at(11, 45), { row: 0 }), lesson(at(11, 45), at(13), { row: 1 })];
    const whole: HandMeal = { groupId: '7A', dayOfWeek: 2, startDate: null, endDate: null };
    expect(run(items, [whole]).size).toBe(0);
    // Another class's meal, or another weekday's, is not this one's.
    expect(run(items, [{ ...whole, groupId: '7B' }]).size).toBe(2);
    expect(run(items, [{ ...whole, dayOfWeek: 3 }]).size).toBe(2);
  });

  describe('per part of the läsår (a meal holds weeks), over many periods', () => {
    // The class's lunch lessons are the autumn's and the spring's. Two lessons dated apart never meet and leave a start;
    // a year-long one meets each of them.
    const autumn = (extra: Partial<FixedItem> = {}) => lesson(at(11, 45), at(13), { startDate: '2026-08-17', endDate: '2026-12-18', ...extra });
    const spring = (extra: Partial<FixedItem> = {}) => lesson(at(11, 45), at(13), { startDate: '2027-01-11', endDate: '2027-06-04', ...extra });
    const wholeYear = lesson(at(10, 30), at(11, 45), { row: 0 });

    it('warns a year-long lesson that meets a lock of each term, and each lock, once per row', () => {
      const warnings = run([wholeYear, autumn({ row: 1 }), spring({ row: 2 })]);
      expect([...warnings.keys()].sort()).toEqual([0, 1, 2]);
      expect(warnings.get(0)).toHaveLength(1);
    });

    it('says nothing of two terms’ lessons that never run in the same week, though together they would fill the window', () => {
      expect(run([lesson(at(10, 30), at(12, 30), { startDate: '2026-08-17', endDate: '2026-12-18', row: 0 }), lesson(at(10, 30), at(13), { startDate: '2027-01-11', endDate: '2027-06-04', row: 1, groupIds: ['7B'] })]).size).toBe(0);
      expect(run([autumn({ row: 0 }), lesson(at(10, 30), at(11, 45), { startDate: '2027-01-11', endDate: '2027-06-04', row: 1 })]).size).toBe(0);
    });

    it('is rescued by a meal for the autumn only where the lessons are the autumn’s, and by two meals that together hold the year', () => {
      const items = [wholeYear, autumn({ row: 1 }), spring({ row: 2 })];
      const autumnMeal: HandMeal = { groupId: '7A', dayOfWeek: 2, startDate: null, endDate: '2026-12-20' };
      const springMeal: HandMeal = { groupId: '7A', dayOfWeek: 2, startDate: '2026-12-21', endDate: null };
      // The autumn alone leaves the spring week unmet: the warning stays on the lessons that run then.
      expect([...run(items, [autumnMeal]).keys()].sort()).toEqual([0, 2]);
      expect(run(items, [autumnMeal, springMeal]).size).toBe(0);
    });

    it.each([15, 16, 17, 18, 19].map((day) => `2026-08-${day}`))('reads a läsår that starts on %s (Saturday to Wednesday) from its own first Monday', (startDate) => {
      const first = item({ dayOfWeek: 2, startMinutes: at(10, 30), endMinutes: at(11, 45), row: 0, startDate: '2026-08-17' });
      const second = item({ dayOfWeek: 2, startMinutes: at(11, 45), endMinutes: at(13), row: 1, startDate: '2026-08-17' });
      expect(run([first, second], [], { startDate, endDate: '2027-06-11' }).size).toBe(2);
      // A meal that begins that Monday holds the whole stretch the lessons do, whichever day the läsår starts.
      expect(run([first, second], [{ groupId: '7A', dayOfWeek: 2, startDate: '2026-08-17', endDate: null }], { startDate, endDate: '2027-06-11' }).size).toBe(0);
    });
  });

  it('asks only the classes that eat', () => {
    const items = [lesson(at(10, 30), at(11, 45), { row: 0, groupIds: ['grupp'] }), lesson(at(11, 45), at(13), { row: 1, groupIds: ['grupp'] })];
    expect(run(items).size).toBe(0);
  });
});

describe('mealsCover', () => {
  const meal = (startDate: string | null, endDate: string | null): HandMeal => ({ groupId: '7A', dayOfWeek: 1, startDate, endDate });
  it('holds the stretch only when no day of it is left out', () => {
    expect(mealsCover([meal(null, null)], '2026-08-17', '2027-06-11')).toBe(true);
    expect(mealsCover([meal(null, '2026-12-18'), meal('2026-12-19', null)], '2026-08-17', '2027-06-11')).toBe(true);
    expect(mealsCover([meal(null, '2026-12-18'), meal('2026-12-21', null)], '2026-08-17', '2027-06-11')).toBe(false);
    expect(mealsCover([meal('2026-09-01', null)], '2026-08-17', '2027-06-11')).toBe(false);
    expect(mealsCover([meal(null, '2027-06-10')], '2026-08-17', '2027-06-11')).toBe(false);
    expect(mealsCover([], '2026-08-17', '2027-06-11')).toBe(false);
  });
  it('holds a stretch whose last day is the last day of the meal', () => {
    expect(mealsCover([meal(null, '2027-06-11')], '2026-08-17', '2027-06-11')).toBe(true);
    expect(mealsCover([meal('2026-08-17', '2027-06-11')], '2026-08-17', '2027-06-11')).toBe(true);
    expect(mealsCover([meal('2026-08-18', '2027-06-11')], '2026-08-17', '2027-06-11')).toBe(false);
  });
  it('is not fooled by overlapping meals or by one inside another', () => {
    expect(mealsCover([meal(null, '2026-12-20'), meal('2026-10-01', '2026-12-10'), meal('2026-12-15', null)], '2026-08-17', '2027-06-11')).toBe(true);
  });
});

describe('noRoomWarningsOf: a pin with no room of its kind free', () => {
  const facts: RoomFacts = {
    typeOfRoom: new Map([
      ['sal1', 'slojd'],
      ['sal2', 'slojd'],
      ['klass', 'ordinary'],
    ]),
    roomsOfType: new Map([
      ['slojd', 2],
      ['ordinary', 1],
    ]),
    typeOfSubject: new Map<string, string | null>([
      ['slojd', 'slojd'],
      ['ma', null],
    ]),
    nameOfType: new Map([['slojd', 'Slöjdsal']]),
  };
  const pin = (row: number, extra: Partial<FixedItem> = {}) =>
    item({ row, pin: true, roomId: null, subjectId: 'slojd', dayOfWeek: 3, startMinutes: at(9), endMinutes: at(10), ...extra });
  const inRoom = (room: string, extra: Partial<FixedItem> = {}) => item({ roomId: room, subjectId: 'slojd', dayOfWeek: 3, startMinutes: at(9), endMinutes: at(10), ...extra });

  it('warns when the fixed lessons in rooms of the type hold every room there is', () => {
    const warnings = noRoomWarningsOf([inRoom('sal1'), inRoom('sal2'), pin(0)], facts);
    expect(warnings.get(0)).toEqual([{ code: 'NO_ROOM_FREE', refuses: true, params: { day: 3, start: '09:00', end: '10:00', roomType: 'Slöjdsal' } }]);
  });

  it('says nothing while a room is left, or at another time, or in the other week', () => {
    expect(noRoomWarningsOf([inRoom('sal1'), pin(0)], facts).size).toBe(0);
    expect(noRoomWarningsOf([inRoom('sal1'), inRoom('sal2', { startMinutes: at(10), endMinutes: at(11) }), pin(0)], facts).size).toBe(0);
    expect(noRoomWarningsOf([inRoom('sal1', { recurrence: 'ODD_WEEKS' }), inRoom('sal2', { recurrence: 'ODD_WEEKS' }), pin(0, { recurrence: 'EVEN_WEEKS' })], facts).size).toBe(0);
  });

  it('counts a lesson that overlaps only part of the pin’s hour, and one that begins inside it', () => {
    const late = [inRoom('sal1', { startMinutes: at(9, 30), endMinutes: at(10, 30) }), inRoom('sal2', { startMinutes: at(9, 45), endMinutes: at(10, 15) })];
    expect(noRoomWarningsOf([...late, pin(0)], facts).get(0)).toHaveLength(1);
    // Two lessons that are each beside the pin but never at the same moment leave a room at every moment.
    const apart = [inRoom('sal1', { startMinutes: at(9), endMinutes: at(9, 30) }), inRoom('sal2', { startMinutes: at(9, 30), endMinutes: at(10) })];
    expect(noRoomWarningsOf([...apart, pin(0)], facts).size).toBe(0);
  });

  it('counts the other pins, each of its own type, and warns every pin that has no room', () => {
    const warnings = noRoomWarningsOf([inRoom('sal1'), pin(0), pin(1)], facts);
    expect([...warnings.keys()].sort()).toEqual([0, 1]);
    // A pin of another type takes no slöjdsal.
    expect(noRoomWarningsOf([inRoom('sal1'), pin(0), pin(1, { subjectId: 'ma' })], facts).size).toBe(0);
  });

  it('asks a subject that needs a type, and not one that takes any room', () => {
    expect(noRoomWarningsOf([item({ row: 0, pin: true, roomId: null, subjectId: 'ma', dayOfWeek: 3, startMinutes: at(9), endMinutes: at(10) })], facts).size).toBe(0);
  });

  it('says there is none when the type has no room at all', () => {
    const bare: RoomFacts = { ...facts, roomsOfType: new Map() };
    expect(noRoomWarningsOf([pin(0)], bare).get(0)).toHaveLength(1);
  });

  it('asks a lesson with a room nothing: the judge has said whether the room is free', () => {
    expect(noRoomWarningsOf([inRoom('sal1', { row: 0 }), inRoom('sal2'), inRoom('sal1')], facts).size).toBe(0);
  });
});

describe('placementWarningsOf', () => {
  it('returns one list per row, in the teacher’s, the class’s and the room’s order, and the teachers whose post was read', () => {
    const items = [
      item({ row: 0, pin: true, roomId: null, subjectId: 'slojd', dayOfWeek: 1, startMinutes: at(10, 30), endMinutes: at(13) }),
      item({ row: 1, dayOfWeek: 2, startMinutes: at(8), endMinutes: at(9) }),
    ];
    const { byRow, hrTold } = placementWarningsOf({
      items,
      rows: 2,
      teacherRules: new Map([['anna', { ...cap(100), maxTeachingDaysPerWeek: 1 }]]),
      showsHr: true,
      lunch: { rule: { startMinutes: at(10, 30), endMinutes: at(13), minutes: 30 }, classes: new Set(['7A']), meals: [], year: { startDate: '2026-08-17', endDate: '2027-06-11' } },
      rooms: {
        typeOfRoom: new Map(),
        roomsOfType: new Map([['slojd', 0]]),
        typeOfSubject: new Map([['slojd', 'slojd']]),
        nameOfType: new Map([['slojd', 'Slöjdsal']]),
      },
    });
    expect(byRow[0]!.map((warning) => warning.code)).toEqual(['TEACHER_DAY_TOO_LONG', 'TEACHER_WEEK_TOO_MANY_DAYS', 'CLASS_HAS_NO_LUNCH', 'NO_ROOM_FREE']);
    expect(byRow[1]!.map((warning) => warning.code)).toEqual(['TEACHER_WEEK_TOO_MANY_DAYS']);
    expect(hrTold).toEqual(['anna']);
  });

  it('is empty for a week with no rule, no lunch and no pin', () => {
    const { byRow } = placementWarningsOf({ items: [item({ row: 0, dayOfWeek: 1, startMinutes: at(8), endMinutes: at(9) })], rows: 1, teacherRules: new Map(), showsHr: true, lunch: null, rooms: null });
    expect(byRow).toEqual([[]]);
  });
});
