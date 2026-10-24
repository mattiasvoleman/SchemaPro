import fixture from './__fixtures__/lesson-shares-cases.json';
import {
  MAX_SHARE_LESSONS,
  canonicalShares,
  hasShares,
  lessonTeachersOf,
  sharesProblem,
  teacherIdsOf,
  teacherPartsOf,
  type LessonShare,
  type SharedRow,
} from './lesson-shares';

/**
 * Delade lektioner, implemented twice, checked against one list of cases.
 *
 * web/lib/lesson-shares.ts mirrors this module so the Timplansposter dialog
 * says which lesson is whose, and which share list the gateway will refuse,
 * before a save does. If the two drift, the dialog lets through a list the
 * PATCH answers REQUIREMENT_SHARES_DO_NOT_FIT, or lays Bo's 40 out as his 80.
 * Neither suite can see the other, so both replay
 * src/common/__fixtures__/lesson-shares-cases.json.
 *
 * The fixture was GENERATED from this implementation (the script is in the
 * commit message); never edit the JSON by hand, because the web replays it.
 */
describe('delade lektioner agree with the shared fixture', () => {
  it('pins the bound the CHECK and the DTO share', () => {
    expect(fixture.constants).toEqual({ MAX_SHARE_LESSONS });
  });

  it('reaches a row nobody shares, a split row, an unstaffed lead, a deleted teacher and every problem', () => {
    expect(fixture.rows.some((c) => !c.hasShares)).toBe(true);
    expect(fixture.rows.some((c) => (c.row as SharedRow).lessonLengths?.length)).toBe(true);
    expect(fixture.rows.some((c) => (c.row as SharedRow).teacherId === null)).toBe(true);
    expect(fixture.rows.some((c) => c.parts.some((part) => part.teacherId === null && part.role === 'SHARE'))).toBe(true);
    expect(new Set(fixture.problems.map((c) => c.problem))).toEqual(
      new Set([
        null,
        'NOT_INTEGER',
        'OUT_OF_RANGE',
        'TEACHER_TWICE',
        'TEACHER_ON_POST',
        'LENGTH_NOT_ON_POST',
        'TOO_MANY_OF_LENGTH',
        'LEAD_KEEPS_NONE',
      ]),
    );
  });

  it.each(fixture.rows.map((entry) => [entry.name, entry] as const))('row: %s', (_name, entry) => {
    const row = entry.row as SharedRow;
    expect({
      hasShares: hasShares(row),
      parts: teacherPartsOf(row),
      lessons: lessonTeachersOf(row),
      teacherIds: teacherIdsOf(row),
    }).toEqual({ hasShares: entry.hasShares, parts: entry.parts, lessons: entry.lessons, teacherIds: entry.teacherIds });
  });

  it.each(fixture.problems.map((entry) => [entry.name, entry] as const))('problem: %s', (_name, entry) => {
    expect(sharesProblem(entry.row as SharedRow, entry.shares as LessonShare[])).toBe(entry.problem);
  });

  it.each(fixture.canonical.map((entry) => [entry.name, entry] as const))('canonical: %s', (_name, entry) => {
    expect(canonicalShares(entry.shares as LessonShare[])).toEqual(entry.canonical);
  });
});
