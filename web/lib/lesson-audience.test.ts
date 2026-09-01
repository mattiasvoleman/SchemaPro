import { describe, expect, it } from "vitest";
import {
  audienceFor,
  buildRosterIndex,
  homeClassesReached,
  showsFraction,
} from "./lesson-audience";

// ---------------------------------------------------------------------------
// A school small enough to count by hand. Class 4.1 has four pupils, 4.2 has
// two. The maths half 4ma1 takes two from 4.1 and one from 4.2 — so every
// count below is a number a reader can verify, and a lesson that reaches "some
// of 4.1" reaches a DIFFERENT some depending on which group it names.
// ---------------------------------------------------------------------------

const HOME = new Map<string, string | null>([
  ["a1", "4.1"],
  ["a2", "4.1"],
  ["a3", "4.1"],
  ["a4", "4.1"],
  ["b1", "4.2"],
  ["b2", "4.2"],
]);

const MEMBERS = [
  { studentId: "a1", studentGroupId: "4ma1" },
  { studentId: "a2", studentGroupId: "4ma1" },
  { studentId: "b1", studentGroupId: "4ma1" },
  { studentId: "a3", studentGroupId: "4ma2" },
  { studentId: "a4", studentGroupId: "4ma2" },
];

const index = buildRosterIndex(HOME, MEMBERS);

function lesson(
  studentGroupId: string,
  extraGroupIds: string[] = [],
  studentIds: string[] = [],
) {
  return { studentGroupId, extraGroupIds, studentIds };
}

describe("audienceFor", () => {
  it("gives the class its own lesson whole", () => {
    expect(audienceFor(lesson("4.1"), "4.1", index)).toEqual({
      attending: 4,
      cohortSize: 4,
      named: true,
    });
  });

  it("gives the class the teaching group half of it sits in", () => {
    // The bug this module exists to end: 4ma1 was invisible in 4.1's week
    // while the pupils in it saw the lesson on their own phones.
    expect(audienceFor(lesson("4ma1"), "4.1", index)).toEqual({
      attending: 2,
      cohortSize: 4,
      named: false,
    });
  });

  it("gives the class a lesson another class owns and it attends", () => {
    const shared = lesson("4.2", ["4.1"]);
    expect(audienceFor(shared, "4.1", index)).toEqual({
      attending: 4,
      cohortSize: 4,
      named: true,
    });
    expect(audienceFor(shared, "4.2", index)).toEqual({
      attending: 2,
      cohortSize: 2,
      named: true,
    });
  });

  it("counts a pupil once when the lesson names two groups holding them", () => {
    // 4ma1 and 4ma2 between them hold all four of 4.1, and 4ma1 also holds b1.
    // Summing per-group intersections would report 2 + 2 = 4 here too, so the
    // discriminating case is the group that OVERLAPS: 4.1 alongside 4ma1 is
    // 4 pupils, not 4 + 2.
    expect(audienceFor(lesson("4.1", ["4ma1"]), "4.1", index)).toEqual({
      attending: 4,
      cohortSize: 4,
      named: true,
    });
  });

  it("reaches a class through individually named pupils", () => {
    // A one-off: no group link at all, just two pupils written onto the lesson.
    expect(audienceFor(lesson("9.3", [], ["a1", "a2"]), "4.1", index)).toEqual({
      attending: 2,
      cohortSize: 4,
      named: false,
    });
  });

  it("keeps a lesson that touches nobody in the class out of its week", () => {
    expect(audienceFor(lesson("4ma2"), "4.2", index)).toBeNull();
    expect(audienceFor(lesson("9.3"), "4.1", index)).toBeNull();
  });

  it("never reports a named lesson as partial", () => {
    // `studentIds` ADDS individual participants, it never narrows a group —
    // conflicts.ts treats a pupil as busy when their own class attends. So a
    // lesson that names the class always holds all of it, and the fraction
    // that follows is a property of this domain rather than of these numbers:
    // every partial lesson is one reached through pupils.
    for (const l of [
      lesson("4.1"),
      lesson("4.1", ["4ma1"]),
      lesson("4.2", ["4.1"]),
      lesson("4.1", [], ["b1"]),
    ]) {
      const audience = audienceFor(l, "4.1", index);
      expect(audience).not.toBeNull();
      expect(audience!.named).toBe(true);
      expect(audience!.attending).toBe(audience!.cohortSize);
      expect(showsFraction(audience!)).toBe(false);
    }
  });
});

describe("buildRosterIndex", () => {
  it("holds nobody while either query is in flight", () => {
    expect(buildRosterIndex(undefined, MEMBERS).membersOf.size).toBe(0);
    expect(buildRosterIndex(HOME, undefined).membersOf.size).toBe(0);
  });

  it("falls back to the name test, with no fraction, on an empty roster", () => {
    const empty = buildRosterIndex(undefined, undefined);
    expect(audienceFor(lesson("4.1"), "4.1", empty)).toEqual({
      attending: 0,
      cohortSize: 0,
      named: true,
    });
    // Fewer cards, never zero: the teaching group is missing until the roster
    // lands, which is the pre-fix behaviour rather than a blank grid.
    expect(audienceFor(lesson("4ma1"), "4.1", empty)).toBeNull();
  });

  it("keeps a pupil with no home class in their teaching group", () => {
    const homeless = buildRosterIndex(new Map([["x1", null]]), [
      { studentId: "x1", studentGroupId: "4ma1" },
    ]);
    expect(homeless.membersOf.get("4ma1")).toEqual(new Set(["x1"]));
    expect(audienceFor(lesson("4ma1"), "4ma1", homeless)?.attending).toBe(1);
  });

  it("names a class with no pupils recorded without dividing by zero", () => {
    const known = buildRosterIndex(HOME, MEMBERS);
    expect(audienceFor(lesson("7.1"), "7.1", known)).toEqual({
      attending: 0,
      cohortSize: 0,
      named: true,
    });
  });
});

describe("showsFraction", () => {
  it("prints the fraction only when the class is partly there", () => {
    expect(showsFraction({ attending: 2, cohortSize: 4, named: false })).toBe(
      true,
    );
    expect(showsFraction({ attending: 4, cohortSize: 4, named: true })).toBe(
      false,
    );
    expect(showsFraction({ attending: 0, cohortSize: 0, named: true })).toBe(
      false,
    );
  });
});

describe("homeClassesReached", () => {
  // The classes, without the teaching groups: 4ma1 is nobody's home.
  const CLASSES = ["4.1", "4.2"];

  it("reaches every class whose pupils sit in the lesson", () => {
    // 4ma1 holds a1 and a2 of 4.1, and b1 of 4.2. Dragging it moves the lesson
    // for a class the administrator filtered to 4.1 never had on screen.
    expect(homeClassesReached(lesson("4ma1"), CLASSES, index)).toEqual([
      "4.1",
      "4.2",
    ]);
  });

  it("leaves out a class that only shares a name with the group", () => {
    expect(homeClassesReached(lesson("4ma2"), CLASSES, index)).toEqual(["4.1"]);
  });

  it("counts a named class even with no roster behind it", () => {
    const bare = buildRosterIndex(new Map(), []);
    expect(homeClassesReached(lesson("4.1", ["4.2"]), CLASSES, bare)).toEqual([
      "4.1",
      "4.2",
    ]);
  });

  it("reaches a class through an individually named pupil", () => {
    expect(homeClassesReached(lesson("9.3", [], ["b2"]), CLASSES, index)).toEqual(
      ["4.2"],
    );
  });

  it("counts only the classes it is given, never the teaching groups", () => {
    // 4ma1 is in the room and is not somebody's home. Counting it would report
    // three where the honest answer is two.
    expect(homeClassesReached(lesson("4ma1"), CLASSES, index)).not.toContain(
      "4ma1",
    );
  });

  it("says one class for a lesson that stays inside one class", () => {
    expect(homeClassesReached(lesson("4.1"), CLASSES, index)).toEqual(["4.1"]);
    expect(homeClassesReached(lesson("4ma2"), CLASSES, index)).toHaveLength(1);
  });
});
