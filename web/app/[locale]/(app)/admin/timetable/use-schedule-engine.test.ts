import { renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { MasterLesson } from "@/lib/types";
import { useScheduleEngine } from "./use-schedule-engine";

/**
 * The clash engine the page builds from what it read. page.test.tsx draws the clashes and refuses drags through
 * the whole page; these hold the two things the page cannot show it got right once the engine lives in a hook of
 * its own: which presence marks it keeps (the page's own open lesson is not a lock against itself), and that a
 * drag is judged against the lessons it is given on each render, not the first.
 */
const year = { id: "y-1", startDate: "2026-08-17", endDate: "2027-06-11", gradeNumbering: "NIOARIG" };
const group = (id: string) => ({ id, name: id, kind: "CLASS", gradeLevel: 4, academicYearId: "y-1" });
const lessonAt = (id: string, groupId: string, startTime: string, endTime: string): MasterLesson =>
  ({
    id,
    academicYearId: "y-1",
    subjectId: "s-1",
    studentGroupId: groupId,
    teacherId: "t-1",
    coTeacherId: null,
    roomId: null,
    dayOfWeek: 1,
    startTime,
    endTime,
    isLocked: false,
    isParked: false,
    recurrence: "ALL_WEEKS",
    startDate: null,
    endDate: null,
    extraGroupIds: [],
    studentIds: [],
  }) as MasterLesson;

type Inputs = Parameters<typeof useScheduleEngine>[0];
const inputs = (over: Partial<Inputs> = {}): Inputs => ({
  groups: [group("g-1"), group("g-2")] as never,
  shownYear: year as never,
  schoolBreaks: [] as never,
  people: [{ id: "t-1", role: "TEACHER", isActive: true }] as never,
  memberships: [] as never,
  lunchSettings: undefined,
  rooms: [] as never,
  subjects: [] as never,
  lessons: [] as never,
  lunchSittings: undefined,
  requirements: undefined,
  roomRules: undefined,
  constraints: [] as never,
  frameTimes: undefined,
  peers: [],
  editing: null,
  ...over,
});

describe("who is editing what", () => {
  const peers = [
    { userId: "u-1", label: "Karin", editingLessonId: "l-1" },
    { userId: "u-2", label: "Olof", editingLessonId: "l-2" },
    { userId: "u-3", label: "Siv", editingLessonId: null },
  ] as never;

  it("names each lesson a collaborator has open, and no lesson nobody has", () => {
    const { result } = renderHook(() => useScheduleEngine(inputs({ peers })));
    expect([...result.current.remoteEditors]).toEqual([
      ["l-1", "Karin"],
      ["l-2", "Olof"],
    ]);
  });

  it("leaves out the lesson this page has open itself, and takes it back when it is closed", () => {
    const open = lessonAt("l-1", "g-1", "08:00:00", "09:00:00");
    const { result, rerender } = renderHook((props: Inputs) => useScheduleEngine(props), {
      initialProps: inputs({ peers, editing: open }),
    });
    expect([...result.current.remoteEditors.keys()]).toEqual(["l-2"]);

    rerender(inputs({ peers, editing: null }));
    expect([...result.current.remoteEditors.keys()]).toEqual(["l-1", "l-2"]);
  });
});

describe("judging a drag", () => {
  const a = lessonAt("a", "g-1", "08:00:00", "09:00:00");
  const b = lessonAt("b", "g-2", "10:00:00", "11:00:00");
  const ontoA = { dayOfWeek: 1, startMinutes: 8 * 60 + 15, endMinutes: 9 * 60 + 15 };
  const toTuesday = { dayOfWeek: 2, startMinutes: 10 * 60, endMinutes: 11 * 60 };

  it("refuses a slot where the same teacher already stands and lets one where nobody does", () => {
    const { result } = renderHook(() => useScheduleEngine(inputs({ lessons: [a, b] as never })));
    expect(result.current.validateChange("b", ontoA)).toBe(false);
    expect(result.current.validateChange("b", toTuesday)).toBe(true);
    // A lesson the page does not know cannot be moved.
    expect(result.current.validateChange("gone", toTuesday)).toBe(false);
  });

  it("asks the lessons it is given on each render: a lesson that has left no longer blocks its slot", () => {
    const { result, rerender } = renderHook((props: Inputs) => useScheduleEngine(props), {
      initialProps: inputs({ lessons: [a, b] as never }),
    });
    expect(result.current.validateChange("b", ontoA)).toBe(false);

    rerender(inputs({ lessons: [b] as never }));
    expect(result.current.validateChange("b", ontoA)).toBe(true);
  });

  it("holds a dragged lesson to its own weeks and window of dates, as the gateway's judge does (the fall file's richer worlds)", () => {
    // The same teacher, the same clock, and two lessons that are never taught in the same week: one in the autumn and one in the spring, one on
    // odd weeks and one on even. Dragged onto the other's hour, the dragged lesson is no clash: the candidate must carry its weeks and its
    // window, or it was taken for a lesson of every week of the year and refused a place the judge lets it have.
    const autumn = { ...lessonAt("autumn", "g-1", "08:00:00", "09:00:00"), startDate: "2026-08-17", endDate: "2026-12-20" } as MasterLesson;
    const spring = { ...lessonAt("spring", "g-2", "10:00:00", "11:00:00"), startDate: "2027-01-11", endDate: "2027-06-06" } as MasterLesson;
    const lets = renderHook(() => useScheduleEngine(inputs({ lessons: [autumn, spring] as never })));
    expect(lets.result.current.validateChange("spring", { dayOfWeek: 1, startMinutes: 8 * 60, endMinutes: 9 * 60 })).toBe(true);
    // Both in the autumn: the same hour is a clash, whatever the window.
    const alsoAutumn = { ...spring, startDate: "2026-10-26", endDate: "2026-12-20" } as MasterLesson;
    const refuses = renderHook(() => useScheduleEngine(inputs({ lessons: [autumn, alsoAutumn] as never })));
    expect(refuses.result.current.validateChange("spring", { dayOfWeek: 1, startMinutes: 8 * 60, endMinutes: 9 * 60 })).toBe(false);

    const odd = { ...lessonAt("odd", "g-1", "08:00:00", "09:00:00"), recurrence: "ODD_WEEKS" } as MasterLesson;
    const even = { ...lessonAt("even", "g-2", "10:00:00", "11:00:00"), recurrence: "EVEN_WEEKS" } as MasterLesson;
    const weeks = renderHook(() => useScheduleEngine(inputs({ lessons: [odd, even] as never })));
    expect(weeks.result.current.validateChange("even", { dayOfWeek: 1, startMinutes: 8 * 60, endMinutes: 9 * 60 })).toBe(true);
    expect(weeks.result.current.validateChange("odd", { dayOfWeek: 1, startMinutes: 10 * 60, endMinutes: 11 * 60 })).toBe(true);
  });

  it("marks the clash a hand-placed overlap makes, and none before", () => {
    const overlapping = lessonAt("b", "g-2", "08:30:00", "09:30:00");
    const apart = renderHook(() => useScheduleEngine(inputs({ lessons: [a, b] as never })));
    expect(apart.result.current.conflictMap.size).toBe(0);

    const together = renderHook(() => useScheduleEngine(inputs({ lessons: [a, overlapping] as never })));
    expect([...together.result.current.conflictMap.keys()].sort()).toEqual(["a", "b"]);
  });
});

describe("a lesson that stands outside the ramtid on purpose (Undantag med flit)", () => {
  // The day of grade 4 runs 08:00-15:00; this lesson ends at 15:30.
  const frame = [{ id: "f-1", minGradeLevel: 4, maxGradeLevel: 4, dayOfWeek: null, startTime: "08:00:00", endTime: "15:00:00" }];
  const late = lessonAt("late", "g-1", "14:30:00", "15:30:00");
  const given = { ...late, isLocked: true, exemptFrom: ["FRAME"] } as MasterLesson;

  it("is a conflict until an administrator has said it stands there on purpose, and then it is an exemption and no conflict", () => {
    const before = renderHook(() => useScheduleEngine(inputs({ lessons: [late] as never, frameTimes: frame as never })));
    expect([...before.result.current.conflictMap.keys()]).toEqual(["late"]);
    expect(before.result.current.exemptionMap.size).toBe(0);

    const after = renderHook(() => useScheduleEngine(inputs({ lessons: [given] as never, frameTimes: frame as never })));
    expect(after.result.current.conflictMap.size).toBe(0);
    expect(after.result.current.exemptionMap.get("late")).toEqual(["FRAME"]);
  });

  it("is a conflict again when it is moved to a time that breaks another rule: an exemption lifts one rule and no other", () => {
    const clash = { ...given, id: "late2", studentGroupId: "g-2" } as MasterLesson;
    const result = renderHook(() => useScheduleEngine(inputs({ lessons: [given, clash] as never, frameTimes: frame as never }))).result;
    // Same teacher, same hour: the clash is a clash for both, the frame is the exemption's.
    expect([...result.current.conflictMap.keys()].sort()).toEqual(["late", "late2"]);
    expect(result.current.conflictMap.get("late")!.map((hit) => hit.kind)).not.toContain("FRAME");
    expect(result.current.exemptionMap.get("late")).toEqual(["FRAME"]);
  });

  it("leaves a lesson with no exemption exactly as the grid found it", () => {
    const result = renderHook(() => useScheduleEngine(inputs({ lessons: [late] as never, frameTimes: frame as never }))).result;
    expect(result.current.conflictMap.get("late")!.map((hit) => hit.kind)).toEqual(["FRAME"]);
  });
});

describe("the weeks of a lov", () => {
  // A lesson written for the two Monday-to-Friday weeks inside the jullov (22 December to 9 January), weeks in which nobody sits: a drag
  // beside it meets it in no week with school. The candidate of a drag carries no window of its own, so it is the
  // other lesson's that makes the difference. page.test.tsx draws the clash between two such lessons from it.
  const jullov = {
    id: "b-jul",
    academicYearId: "y-1",
    name: "Jullov",
    kind: "HOLIDAY",
    startDate: "2026-12-22",
    endDate: "2027-01-09",
    minGradeLevel: null,
    maxGradeLevel: null,
  };
  const inLov = { ...lessonAt("a", "g-1", "08:00:00", "09:00:00"), startDate: "2026-12-28", endDate: "2027-01-08" };
  const moved = lessonAt("b", "g-2", "10:00:00", "11:00:00");
  const ontoIt = { dayOfWeek: 1, startMinutes: 8 * 60, endMinutes: 9 * 60 };

  it("lets a drag stand beside a lesson it meets only in a lov, and takes that back when the lov goes", () => {
    // Everything but the breaks keeps its identity from render to render, so only they can change the answer.
    const same = inputs({ lessons: [inLov, moved] as never });
    const { result, rerender } = renderHook((props: Inputs) => useScheduleEngine(props), {
      initialProps: { ...same, schoolBreaks: [] as never },
    });
    expect(result.current.validateChange("b", ontoIt)).toBe(false);

    rerender({ ...same, schoolBreaks: [jullov] as never });
    expect(result.current.closedWeeks).toBeDefined();
    expect(result.current.validateChange("b", ontoIt)).toBe(true);

    rerender({ ...same, schoolBreaks: [] as never });
    expect(result.current.validateChange("b", ontoIt)).toBe(false);
  });
});
