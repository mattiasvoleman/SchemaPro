import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import fixture from './__fixtures__/stretch-cases.json';
import {
  CONSECUTIVE_BREAK_MINUTES_MAX,
  CONSECUTIVE_BREAK_MINUTES_MIN,
  CONSECUTIVE_STEP,
  MAX_CONSECUTIVE_TEACHING_MINUTES_MAX,
  MAX_CONSECUTIVE_TEACHING_MINUTES_MIN,
  hasStretchRule,
  overlongStretches,
  stretchesOf,
} from './stretch';
import { teacherDayBreaches, type TeacherDayRule, type TeachingLesson } from './teacher-day';

/**
 * Sammanhängande undervisning, read twice, checked against one list of cases.
 *
 * This module and the engine's checker (benchmarks/validate_schedule.py,
 * _stretch_problems) both replay src/common/__fixtures__/stretch-cases.json —
 * the engine only the cases it can state, every lesson every week with open
 * dates, since it has no weeks. The expected breaches in the fixture are
 * written by hand from the definition in stretch.ts, not generated from it, so
 * a bug in the arithmetic cannot make its own cases agree.
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

const span = (start: string, end: string) => ({ startMinutes: clock(start), endMinutes: clock(end) });

describe('Sammanhängande undervisning agrees with the shared fixture', () => {
  it('holds cases the engine can replay and cases only the weeks can tell apart, with and without a breach', () => {
    const everyWeek = (c: FixtureCase) =>
      c.lessons.every(
        (lesson) =>
          (lesson.recurrence ?? 'ALL_WEEKS') === 'ALL_WEEKS' && lesson.startDate == null && lesson.endDate == null,
      );
    expect(cases.filter(everyWeek).length).toBeGreaterThan(8);
    expect(cases.filter((c) => !everyWeek(c)).length).toBeGreaterThanOrEqual(4);
    expect(cases.filter((c) => c.breaches.length === 0).length).toBeGreaterThan(5);
    expect(cases.filter((c) => c.breaches.length > 0).length).toBeGreaterThan(5);
  });

  it.each(cases.map((c) => [c.name, c] as const))('%s', (_name, c) => {
    expect(teacherDayBreaches(c.rule, c.lessons.map(teaching))).toEqual(c.breaches);
  });
});

describe('stretchesOf', () => {
  it('joins a lesson that starts less than the pause after the stretch ends, and splits at the pause itself', () => {
    expect(stretchesOf([span('08:00', '09:00'), span('09:29', '10:00')], 30)).toHaveLength(1);
    expect(stretchesOf([span('08:00', '09:00'), span('09:30', '10:00')], 30)).toHaveLength(2);
  });

  it('measures a stretch from its first start to its last end, the gaps inside counted in', () => {
    const [stretch] = stretchesOf([span('08:00', '09:00'), span('09:10', '10:10')], 30);
    expect(stretch).toMatchObject({ startMinutes: 480, endMinutes: 610, minutes: 130 });
  });

  it('does not depend on the order the lessons come in', () => {
    const forward = stretchesOf([span('08:00', '09:00'), span('09:10', '10:10'), span('13:00', '14:00')], 30);
    const backward = stretchesOf([span('13:00', '14:00'), span('09:10', '10:10'), span('08:00', '09:00')], 30);
    expect(backward.map((s) => [s.startMinutes, s.endMinutes])).toEqual(
      forward.map((s) => [s.startMinutes, s.endMinutes]),
    );
  });

  it('lets a lesson inside a longer one change nothing', () => {
    const [stretch] = stretchesOf([span('08:00', '12:00'), span('09:00', '10:00')], 30);
    expect(stretch).toMatchObject({ minutes: 240 });
    expect(stretch!.spans).toHaveLength(2);
  });

  it('leaves out a span that takes no time, and answers nothing for no lessons', () => {
    expect(stretchesOf([span('08:00', '08:00')], 30)).toEqual([]);
    expect(stretchesOf([], 30)).toEqual([]);
  });

  it('names the stretches over a limit and not the ones at it', () => {
    const spans = [span('08:00', '10:00'), span('13:00', '15:01')];
    expect(overlongStretches(spans, 120, 30).map((s) => s.minutes)).toEqual([121]);
  });
});

describe('hasStretchRule', () => {
  it('needs both figures', () => {
    expect(hasStretchRule({ maxConsecutiveTeachingMinutes: 180, consecutiveBreakMinutes: 30 })).toBe(true);
    expect(hasStretchRule({ maxConsecutiveTeachingMinutes: 180, consecutiveBreakMinutes: null })).toBe(false);
    expect(hasStretchRule({ maxConsecutiveTeachingMinutes: null, consecutiveBreakMinutes: 30 })).toBe(false);
    expect(hasStretchRule({})).toBe(false);
  });
});

describe('a hand edit asks the three limits together', () => {
  const rule: TeacherDayRule = {
    maxTeachingMinutesPerDay: 300,
    maxTeachingDaysPerWeek: null,
    maxConsecutiveTeachingMinutes: 120,
    consecutiveBreakMinutes: 30,
  };
  const lesson = (id: string, start: string, end: string, dayOfWeek = 1): TeachingLesson => ({
    id,
    dayOfWeek,
    startMinutes: clock(start),
    endMinutes: clock(end),
  });

  it('names a day over the cap and a stretch over the limit as two breaches, in that order', () => {
    const breaches = teacherDayBreaches(rule, [
      lesson('a', '08:00', '10:00'),
      lesson('b', '10:00', '12:00'),
      lesson('c', '12:00', '14:00'),
    ]);
    expect(breaches.map((b) => b.kind)).toEqual(['DAILY_CAP', 'CONSECUTIVE']);
  });

  it('reads only the stretches the edit is part of: a long one it does not touch is not its to repeat', () => {
    const lessons = [lesson('a', '08:00', '11:00'), lesson('b', '13:00', '14:00')];
    expect(teacherDayBreaches(rule, lessons, new Set(['b']))).toEqual([]);
    expect(teacherDayBreaches(rule, lessons, new Set(['a']))).toEqual([
      { kind: 'CONSECUTIVE', dayOfWeek: 1, minutes: 180, max: 120, breakMinutes: 30, lessonIds: ['a'] },
    ]);
  });

  it('names a stretch the edit made by joining two lessons', () => {
    const lessons = [lesson('a', '08:00', '09:30'), lesson('b', '09:40', '11:00')];
    expect(teacherDayBreaches(rule, lessons, new Set(['b']))).toMatchObject([
      { kind: 'CONSECUTIVE', minutes: 180, lessonIds: ['a', 'b'] },
    ]);
  });

  it('says nothing for a teacher whose rule has only one of the two figures', () => {
    const half: TeacherDayRule = { ...rule, maxTeachingMinutesPerDay: null, consecutiveBreakMinutes: null };
    expect(teacherDayBreaches(half, [lesson('a', '08:00', '14:00')])).toEqual([]);
  });
});

describe('the bounds are the CHECKs of 20261218090000', () => {
  // Read out of the migration rather than retyped, as for the cap: the DTOs and
  // the engine take these constants.
  const sql = readFileSync(
    join(
      __dirname,
      '../../prisma/migrations/20261218090000_en_larares_foljd_av_lektioner_har_en_grans_som_generatorn_forsoker_halla/migration.sql',
    ),
    'utf8',
  );
  const between = (column: string): [number, number] => {
    const found = new RegExp(`CHECK \\("${column}" BETWEEN (\\d+) AND (\\d+)`).exec(sql);
    if (!found) throw new Error(`no CHECK on ${column}`);
    return [Number(found[1]), Number(found[2])];
  };

  it('the limit: 30..480 minutes, a multiple of five', () => {
    expect(between('maxConsecutiveTeachingMinutes')).toEqual([
      MAX_CONSECUTIVE_TEACHING_MINUTES_MIN,
      MAX_CONSECUTIVE_TEACHING_MINUTES_MAX,
    ]);
    expect(sql).toContain(`"maxConsecutiveTeachingMinutes" % ${CONSECUTIVE_STEP} = 0`);
  });

  it('the pause: 5..120 minutes, a multiple of five', () => {
    expect(between('consecutiveBreakMinutes')).toEqual([CONSECUTIVE_BREAK_MINUTES_MIN, CONSECUTIVE_BREAK_MINUTES_MAX]);
    expect(sql).toContain(`"consecutiveBreakMinutes" % ${CONSECUTIVE_STEP} = 0`);
  });

  it('the two are set together or not at all', () => {
    expect(sql).toContain('("maxConsecutiveTeachingMinutes" IS NULL) = ("consecutiveBreakMinutes" IS NULL)');
  });
});
