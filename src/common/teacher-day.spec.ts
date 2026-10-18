import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import fixture from './__fixtures__/teacher-day-cases.json';
import {
  MAX_TEACHING_DAYS_PER_WEEK_MAX,
  MAX_TEACHING_DAYS_PER_WEEK_MIN,
  MAX_TEACHING_MINUTES_PER_DAY_MAX,
  MAX_TEACHING_MINUTES_PER_DAY_MIN,
  MAX_TEACHING_MINUTES_PER_DAY_STEP,
  NO_TEACHER_DAY_RULE,
  PREFERRED_FREE_DAY_MAX,
  PREFERRED_FREE_DAY_MIN,
  hasTeacherDayRule,
  lockedWeekdaySets,
  teacherDayBreaches,
  unionMinutes,
  type TeacherDayRule,
  type TeachingLesson,
} from './teacher-day';

/**
 * Lärarens dag, read twice, checked against one list of cases.
 *
 * This module decides what a hand edit of the grundschema is warned about
 * (master-lessons.service.ts) and what the Vikarietavla holds a cover to; the
 * engine's independent checker, benchmarks/validate_schedule.py, decides
 * whether a generated week kept the same rule. Neither can see the other, so
 * both replay src/common/__fixtures__/teacher-day-cases.json — the engine
 * only the cases it can state, every lesson every week with open dates, since
 * it has no weeks.
 *
 * The fixture was GENERATED from this implementation by a script that writes
 * nothing unless every case's breaches equal the ones written beside it by
 * hand (the script is in the commit message); never edit the JSON by hand.
 * The cases below it are the ones the fixture's shape cannot carry: the
 * arithmetic of a span, the bounds against the CHECKs, and the weeks read out
 * of three windows at once.
 */

interface FixtureLesson {
  id: string;
  dayOfWeek: number;
  start: string;
  end: string;
  recurrence?: TeachingLesson['recurrence'];
  startDate?: string | null;
  endDate?: string | null;
}

interface FixtureCase {
  name: string;
  rule: TeacherDayRule;
  lessons: FixtureLesson[];
  breaches: unknown[];
}

const cases = fixture.cases as unknown as FixtureCase[];

/** 'HH:MM' → minutes since midnight, as the fixture writes a clock. */
const clock = (value: string): number => {
  const [hours, minutes] = value.split(':').map(Number);
  return hours! * 60 + minutes!;
};

const teaching = (lesson: FixtureLesson): TeachingLesson => ({
  id: lesson.id,
  dayOfWeek: lesson.dayOfWeek,
  startMinutes: clock(lesson.start),
  endMinutes: clock(lesson.end),
  recurrence: lesson.recurrence,
  startDate: lesson.startDate,
  endDate: lesson.endDate,
});

describe('Lärarens dag agrees with the shared fixture', () => {
  it('reaches both kinds of breach, both together, and none', () => {
    const kinds = cases.map((c) =>
      [...new Set((c.breaches as Array<{ kind: string }>).map((b) => b.kind))].sort().join('+'),
    );
    expect(new Set(kinds)).toEqual(new Set(['', 'DAILY_CAP', 'WORK_DAYS', 'DAILY_CAP+WORK_DAYS']));
  });

  it('holds cases the engine can replay and cases only the weeks can tell apart', () => {
    // validate_schedule.py replays a case whose every lesson runs every week
    // with open dates; the rest are this module's alone. Both kinds must stay.
    const everyWeek = (c: FixtureCase) =>
      c.lessons.every(
        (lesson) =>
          (lesson.recurrence ?? 'ALL_WEEKS') === 'ALL_WEEKS' && lesson.startDate == null && lesson.endDate == null,
      );
    expect(cases.filter(everyWeek).length).toBeGreaterThan(5);
    expect(cases.filter((c) => !everyWeek(c)).length).toBeGreaterThan(5);
  });

  it.each(cases.map((c) => [c.name, c] as const))('%s', (_name, c) => {
    expect(teacherDayBreaches(c.rule, c.lessons.map(teaching))).toEqual(c.breaches);
  });
});

describe('the bounds are the CHECKs of 20261123090000', () => {
  // Read out of the migration rather than retyped: the DTOs and the engine
  // take these constants, and a bound that drifted from the database's would
  // be a value the form accepts and the write refuses.
  const sql = readFileSync(
    join(
      __dirname,
      '../../prisma/migrations/20261123090000_en_larares_dag_har_ett_tak_dagar_och_en_onskad_ledig_dag/migration.sql',
    ),
    'utf8',
  );
  const between = (column: string): [number, number] => {
    const found = new RegExp(`CHECK \\("${column}" BETWEEN (\\d+) AND (\\d+)`).exec(sql);
    if (!found) throw new Error(`no CHECK on ${column}`);
    return [Number(found[1]), Number(found[2])];
  };

  it('the cap: 30..720 minutes, a multiple of five', () => {
    expect(between('maxTeachingMinutesPerDay')).toEqual([
      MAX_TEACHING_MINUTES_PER_DAY_MIN,
      MAX_TEACHING_MINUTES_PER_DAY_MAX,
    ]);
    expect(sql).toContain(`"maxTeachingMinutesPerDay" % ${MAX_TEACHING_MINUTES_PER_DAY_STEP} = 0`);
  });

  it('the days: 1..6', () => {
    expect(between('maxTeachingDaysPerWeek')).toEqual([MAX_TEACHING_DAYS_PER_WEEK_MIN, MAX_TEACHING_DAYS_PER_WEEK_MAX]);
  });

  it('the wished free day: an ISO weekday', () => {
    expect(between('preferredFreeDayOfWeek')).toEqual([PREFERRED_FREE_DAY_MIN, PREFERRED_FREE_DAY_MAX]);
  });
});

describe('unionMinutes', () => {
  const span = (start: string, end: string) => ({ startMinutes: clock(start), endMinutes: clock(end) });

  it('is nothing for no spans', () => {
    expect(unionMinutes([])).toBe(0);
  });

  it('is a span’s own length', () => {
    expect(unionMinutes([span('08:00', '09:20')])).toBe(80);
  });

  it('adds spans apart from each other', () => {
    expect(unionMinutes([span('08:00', '09:00'), span('10:00', '10:40')])).toBe(100);
  });

  it('counts an overlap once', () => {
    expect(unionMinutes([span('08:00', '09:20'), span('09:00', '10:30')])).toBe(150);
  });

  it('counts a span inside another not at all', () => {
    expect(unionMinutes([span('08:00', '10:00'), span('08:30', '09:00')])).toBe(120);
  });

  it('counts the same span twice once', () => {
    expect(unionMinutes([span('08:00', '09:00'), span('08:00', '09:00')])).toBe(60);
  });

  it('joins spans that touch end to start', () => {
    expect(unionMinutes([span('08:00', '09:00'), span('09:00', '10:00')])).toBe(120);
  });

  it('reads the spans in clock order, whatever order they come in', () => {
    expect(
      unionMinutes([span('13:00', '14:00'), span('08:00', '09:00'), span('08:30', '10:00'), span('09:50', '10:10')]),
    ).toBe(190);
  });

  it('counts an empty or inverted span not at all', () => {
    expect(unionMinutes([span('09:00', '09:00')])).toBe(0);
    expect(unionMinutes([span('10:00', '09:00')])).toBe(0);
    expect(unionMinutes([span('10:00', '09:00'), span('08:00', '08:30')])).toBe(30);
  });
});

describe('teacherDayBreaches', () => {
  const lesson = (id: string, dayOfWeek: number, extra: Partial<TeachingLesson> = {}): TeachingLesson => ({
    id,
    dayOfWeek,
    startMinutes: clock('08:00'),
    endMinutes: clock('09:00'),
    ...extra,
  });

  it('a rule is a cap or a day limit; neither set is no rule', () => {
    expect(hasTeacherDayRule(NO_TEACHER_DAY_RULE)).toBe(false);
    expect(NO_TEACHER_DAY_RULE).toEqual({ maxTeachingMinutesPerDay: null, maxTeachingDaysPerWeek: null });
    expect(hasTeacherDayRule({ maxTeachingMinutesPerDay: 30, maxTeachingDaysPerWeek: null })).toBe(true);
    expect(hasTeacherDayRule({ maxTeachingMinutesPerDay: null, maxTeachingDaysPerWeek: 1 })).toBe(true);
  });

  it('says nothing of an empty week, whatever the rule', () => {
    expect(teacherDayBreaches({ maxTeachingMinutesPerDay: 30, maxTeachingDaysPerWeek: 1 }, [])).toEqual([]);
  });

  it('says nothing without a rule, however long the day', () => {
    expect(
      teacherDayBreaches(NO_TEACHER_DAY_RULE, [
        lesson('a', 1, { startMinutes: clock('07:00'), endMinutes: clock('19:00') }),
        lesson('b', 2),
      ]),
    ).toEqual([]);
  });

  it('looks three weeks before the earliest date for lessons open at the start, across a year of 53 weeks', () => {
    // a ends in 2027's week 2 and b runs every even week from the start: they
    // meet only in even weeks up to the end of 2026 — week 52, the last even
    // one, since week 53 and 2027's week 1 are both odd. Only a week sampled
    // before a's end date, of the even parity, sees them together.
    const rule = { maxTeachingMinutesPerDay: null, maxTeachingDaysPerWeek: 1 };
    const a = lesson('a', 5, { endDate: '2027-01-11' });
    const b = lesson('b', 1, { recurrence: 'EVEN_WEEKS' });
    expect(teacherDayBreaches(rule, [a, b])).toEqual([
      { kind: 'WORK_DAYS', days: 2, max: 1, lessonIds: ['a', 'b'] },
    ]);
    // The earliest date is the earliest of them all, whichever lesson comes
    // first: c starts long after a has ended, and still meets b.
    const c = lesson('c', 3, { startDate: '2027-06-01' });
    expect(teacherDayBreaches(rule, [c, b, a])).toEqual([
      { kind: 'WORK_DAYS', days: 2, max: 1, lessonIds: ['a', 'b', 'c'] },
    ]);
  });

  it('a lesson that takes no time makes no teaching day, and is named in no breach', () => {
    const rule = { maxTeachingMinutesPerDay: 60, maxTeachingDaysPerWeek: 1 };
    expect(
      teacherDayBreaches(rule, [
        lesson('a', 1),
        lesson('empty', 2, { startMinutes: clock('10:00'), endMinutes: clock('10:00') }),
        lesson('inverted', 3, { startMinutes: clock('11:00'), endMinutes: clock('10:00') }),
      ]),
    ).toEqual([]);
    expect(
      teacherDayBreaches(rule, [
        lesson('empty', 2, { startMinutes: clock('10:00'), endMinutes: clock('10:00') }),
      ]),
    ).toEqual([]);
    expect(teacherDayBreaches(rule, [lesson('a', 1), lesson('b', 2), lesson('empty', 2, {
      startMinutes: clock('10:00'),
      endMinutes: clock('10:00'),
    })])).toEqual([{ kind: 'WORK_DAYS', days: 2, max: 1, lessonIds: ['a', 'b'] }]);
  });

  it('a lesson with no recurrence runs every week, in both parities', () => {
    // Without the default the lesson would be in neither parity's weeks, and
    // the Monday would hold the odd lesson alone.
    expect(
      teacherDayBreaches({ maxTeachingMinutesPerDay: 90, maxTeachingDaysPerWeek: null }, [
        lesson('a', 1),
        lesson('b', 1, { startMinutes: clock('10:00'), endMinutes: clock('11:00'), recurrence: 'ODD_WEEKS' }),
      ]),
    ).toEqual([{ kind: 'DAILY_CAP', dayOfWeek: 1, minutes: 120, cap: 90, lessonIds: ['a', 'b'] }]);
  });

  /*
   * THE WEEKS ARE ISO WEEKS, as publishing reads them: a lesson is in a week
   * when it runs on its own weekday's date of that week. A set of lessons that
   * runs in some week is inside the set of the first week with that week's
   * parity from the latest first week among them, so three windows that
   * overlap pairwise share a week (intervals on a line do), and three that
   * only chain do not. The fixture carries most cases where a date and a week
   * disagree; these are the windows read three at a time, and a start that
   * misses its weekday by a day.
   */
  describe('the weeks of three windows', () => {
    const DAYS = { maxTeachingMinutesPerDay: null, maxTeachingDaysPerWeek: 2 };

    it('three that overlap pairwise run in one week', () => {
      expect(
        teacherDayBreaches(DAYS, [
          lesson('a', 1, { startDate: '2026-08-17', endDate: '2026-10-30' }),
          lesson('b', 2, { startDate: '2026-09-01', endDate: '2026-12-18' }),
          lesson('c', 3, { startDate: '2026-10-01', endDate: null }),
        ]),
      ).toEqual([{ kind: 'WORK_DAYS', days: 3, max: 2, lessonIds: ['a', 'b', 'c'] }]);
    });

    it('three that only chain never run in one week', () => {
      const chain = [
        lesson('a', 1, { startDate: '2026-08-17', endDate: '2026-09-30' }),
        lesson('b', 2, { startDate: '2026-09-15', endDate: '2026-11-30' }),
        lesson('c', 3, { startDate: '2026-10-15', endDate: null }),
      ];
      expect(teacherDayBreaches(DAYS, chain)).toEqual([]);
      // Each link is two days, so a limit of one names every lesson of a link.
      expect(teacherDayBreaches({ ...DAYS, maxTeachingDaysPerWeek: 1 }, chain)).toEqual([
        { kind: 'WORK_DAYS', days: 2, max: 1, lessonIds: ['a', 'b', 'c'] },
      ]);
    });

    it('a parity and a window together: the odd autumn lesson never meets the even week', () => {
      // Odd weeks hold a in the autumn and c in the spring, never both; even
      // weeks hold b all year and c from January: two days, over a limit of one.
      expect(
        teacherDayBreaches({ maxTeachingMinutesPerDay: null, maxTeachingDaysPerWeek: 1 }, [
          lesson('a', 1, { recurrence: 'ODD_WEEKS', startDate: '2026-08-17', endDate: '2026-12-18' }),
          lesson('b', 2, { recurrence: 'EVEN_WEEKS' }),
          lesson('c', 3, { startDate: '2027-01-11', endDate: null }),
        ]),
      ).toEqual([{ kind: 'WORK_DAYS', days: 2, max: 1, lessonIds: ['b', 'c'] }]);
    });

    it('a lesson counts in the week it starts', () => {
      // Both start on one Monday, which holds both.
      expect(
        teacherDayBreaches({ maxTeachingMinutesPerDay: 90, maxTeachingDaysPerWeek: null }, [
          lesson('a', 1, { startDate: '2027-01-11' }),
          lesson('b', 1, { startMinutes: clock('10:00'), endMinutes: clock('11:00'), startDate: '2027-01-11' }),
        ]),
      ).toEqual([{ kind: 'DAILY_CAP', dayOfWeek: 1, minutes: 120, cap: 90, lessonIds: ['a', 'b'] }]);
    });

    it('a lesson that starts after its weekday has passed is first taught the week after', () => {
      // a starts on Tuesday 20 October, so its first Monday is the 26th; b's
      // last Monday is the 19th, though its window runs to the Sunday.
      const rule = { maxTeachingMinutesPerDay: 90, maxTeachingDaysPerWeek: null };
      const b = lesson('b', 1, { startMinutes: clock('10:00'), endMinutes: clock('11:00'), endDate: '2026-10-25' });
      expect(teacherDayBreaches(rule, [lesson('a', 1, { startDate: '2026-10-20' }), b])).toEqual([]);
      // Started on the Monday itself, it is.
      expect(teacherDayBreaches(rule, [lesson('a', 1, { startDate: '2026-10-19' }), b])).toEqual([
        { kind: 'DAILY_CAP', dayOfWeek: 1, minutes: 120, cap: 90, lessonIds: ['a', 'b'] },
      ]);
    });
  });

  /*
   * ABOUT THE LESSONS AN EDIT WROTE: only the weeks that hold one of them
   * count, for the figure and for the lessons named — the hand edit's warning
   * (master-lessons.service.ts) says what the edit made, not what another
   * week already held.
   */
  describe('about the lessons an edit wrote', () => {
    const CAP = { maxTeachingMinutesPerDay: 90, maxTeachingDaysPerWeek: null };

    it('the cap’s minutes are the edit’s weeks’, not a week of the other parity already over', () => {
      // Odd Mondays were 120 minutes before the edit; x makes even Mondays 100.
      const week = [
        lesson('p', 1, { endMinutes: clock('10:00'), recurrence: 'ODD_WEEKS' }),
        lesson('y', 1, { endMinutes: clock('08:40'), recurrence: 'EVEN_WEEKS' }),
        lesson('x', 1, { startMinutes: clock('11:00'), endMinutes: clock('12:00'), recurrence: 'EVEN_WEEKS' }),
      ];
      expect(teacherDayBreaches(CAP, week)).toEqual([
        { kind: 'DAILY_CAP', dayOfWeek: 1, minutes: 120, cap: 90, lessonIds: ['p', 'x', 'y'] },
      ]);
      expect(teacherDayBreaches(CAP, week, new Set(['x']))).toEqual([
        { kind: 'DAILY_CAP', dayOfWeek: 1, minutes: 100, cap: 90, lessonIds: ['x', 'y'] },
      ]);
      // An edit on the odd Mondays is told the odd week's figure.
      expect(teacherDayBreaches(CAP, week, new Set(['p']))).toEqual([
        { kind: 'DAILY_CAP', dayOfWeek: 1, minutes: 120, cap: 90, lessonIds: ['p'] },
      ]);
    });

    it('a weekday the edit is not on is not its to repeat, though its weeks hold the edit', () => {
      const week = [
        lesson('m1', 1),
        lesson('m2', 1, { startMinutes: clock('10:00'), endMinutes: clock('11:00') }),
        lesson('x', 2),
      ];
      expect(teacherDayBreaches(CAP, week)).toEqual([
        { kind: 'DAILY_CAP', dayOfWeek: 1, minutes: 120, cap: 90, lessonIds: ['m1', 'm2'] },
      ]);
      expect(teacherDayBreaches(CAP, week, new Set(['x']))).toEqual([]);
    });

    it('the days are the edit’s weeks’ too', () => {
      // Odd weeks were four days before the edit; z makes even weeks three.
      const week = [
        ...[1, 2, 3, 4].map((day) => lesson(`odd${day}`, day, { recurrence: 'ODD_WEEKS' })),
        lesson('x', 1, { recurrence: 'EVEN_WEEKS' }),
        lesson('y', 2, { recurrence: 'EVEN_WEEKS' }),
        lesson('z', 5, { recurrence: 'EVEN_WEEKS' }),
      ];
      const DAYS = { maxTeachingMinutesPerDay: null, maxTeachingDaysPerWeek: 2 };
      expect(teacherDayBreaches(DAYS, week)).toEqual([
        { kind: 'WORK_DAYS', days: 4, max: 2, lessonIds: ['odd1', 'odd2', 'odd3', 'odd4', 'x', 'y', 'z'] },
      ]);
      expect(teacherDayBreaches(DAYS, week, new Set(['z']))).toEqual([
        { kind: 'WORK_DAYS', days: 3, max: 2, lessonIds: ['x', 'y', 'z'] },
      ]);
      // Nor is a week over the limit before the edit, which the edit keeps under it.
      expect(teacherDayBreaches({ ...DAYS, maxTeachingDaysPerWeek: 3 }, week, new Set(['z']))).toEqual([]);
    });
  });

  it('names the lessons of a breach sorted, whatever order the week came in', () => {
    expect(
      teacherDayBreaches({ maxTeachingMinutesPerDay: 60, maxTeachingDaysPerWeek: null }, [
        lesson('z', 4, { startMinutes: clock('10:00'), endMinutes: clock('11:00') }),
        lesson('m', 4),
      ]),
    ).toEqual([{ kind: 'DAILY_CAP', dayOfWeek: 4, minutes: 120, cap: 60, lessonIds: ['m', 'z'] }]);
  });
});

/*
 * THE WEEKDAYS THE GENERATOR IS TOLD A TEACHER'S KEPT LESSONS HOLD, one set
 * per real week (AnonymousTeacherDayLimit.lockedWeekdays): it counts a lesson
 * it places as a day of every week whose set lacks that weekday, so the
 * sets must be the weeks' own and not their union, and a set may be left
 * out only where a larger one of at most the limit's days implies it.
 */
describe('lockedWeekdaySets', () => {
  const lesson = (id: string, dayOfWeek: number, extra: Partial<TeachingLesson> = {}): TeachingLesson => ({
    id,
    dayOfWeek,
    startMinutes: clock('08:00'),
    endMinutes: clock('09:00'),
    ...extra,
  });

  it('is the empty week alone for a teacher with no kept lesson', () => {
    expect(lockedWeekdaySets([], 2)).toEqual([[]]);
  });

  it('a lesson that takes no time holds no weekday', () => {
    const empty = lesson('empty', 2, { startMinutes: clock('10:00'), endMinutes: clock('10:00') });
    const inverted = lesson('inverted', 3, { startMinutes: clock('11:00'), endMinutes: clock('10:00') });
    expect(lockedWeekdaySets([empty, inverted], 2)).toEqual([[]]);
    expect(lockedWeekdaySets([lesson('a', 1), empty], 2)).toEqual([[1]]);
  });

  it('every-week lessons hold their weekdays in every week, and no week is empty', () => {
    expect(lockedWeekdaySets([lesson('t', 2), lesson('m', 1), lesson('m2', 1, { startMinutes: clock('10:00') })], 4)).toEqual([
      [1, 2],
    ]);
  });

  it('odd weeks’ Monday and Tuesday and even weeks’ Wednesday and Thursday are two weeks of two days, not four', () => {
    // The review's part-timer, on a post of two days: every real week is
    // within it. Read as the union, the engine had no day left to count and
    // let a weekly Monday and Wednesday make every week three.
    const week = [
      lesson('w', 3, { recurrence: 'EVEN_WEEKS' }),
      lesson('th', 4, { recurrence: 'EVEN_WEEKS' }),
      lesson('m', 1, { recurrence: 'ODD_WEEKS' }),
      lesson('tu', 2, { recurrence: 'ODD_WEEKS' }),
    ];
    expect(lockedWeekdaySets(week, 2)).toEqual([
      [1, 2],
      [3, 4],
    ]);
  });

  it('an autumn’s Monday and Tuesday and a spring’s Thursday and Friday are two sets, the weeks between them implied', () => {
    // Before the autumn, over Christmas and after the spring nothing is
    // kept: those weeks' empty set lies inside either term's, of two days.
    const week = [
      lesson('th', 4, { startDate: '2027-01-11', endDate: '2027-06-11' }),
      lesson('fr', 5, { startDate: '2027-01-11', endDate: '2027-06-11' }),
      lesson('m', 1, { startDate: '2026-08-17', endDate: '2026-12-18' }),
      lesson('tu', 2, { startDate: '2026-08-17', endDate: '2026-12-18' }),
    ];
    expect(lockedWeekdaySets(week, 2)).toEqual([
      [1, 2],
      [4, 5],
    ]);
    // On a post of one day both terms' kept lessons are over it alone, so
    // the empty weeks are implied by neither, and say the limit as it reads
    // without locks.
    expect(lockedWeekdaySets(week, 1)).toEqual([[], [1, 2], [4, 5]]);
  });

  it('leaves out a week’s set inside a larger one of at most the limit’s days', () => {
    // Monday every week, Tuesday the odd ones: the even weeks' Monday lies
    // inside the odd weeks' Monday and Tuesday.
    const week = [lesson('m', 1), lesson('tu', 2, { recurrence: 'ODD_WEEKS' })];
    expect(lockedWeekdaySets(week, 3)).toEqual([[1, 2]]);
    expect(lockedWeekdaySets(week, 2)).toEqual([[1, 2]]);
  });

  it('keeps a smaller week’s set that is not inside the larger, whatever the limit', () => {
    // Monday in odd weeks, Tuesday and Wednesday in even ones: the odd weeks
    // may take two days off Monday, the even weeks one off Tuesday and
    // Wednesday, and neither bound says the other. Size alone is not
    // implication.
    const week = [
      lesson('m', 1, { recurrence: 'ODD_WEEKS' }),
      lesson('tu', 2, { recurrence: 'EVEN_WEEKS' }),
      lesson('w', 3, { recurrence: 'EVEN_WEEKS' }),
    ];
    expect(lockedWeekdaySets(week, 3)).toEqual([[1], [2, 3]]);
  });

  it('keeps a week’s set inside a larger one over the limit, which does not imply it', () => {
    // Monday to Wednesday in odd weeks and Monday alone in even ones, on a
    // post of two days: the odd weeks allow nothing off Monday to Wednesday,
    // and a placed Tuesday and Wednesday would fit that and give the even
    // weeks three days. Their Monday is said too.
    const week = [
      lesson('m', 1),
      lesson('tu', 2, { recurrence: 'ODD_WEEKS' }),
      lesson('w', 3, { recurrence: 'ODD_WEEKS' }),
    ];
    expect(lockedWeekdaySets(week, 2)).toEqual([[1], [1, 2, 3]]);
    // On a post of three the odd weeks are within it, and imply the even.
    expect(lockedWeekdaySets(week, 3)).toEqual([[1, 2, 3]]);
  });

  describe('given the läsår, only its weeks', () => {
    const year = { startDate: '2026-08-17', endDate: '2027-06-11' };

    it('reads no week before the year starts or after it ends', () => {
      // An undated Monday and a Tuesday dated over the whole year, on a post
      // of one day: every week the school has holds both. Unbounded, the
      // weeks before 17 August and after 11 June add a Monday alone, which —
      // inside a set over the limit — would hold the generator to it.
      const week = [lesson('m', 1), lesson('tu', 2, { startDate: '2026-08-17', endDate: '2027-06-11' })];
      expect(lockedWeekdaySets(week, 1)).toEqual([[1], [1, 2]]);
      expect(lockedWeekdaySets(week, 1, year)).toEqual([[1, 2]]);
    });

    it('keeps a real week of the year that a dated lesson has left', () => {
      // The Tuesday ends at Christmas: the spring's weeks hold Monday alone.
      const week = [lesson('m', 1), lesson('tu', 2, { startDate: '2026-08-17', endDate: '2026-12-18' })];
      expect(lockedWeekdaySets(week, 1, year)).toEqual([[1], [1, 2]]);
    });

    it('reads a week that holds the year’s first day, and its last', () => {
      // The year starts on a Wednesday and ends on a Tuesday. The first week's
      // Monday lies before the year and the last week's Friday after it, but
      // both weeks are the year's: a Wednesday in the first and a Tuesday in
      // the last are each a week's set. (The weeks between hold neither, and
      // their empty set lies inside each of these, of at most one day.)
      const short = { startDate: '2026-08-19', endDate: '2027-06-08' };
      const week = [
        lesson('w', 3, { startDate: '2026-08-19', endDate: '2026-08-21' }),
        lesson('tu', 2, { startDate: '2027-06-08', endDate: '2027-06-08' }),
      ];
      expect(lockedWeekdaySets(week, 1, short)).toEqual([[2], [3]]);
    });

    it('holds undated lessons to the year’s own first weeks, both parities', () => {
      const week = [lesson('o', 1, { recurrence: 'ODD_WEEKS' }), lesson('e', 4, { recurrence: 'EVEN_WEEKS' })];
      expect(lockedWeekdaySets(week, 1, year)).toEqual([[1], [4]]);
      expect(lockedWeekdaySets([], 1, year)).toEqual([[]]);
    });
  });

  it('reads the week after a lesson ends, whose set no week around a start holds', () => {
    // a runs Mondays in September, b Tuesdays from mid-September to the new
    // year: September's first weeks hold Monday, its last both, and October
    // to December Tuesday alone — a set found only after a's end. On a post
    // of one day the weeks of both are over it, and neither single day is
    // implied by them.
    const week = [
      lesson('a', 1, { startDate: '2026-09-01', endDate: '2026-09-30' }),
      lesson('b', 2, { startDate: '2026-09-15', endDate: '2026-12-31' }),
    ];
    expect(lockedWeekdaySets(week, 1)).toEqual([[1], [1, 2], [2]]);
    // On a post of two the weeks of both imply every other.
    expect(lockedWeekdaySets(week, 2)).toEqual([[1, 2]]);
  });

  it('reads three weeks from the first week after an end, which across week 53 reach an even one', () => {
    // a's last Monday is its end date, 21 December 2026 (week 52); weeks 53
    // and 2027's 1 are both odd, so the even weeks' Tuesday alone is first
    // taught in week 2 — the third week after the end, and only the third
    // when the weeks are counted from the week after the end's own.
    const week = [lesson('a', 1, { endDate: '2026-12-21' }), lesson('b', 2, { recurrence: 'EVEN_WEEKS' })];
    expect(lockedWeekdaySets(week, 1)).toEqual([[1], [1, 2], [2]]);
  });

  it('counts a weekday off the school’s days like any other', () => {
    expect(lockedWeekdaySets([lesson('sat', 6), lesson('m', 1)], 2)).toEqual([[1, 6]]);
  });
});
