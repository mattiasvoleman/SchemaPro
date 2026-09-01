import { describe, expect, it } from "vitest";
import type { AvailabilityConstraint, MasterLesson } from "@/lib/types";
import {
  buildGroupConflictMap,
  conflictKinds,
  detectConflicts,
  findOpenSlots,
  suggestPlacements,
  toPlacement,
  weeksCanOverlap,
  validatePlacement,
  type Placement,
  type RoomLockCheck,
} from "./conflicts";

// ---------------------------------------------------------------------------
// Factories. Placements default to the SAME slot (Monday 09:00–10:00) so that
// overlap is the baseline and non-overlap must be stated explicitly, but to a
// UNIQUE student group so that no test picks up an accidental GROUP clash.
// ---------------------------------------------------------------------------

let groupSeq = 0;

function makePlacement(overrides: Partial<Placement> = {}): Placement {
  return {
    id: null,
    dayOfWeek: 1,
    startMinutes: 9 * 60,
    endMinutes: 10 * 60,
    teacherId: null,
    roomId: null,
    studentGroupId: `unique-group-${++groupSeq}`,
    ...overrides,
  };
}

function makeConstraint(
  overrides: Partial<AvailabilityConstraint> = {},
): AvailabilityConstraint {
  return {
    id: "c1",
    resourceType: "TEACHER",
    userId: null,
    roomId: null,
    studentGroupId: null,
    minGradeLevel: null,
    maxGradeLevel: null,
    dayOfWeek: 1,
    date: null,
    startTime: "08:00",
    endTime: "17:00",
    type: "UNAVAILABLE",
    reason: null,
    ...overrides,
  };
}

function makeLesson(overrides: Partial<MasterLesson> = {}): MasterLesson {
  return {
    id: "L1",
    academicYearId: "year-1",
    subjectId: "subject-1",
    studentGroupId: `unique-group-${++groupSeq}`,
    teacherId: null,
    coTeacherId: null,
    roomId: null,
    dayOfWeek: 1,
    startTime: "09:00",
    endTime: "10:00",
    isLocked: false,
    recurrence: "ALL_WEEKS",
    startDate: null,
    endDate: null,
    extraGroupIds: [],
    studentIds: [],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// toPlacement
// ---------------------------------------------------------------------------

describe("toPlacement", () => {
  it("converts wall-clock times to minutes and carries every scheduling field", () => {
    const lesson = makeLesson({
      id: "L9",
      dayOfWeek: 4,
      startTime: "08:15",
      endTime: "09:05:30", // seconds are ignored by timeToMinutes
      teacherId: "t1",
      coTeacherId: "t2",
      roomId: "r1",
      studentGroupId: "gA",
      extraGroupIds: ["gB"],
      studentIds: ["s1", "s2"],
    });

    expect(toPlacement(lesson)).toEqual({
      id: "L9",
      dayOfWeek: 4,
      startMinutes: 8 * 60 + 15,
      endMinutes: 9 * 60 + 5,
      teacherId: "t1",
      coTeacherId: "t2",
      roomId: "r1",
      studentGroupId: "gA",
      extraGroupIds: ["gB"],
      studentIds: ["s1", "s2"],
      recurrence: "ALL_WEEKS",
      startDate: null,
      endDate: null,
    });
  });
});

// ---------------------------------------------------------------------------
// validatePlacement — interval semantics (probed through a shared teacher)
// ---------------------------------------------------------------------------

describe("validatePlacement interval semantics", () => {
  const at = (startMinutes: number, endMinutes: number) =>
    makePlacement({ teacherId: "t1", startMinutes, endMinutes });
  const otherAt = (startMinutes: number, endMinutes: number) =>
    makePlacement({ id: "other", teacherId: "t1", startMinutes, endMinutes });

  it("treats back-to-back lessons as conflict-free (half-open intervals)", () => {
    // candidate 09:00–10:00 vs other 10:00–11:00 — shared boundary, no clash
    expect(validatePlacement(at(540, 600), [otherAt(600, 660)], [])).toEqual([]);
    // ...and symmetrically when the other lesson ends where the candidate starts
    expect(validatePlacement(at(540, 600), [otherAt(480, 540)], [])).toEqual([]);
  });

  it("flags a single minute of overlap", () => {
    expect(validatePlacement(at(540, 600), [otherAt(599, 660)], [])).toEqual([
      { kind: "TEACHER", otherLessonId: "other" },
    ]);
  });

  it("flags identical intervals", () => {
    expect(validatePlacement(at(540, 600), [otherAt(540, 600)], [])).toEqual([
      { kind: "TEACHER", otherLessonId: "other" },
    ]);
  });

  it("flags full containment", () => {
    expect(validatePlacement(at(540, 600), [otherAt(555, 585)], [])).toEqual([
      { kind: "TEACHER", otherLessonId: "other" },
    ]);
  });

  it("never conflicts across different days, even at identical times", () => {
    const other = makePlacement({
      id: "other",
      teacherId: "t1",
      dayOfWeek: 2,
      startMinutes: 540,
      endMinutes: 600,
    });
    expect(validatePlacement(at(540, 600), [other], [])).toEqual([]);
  });

  it("treats a zero-duration placement as busy strictly inside an interval but free at its boundaries", () => {
    // inside: 09:30–09:30 within 09:00–10:00
    expect(validatePlacement(at(570, 570), [otherAt(540, 600)], [])).toEqual([
      { kind: "TEACHER", otherLessonId: "other" },
    ]);
    // exactly at the start / end boundary: half-open on both sides
    expect(validatePlacement(at(540, 540), [otherAt(540, 600)], [])).toEqual([]);
    expect(validatePlacement(at(600, 600), [otherAt(540, 600)], [])).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// validatePlacement — self-exclusion by id
// ---------------------------------------------------------------------------

describe("validatePlacement id handling", () => {
  it("skips the other placement carrying the candidate's own id", () => {
    const candidate = makePlacement({ id: "same", teacherId: "t1" });
    const stale = makePlacement({ id: "same", teacherId: "t1" });
    expect(validatePlacement(candidate, [stale], [])).toEqual([]);
  });

  it("never treats two null ids as the same lesson", () => {
    const candidate = makePlacement({ id: null, teacherId: "t1" });
    const other = makePlacement({ id: null, teacherId: "t1" });
    expect(validatePlacement(candidate, [other], [])).toEqual([
      { kind: "TEACHER", otherLessonId: undefined },
    ]);
  });

  it("omits otherLessonId when the clashing lesson is unsaved (null id)", () => {
    const candidate = makePlacement({ teacherId: "t1" });
    const other = makePlacement({ id: null, teacherId: "t1" });
    const hits = validatePlacement(candidate, [other], []);
    expect(hits).toHaveLength(1);
    expect(hits[0]?.kind).toBe("TEACHER");
    expect(hits[0]?.otherLessonId).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// validatePlacement — teachers
// ---------------------------------------------------------------------------

describe("validatePlacement teacher conflicts", () => {
  it("does not conflict when both lessons have no teacher", () => {
    const candidate = makePlacement({ teacherId: null });
    const other = makePlacement({ id: "other", teacherId: null });
    expect(validatePlacement(candidate, [other], [])).toEqual([]);
  });

  it("flags the candidate's co-teacher leading another lesson", () => {
    const candidate = makePlacement({ teacherId: "t1", coTeacherId: "t2" });
    const other = makePlacement({ id: "other", teacherId: "t2" });
    expect(validatePlacement(candidate, [other], [])).toEqual([
      { kind: "TEACHER", otherLessonId: "other" },
    ]);
  });

  it("flags two lessons sharing a co-teacher", () => {
    const candidate = makePlacement({ teacherId: "t1", coTeacherId: "shared" });
    const other = makePlacement({
      id: "other",
      teacherId: "t3",
      coTeacherId: "shared",
    });
    expect(validatePlacement(candidate, [other], [])).toEqual([
      { kind: "TEACHER", otherLessonId: "other" },
    ]);
  });
});

// ---------------------------------------------------------------------------
// validatePlacement — rooms
// ---------------------------------------------------------------------------

describe("validatePlacement room conflicts", () => {
  it("flags two lessons in the same room", () => {
    const candidate = makePlacement({ roomId: "r1" });
    const other = makePlacement({ id: "other", roomId: "r1" });
    expect(validatePlacement(candidate, [other], [])).toEqual([
      { kind: "ROOM", otherLessonId: "other" },
    ]);
  });

  it("does not conflict when both lessons are roomless", () => {
    const candidate = makePlacement({ roomId: null });
    const other = makePlacement({ id: "other", roomId: null });
    expect(validatePlacement(candidate, [other], [])).toEqual([]);
  });

  it("does not conflict across different rooms", () => {
    const candidate = makePlacement({ roomId: "r1" });
    const other = makePlacement({ id: "other", roomId: "r2" });
    expect(validatePlacement(candidate, [other], [])).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// validatePlacement — groups
// ---------------------------------------------------------------------------

describe("validatePlacement group conflicts", () => {
  it("flags a shared primary group", () => {
    const candidate = makePlacement({ studentGroupId: "gA" });
    const other = makePlacement({ id: "other", studentGroupId: "gA" });
    expect(validatePlacement(candidate, [other], [])).toEqual([
      { kind: "GROUP", otherLessonId: "other" },
    ]);
  });

  it("flags the candidate's primary group attending the other lesson as an extra group", () => {
    const candidate = makePlacement({ studentGroupId: "gA" });
    const other = makePlacement({ id: "other", extraGroupIds: ["gA"] });
    expect(validatePlacement(candidate, [other], [])).toEqual([
      { kind: "GROUP", otherLessonId: "other" },
    ]);
  });

  it("flags a group shared through both lessons' extra groups", () => {
    const candidate = makePlacement({ extraGroupIds: ["gShared"] });
    const other = makePlacement({ id: "other", extraGroupIds: ["gShared"] });
    expect(validatePlacement(candidate, [other], [])).toEqual([
      { kind: "GROUP", otherLessonId: "other" },
    ]);
  });
});

// ---------------------------------------------------------------------------
// validatePlacement — individual student participants
// ---------------------------------------------------------------------------

describe("validatePlacement student participants", () => {
  it("flags a student enrolled individually in both lessons (no map needed)", () => {
    const candidate = makePlacement({ studentIds: ["s1"] });
    const other = makePlacement({ id: "other", studentIds: ["s1", "s2"] });
    expect(validatePlacement(candidate, [other], [])).toEqual([
      { kind: "GROUP", otherLessonId: "other" },
    ]);
  });

  it("flags a candidate participant whose home class attends the other lesson", () => {
    const candidate = makePlacement({ studentIds: ["s1"] });
    const other = makePlacement({ id: "other", studentGroupId: "gHome" });
    const map = new Map<string, string | null>([["s1", "gHome"]]);
    expect(validatePlacement(candidate, [other], [], map)).toEqual([
      { kind: "GROUP", otherLessonId: "other" },
    ]);
  });

  it("flags the symmetric case: the other lesson's participant belongs to the candidate's class", () => {
    const candidate = makePlacement({ studentGroupId: "gHome" });
    const other = makePlacement({ id: "other", studentIds: ["s1"] });
    const map = new Map<string, string | null>([["s1", "gHome"]]);
    expect(validatePlacement(candidate, [other], [], map)).toEqual([
      { kind: "GROUP", otherLessonId: "other" },
    ]);
  });

  it("cannot detect home-class clashes without the studentGroupOf map", () => {
    const candidate = makePlacement({ studentIds: ["s1"] });
    const other = makePlacement({ id: "other", studentGroupId: "gHome" });
    // Same setup as above, but no map — only direct id intersection is checked.
    expect(validatePlacement(candidate, [other], [])).toEqual([]);
  });

  it("treats a student with no home class (null in the map) as unconstrained by classes", () => {
    const candidate = makePlacement({ studentIds: ["s1"] });
    const other = makePlacement({ id: "other", studentGroupId: "gHome" });
    const map = new Map<string, string | null>([["s1", null]]);
    expect(validatePlacement(candidate, [other], [], map)).toEqual([]);
  });

  it("can report GROUP twice for one lesson when both the class and a student clash", () => {
    // The class-overlap check and the participant check each push their own
    // GROUP hit for the same other lesson. Consumers dedupe via
    // conflictKinds(), so the duplication is benign — pinned here on purpose.
    const candidate = makePlacement({ studentGroupId: "gA", studentIds: ["s1"] });
    const other = makePlacement({
      id: "other",
      studentGroupId: "gA",
      studentIds: ["s1"],
    });
    expect(validatePlacement(candidate, [other], [])).toEqual([
      { kind: "GROUP", otherLessonId: "other" },
      { kind: "GROUP", otherLessonId: "other" },
    ]);
  });
});

// ---------------------------------------------------------------------------
// validatePlacement — multiple kinds and multiple others
// ---------------------------------------------------------------------------

describe("validatePlacement combined conflicts", () => {
  it("reports every clashing resource kind against one lesson, in TEACHER/ROOM/GROUP order", () => {
    const candidate = makePlacement({
      teacherId: "t1",
      roomId: "r1",
      studentGroupId: "gA",
    });
    const other = makePlacement({
      id: "other",
      teacherId: "t1",
      roomId: "r1",
      studentGroupId: "gA",
    });
    expect(validatePlacement(candidate, [other], [])).toEqual([
      { kind: "TEACHER", otherLessonId: "other" },
      { kind: "ROOM", otherLessonId: "other" },
      { kind: "GROUP", otherLessonId: "other" },
    ]);
  });

  it("accumulates hits across several other lessons", () => {
    const candidate = makePlacement({ teacherId: "t1", roomId: "r1" });
    const teacherClash = makePlacement({ id: "o1", teacherId: "t1" });
    const roomClash = makePlacement({ id: "o2", roomId: "r1" });
    expect(validatePlacement(candidate, [teacherClash, roomClash], [])).toEqual([
      { kind: "TEACHER", otherLessonId: "o1" },
      { kind: "ROOM", otherLessonId: "o2" },
    ]);
  });

  it("returns an empty list against an empty timetable with no constraints", () => {
    expect(validatePlacement(makePlacement({ teacherId: "t1" }), [], [])).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// validatePlacement — availability constraints
// ---------------------------------------------------------------------------

describe("validatePlacement availability constraints", () => {
  const candidate = () =>
    makePlacement({
      teacherId: "t1",
      roomId: "r1",
      studentGroupId: "gA",
      startMinutes: 540,
      endMinutes: 600,
    });

  it("flags an overlapping weekly UNAVAILABLE teacher constraint, without otherLessonId", () => {
    const hit = validatePlacement(candidate(), [], [
      makeConstraint({ userId: "t1", startTime: "09:30", endTime: "10:30" }),
    ]);
    expect(hit).toEqual([{ kind: "AVAILABILITY" }]);
    expect(hit[0]?.otherLessonId).toBeUndefined();
  });

  it("applies teacher constraints to the co-teacher as well", () => {
    const withCoTeacher = makePlacement({ teacherId: "t1", coTeacherId: "t2" });
    expect(
      validatePlacement(withCoTeacher, [], [makeConstraint({ userId: "t2" })]),
    ).toEqual([{ kind: "AVAILABILITY" }]);
  });

  it("uses half-open overlap: a constraint ending exactly at the lesson start is fine", () => {
    expect(
      validatePlacement(candidate(), [], [
        makeConstraint({ userId: "t1", startTime: "08:00", endTime: "09:00" }),
      ]),
    ).toEqual([]);
  });

  it("ignores PREFERRED_FREE and PREFERRED_BUSY constraints", () => {
    expect(
      validatePlacement(candidate(), [], [
        makeConstraint({ userId: "t1", type: "PREFERRED_FREE" }),
        makeConstraint({ userId: "t1", type: "PREFERRED_BUSY" }),
      ]),
    ).toEqual([]);
  });

  it("ignores one-off dated constraints (they act at publish time)", () => {
    expect(
      validatePlacement(candidate(), [], [
        makeConstraint({ userId: "t1", date: "2026-09-01" }),
      ]),
    ).toEqual([]);
  });

  it("ignores constraints on a different weekday", () => {
    expect(
      validatePlacement(candidate(), [], [
        makeConstraint({ userId: "t1", dayOfWeek: 2 }),
      ]),
    ).toEqual([]);
  });

  it("reads a weekly constraint with no weekday as EVERY day", () => {
    /*
     * This asserted the opposite, with no reason given, and the opposite is
     * what the engine does not do: TimeGrid.window_to_absolute_range expands a
     * null weekday across every teaching day. Reading it as "no day" here meant
     * the two halves of the app disagreed about the same row.
     *
     * Dated one-offs are skipped a few lines earlier, so after that point a
     * null weekday can only mean the recurring every-day case.
     *
     * No such row exists in production and the rules page cannot create one, so
     * this closes a divergence before anybody reaches it rather than fixing a
     * bug anybody has hit.
     */
    expect(
      validatePlacement(candidate(), [], [
        makeConstraint({ userId: "t1", dayOfWeek: null }),
      ]),
    ).toEqual([{ kind: "AVAILABILITY" }]);
  });

  it("still skips a one-off dated constraint, which publish handles", () => {
    // The other shape with a null weekday, and the reason the line above can
    // only mean "every day" by the time it runs.
    expect(
      validatePlacement(candidate(), [], [
        makeConstraint({ userId: "t1", dayOfWeek: null, date: "2027-02-24" }),
      ]),
    ).toEqual([]);
  });

  describe("year rules", () => {
    /*
     * The bug this branch exists for: a GRADE_LEVEL rule names no row — no
     * userId, no roomId, no studentGroupId — so it matched nothing here and was
     * ignored in silence. The solver refused to place åk 4 after 15:00 while
     * this function let the same lesson be dragged there and reported nothing,
     * and the gap search called the slot free.
     */
    const yearRule = (min: number | null, max: number | null) =>
      makeConstraint({
        resourceType: "GRADE_LEVEL",
        userId: null,
        minGradeLevel: min,
        maxGradeLevel: max,
      });

    const spans = (entries: Record<string, { min: number; max: number }>) =>
      new Map(Object.entries(entries));

    it("flags a lesson for a group inside the rule's years", () => {
      expect(
        validatePlacement(candidate(), [], [yearRule(4, 4)], undefined, undefined,
          spans({ gA: { min: 4, max: 4 } })),
      ).toEqual([{ kind: "AVAILABILITY" }]);
    });

    it("leaves a group outside the rule's years alone", () => {
      expect(
        validatePlacement(candidate(), [], [yearRule(4, 4)], undefined, undefined,
          spans({ gA: { min: 7, max: 7 } })),
      ).toEqual([]);
    });

    it("reaches a group that only overlaps the rule", () => {
      // Overlap, not containment: some of its pupils are in åk 6 and they
      // cannot be in two places.
      expect(
        validatePlacement(candidate(), [], [yearRule(4, 6)], undefined, undefined,
          spans({ gA: { min: 6, max: 7 } })),
      ).toEqual([{ kind: "AVAILABILITY" }]);
    });

    it("reaches through an extra group, not only the owning one", () => {
      const shared = { ...candidate(), extraGroupIds: ["g9"] };
      expect(
        validatePlacement(shared, [], [yearRule(9, 9)], undefined, undefined,
          spans({ gA: { min: 4, max: 4 }, g9: { min: 9, max: 9 } })),
      ).toEqual([{ kind: "AVAILABILITY" }]);
    });

    it("does not guess at a group whose year is unknown", () => {
      expect(
        validatePlacement(candidate(), [], [yearRule(4, 4)], undefined, undefined, spans({})),
      ).toEqual([]);
    });

    it("skips year rules entirely when no spans are supplied", () => {
      // What every caller got before this parameter existed. Stated so that a
      // caller which forgets to pass them fails visibly in review rather than
      // quietly reproducing the original bug.
      expect(
        validatePlacement(candidate(), [], [yearRule(4, 4)]),
      ).toEqual([]);
    });
  });

  it("flags a room constraint only for that room", () => {
    const roomConstraint = makeConstraint({
      resourceType: "ROOM",
      roomId: "r1",
      userId: null,
    });
    expect(validatePlacement(candidate(), [], [roomConstraint])).toEqual([
      { kind: "AVAILABILITY" },
    ]);
    const elsewhere = makePlacement({ roomId: "r2" });
    expect(validatePlacement(elsewhere, [], [roomConstraint])).toEqual([]);
  });

  it("never matches a room constraint against a roomless lesson, even with a null constraint room", () => {
    const roomless = makePlacement({ roomId: null });
    expect(
      validatePlacement(roomless, [], [
        makeConstraint({ resourceType: "ROOM", roomId: null }),
      ]),
    ).toEqual([]);
  });

  it("flags a student-group constraint matching an extra group", () => {
    const withExtra = makePlacement({ extraGroupIds: ["gExtra"] });
    expect(
      validatePlacement(withExtra, [], [
        makeConstraint({ resourceType: "STUDENT_GROUP", studentGroupId: "gExtra" }),
      ]),
    ).toEqual([{ kind: "AVAILABILITY" }]);
  });

  it("parses HH:MM:SS constraint times", () => {
    expect(
      validatePlacement(candidate(), [], [
        makeConstraint({
          userId: "t1",
          startTime: "08:00:00",
          endTime: "09:30:00",
        }),
      ]),
    ).toEqual([{ kind: "AVAILABILITY" }]);
  });
});

// ---------------------------------------------------------------------------
// detectConflicts
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// validatePlacement — ramtider
// ---------------------------------------------------------------------------

describe("validatePlacement frame times", () => {
  const frame = (
    min: number,
    max: number,
    start: string,
    end: string,
    dayOfWeek: number | null = null,
  ) => ({
    id: `f-${min}-${max}-${start}`,
    minGradeLevel: min,
    maxGradeLevel: max,
    dayOfWeek,
    startTime: `${start}:00`,
    endTime: `${end}:00`,
  });

  const spans = (entries: Record<string, { min: number; max: number }>) =>
    new Map(Object.entries(entries));

  /** 09:00-10:00 on a Monday, for group gA — the shared fixture's default. */
  const candidate = () => makePlacement({ studentGroupId: "gA" });

  const check = (
    placement: Placement,
    frames: ReturnType<typeof frame>[] | undefined,
    gradeSpanOf = spans({ gA: { min: 4, max: 4 } }),
  ) => validatePlacement(placement, [], [], undefined, undefined, gradeSpanOf, frames);

  it("is silent when no frames were supplied", () => {
    // The state every caller was in before frames existed, and the honest
    // reading of a query still in flight.
    expect(check(candidate(), undefined)).toEqual([]);
  });

  it("is silent when the school has no frames", () => {
    expect(check(candidate(), [])).toEqual([]);
  });

  it("leaves a lesson inside the frame alone", () => {
    expect(check(candidate(), [frame(4, 6, "08:00", "15:00")])).toEqual([]);
  });

  it("flags a lesson after the frame closes", () => {
    const late = makePlacement({
      studentGroupId: "gA",
      startMinutes: 16 * 60,
      endMinutes: 17 * 60,
    });
    expect(check(late, [frame(4, 6, "08:00", "15:00")])).toEqual([{ kind: "FRAME" }]);
  });

  it("flags a lesson before the frame opens", () => {
    const early = makePlacement({
      studentGroupId: "gA",
      startMinutes: 7 * 60,
      endMinutes: 8 * 60,
    });
    expect(check(early, [frame(4, 6, "08:00", "15:00")])).toEqual([{ kind: "FRAME" }]);
  });

  it("reports FRAME as its own kind, not as AVAILABILITY", () => {
    /*
     * The two are fixed differently: a busy teacher is one lesson to move, a
     * closed day may be the frame to change. A grid that said the same sentence
     * for both would send the reader to the wrong screen.
     */
    const late = makePlacement({
      studentGroupId: "gA",
      startMinutes: 16 * 60,
      endMinutes: 17 * 60,
    });
    const hits = check(late, [frame(4, 6, "08:00", "15:00")]);
    expect(hits.map((hit) => hit.kind)).not.toContain("AVAILABILITY");
  });

  it("does not reach a group in another stage", () => {
    const late = makePlacement({
      studentGroupId: "gA",
      startMinutes: 16 * 60,
      endMinutes: 17 * 60,
    });
    expect(check(late, [frame(7, 9, "08:00", "15:00")])).toEqual([]);
  });

  it("reports the double-booking first when a lesson is both", () => {
    // Whichever is listed first is what the grid shows; the booking's fix is
    // the unambiguous one.
    const late = makePlacement({
      id: "L1",
      studentGroupId: "gA",
      teacherId: "t1",
      startMinutes: 16 * 60,
      endMinutes: 17 * 60,
    });
    const other = makePlacement({
      id: "L2",
      studentGroupId: "gB",
      teacherId: "t1",
      startMinutes: 16 * 60,
      endMinutes: 17 * 60,
    });

    const hits = validatePlacement(
      late,
      [other],
      [],
      undefined,
      undefined,
      spans({ gA: { min: 4, max: 4 } }),
      [frame(4, 6, "08:00", "15:00")],
    );

    expect(hits.map((hit) => hit.kind)).toEqual(["TEACHER", "FRAME"]);
  });
});

// ---------------------------------------------------------------------------
// validatePlacement — the meal
// ---------------------------------------------------------------------------

describe("validatePlacement lunch sittings", () => {
  const spans = (entries: Record<string, { min: number; max: number }>) =>
    new Map(Object.entries(entries));

  /** gA eats 11:30-12:00 on Monday. */
  const lunch = () =>
    new Map([["gA:1", { startMinutes: 11 * 60 + 30, endMinutes: 12 * 60 }]]);

  const at = (start: number, end: number) =>
    makePlacement({ studentGroupId: "gA", startMinutes: start, endMinutes: end });

  const check = (
    placement: Placement,
    lunchOf: ReturnType<typeof lunch> | undefined,
  ) =>
    validatePlacement(
      placement,
      [],
      [],
      undefined,
      undefined,
      spans({ gA: { min: 4, max: 4 } }),
      [],
      lunchOf,
    );

  it("is silent when no sittings were supplied", () => {
    // A band with no validator looks like a rule and behaves like decoration.
    // Absent is the honest reading of a query still in flight.
    expect(check(at(11 * 60 + 30, 12 * 60), undefined)).toEqual([]);
  });

  it("flags a lesson dropped on the class's own meal", () => {
    expect(check(at(11 * 60 + 45, 12 * 60 + 45), lunch())).toEqual([
      { kind: "LUNCH" },
    ]);
  });

  it("leaves a lesson that ends when the meal starts alone", () => {
    expect(check(at(10 * 60 + 30, 11 * 60 + 30), lunch())).toEqual([]);
  });

  it("leaves a lesson that starts when the meal ends alone", () => {
    expect(check(at(12 * 60, 13 * 60), lunch())).toEqual([]);
  });

  it("looks at the lesson's own weekday", () => {
    const tuesday = makePlacement({
      studentGroupId: "gA",
      dayOfWeek: 2,
      startMinutes: 11 * 60 + 45,
      endMinutes: 12 * 60 + 45,
    });
    expect(check(tuesday, lunch())).toEqual([]);
  });

  it("reports LUNCH once for a lesson two classes attend, not twice", () => {
    const shared = makePlacement({
      studentGroupId: "gA",
      extraGroupIds: ["gB"],
      startMinutes: 11 * 60 + 45,
      endMinutes: 12 * 60 + 45,
    });
    const both = new Map([
      ["gA:1", { startMinutes: 11 * 60 + 30, endMinutes: 12 * 60 }],
      ["gB:1", { startMinutes: 11 * 60 + 30, endMinutes: 12 * 60 }],
    ]);

    expect(check(shared, both)).toEqual([{ kind: "LUNCH" }]);
  });

  it("flags the lesson when only the second class is eating", () => {
    const shared = makePlacement({
      studentGroupId: "gA",
      extraGroupIds: ["gB"],
      startMinutes: 11 * 60 + 45,
      endMinutes: 12 * 60 + 45,
    });
    const onlyB = new Map([
      ["gB:1", { startMinutes: 11 * 60 + 30, endMinutes: 12 * 60 }],
    ]);

    expect(check(shared, onlyB)).toEqual([{ kind: "LUNCH" }]);
  });

  it("reports the double-booking before the meal", () => {
    // Whichever is listed first is what the grid shows, and a booking's fix is
    // the unambiguous one.
    const late = makePlacement({
      id: "L1",
      studentGroupId: "gA",
      teacherId: "t1",
      startMinutes: 11 * 60 + 45,
      endMinutes: 12 * 60 + 45,
    });
    const other = makePlacement({
      id: "L2",
      studentGroupId: "gB",
      teacherId: "t1",
      startMinutes: 11 * 60 + 45,
      endMinutes: 12 * 60 + 45,
    });

    const hits = validatePlacement(
      late,
      [other],
      [],
      undefined,
      undefined,
      spans({ gA: { min: 4, max: 4 } }),
      [],
      lunch(),
    );

    expect(hits.map((hit) => hit.kind)).toEqual(["TEACHER", "LUNCH"]);
  });
});

// ---------------------------------------------------------------------------
// validatePlacement — the locked room
// ---------------------------------------------------------------------------

describe("validatePlacement room locks", () => {
  /** Forbids every room but "ok". */
  const lock = (): RoomLockCheck => (placement) =>
    placement.roomId !== null && placement.roomId !== "ok";

  const at = (roomId: string | null) => makePlacement({ roomId });

  const check = (placement: Placement, roomLock?: RoomLockCheck) =>
    validatePlacement(
      placement,
      [],
      [],
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      roomLock,
    );

  it("is silent when no locks were supplied", () => {
    expect(check(at("wrong"), undefined)).toEqual([]);
  });

  it("flags a lesson in a room its lock forbids", () => {
    expect(check(at("wrong"), lock())).toEqual([{ kind: "ROOM_LOCK" }]);
  });

  it("leaves a lesson in an allowed room alone", () => {
    expect(check(at("ok"), lock())).toEqual([]);
  });

  it("reports the room lock last, after everything about time", () => {
    /*
     * A lock says nothing about WHEN the lesson is — it would be just as true
     * at any other hour — so a reader scanning the list wants the time clashes
     * first.
     */
    const candidate = makePlacement({ id: "L1", teacherId: "t1", roomId: "wrong" });
    const other = makePlacement({ id: "L2", teacherId: "t1", roomId: "elsewhere" });

    const hits = validatePlacement(
      candidate,
      [other],
      [],
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      lock(),
    );

    expect(hits.map((hit) => hit.kind)).toEqual(["TEACHER", "ROOM_LOCK"]);
  });
});

describe("detectConflicts", () => {
  it("returns an empty map for an empty timetable", () => {
    expect(detectConflicts([], []).size).toBe(0);
  });

  /*
   * detectConflicts took the spans and dropped them: it never passed them on to
   * validatePlacement. Every year-rule test below it went through
   * validatePlacement directly, so the whole suite stayed green while the
   * timetable page — which calls detectConflicts, not validatePlacement — kept
   * showing åk 4 as unflagged at 16:00.
   */
  it("passes the room locks on to each lesson it checks", () => {
    /*
     * detectConflicts is what the GRID reads; validatePlacement is the drag
     * predicate, which deliberately never gets the locks. So a lock that
     * reaches the one and not the other is invisible in exactly the place the
     * feature exists to be visible — the same hole the year spans had.
     */
    const lesson = makeLesson({ id: "L1", roomId: "wrong" });
    const locked: RoomLockCheck = (placement) => placement.roomId === "wrong";

    expect(
      detectConflicts([lesson], [], undefined, undefined, undefined, undefined, undefined, locked)
        .get("L1"),
    ).toEqual([{ kind: "ROOM_LOCK" }]);
  });

  it("passes the year spans on to each lesson it checks", () => {
    const lesson = makeLesson({ id: "L1", studentGroupId: "gA" });
    const rule = makeConstraint({
      resourceType: "GRADE_LEVEL",
      userId: null,
      minGradeLevel: 4,
      maxGradeLevel: 4,
    });
    const spans = new Map([["gA", { min: 4, max: 4 }]]);

    expect(detectConflicts([lesson], [rule], undefined, undefined, spans).get("L1")).toEqual([
      { kind: "AVAILABILITY" },
    ]);
  });

  it("leaves a year outside the rule alone when the spans are passed on", () => {
    const lesson = makeLesson({ id: "L1", studentGroupId: "gA" });
    const rule = makeConstraint({
      resourceType: "GRADE_LEVEL",
      userId: null,
      minGradeLevel: 4,
      maxGradeLevel: 4,
    });
    const spans = new Map([["gA", { min: 7, max: 9 }]]);

    expect(detectConflicts([lesson], [rule], undefined, undefined, spans).size).toBe(0);
  });

  it("returns an empty map for a clean timetable", () => {
    const monday = makeLesson({ id: "L1", teacherId: "t1" });
    const tuesday = makeLesson({ id: "L2", teacherId: "t1", dayOfWeek: 2 });
    const later = makeLesson({
      id: "L3",
      teacherId: "t1",
      startTime: "10:00",
      endTime: "11:00",
    });
    expect(detectConflicts([monday, tuesday, later], []).size).toBe(0);
  });

  it("flags both sides of a double-booking, each pointing at the other", () => {
    const l1 = makeLesson({ id: "L1", teacherId: "t-shared" });
    const l2 = makeLesson({
      id: "L2",
      teacherId: "t-shared",
      startTime: "09:30",
      endTime: "10:30",
    });
    const map = detectConflicts([l1, l2], []);
    expect(map.size).toBe(2);
    expect(map.get("L1")).toEqual([{ kind: "TEACHER", otherLessonId: "L2" }]);
    expect(map.get("L2")).toEqual([{ kind: "TEACHER", otherLessonId: "L1" }]);
  });

  it("leaves unaffected lessons out of the map", () => {
    const l1 = makeLesson({ id: "L1", roomId: "r1" });
    const l2 = makeLesson({ id: "L2", roomId: "r1" });
    const bystander = makeLesson({ id: "L3", dayOfWeek: 5 });
    const map = detectConflicts([l1, l2, bystander], []);
    expect(map.size).toBe(2);
    expect(map.has("L3")).toBe(false);
  });

  it("includes availability violations keyed by lesson id", () => {
    const l1 = makeLesson({ id: "L1", teacherId: "t1" });
    const map = detectConflicts([l1], [makeConstraint({ userId: "t1" })]);
    expect(map.get("L1")).toEqual([{ kind: "AVAILABILITY" }]);
  });

  it("forwards the studentGroupOf map so participant clashes surface on both lessons", () => {
    const classLesson = makeLesson({ id: "L1", teacherId: "t1", studentGroupId: "gA" });
    const elective = makeLesson({
      id: "L2",
      teacherId: "t2",
      studentGroupId: "gB",
      studentIds: ["s1"],
    });
    // Without the map the timetable looks clean...
    expect(detectConflicts([classLesson, elective], []).size).toBe(0);
    // ...with it, s1's home class (gA) makes both lessons clash.
    const map = detectConflicts(
      [classLesson, elective],
      [],
      new Map([["s1", "gA"]]),
    );
    expect(map.get("L1")).toEqual([{ kind: "GROUP", otherLessonId: "L2" }]);
    expect(map.get("L2")).toEqual([{ kind: "GROUP", otherLessonId: "L1" }]);
  });
});

// ---------------------------------------------------------------------------
// conflictKinds
// ---------------------------------------------------------------------------

describe("conflictKinds", () => {
  it("dedupes kinds preserving first-seen order", () => {
    expect(
      conflictKinds([
        { kind: "TEACHER", otherLessonId: "a" },
        { kind: "GROUP", otherLessonId: "b" },
        { kind: "TEACHER", otherLessonId: "c" },
        { kind: "AVAILABILITY" },
      ]),
    ).toEqual(["TEACHER", "GROUP", "AVAILABILITY"]);
  });

  it("returns an empty list for no hits", () => {
    expect(conflictKinds([])).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// suggestPlacements
// ---------------------------------------------------------------------------

describe("suggestPlacements", () => {
  it("ranks same-day free slots by distance from the requested start", () => {
    const candidate = makePlacement({
      id: "move-me",
      dayOfWeek: 2,
      startMinutes: 540,
      endMinutes: 600,
      teacherId: "t1",
    });
    const blocker = makePlacement({
      id: "blocker",
      dayOfWeek: 2,
      startMinutes: 540,
      endMinutes: 600,
      teacherId: "t1",
    });

    expect(
      suggestPlacements(candidate, [blocker], [], { days: [2], limit: 4 }),
    ).toEqual([
      { dayOfWeek: 2, startMinutes: 480, endMinutes: 540, score: 60 },
      { dayOfWeek: 2, startMinutes: 600, endMinutes: 660, score: 60 },
      { dayOfWeek: 2, startMinutes: 615, endMinutes: 675, score: 75 },
      { dayOfWeek: 2, startMinutes: 630, endMinutes: 690, score: 90 },
    ]);
  });

  it("prefers same-day slots and only then walks to adjacent days", () => {
    const candidate = makePlacement({
      id: "move-me",
      dayOfWeek: 2,
      startMinutes: 540,
      endMinutes: 600,
      teacherId: "t1",
    });
    // The teacher is busy for the whole of Tuesday, so every same-day slot
    // conflicts and the nearest neighbours are Monday/Wednesday at 09:00.
    const allDayTuesday = makePlacement({
      id: "blocker",
      dayOfWeek: 2,
      startMinutes: 480,
      endMinutes: 1020,
      teacherId: "t1",
    });

    expect(suggestPlacements(candidate, [allDayTuesday], [])).toEqual([
      { dayOfWeek: 1, startMinutes: 540, endMinutes: 600, score: 1440 },
      { dayOfWeek: 3, startMinutes: 540, endMinutes: 600, score: 1440 },
      { dayOfWeek: 1, startMinutes: 525, endMinutes: 585, score: 1455 },
      { dayOfWeek: 1, startMinutes: 555, endMinutes: 615, score: 1455 },
      { dayOfWeek: 3, startMinutes: 525, endMinutes: 585, score: 1455 },
    ]);
  });

  it("excludes the requested slot itself even when it is conflict-free", () => {
    const candidate = makePlacement({
      id: null,
      dayOfWeek: 3,
      startMinutes: 540,
      endMinutes: 600,
      teacherId: "t1",
    });
    const suggestions = suggestPlacements(candidate, [], []);
    expect(
      suggestions.some((s) => s.dayOfWeek === 3 && s.startMinutes === 540),
    ).toBe(false);
    expect(
      suggestions.map((s) => ({ dayOfWeek: s.dayOfWeek, startMinutes: s.startMinutes, score: s.score })),
    ).toEqual([
      { dayOfWeek: 3, startMinutes: 525, score: 15 },
      { dayOfWeek: 3, startMinutes: 555, score: 15 },
      { dayOfWeek: 3, startMinutes: 510, score: 30 },
      { dayOfWeek: 3, startMinutes: 570, score: 30 },
      { dayOfWeek: 3, startMinutes: 495, score: 45 },
    ]);
  });

  it("ignores the candidate's own saved placement when it appears in others", () => {
    const candidate = makePlacement({
      id: "move-me",
      dayOfWeek: 2,
      startMinutes: 540,
      endMinutes: 600,
      teacherId: "t1",
    });
    const suggestions = suggestPlacements(candidate, [{ ...candidate }], [], {
      days: [2],
      limit: 3,
    });
    // If the id skip failed, every slot overlapping 09:00–10:00 would clash
    // with the candidate's own copy and 525/555 could not be suggested.
    expect(suggestions).toEqual([
      { dayOfWeek: 2, startMinutes: 525, endMinutes: 585, score: 15 },
      { dayOfWeek: 2, startMinutes: 555, endMinutes: 615, score: 15 },
      { dayOfWeek: 2, startMinutes: 510, endMinutes: 570, score: 30 },
    ]);
  });

  it("preserves the lesson duration and fits it inside the day window", () => {
    const candidate = makePlacement({
      id: "move-me",
      dayOfWeek: 1,
      startMinutes: 480,
      endMinutes: 600, // 120 minutes
      teacherId: "t1",
    });
    // Window of exactly 120 minutes: only start 480 fits; day 1 at 480 is the
    // requested slot itself, so day 2 is the single suggestion.
    expect(
      suggestPlacements(candidate, [], [], {
        days: [1, 2],
        dayStartMinutes: 480,
        dayEndMinutes: 600,
      }),
    ).toEqual([{ dayOfWeek: 2, startMinutes: 480, endMinutes: 600, score: 1440 }]);
  });

  it("returns nothing when the lesson cannot fit in the day window", () => {
    const tenHours = makePlacement({
      id: "move-me",
      startMinutes: 480,
      endMinutes: 1080, // 600 min > default 08:00–17:00 window
      teacherId: "t1",
    });
    expect(suggestPlacements(tenHours, [], [])).toEqual([]);
  });

  it("skips slots blocked by availability constraints", () => {
    const candidate = makePlacement({
      id: "move-me",
      dayOfWeek: 1,
      startMinutes: 540,
      endMinutes: 600,
      teacherId: "t1",
    });
    const morningOff = makeConstraint({
      userId: "t1",
      startTime: "08:00",
      endTime: "12:00",
    });
    const suggestions = suggestPlacements(candidate, [], [morningOff], {
      days: [1],
    });
    expect(suggestions.map((s) => s.startMinutes)).toEqual([
      720, 735, 750, 765, 780,
    ]);
    expect(suggestions[0]).toEqual({
      dayOfWeek: 1,
      startMinutes: 720,
      endMinutes: 780,
      score: 180,
    });
  });

  it("returns nothing when every slot conflicts", () => {
    const candidate = makePlacement({
      id: "move-me",
      dayOfWeek: 1,
      startMinutes: 540,
      endMinutes: 600,
      teacherId: "t1",
    });
    const allWeekOff = makeConstraint({
      userId: "t1",
      startTime: "08:00",
      endTime: "17:00",
    });
    expect(suggestPlacements(candidate, [], [allWeekOff], { days: [1] })).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// findOpenSlots
// ---------------------------------------------------------------------------

describe("findOpenSlots", () => {
  it("offers the earliest slots with the assigned teacher, up to the default limit of 8", () => {
    const matches = findOpenSlots({
      studentGroupIds: ["gA"],
      durationMinutes: 60,
      primaryTeacherIds: ["t1"],
      fallbackTeacherIds: [],
      placements: [],
      constraints: [],
    });
    expect(matches).toHaveLength(8);
    expect(matches[0]).toEqual({
      dayOfWeek: 1,
      startMinutes: 480,
      endMinutes: 540,
      teacherId: "t1",
      isFallback: false,
    });
    expect(matches[7]).toEqual({
      dayOfWeek: 1,
      startMinutes: 585,
      endMinutes: 645,
      teacherId: "t1",
      isFallback: false,
    });
    expect(matches.every((m) => m.dayOfWeek === 1 && !m.isFallback)).toBe(true);
  });

  it("treats a slot starting exactly when the class's lesson ends as free (half-open)", () => {
    const busyUntilNine = makePlacement({
      id: "existing",
      dayOfWeek: 1,
      startMinutes: 480,
      endMinutes: 540,
      studentGroupId: "gA",
    });
    expect(
      findOpenSlots({
        studentGroupIds: ["gA"],
        durationMinutes: 60,
        primaryTeacherIds: ["t1"],
        fallbackTeacherIds: [],
        placements: [busyUntilNine],
        constraints: [],
        days: [1],
        dayStartMinutes: 480,
        dayEndMinutes: 600,
        stepMinutes: 15,
      }),
    ).toEqual([
      {
        dayOfWeek: 1,
        startMinutes: 540,
        endMinutes: 600,
        teacherId: "t1",
        isFallback: false,
      },
    ]);
  });

  it("counts a class attending another lesson as an extra group as busy", () => {
    const jointLesson = makePlacement({
      id: "joint",
      dayOfWeek: 1,
      startMinutes: 480,
      endMinutes: 540,
      studentGroupId: "gOther",
      extraGroupIds: ["gA"],
    });
    const matches = findOpenSlots({
      studentGroupIds: ["gA"],
      durationMinutes: 60,
      primaryTeacherIds: ["t1"],
      fallbackTeacherIds: [],
      placements: [jointLesson],
      constraints: [],
      days: [1],
      dayStartMinutes: 480,
      dayEndMinutes: 600,
      stepMinutes: 60,
    });
    expect(matches.map((m) => m.startMinutes)).toEqual([540]);
  });

  it("offers a fallback teacher only for slots where no primary is free, ranked after all primary matches", () => {
    const primaryBusyMonday = makePlacement({
      id: "busy",
      dayOfWeek: 1,
      startMinutes: 480,
      endMinutes: 600,
      teacherId: "t1",
      studentGroupId: "gZ",
    });
    const matches = findOpenSlots({
      studentGroupIds: ["gA"],
      durationMinutes: 60,
      primaryTeacherIds: ["t1"],
      fallbackTeacherIds: ["t2"],
      placements: [primaryBusyMonday],
      constraints: [],
      days: [1, 2],
      dayStartMinutes: 480,
      dayEndMinutes: 600,
      stepMinutes: 60,
    });
    // Tuesday's primary matches outrank Monday's fallback matches even though
    // Monday comes earlier in the week — assigned-teacher slots always win.
    expect(matches).toEqual([
      { dayOfWeek: 2, startMinutes: 480, endMinutes: 540, teacherId: "t1", isFallback: false },
      { dayOfWeek: 2, startMinutes: 540, endMinutes: 600, teacherId: "t1", isFallback: false },
      { dayOfWeek: 1, startMinutes: 480, endMinutes: 540, teacherId: "t2", isFallback: true },
      { dayOfWeek: 1, startMinutes: 540, endMinutes: 600, teacherId: "t2", isFallback: true },
    ]);
  });

  it("applies the limit across the combined primary + fallback list", () => {
    const primaryBusyMonday = makePlacement({
      id: "busy",
      dayOfWeek: 1,
      startMinutes: 480,
      endMinutes: 600,
      teacherId: "t1",
      studentGroupId: "gZ",
    });
    const matches = findOpenSlots({
      studentGroupIds: ["gA"],
      durationMinutes: 60,
      primaryTeacherIds: ["t1"],
      fallbackTeacherIds: ["t2"],
      placements: [primaryBusyMonday],
      constraints: [],
      days: [1, 2],
      dayStartMinutes: 480,
      dayEndMinutes: 600,
      stepMinutes: 60,
      limit: 3,
    });
    expect(matches).toHaveLength(3);
    expect(matches[2]).toEqual({
      dayOfWeek: 1,
      startMinutes: 480,
      endMinutes: 540,
      teacherId: "t2",
      isFallback: true,
    });
  });

  it("yields no match for a slot where the classes are free but no teacher is", () => {
    const t1Busy = makePlacement({
      id: "b1",
      dayOfWeek: 1,
      startMinutes: 480,
      endMinutes: 540,
      teacherId: "t1",
    });
    const t2Busy = makePlacement({
      id: "b2",
      dayOfWeek: 1,
      startMinutes: 480,
      endMinutes: 540,
      teacherId: "t2",
    });
    expect(
      findOpenSlots({
        studentGroupIds: ["gA"],
        durationMinutes: 60,
        primaryTeacherIds: ["t1"],
        fallbackTeacherIds: ["t2"],
        placements: [t1Busy, t2Busy],
        constraints: [],
        days: [1],
        dayStartMinutes: 480,
        dayEndMinutes: 540,
        stepMinutes: 60,
      }),
    ).toEqual([]);
  });

  it("treats a teacher co-teaching another lesson as busy", () => {
    const coTeaching = makePlacement({
      id: "co",
      dayOfWeek: 1,
      startMinutes: 480,
      endMinutes: 540,
      teacherId: "someone-else",
      coTeacherId: "t1",
    });
    expect(
      findOpenSlots({
        studentGroupIds: ["gA"],
        durationMinutes: 60,
        primaryTeacherIds: ["t1"],
        fallbackTeacherIds: [],
        placements: [coTeaching],
        constraints: [],
        days: [1],
        dayStartMinutes: 480,
        dayEndMinutes: 540,
        stepMinutes: 60,
      }),
    ).toEqual([]);
  });

  it("requires each participant's home class to be free", () => {
    const homeClassBusy = makePlacement({
      id: "homeroom",
      dayOfWeek: 1,
      startMinutes: 480,
      endMinutes: 540,
      studentGroupId: "gB",
    });
    const matches = findOpenSlots({
      studentGroupIds: ["gA"],
      participantStudentIds: ["s1"],
      studentGroupOf: new Map([["s1", "gB"]]),
      durationMinutes: 60,
      primaryTeacherIds: ["t1"],
      fallbackTeacherIds: [],
      placements: [homeClassBusy],
      constraints: [],
      days: [1],
      dayStartMinutes: 480,
      dayEndMinutes: 600,
      stepMinutes: 60,
    });
    expect(matches.map((m) => m.startMinutes)).toEqual([540]);
  });

  it("excludes slots where a participant is individually booked elsewhere", () => {
    const elective = makePlacement({
      id: "elective",
      dayOfWeek: 1,
      startMinutes: 480,
      endMinutes: 540,
      studentIds: ["s1"],
    });
    const matches = findOpenSlots({
      studentGroupIds: ["gA"],
      participantStudentIds: ["s1"],
      durationMinutes: 60,
      primaryTeacherIds: ["t1"],
      fallbackTeacherIds: [],
      placements: [elective],
      constraints: [],
      days: [1],
      dayStartMinutes: 480,
      dayEndMinutes: 600,
      stepMinutes: 60,
    });
    expect(matches.map((m) => m.startMinutes)).toEqual([540]);
  });

  it("adds no group requirement for a participant with no home class", () => {
    const matches = findOpenSlots({
      studentGroupIds: ["gA"],
      participantStudentIds: ["s1"],
      studentGroupOf: new Map([["s1", null]]),
      durationMinutes: 60,
      primaryTeacherIds: ["t1"],
      fallbackTeacherIds: [],
      placements: [],
      constraints: [],
      days: [1],
      dayStartMinutes: 480,
      dayEndMinutes: 600,
      stepMinutes: 60,
    });
    expect(matches).toHaveLength(2);
  });

  it("excludes slots blocked by a weekly teacher UNAVAILABLE constraint", () => {
    const matches = findOpenSlots({
      studentGroupIds: ["gA"],
      durationMinutes: 60,
      primaryTeacherIds: ["t1"],
      fallbackTeacherIds: [],
      placements: [],
      constraints: [makeConstraint({ userId: "t1", startTime: "08:00", endTime: "09:00" })],
      days: [1],
      dayStartMinutes: 480,
      dayEndMinutes: 600,
      stepMinutes: 60,
    });
    expect(matches.map((m) => m.startMinutes)).toEqual([540]);
  });

  it("excludes slots blocked by a weekly student-group UNAVAILABLE constraint", () => {
    const matches = findOpenSlots({
      studentGroupIds: ["gA"],
      durationMinutes: 60,
      primaryTeacherIds: ["t1"],
      fallbackTeacherIds: [],
      placements: [],
      constraints: [
        makeConstraint({
          resourceType: "STUDENT_GROUP",
          studentGroupId: "gA",
          startTime: "08:00",
          endTime: "09:00",
        }),
      ],
      days: [1],
      dayStartMinutes: 480,
      dayEndMinutes: 600,
      stepMinutes: 60,
    });
    expect(matches.map((m) => m.startMinutes)).toEqual([540]);
  });

  it("ignores dated and preference constraints", () => {
    const matches = findOpenSlots({
      studentGroupIds: ["gA"],
      durationMinutes: 60,
      primaryTeacherIds: ["t1"],
      fallbackTeacherIds: [],
      placements: [],
      constraints: [
        makeConstraint({ userId: "t1", date: "2026-09-01" }),
        makeConstraint({ userId: "t1", type: "PREFERRED_FREE" }),
      ],
      days: [1],
      dayStartMinutes: 480,
      dayEndMinutes: 600,
      stepMinutes: 60,
    });
    expect(matches).toHaveLength(2);
  });

  it("returns nothing when the duration does not fit the day window", () => {
    expect(
      findOpenSlots({
        studentGroupIds: ["gA"],
        durationMinutes: 200,
        primaryTeacherIds: ["t1"],
        fallbackTeacherIds: [],
        placements: [],
        constraints: [],
        days: [1],
        dayStartMinutes: 480,
        dayEndMinutes: 600,
      }),
    ).toEqual([]);
  });
});

describe("teaching-group conflicts (groups sharing students)", () => {
  const base = {
    id: null,
    dayOfWeek: 1,
    startMinutes: 8 * 60,
    endMinutes: 9 * 60,
    teacherId: "t-1",
    coTeacherId: null,
    roomId: "r-1",
    extraGroupIds: [],
    studentIds: [],
  };
  const class7a: Placement = { ...base, id: "l-7a", studentGroupId: "g-7a" };
  const ma71: Placement = {
    ...base,
    id: "l-ma71",
    studentGroupId: "g-ma71",
    teacherId: "t-2",
    roomId: "r-2",
  };

  it("buildGroupConflictMap pairs a home class with a teaching group via a shared student", () => {
    const relation = buildGroupConflictMap(
      new Map([["s-1", "g-7a"]]),
      [{ studentId: "s-1", studentGroupId: "g-ma71" }],
    );
    expect(relation.get("g-7a")?.has("g-ma71")).toBe(true);
    expect(relation.get("g-ma71")?.has("g-7a")).toBe(true);
  });

  it("flags overlapping lessons for groups that share students", () => {
    const relation = buildGroupConflictMap(
      new Map([["s-1", "g-7a"]]),
      [{ studentId: "s-1", studentGroupId: "g-ma71" }],
    );
    const hits = validatePlacement(ma71, [class7a], [], new Map(), relation);
    expect(hits.map((hit) => hit.kind)).toContain("GROUP");
  });

  it("does NOT flag the same overlap without shared students", () => {
    // Same two lessons, but the membership rows connect nobody: the groups
    // are disjoint and may run in parallel. This is the non-vacuity twin of
    // the test above — remove the relation and the hit must disappear.
    const relation = buildGroupConflictMap(new Map([["s-1", "g-7a"]]), []);
    const hits = validatePlacement(ma71, [class7a], [], new Map(), relation);
    expect(hits.map((hit) => hit.kind)).not.toContain("GROUP");
  });

  it("ignores non-overlapping lessons even for conflicting groups", () => {
    const relation = buildGroupConflictMap(
      new Map([["s-1", "g-7a"]]),
      [{ studentId: "s-1", studentGroupId: "g-ma71" }],
    );
    const later = { ...ma71, startMinutes: 9 * 60, endMinutes: 10 * 60 };
    const hits = validatePlacement(later, [class7a], [], new Map(), relation);
    expect(hits).toHaveLength(0);
  });

  it("detectConflicts marks both lessons of a conflicting overlapping pair", () => {
    const relation = buildGroupConflictMap(
      new Map([["s-1", "g-7a"]]),
      [{ studentId: "s-1", studentGroupId: "g-ma71" }],
    );
    // detectConflicts takes MasterLesson rows (HH:MM times), not placements.
    const asLesson = (placement: Placement): MasterLesson =>
      ({
        id: placement.id!,
        academicYearId: "y-1",
        subjectId: "subj-1",
        studentGroupId: placement.studentGroupId,
        teacherId: placement.teacherId,
        coTeacherId: null,
        roomId: placement.roomId,
        dayOfWeek: placement.dayOfWeek,
        startTime: "08:00",
        endTime: "09:00",
        isLocked: false,
        extraGroupIds: [],
        studentIds: [],
      }) as unknown as MasterLesson;
    const map = detectConflicts(
      [asLesson(class7a), asLesson(ma71)],
      [],
      new Map(),
      relation,
    );
    expect(map.get("l-7a")).toBeTruthy();
    expect(map.get("l-ma71")).toBeTruthy();
  });

  it("two teaching groups sharing a student conflict with each other", () => {
    // Neither group is anyone's home class: Ma71 vs Sv73 with one common
    // student, connected purely through membership rows.
    const relation = buildGroupConflictMap(new Map(), [
      { studentId: "s-1", studentGroupId: "g-ma71" },
      { studentId: "s-1", studentGroupId: "g-sv73" },
    ]);
    const sv73 = { ...class7a, id: "l-sv73", studentGroupId: "g-sv73" };
    const hits = validatePlacement(ma71, [sv73], [], new Map(), relation);
    expect(hits.map((hit) => hit.kind)).toContain("GROUP");
  });
});

describe("alternating weeks", () => {
  const at = (overrides: Partial<MasterLesson>) =>
    toPlacement(makeLesson({ dayOfWeek: 1, startTime: "09:00", endTime: "10:00", ...overrides }));

  it("lets opposite parities share a slot, room and teacher", () => {
    // Slöjd udda veckor and hemkunskap jämna veckor in the same slot is the
    // whole point of the feature, and the grid must not refuse the drag.
    const slojd = at({ id: "L1", recurrence: "ODD_WEEKS", roomId: "r1", teacherId: "t1" });
    const hemkunskap = at({
      id: "L2",
      recurrence: "EVEN_WEEKS",
      roomId: "r1",
      teacherId: "t1",
      studentGroupId: slojd.studentGroupId,
    });

    expect(validatePlacement(hemkunskap, [slojd], [])).toEqual([]);
  });

  it("still reports a clash when both run the same weeks", () => {
    const first = at({ id: "L1", recurrence: "ODD_WEEKS", roomId: "r1" });
    const second = at({ id: "L2", recurrence: "ODD_WEEKS", roomId: "r1" });

    expect(conflictKinds(validatePlacement(second, [first], []))).toContain(
      "ROOM",
    );
  });

  it("still reports a clash when one of them runs every week", () => {
    const weekly = at({ id: "L1", roomId: "r1" });
    const odd = at({ id: "L2", recurrence: "ODD_WEEKS", roomId: "r1" });

    expect(conflictKinds(validatePlacement(odd, [weekly], []))).toContain(
      "ROOM",
    );
  });

  it("lets two consecutive half-terms share a slot", () => {
    const autumn = at({ id: "L1", roomId: "r1", endDate: "2026-10-30" });
    const winter = at({ id: "L2", roomId: "r1", startDate: "2026-11-02" });

    expect(validatePlacement(winter, [autumn], [])).toEqual([]);
  });

  it("reports a clash when the periods touch", () => {
    const first = at({ id: "L1", roomId: "r1", endDate: "2026-10-30" });
    const second = at({ id: "L2", roomId: "r1", startDate: "2026-10-30" });

    expect(conflictKinds(validatePlacement(second, [first], []))).toContain(
      "ROOM",
    );
  });

  it("agrees with the API rule on every combination", () => {
    // The two implementations must not drift: a lenient grid shows a schedule
    // the API rejects, a strict one refuses a placement the API allows.
    const kinds = ["ALL_WEEKS", "ODD_WEEKS", "EVEN_WEEKS"] as const;
    const expected: Record<string, boolean> = {
      "ALL_WEEKS|ALL_WEEKS": true,
      "ALL_WEEKS|ODD_WEEKS": true,
      "ALL_WEEKS|EVEN_WEEKS": true,
      "ODD_WEEKS|ALL_WEEKS": true,
      "ODD_WEEKS|ODD_WEEKS": true,
      "ODD_WEEKS|EVEN_WEEKS": false,
      "EVEN_WEEKS|ALL_WEEKS": true,
      "EVEN_WEEKS|ODD_WEEKS": false,
      "EVEN_WEEKS|EVEN_WEEKS": true,
    };

    for (const a of kinds) {
      for (const b of kinds) {
        expect(weeksCanOverlap(at({ recurrence: a }), at({ recurrence: b }))).toBe(
          expected[`${a}|${b}`],
        );
      }
    }
  });
});
