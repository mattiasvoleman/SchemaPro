import { describe, expect, it } from "vitest";
import pupilList from "../../src/common/__fixtures__/pupil-list-cases.json";
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
    // conflicts.ts treats a pupil as busy when their own class attends. So, in
    // a school with no replacing group, a lesson that names the class holds
    // all of it, and the fraction that follows is a property of this domain
    // rather than of these numbers: every partial lesson is one reached
    // through pupils. A replacing group is the one thing that takes a class's
    // pupils off its own lesson (Elevlistan i uppföljningen, below).
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

describe("a class's halves (Halvklasser)", () => {
  const groups = [
    { id: "4.1:1", halfOfId: "4.1" },
    { id: "4.1:2", halfOfId: "4.1" },
  ];

  it("keeps a half's lesson in its class's week before anyone is placed, and in no other class's", () => {
    const halves = buildRosterIndex(HOME, MEMBERS, groups);

    expect(audienceFor(lesson("4.1:1"), "4.1", halves)).toEqual({ attending: 0, cohortSize: 4, named: true });
    expect(audienceFor(lesson("4.1:1"), "4.2", halves)).toBeNull();
    expect(homeClassesReached(lesson("4.1:2"), ["4.1", "4.2"], halves)).toEqual(["4.1"]);
    // Without the halves the lesson reaches nobody: what the class's view used to hide.
    expect(audienceFor(lesson("4.1:1"), "4.1", index)).toBeNull();
  });

  it("counts the placed half of the class once they are placed", () => {
    const placed = buildRosterIndex(
      HOME,
      [...MEMBERS, { studentId: "a1", studentGroupId: "4.1:1" }, { studentId: "a2", studentGroupId: "4.1:1" }],
      groups,
    );

    expect(audienceFor(lesson("4.1:1"), "4.1", placed)).toEqual({ attending: 2, cohortSize: 4, named: true });
  });
});

describe("Elevlistan i uppföljningen: a replacing group takes its pupils out of the room", () => {
  // The shared school (src/common/__fixtures__/pupil-list-cases.json): 7A of
  // Alva (in SvA7 and the half 7A:1), Bo (in Stöd7 and the half) and Cim.
  // With SvA7 replacing Svenska, Alva is not in the room for 7A's svenska or
  // the half's; Bo, in a support group that replaces nothing, is.
  interface Fixture {
    pupils: { id: string; homeGroupId: string; groupIds: string[] }[];
    lessons: { id: string; name: string; subjectId: string; groupIds: string[]; named: string[] }[];
    schools: {
      name: string;
      groups: { id: string; name: string; kind: string; halfOfId: string | null; replacesSubjectId: string | null; academicYearId: string }[];
      expected: Record<string, { on: string[]; off: string[] }>;
    }[];
  }
  const f = pupilList as unknown as Fixture;
  const home = new Map(f.pupils.map((pupil) => [pupil.id, pupil.homeGroupId] as [string, string | null]));
  const members = f.pupils.flatMap((pupil) => pupil.groupIds.map((studentGroupId) => ({ studentId: pupil.id, studentGroupId })));
  const asLesson = (l: Fixture["lessons"][number]) => ({
    studentGroupId: l.groupIds[0]!,
    extraGroupIds: l.groupIds.slice(1),
    studentIds: l.named,
    subjectId: l.subjectId,
  });

  it.each(f.schools.map((school) => [school.name, school] as const))("%s: each group's count is who of it lessonPupils puts on the lesson", (_name, school) => {
    const roster = buildRosterIndex(home, members, school.groups);
    for (const l of f.lessons) {
      const on = new Set(school.expected[l.id]!.on);
      for (const group of school.groups) {
        const cohort = roster.membersOf.get(group.id) ?? new Set<string>();
        const attending = [...cohort].filter((pupil) => on.has(pupil)).length;
        const audience = audienceFor(asLesson(l), group.id, roster);
        const named = l.groupIds.includes(group.id) || l.groupIds.some((id) => school.groups.find((g) => g.id === id)?.halfOfId === group.id);
        expect([l.name, group.name, audience?.attending ?? null]).toEqual([l.name, group.name, attending === 0 && !named ? null : attending]);
      }
    }
  });

  it("7A's own svenska is partly 7A's, 3/5, and nothing of SvA7's; with no replacing group it is 7A's whole, as before", () => {
    const [withSva, without] = f.schools;
    const classSvenska = asLesson(f.lessons.find((l) => l.name === "7A:s svenska")!);
    const c7a = withSva!.groups.find((g) => g.name === "7A")!.id;
    const sva7 = withSva!.groups.find((g) => g.name === "SvA7")!.id;
    const replaced = audienceFor(classSvenska, c7a, buildRosterIndex(home, members, withSva!.groups))!;
    expect(replaced).toEqual({ attending: 3, cohortSize: 5, named: true });
    expect(showsFraction(replaced)).toBe(true);
    expect(audienceFor(classSvenska, sva7, buildRosterIndex(home, members, withSva!.groups))).toBeNull();
    const plain = audienceFor(classSvenska, c7a, buildRosterIndex(home, members, without!.groups))!;
    expect(plain).toEqual({ attending: 5, cohortSize: 5, named: true });
    expect(showsFraction(plain)).toBe(false);
    // Without a subject the lesson is counted as before: nothing to replace.
    expect(audienceFor({ ...classSvenska, subjectId: undefined }, c7a, buildRosterIndex(home, members, withSva!.groups))!.attending).toBe(5);
  });
});
