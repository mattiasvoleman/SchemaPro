import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { isoWeekNumber, runsOn } from '../calendar/lesson-recurrence';
import { weekPeriodsOfUndatedYear, yearPeriodsOf } from '../optimization/year-periods';
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
  lockedWeekdaySetsByPeriod,
  teacherDayBreaches,
  unionMinutes,
  type TeacherDayRule,
  type TeachingLesson,
  type LockedWeekdaysInPeriods,
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

  it('a rule is a cap, a day limit or a limit on teaching in a row; none set is no rule', () => {
    expect(hasTeacherDayRule(NO_TEACHER_DAY_RULE)).toBe(false);
    expect(NO_TEACHER_DAY_RULE).toEqual({
      maxTeachingMinutesPerDay: null,
      maxTeachingDaysPerWeek: null,
      maxConsecutiveTeachingMinutes: null,
      consecutiveBreakMinutes: null,
    });
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

describe('lockedWeekdaySetsByPeriod', () => {
  const year = { startDate: '2026-08-17', endDate: '2027-06-11' };
  const AUTUMN = { startDate: null, endDate: '2026-12-18' };
  const SPRING = { startDate: '2027-01-11', endDate: null };
  const lesson = (id: string, dayOfWeek: number, extra: Partial<TeachingLesson> = {}): TeachingLesson => ({
    id,
    dayOfWeek,
    startMinutes: clock('08:00'),
    endMinutes: clock('09:00'),
    ...extra,
  });
  /** The läsår cut as the payload cuts it: by the windows of what it sends. */
  const cut = (...windows: { startDate: string | null; endDate: string | null }[]) =>
    yearPeriodsOf(
      year,
      windows.map((window) => [window]),
    )!;

  it('holds the autumn’s Monday in the autumn, and the empty week in the rest of the year', () => {
    // The review's part-timer (#300, MEDEL-1): two days a week, a kept Monday
    // that runs until Christmas, and the spring's posts on other days. Three
    // periods: the autumn, the weeks between the terms, the spring.
    const periods = cut(AUTUMN, SPRING);
    expect(periods.weeks).toEqual([18, 3, 22]);
    const kept = [lesson('m', 1, AUTUMN)];
    expect(lockedWeekdaySets(kept, 2, year)).toEqual([[1]]);
    expect(lockedWeekdaySetsByPeriod(kept, 2, year, periods.weekPeriods)).toEqual([
      { weekdays: [], periods: [false, true, true] },
      { weekdays: [1], periods: [true, false, false] },
    ]);
  });

  it('is null when every period holds the same weeks: the sets say it already', () => {
    const periods = cut(AUTUMN, SPRING);
    expect(lockedWeekdaySetsByPeriod([lesson('m', 1), lesson('tu', 2)], 2, year, periods.weekPeriods)).toBeNull();
    expect(lockedWeekdaySetsByPeriod([], 2, year, periods.weekPeriods)).toBeNull();
    // Odd and even weeks that hold the same weekday are the same set in both parities.
    const same = [lesson('o', 1, { recurrence: 'ODD_WEEKS' }), lesson('e', 1, { recurrence: 'EVEN_WEEKS' })];
    expect(lockedWeekdaySetsByPeriod(same, 1, year, periods.weekPeriods)).toBeNull();
  });

  it('sends the parity where a period’s odd and even weeks hold other sets, and only then', () => {
    // Odd weeks' Monday and even weeks' Thursday, all year: another set in the
    // two weeks of every period. Held both in every week, as the engine did, the
    // odd weeks were refused the Thursday the even weeks' lesson takes.
    const periods = cut(AUTUMN, SPRING);
    const alternating = [lesson('o', 1, { recurrence: 'ODD_WEEKS' }), lesson('e', 4, { recurrence: 'EVEN_WEEKS' })];
    expect(lockedWeekdaySetsByPeriod(alternating, 1, year, periods.weekPeriods)).toEqual([
      { weekdays: [1], periods: [true, true, true], recurrence: 'ODD_WEEKS' },
      { weekdays: [4], periods: [true, true, true], recurrence: 'EVEN_WEEKS' },
    ]);
    // A period where they agree has the set once, for both: the autumn alternates, the spring does not.
    const kept = [
      lesson('o', 1, { ...AUTUMN, recurrence: 'ODD_WEEKS' }),
      lesson('e', 4, { ...AUTUMN, recurrence: 'EVEN_WEEKS' }),
      lesson('w', 3, SPRING),
    ];
    expect(lockedWeekdaySetsByPeriod(kept, 1, year, periods.weekPeriods)).toEqual([
      { weekdays: [], periods: [false, true, false] },
      { weekdays: [1], periods: [true, false, false], recurrence: 'ODD_WEEKS' },
      { weekdays: [3], periods: [false, false, true] },
      { weekdays: [4], periods: [true, false, false], recurrence: 'EVEN_WEEKS' },
    ]);
  });

  it('is one period in a year nothing dates: the parity says the sets apart, and nothing else does', () => {
    // The review of #320, MEDEL-1: a school with A/B-weeks that dates no post has no periods, and its
    // teacher's odd weeks (a Monday) and even weeks (a Thursday) were held against both sets.
    const one = weekPeriodsOfUndatedYear(year);
    expect(one.length).toBe(43);
    expect(one.every((period) => period === 0)).toBe(true);
    const alternating = [lesson('o', 1, { recurrence: 'ODD_WEEKS' }), lesson('e', 4, { recurrence: 'EVEN_WEEKS' })];
    expect(lockedWeekdaySetsByPeriod(alternating, 1, year, one)).toEqual([
      { weekdays: [1], periods: [true], recurrence: 'ODD_WEEKS' },
      { weekdays: [4], periods: [true], recurrence: 'EVEN_WEEKS' },
    ]);
    // Where the two parities hold the same sets, or the lessons are every week's, the sets say it already.
    const same = [lesson('o', 1, { recurrence: 'ODD_WEEKS' }), lesson('e', 1, { recurrence: 'EVEN_WEEKS' })];
    expect(lockedWeekdaySetsByPeriod(same, 1, year, one)).toBeNull();
    expect(lockedWeekdaySetsByPeriod([lesson('m', 1), lesson('tu', 2)], 2, year, one)).toBeNull();
    expect(lockedWeekdaySetsByPeriod([], 2, year, one)).toBeNull();
    // The odd weeks' one day and the even weeks' two: each parity is its own line.
    const inside = [
      lesson('o', 1, { recurrence: 'ODD_WEEKS' }),
      lesson('e', 1, { recurrence: 'EVEN_WEEKS' }),
      lesson('e2', 2, { recurrence: 'EVEN_WEEKS' }),
    ];
    expect(lockedWeekdaySetsByPeriod(inside, 2, year, one)).toEqual([
      { weekdays: [1], periods: [true], recurrence: 'ODD_WEEKS' },
      { weekdays: [1, 2], periods: [true], recurrence: 'EVEN_WEEKS' },
    ]);
  });

  it('holds a set in both parities of one period and in one parity of another: one entry for each', () => {
    // Monday every week in the autumn and the spring's odd weeks, Tuesday in the spring's even ones.
    const periods = cut(AUTUMN, SPRING);
    const kept = [
      lesson('m', 1, AUTUMN),
      lesson('m2', 1, { ...SPRING, recurrence: 'ODD_WEEKS' }),
      lesson('tu', 2, { ...SPRING, recurrence: 'EVEN_WEEKS' }),
    ];
    expect(lockedWeekdaySetsByPeriod(kept, 1, year, periods.weekPeriods)).toEqual([
      { weekdays: [], periods: [false, true, false] },
      { weekdays: [1], periods: [true, false, false] },
      { weekdays: [1], periods: [false, false, true], recurrence: 'ODD_WEEKS' },
      { weekdays: [2], periods: [false, false, true], recurrence: 'EVEN_WEEKS' },
    ]);
  });

  it('leaves a set out only where the same period holds the larger one', () => {
    // Monday all year, Tuesday in the spring. Over the year, {Mon} lies inside
    // {Mon, Tue} and is left out; held by period, the autumn has no other set
    // than {Mon}, and without it the autumn would have no line at all.
    const periods = cut(AUTUMN, SPRING);
    const kept = [lesson('m', 1), lesson('tu', 2, SPRING)];
    expect(lockedWeekdaySets(kept, 2, year)).toEqual([[1, 2]]);
    expect(lockedWeekdaySetsByPeriod(kept, 2, year, periods.weekPeriods)).toEqual([
      { weekdays: [1], periods: [true, true, false] },
      { weekdays: [1, 2], periods: [false, false, true] },
    ]);
  });

  it('keeps a set inside one the kept lessons alone put over the post, period by period', () => {
    // Odd weeks hold Monday, even weeks Monday to Wednesday, in the autumn; a
    // post of two days. {Mon} is not implied by a set of three, as over the
    // year, and the spring holds the empty week.
    const periods = cut(AUTUMN, SPRING);
    const kept = [
      lesson('m', 1, AUTUMN),
      lesson('tu', 2, { ...AUTUMN, recurrence: 'EVEN_WEEKS' }),
      lesson('w', 3, { ...AUTUMN, recurrence: 'EVEN_WEEKS' }),
    ];
    const sent = [
      { weekdays: [], periods: [false, true, true] },
      { weekdays: [1], periods: [true, false, false], recurrence: 'ODD_WEEKS' },
      { weekdays: [1, 2, 3], periods: [true, false, false], recurrence: 'EVEN_WEEKS' },
    ];
    expect(lockedWeekdaySetsByPeriod(kept, 2, year, periods.weekPeriods)).toEqual(sent);
    // On a post of three the larger set is held by the even weeks and the smaller one by the odd: a
    // week is held against the sets of its own parity, so nothing is left out across the two.
    expect(lockedWeekdaySetsByPeriod(kept, 3, year, periods.weekPeriods)).toEqual(sent);
  });

  it('compares what each parity holds in full: two pools of the same size that share only some sets differ', () => {
    // One period for the whole läsår. The odd weeks hold {Mon} until Wednesday 20 January and {Mon, Tue}
    // after it; the even weeks {Mon} until Wednesday 3 February and {Mon, Wed} after it. Two sets each,
    // one of them the same: other sets, so the parity is sent (on a post of one day nothing is left out).
    const whole = yearPeriodsOf(year, [[{ startDate: '2027-02-03', endDate: null }]])!;
    const oneYear = whole.weekPeriods.map(() => 0);
    const kept = [
      lesson('m', 1),
      lesson('tu', 2, { startDate: '2027-01-20', endDate: null, recurrence: 'ODD_WEEKS' }),
      lesson('w', 3, { startDate: '2027-02-03', endDate: null, recurrence: 'EVEN_WEEKS' }),
    ];
    expect(lockedWeekdaySetsByPeriod(kept, 1, year, oneYear)).toEqual([
      { weekdays: [1], periods: [true], recurrence: 'ODD_WEEKS' },
      { weekdays: [1], periods: [true], recurrence: 'EVEN_WEEKS' },
      { weekdays: [1, 2], periods: [true], recurrence: 'ODD_WEEKS' },
      { weekdays: [1, 3], periods: [true], recurrence: 'EVEN_WEEKS' },
    ]);
  });

  it('writes a set without a parity before the same set held by one, in the order of the weekdays', () => {
    // The autumn's odd weeks hold Monday and its even weeks Tuesday; the spring holds Monday every week.
    // {Mon} is held by the odd weeks of the first period and by both parities of the last: the one
    // without a parity first, then the odd weeks', then the sets of the next weekday.
    const periods = cut(AUTUMN, SPRING);
    const kept = [
      lesson('o', 1, { ...AUTUMN, recurrence: 'ODD_WEEKS' }),
      lesson('e', 2, { ...AUTUMN, recurrence: 'EVEN_WEEKS' }),
      lesson('m', 1, SPRING),
    ];
    expect(lockedWeekdaySetsByPeriod(kept, 2, year, periods.weekPeriods)).toEqual([
      { weekdays: [], periods: [false, true, false] },
      { weekdays: [1], periods: [false, false, true] },
      { weekdays: [1], periods: [true, false, false], recurrence: 'ODD_WEEKS' },
      { weekdays: [2], periods: [true, false, false], recurrence: 'EVEN_WEEKS' },
    ]);
  });

  it('leaves a set out inside a period and a parity only, and compares the sets after it', () => {
    // A Monday and a Tuesday kept from Wednesday 13 January: the week of the 11th, an even one, holds
    // neither. On a post of two days {} lies inside {Mon, Tue} in the even weeks and is left out, so both
    // parities hold {Mon, Tue} and the spring is the one set it always was. On a post of one day it
    // is not inside it, and the odd weeks hold {Mon, Tue} alone while the even weeks hold it and the empty week.
    const from = { startDate: '2027-01-13', endDate: null };
    const periods = cut(from);
    const kept = [lesson('m', 1, from), lesson('tu', 2, from)];
    expect(lockedWeekdaySetsByPeriod(kept, 2, year, periods.weekPeriods)).toEqual([
      { weekdays: [], periods: [true, false] },
      { weekdays: [1, 2], periods: [false, true] },
    ]);
    expect(lockedWeekdaySetsByPeriod(kept, 1, year, periods.weekPeriods)).toEqual([
      { weekdays: [], periods: [true, false] },
      { weekdays: [], periods: [false, true], recurrence: 'EVEN_WEEKS' },
      { weekdays: [1, 2], periods: [false, true], recurrence: 'ODD_WEEKS' },
      { weekdays: [1, 2], periods: [false, true], recurrence: 'EVEN_WEEKS' },
    ]);
  });

  it('reads the week a kept lesson’s window touches before its own weekday comes', () => {
    // A Monday and a Tuesday kept from Wednesday 13 January: the week of the
    // 11th is in their period (the window has a day in it) and holds neither
    // of them. On a post of one day the two together are over it, so the
    // empty week is a line of its own in the spring too: it is an even week,
    // and the odd weeks of the spring are not held against it.
    const from = { startDate: '2027-01-13', endDate: null };
    const periods = cut(from);
    const kept = [lesson('m', 1, from), lesson('tu', 2, from)];
    expect(lockedWeekdaySetsByPeriod(kept, 1, year, periods.weekPeriods)).toEqual([
      { weekdays: [], periods: [true, false] },
      { weekdays: [], periods: [false, true], recurrence: 'EVEN_WEEKS' },
      { weekdays: [1, 2], periods: [false, true], recurrence: 'ODD_WEEKS' },
      { weekdays: [1, 2], periods: [false, true], recurrence: 'EVEN_WEEKS' },
    ]);
  });

  it('a lesson that takes no time holds no weekday', () => {
    const periods = cut(AUTUMN, SPRING);
    const empty = lesson('empty', 2, { ...AUTUMN, startMinutes: clock('10:00'), endMinutes: clock('10:00') });
    expect(lockedWeekdaySetsByPeriod([empty], 2, year, periods.weekPeriods)).toBeNull();
  });

  it('leaves out no set that only shares a weekday with a larger one', () => {
    // A post of three days. The autumn's odd weeks hold Monday and Tuesday,
    // its even weeks Tuesday to Thursday: the two share the Tuesday and
    // neither lies inside the other, so both are the autumn's lines. Read as
    // "some weekday of the smaller is in the larger", Monday's weeks would
    // have no line and the engine could fill them with three other days.
    const periods = cut(AUTUMN, SPRING);
    const kept = [
      lesson('tu', 2, AUTUMN),
      lesson('m', 1, { ...AUTUMN, recurrence: 'ODD_WEEKS' }),
      lesson('w', 3, { ...AUTUMN, recurrence: 'EVEN_WEEKS' }),
      lesson('th', 4, { ...AUTUMN, recurrence: 'EVEN_WEEKS' }),
    ];
    const sent = [
      { weekdays: [], periods: [false, true, true] },
      { weekdays: [1, 2], periods: [true, false, false], recurrence: 'ODD_WEEKS' },
      { weekdays: [2, 3, 4], periods: [true, false, false], recurrence: 'EVEN_WEEKS' },
    ];
    expect(lockedWeekdaySetsByPeriod(kept, 3, year, periods.weekPeriods)).toEqual(sent);
    // On a post of four the same: inside is every weekday, not one of them.
    expect(lockedWeekdaySetsByPeriod(kept, 4, year, periods.weekPeriods)).toEqual(sent);
  });

  it('counts the weeks from the Monday of the läsår’s first week, whatever weekday the läsår starts on', () => {
    // Production's läsår starts on a Saturday, 15 August 2026: its first week
    // is the two days before the first Monday. A Monday and a Tuesday kept
    // from Wednesday 13 January, on a post of one day: the week of the 11th
    // is in their period and holds neither, so the empty week is a line of
    // the spring too. Counted from the läsår's own first day, that week's
    // "Monday" would be Saturday the 16th, inside the window, and the week
    // would be told as holding both: the spring without its empty line.
    const saturday = { startDate: '2026-08-15', endDate: '2027-06-12' };
    const from = { startDate: '2027-01-13', endDate: null };
    const periods = yearPeriodsOf(saturday, [[from]])!;
    expect(periods.weeks).toEqual([22, 22]);
    expect(lockedWeekdaySetsByPeriod([lesson('m', 1, from), lesson('tu', 2, from)], 1, saturday, periods.weekPeriods)).toEqual([
      { weekdays: [], periods: [true, false] },
      { weekdays: [], periods: [false, true], recurrence: 'EVEN_WEEKS' },
      { weekdays: [1, 2], periods: [false, true], recurrence: 'ODD_WEEKS' },
      { weekdays: [1, 2], periods: [false, true], recurrence: 'EVEN_WEEKS' },
    ]);
  });

  it('tells the läsår’s first, incomplete week apart once a post starts on the first Monday, for odd and even locks', () => {
    // No term differs from another here, and the periods are still told: the
    // two days before Monday 17 August are a week of their own (week 33, an
    // odd one) as soon as a post is dated from that Monday, and a teacher
    // kept on Tuesdays in the odd weeks and on Wednesdays in the even ones
    // holds the Tuesday there and, in the rest, the Tuesday in the odd weeks and the Wednesday in the
    // even ones (docs/DEPLOYMENT.md 19.5). The first week has weeks of one parity only, and says both.
    const saturday = { startDate: '2026-08-15', endDate: '2027-06-12' };
    const periods = yearPeriodsOf(saturday, [[{ startDate: '2026-08-17', endDate: null }]])!;
    expect(periods.weeks).toEqual([1, 43]);
    const kept = [lesson('odd', 2, { recurrence: 'ODD_WEEKS' }), lesson('even', 3, { recurrence: 'EVEN_WEEKS' })];
    expect(lockedWeekdaySetsByPeriod(kept, 2, saturday, periods.weekPeriods)).toEqual([
      { weekdays: [2], periods: [true, false] },
      { weekdays: [2], periods: [false, true], recurrence: 'ODD_WEEKS' },
      { weekdays: [3], periods: [false, true], recurrence: 'EVEN_WEEKS' },
    ]);
    // In a läsår that starts on that Monday there is no such week, and
    // nothing to tell apart.
    const monday = { startDate: '2026-08-17', endDate: '2027-06-12' };
    expect(yearPeriodsOf(monday, [[{ startDate: '2026-08-17', endDate: null }]])).toBeNull();
  });

  /*
   * THE WEEKS READ ONE BY ONE with runsOn, the rule publishing materialises a
   * lesson by, on random teachers and random cuts of the year — and for a
   * läsår starting on each weekday from Saturday to Wednesday, since the
   * weeks are counted from the Monday of the läsår's first week and not from
   * its first day (production's starts on Saturday 15 August 2026). The
   * Mondays are written out here, not computed as the function computes them.
   *
   * Three things are held, and together they say exactly what is sent:
   *   - every real week is held: its own weekdays are a line of its period,
   *     or lie inside a line of at most the post's days;
   *   - every line of a period is the weekdays of a real week of it;
   *   - no line of a period lies inside another line of it of at most the
   *     post's days — what the larger one implies is left out.
   */
  it.each([
    ['2026-08-15', '2026-08-10'],
    ['2026-08-16', '2026-08-10'],
    ['2026-08-17', '2026-08-17'],
    ['2026-08-18', '2026-08-17'],
    ['2026-08-19', '2026-08-17'],
  ])('holds every real week, and nothing else, in its period: a läsår from %s (first week’s Monday %s)', (startDate, firstMonday) => {
    const year = { startDate, endDate: '2027-06-11' };
    let seed = 20261112;
    const random = (below: number) => {
      // mulberry32: the low bits of a plain linear generator repeat every four draws.
      seed = (seed + 0x6d2b79f5) | 0;
      let mixed = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      mixed = (mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed)) ^ mixed;
      return ((mixed ^ (mixed >>> 14)) >>> 0) % below;
    };
    const days = ['2026-08-17', '2026-10-05', '2026-10-28', '2026-12-18', '2027-01-11', '2027-01-13', '2027-03-01', '2027-06-11'];
    const window = () => {
      const [a, b] = [random(days.length), random(days.length)].sort((x, y) => x - y);
      return [
        { startDate: null, endDate: null },
        { startDate: days[a]!, endDate: null },
        { startDate: null, endDate: days[b]! },
        { startDate: days[a]!, endDate: days[b]! },
      ][random(4)]!;
    };
    const monday = new Date(`${firstMonday}T00:00:00.000Z`).getTime();
    const inside = (set: readonly number[], larger: readonly number[], max: number) =>
      larger.length > set.length && larger.length <= max && set.every((day) => larger.includes(day));
    let told = 0;
    let overlapping = 0;
    let parity = 0;
    for (let round = 0; round < 300; round++) {
      const kept = Array.from({ length: 1 + random(5) }, (_, index) =>
        lesson(`l${index}`, 1 + random(5), {
          ...window(),
          recurrence: (['ALL_WEEKS', 'ALL_WEEKS', 'ODD_WEEKS', 'EVEN_WEEKS'] as const)[random(4)]!,
        }),
      );
      const others = Array.from({ length: random(3) }, () => window());
      const periods = yearPeriodsOf(year, [...kept, ...others].map((entry) => [{ startDate: entry.startDate ?? null, endDate: entry.endDate ?? null }]));
      if (!periods) continue;
      const max = 1 + random(4);
      const sent = lockedWeekdaySetsByPeriod(kept, max, year, periods.weekPeriods);
      const sets: LockedWeekdaysInPeriods[] =
        sent ?? lockedWeekdaySets(kept, max, year).map((weekdays) => ({ weekdays, periods: periods.weeks.map(() => true) }));
      if (sent) told++;
      // The real sets of each period, in the odd weeks and in the even ones.
      const real = periods.weeks.map(() => ({ ODD_WEEKS: new Set<string>(), EVEN_WEEKS: new Set<string>() }));
      periods.weekPeriods.forEach((period, week) => {
        const own = [
          ...new Set(
            kept
              .filter((entry) =>
                runsOn(
                  {
                    recurrence: entry.recurrence,
                    startDate: entry.startDate ? new Date(`${entry.startDate}T00:00:00.000Z`) : null,
                    endDate: entry.endDate ? new Date(`${entry.endDate}T00:00:00.000Z`) : null,
                  },
                  new Date(monday + (7 * week + entry.dayOfWeek - 1) * 86_400_000),
                ),
              )
              .map((entry) => entry.dayOfWeek),
          ),
        ].sort((a, b) => a - b);
        const parity = isoWeekNumber(new Date(monday + 7 * week * 86_400_000)) % 2 === 1 ? 'ODD_WEEKS' : 'EVEN_WEEKS';
        real[period]![parity].add(own.join(','));
        // Held against the sets of its own period and parity: the entries that name them.
        const here = sets.filter((entry) => entry.periods[period] && (!entry.recurrence || entry.recurrence === parity));
        const holds = here.some(
          (entry) =>
            own.every((day) => entry.weekdays.includes(day)) &&
            (entry.weekdays.length === own.length || entry.weekdays.length <= max),
        );
        expect({ round, week, parity, own, holds }).toEqual({ round, week, parity, own, holds: true });
      });
      periods.weeks.forEach((_, period) => {
        const either = new Set([...real[period]!.ODD_WEEKS, ...real[period]!.EVEN_WEEKS]);
        for (const parity of ['ODD_WEEKS', 'EVEN_WEEKS'] as const) {
          const here = sets.filter((entry) => entry.periods[period] && (!entry.recurrence || entry.recurrence === parity));
          // Every period is told in each parity,
          expect({ round, period, parity, lines: here.length > 0 }).toEqual({ round, period, parity, lines: true });
          for (const line of here) {
            // each line is a real week of it (of its own parity where it names one),
            const own = line.recurrence ? real[period]![line.recurrence] : either;
            expect({ round, period, line, real: own.has(line.weekdays.join(',')) }).toEqual({ round, period, line, real: true });
            // and none is implied by another line the same weeks are held against.
            expect({
              round,
              period,
              line,
              implied: here.some((larger) => inside(line.weekdays, larger.weekdays, max)),
            }).toEqual({ round, period, line, implied: false });
          }
        }
        // How often the rounds reach two real weeks that share a weekday
        // with neither inside the other, the larger within the post's days.
        const weeks = [...either].map((key) => (key ? key.split(',').map(Number) : []));
        if (
          weeks.some((set) =>
            weeks.some(
              (larger) =>
                larger.length > set.length &&
                larger.length <= max &&
                set.some((day) => larger.includes(day)) &&
                !set.every((day) => larger.includes(day)),
            ),
          )
        ) {
          overlapping++;
        }
      });
      // The parity is sent only where some period's odd and even weeks hold other sets, and then it is.
      const differs = real.some(
        ({ ODD_WEEKS: odd, EVEN_WEEKS: even }) =>
          odd.size > 0 && even.size > 0 && (odd.size !== even.size || [...odd].some((key) => !even.has(key))),
      );
      const withParity = sets.some((entry) => entry.recurrence);
      if (withParity) parity++;
      if (withParity) expect({ round, differs }).toEqual({ round, differs: true });
      if (!differs) expect({ round, withParity }).toEqual({ round, withParity: false });
    }
    expect(told).toBeGreaterThan(100);
    expect(overlapping).toBeGreaterThan(0);
    expect(parity).toBeGreaterThan(20);
  });
});
