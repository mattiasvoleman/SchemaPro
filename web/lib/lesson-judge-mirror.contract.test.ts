import { describe, expect, it } from "vitest";
import { buildGroupConflictMap, detectConflicts, toPlacement, validatePlacement, type ConflictKind, type LunchOf, type Meal } from "./conflicts";
import { conflictRows } from "./conflict-rows";
import { buildGradeSpans } from "./grade-span";
import { clockOfMinutes, minutesOfClock } from "./requirement-placement-text";
import { cases, constraintsOf, framesOf, groupsOf, homeClassOf, lessonsOf, membershipsOf, worlds, type Case, type World } from "./lesson-judge-world";

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
 * stricter only where a case is named in MIRROR_STRICTER, and is never milder.
 *
 * The file's worlds from the nineteenth on (probe-domaren.ts generateRichWorlds) carry what the first eighteen leave out: pupils with a
 * home class, teaching groups of pupils from several classes (PUPILS), lessons with an extra class or with pupils named on them, lessons
 * and meals that run in a window of dates, and a room that another school has borrowed for an hour (OTHER_SCHOOL, E3). The grid has no
 * word for OTHER_SCHOOL: the page holds no other school's lessons and no loan, and the save says it (the gateway's refusal, in the toast
 * and the dialog), and the board paints it from the gateway's answer (lib/possible-times.ts). Such a case is held to the rest of what the
 * judge says of it.
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
  // The page holds no other school's lessons and no loan of a room: see above.
  OTHER_SCHOOL: null,
};

/** The cases (by name) the grid refuses and the judge lets through: where it is stricter, and why. Empty is the aim. */
const MIRROR_STRICTER: Readonly<Record<string, string>> = {};

/** The week as the page holds it (use-schedule-engine.ts), from a world. */
function pageOf(world: World) {
  const groups = groupsOf(world);
  const studentGroupOf = homeClassOf(world);
  const memberships = membershipsOf(world);
  const membersByGroup = new Map<string, string[]>();
  for (const row of memberships) membersByGroup.set(row.studentGroupId, [...(membersByGroup.get(row.studentGroupId) ?? []), row.studentId]);
  const lunchOf: LunchOf = new Map();
  for (const meal of world.meals) {
    const key = `${meal.class}:${meal.day}`;
    const held: Meal[] = (lunchOf.get(key) as Meal[] | undefined) ?? [];
    held.push({ startMinutes: minutesOfClock(meal.start), endMinutes: minutesOfClock(meal.end), startDate: meal.startDate ?? null, endDate: meal.endDate ?? null });
    lunchOf.set(key, held);
  }
  return {
    lessons: lessonsOf(world),
    constraints: constraintsOf(world),
    studentGroupOf,
    groupConflictMap: buildGroupConflictMap(studentGroupOf, memberships, groups),
    gradeSpanOf: buildGradeSpans({ groups, membersByGroup, homeClassOf: studentGroupOf, numbering: "NIOARIG" }),
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
    for (const reason of ["TEACHER", "ROOM", "GROUP", "PUPILS", "AVAILABILITY", "FRAME", "LUNCH", "GRADE_RULE", "OTHER_SCHOOL"]) {
      expect(refused.filter((entry) => entry.verdict.reasons.includes(reason)).length, `${reason} refused`).toBeGreaterThan(0);
    }
    // The richer worlds are what they say: pupils and groups, extra classes and pupils named on a lesson, windows of dates on lessons and
    // on meals, and a lent room. A world that lost one of them would prove the grid on a thinner slice than the file claims.
    const rich = worlds.filter((world) => world.pupils !== undefined);
    expect(rich.length).toBeGreaterThanOrEqual(10);
    const lessons = rich.flatMap((world) => world.lessons);
    expect(lessons.filter((lesson) => (lesson.extra ?? []).length > 0).length, "lessons with an extra class").toBeGreaterThan(5);
    expect(lessons.filter((lesson) => (lesson.participants ?? []).length > 0).length, "lessons with pupils named").toBeGreaterThan(5);
    expect(lessons.filter((lesson) => lesson.startDate).length, "lessons in a window").toBeGreaterThan(10);
    expect(rich.flatMap((world) => world.lessons.filter((lesson) => (world.groups ?? []).some((group) => group.key === lesson.class))).length, "lessons of a teaching group").toBeGreaterThan(10);
    expect(rich.flatMap((world) => world.meals).filter((meal) => meal.startDate).length, "meals in a window").toBeGreaterThan(5);
    expect(rich.flatMap((world) => world.loans ?? []).length, "lent rooms").toBeGreaterThan(10);
    // The possible-times probe holds its prune exact (it lets nothing through that the judge refuses) only in a world where no lesson names a
    // pupil, which it cannot see: the file keeps worlds with the richer rules and none of that, or the exactness would be held for them nowhere.
    expect(rich.filter((world) => !world.lessons.some((lesson) => (lesson.participants ?? []).length > 0)).length, "richer worlds with no pupil named on a lesson").toBeGreaterThanOrEqual(4);
    // The edge worlds (probe-domaren.ts generateEdgeWorlds): a comparison is proved by the case on each side of its turn, and a random world
    // seldom lands on it. Each of these is a turn the other worlds do not reach, and a case on both sides of it.
    const allLessons = worlds.flatMap((world) => world.lessons.map((lesson) => ({ world, lesson })));
    const sameDay = (a: string | undefined, b: string | undefined) => a !== undefined && a === b;
    expect(
      worlds.some((world) => world.lessons.some((a) => world.lessons.some((b) => a !== b && sameDay(a.endDate, b.startDate)))),
      "two windows that meet on one day",
    ).toBe(true);
    expect(
      allLessons.some(({ world, lesson }) => world.meals.some((meal) => meal.class === lesson.class && (sameDay(lesson.startDate, meal.endDate) || sameDay(lesson.endDate, meal.startDate)))),
      "a lesson window that touches the first or last day of a meal's",
    ).toBe(true);
    expect(
      worlds.some((world) => world.lessons.some((a) => world.lessons.some((b) => a !== b && (a.participants ?? []).some((pupil) => (b.participants ?? []).includes(pupil))))),
      "a pupil named on two lessons",
    ).toBe(true);
    expect(
      allLessons.some(({ world, lesson }) => {
        const frameOf = (key: string) => world.frames.find((frame) => { const grade = world.classes.find((entry) => entry.key === key)?.grade; return grade !== undefined && frame.grades[0] <= grade && grade <= frame.grades[1]; });
        return (lesson.extra ?? []).some((key) => frameOf(key)?.end !== frameOf(lesson.class)?.end);
      }),
      "an extra class of another stage, whose ramtid is not the class's own",
    ).toBe(true);
    expect(
      rich.some((world) => (world.groups ?? []).some((group) => world.frames.length > 0 && group.members.every((pupil) => (world.pupils ?? []).find((entry) => entry.key === pupil)!.class !== "7A") && world.frames.every((frame) => frame.grades[1] < 8))),
      "a teaching group none of whose pupils the ramtid reaches",
    ).toBe(true);
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
      // Only the school day and another school say no: the drag control's own rule (held in suggestions-and-the-drag.test.ts), and what the
      // page holds no word for (above).
      for (const reason of testCase.verdict.reasons) expect(["SCHOOL_DAY", "OTHER_SCHOOL"], reason).toContain(reason);
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

describe("the krocklista, against the judge", () => {
  /*
   * The list says each reason in the sentence of the refusal of a save (common.codes.MASTER_LESSON_REFUSED), so it must say the reason
   * the judge gives for the same lesson in the same place. Each refused case is laid out as the week would stand after the drop, the grid
   * reads its clashes (detectConflicts), and the list's reasons for the dragged lesson must hold every reason the judge gave. The list
   * may say more (the judge gives one of the board's three rules, the grid every one that holds), and never less or another.
   */
  it.each(cases.filter((entry) => !entry.verdict.ok).map((entry) => [entry.name, entry] as const))("%s", (_name, testCase) => {
    const page = pages[testCase.world]!;
    const dropped = page.lessons.map((lesson) => {
      if (lesson.id !== testCase.drag.lesson) return lesson;
      const length = minutesOfClock(lesson.endTime.slice(0, 5)) - minutesOfClock(lesson.startTime.slice(0, 5));
      return {
        ...lesson,
        dayOfWeek: testCase.drag.day,
        startTime: `${testCase.drag.start}:00`,
        endTime: `${clockOfMinutes(minutesOfClock(testCase.drag.start) + length)}:00`,
      };
    });
    const map = detectConflicts(dropped, page.constraints, page.studentGroupOf, page.groupConflictMap, page.gradeSpanOf, page.frames, page.lunchOf);
    const rows = conflictRows(map, new Map(dropped.map((lesson) => [lesson.id, lesson])), { group: (id) => id, subject: (id) => id }, {
      constraints: page.constraints,
      gradeSpanOf: page.gradeSpanOf,
    });
    const said = new Set((rows.find((row) => row.lesson.id === testCase.drag.lesson)?.reasons ?? []).map((reason) => reason.values?.["reason"]));
    // The school day is no conflict the grid marks or the list names: a lesson a file brought to a Saturday stands there (låt stå), and what
    // the judge refuses is only putting one there. Nor is another school's hold: the page holds none.
    for (const reason of testCase.verdict.reasons.filter((entry) => entry !== "SCHOOL_DAY" && entry !== "OTHER_SCHOOL")) expect(said, `the judge says ${reason}`).toContain(reason);
  });
});
