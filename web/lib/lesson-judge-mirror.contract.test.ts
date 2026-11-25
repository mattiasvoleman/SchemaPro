import { describe, expect, it } from "vitest";
import { buildGroupConflictMap, toPlacement, validatePlacement, type ConflictKind, type LunchOf, type Meal } from "./conflicts";
import { buildGradeSpans } from "./grade-span";
import { minutesOfClock } from "./requirement-placement-text";
import { cases, constraintsOf, framesOf, groupsOf, lessonsOf, worlds, type Case, type World } from "./lesson-judge-world";

/**
 * THE GRID'S DRAG CONTROL MUST NOT BE MILDER THAN THE JUDGE OF A HAND EDIT (E1, Klart (d)).
 *
 * src/calendar/__fixtures__/lesson-judge-cases.json holds small worlds, one lesson of each dragged to a new day and clock, and the
 * verdict of the gateway's REAL judge (src/calendar/lesson-judge.ts, asked as the PATCH the page writes with, over real Postgres by
 * scripts/test/probe-domaren.ts, which writes the file and requires the swap's judge and the förläggning's to say the same). The page's
 * drag control is `validateChange` (app/.../admin/timetable/use-schedule-engine.ts), which asks `validatePlacement` (lib/conflicts.ts)
 * with the week as the page holds it. This builds that week from each world, with the arguments `validateChange` gives, and asks it of
 * the dragged lesson's new place.
 *
 * For the rules the grid has (TEACHER, ROOM, GROUP and PUPILS, AVAILABILITY, FRAME, LUNCH, GRADE_RULE) it refuses where the judge
 * refuses, with the kind of rule the judge names: a year rule is one more constraint to the grid, so the judge's GRADE_RULE is the
 * grid's AVAILABILITY, and pupils a teaching group shares with the class (PUPILS) are one more clash of groups (GROUP). It may be
 * stricter only where a case is named in MIRROR_STRICTER, and is never milder. OTHER_SCHOOL is not in the file: the page holds no other
 * school's lessons, and the save says it (the gateway's refusal, in the toast and in the dialog).
 */

/** The kind of rule the grid says for each reason the judge gives. */
const KIND: Readonly<Record<string, ConflictKind | null>> = {
  // The school day is no rule of the week's clash mirror but of the drag control itself (validateChange: a Saturday or a Sunday is not a place to
  // drop a lesson, and a lesson that stands there may stay): suggestions-and-the-drag.test.ts holds that, for every case, against `validateChange`.
  SCHOOL_DAY: null,
  TEACHER: "TEACHER",
  ROOM: "ROOM",
  GROUP: "GROUP",
  PUPILS: "GROUP",
  AVAILABILITY: "AVAILABILITY",
  GRADE_RULE: "AVAILABILITY",
  FRAME: "FRAME",
  LUNCH: "LUNCH",
};

/** The cases (by name) the grid refuses and the judge lets through: where it is stricter, and why. Empty is the aim. */
const MIRROR_STRICTER: Readonly<Record<string, string>> = {};

/** The week as the page holds it (use-schedule-engine.ts), from a world. */
function pageOf(world: World) {
  const groups = groupsOf(world);
  const studentGroupOf = new Map<string, string | null>();
  const lunchOf: LunchOf = new Map();
  for (const meal of world.meals) {
    const key = `${meal.class}:${meal.day}`;
    const held: Meal[] = (lunchOf.get(key) as Meal[] | undefined) ?? [];
    held.push({ startMinutes: minutesOfClock(meal.start), endMinutes: minutesOfClock(meal.end), startDate: null, endDate: null });
    lunchOf.set(key, held);
  }
  return {
    lessons: lessonsOf(world),
    constraints: constraintsOf(world),
    studentGroupOf,
    groupConflictMap: buildGroupConflictMap(studentGroupOf, [], groups),
    gradeSpanOf: buildGradeSpans({ groups, membersByGroup: new Map(), homeClassOf: studentGroupOf, numbering: "NIOARIG" }),
    frames: framesOf(world),
    lunchOf,
  };
}

const pages = worlds.map(pageOf);

/** What the page's drag control says of the dragged lesson at its new place: validateChange's own call. */
function mirrorSays(testCase: Case): ConflictKind[] {
  const page = pages[testCase.world]!;
  const lesson = page.lessons.find((entry) => entry.id === testCase.drag.lesson)!;
  const length = minutesOfClock(lesson.endTime) - minutesOfClock(lesson.startTime);
  const start = minutesOfClock(testCase.drag.start);
  const candidate = { ...toPlacement(lesson), dayOfWeek: testCase.drag.day, startMinutes: start, endMinutes: start + length };
  const hits = validatePlacement(
    candidate,
    page.lessons.filter((entry) => !entry.isParked).map((entry) => toPlacement(entry)),
    page.constraints,
    page.studentGroupOf,
    page.groupConflictMap,
    page.gradeSpanOf,
    page.frames,
    page.lunchOf,
    // No room lock, as validateChange has none: a drag moves time and not place.
    undefined,
    undefined,
  );
  return [...new Set(hits.map((hit) => hit.kind))];
}

describe("the cases", () => {
  it("are not empty: they hold the judge's nos and its oks, and a no for every rule the grid has", () => {
    const refused = cases.filter((entry) => !entry.verdict.ok);
    const held = cases.filter((entry) => entry.verdict.ok);
    expect(refused.length).toBeGreaterThanOrEqual(100);
    expect(held.length).toBeGreaterThanOrEqual(100);
    expect(refused.length + held.length).toBe(cases.length);
    for (const reason of ["TEACHER", "ROOM", "GROUP", "AVAILABILITY", "FRAME", "LUNCH", "GRADE_RULE"]) {
      expect(refused.filter((entry) => entry.verdict.reasons.includes(reason)).length, `${reason} refused`).toBeGreaterThan(0);
    }
    // A reason the file carries that this test has no kind for would be compared with nothing.
    for (const entry of cases) for (const reason of entry.verdict.reasons) expect(KIND, `${entry.name}: ${reason}`).toHaveProperty(reason);
    // A refusal says at least one reason, and a case that holds says none.
    for (const entry of cases) expect(entry.verdict.reasons.length > 0, entry.name).toBe(!entry.verdict.ok);
  });
});

describe("the grid's drag control, against the judge of a hand edit", () => {
  it.each(cases.map((entry) => [entry.name, entry] as const))("%s", (_name, testCase) => {
    const said = mirrorSays(testCase);
    const gridReasons = testCase.verdict.reasons.filter((reason) => KIND[reason] !== null);
    if (gridReasons.length > 0) {
      // NEVER MILDER: the judge refuses, the grid refuses, and for every rule of the grid's the judge names.
      expect(said.length, "the grid lets through what the judge refuses").toBeGreaterThan(0);
      for (const reason of gridReasons) expect(said, `the judge says ${reason}`).toContain(KIND[reason]);
    } else if (!testCase.verdict.ok) {
      // Only the school day says no: the drag control's rule, held in suggestions-and-the-drag.test.ts.
      expect(testCase.verdict.reasons).toEqual(["SCHOOL_DAY"]);
    } else if (said.length > 0) {
      // STRICTER only where a case says so, and why.
      expect(MIRROR_STRICTER[testCase.name], `the grid refuses (${said.join(", ")}) what the judge lets through`).toBeDefined();
    }
  });

  it("is checked on every case of the file: the count of what it said, no and ok", () => {
    const counts = { bothRefuse: 0, bothHold: 0 };
    for (const testCase of cases) {
      const said = mirrorSays(testCase);
      const gridRefuses = testCase.verdict.reasons.some((reason) => KIND[reason] !== null);
      if (gridRefuses && said.length > 0) counts.bothRefuse++;
      if (testCase.verdict.ok && said.length === 0) counts.bothHold++;
    }
    expect(counts.bothRefuse).toBe(cases.filter((entry) => entry.verdict.reasons.some((reason) => KIND[reason] !== null)).length);
    expect(counts.bothHold + Object.keys(MIRROR_STRICTER).length).toBe(cases.filter((entry) => entry.verdict.ok).length);
  });
});
