import fixture from './__fixtures__/lesson-lengths-cases.json';
import { SLOT_MINUTES } from './solver-grid';
import {
  LESSON_GRID_MINUTES,
  LESSON_MAX_MINUTES,
  LESSON_MIN_MINUTES,
  MAX_DISTINCT_LENGTHS,
  MAX_LESSONS_PER_WEEK,
  canonicalShape,
  isMixed,
  lengthPartsOf,
  lengthsProblem,
  lessonCountOf,
  lessonMinutesOf,
  longestLessonOf,
  shapeFromParts,
  shortestLessonOf,
  weeklyMinutesOf,
  type LessonShape,
} from './lesson-lengths';

/**
 * Lektionslängder, implemented twice, checked against one list of cases.
 *
 * web/lib/lesson-lengths.ts mirrors this module so the Timplansposter matrix,
 * the teacher card and the load report count a split row as the gateway does.
 * If the two drift, the web says 160 minutes for 1 × 80 + 1 × 40 while
 * GET /timplan-coverage and the staffing report say 120 for the same row.
 * Neither suite can see the other, so both replay
 * src/common/__fixtures__/lesson-lengths-cases.json — the web importing it
 * across the package boundary, as it does the timplan-planned fixture.
 *
 * The fixture was GENERATED from this implementation (the script is in the
 * commit message); never edit the JSON by hand, because the web replays the
 * numbers. Its constants block is asserted on both sides, so a grid that moves
 * on one side alone fails a test rather than a solve.
 */

type FixtureShape = Omit<LessonShape, 'lessonsPerWeek'> & { lessonsPerWeek: number | 'NaN' };

const shapeOf = (row: FixtureShape): LessonShape => ({
  ...row,
  lessonsPerWeek: row.lessonsPerWeek === 'NaN' ? Number.NaN : row.lessonsPerWeek,
});

describe('lektionslängder agree with the shared fixture', () => {
  it('pins the bounds the engine and the CHECK share', () => {
    expect(fixture.constants).toEqual({
      LESSON_MIN_MINUTES,
      LESSON_MAX_MINUTES,
      LESSON_GRID_MINUTES,
      MAX_LESSONS_PER_WEEK,
      MAX_DISTINCT_LENGTHS,
    });
    expect(fixture.constants.LESSON_GRID_MINUTES).toBe(SLOT_MINUTES);
  });

  it('reaches uniform and split rows, every problem and the null answer', () => {
    expect(fixture.rows.some((c) => c.isMixed)).toBe(true);
    expect(fixture.rows.some((c) => !c.isMixed)).toBe(true);
    expect(new Set(fixture.problems.map((c) => c.problem))).toEqual(
      new Set([
        'EMPTY',
        'NOT_INTEGER',
        'OUT_OF_RANGE',
        'OFF_GRID',
        'TOO_MANY_LESSONS',
        'TOO_MANY_KINDS',
        null,
      ]),
    );
  });

  it.each(fixture.rows.map((entry) => [entry.name, entry] as const))('row: %s', (_name, entry) => {
    const row = shapeOf(entry.row as FixtureShape);
    expect({
      isMixed: isMixed(row),
      lessonCount: lessonCountOf(row),
      lessonMinutes: lessonMinutesOf(row),
      weeklyMinutes: weeklyMinutesOf(row),
      shortest: shortestLessonOf(row),
      longest: longestLessonOf(row),
      parts: lengthPartsOf(row),
    }).toEqual({
      isMixed: entry.isMixed,
      lessonCount: entry.lessonCount,
      lessonMinutes: entry.lessonMinutes,
      weeklyMinutes: entry.weeklyMinutes,
      shortest: entry.shortest,
      longest: entry.longest,
      parts: entry.parts,
    });
  });

  it.each(fixture.canonical.map((entry) => [entry.name, entry] as const))(
    'canonical: %s',
    (_name, entry) => {
      expect(canonicalShape(entry.lengths)).toEqual(entry.shape);
    },
  );

  it.each(fixture.parts.map((entry) => [entry.name, entry] as const))('parts: %s', (_name, entry) => {
    expect(shapeFromParts(entry.parts)).toEqual(entry.shape);
  });

  it.each(fixture.problems.map((entry) => [entry.name, entry] as const))(
    'problem: %s',
    (_name, entry) => {
      expect(lengthsProblem(entry.lengths)).toBe(entry.problem);
    },
  );
});
