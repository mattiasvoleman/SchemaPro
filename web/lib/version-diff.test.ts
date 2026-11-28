import { describe, expect, it } from "vitest";
import { classOf, countsOf, diffLessons, KIND_ORDER, type DiffEntry, type DiffLesson } from "./version-diff";

/*
 * JÄMFÖRELSEN AV TVÅ SCHEMAN (E9): a lesson that moved is one line that says it moved, a lesson that stands where it stood and has another teacher or room is
 * one that changed, and the rest is added or removed. Snapshots have no lesson ids, so "the same lesson" is what it is: subject, class, teacher, weeks, who else.
 */
const lesson = (over: Partial<DiffLesson> = {}): DiffLesson => ({ subjectId: "ma", studentGroupId: "7a", teacherId: "anna", roomId: "r1", dayOfWeek: 1, startTime: "08:00", endTime: "09:00", ...over });
const kinds = (entries: DiffEntry[]) => entries.map((entry) => entry.kind);

describe("what two schedules do not share", () => {
  it("says nothing of lessons that stand the same on both sides, however the clock and the dates are spelled", () => {
    const grid = [lesson({ startTime: "08:00:00", endTime: "09:00:00", startDate: "2026-09-07" }), lesson({ dayOfWeek: 2 })];
    const version = [lesson({ dayOfWeek: 2 }), lesson({ startDate: "2026-09-07T00:00:00.000Z" })];
    expect(diffLessons(version, grid)).toEqual([]);
  });

  it("shows a lesson that moved as ONE entry that says it moved, and not as one removed and one added", () => {
    const entries = diffLessons([lesson()], [lesson({ dayOfWeek: 3, startTime: "10:00", endTime: "11:00" })]);
    expect(entries).toEqual([{ kind: "moved", from: lesson(), to: lesson({ dayOfWeek: 3, startTime: "10:00", endTime: "11:00" }), room: false }]);
  });

  it("says that the room is another when a lesson that moved changed room as well", () => {
    const [entry] = diffLessons([lesson()], [lesson({ dayOfWeek: 2, roomId: "r2" })]);
    expect(entry).toMatchObject({ kind: "moved", room: true });
  });

  it("reads a lesson put on the tray, and one put back from it, as moved", () => {
    expect(kinds(diffLessons([lesson()], [lesson({ isParked: true })]))).toEqual(["moved"]);
    expect(kinds(diffLessons([lesson({ isParked: true, dayOfWeek: 4 })], [lesson()]))).toEqual(["moved"]);
    // Two parked lessons that remember other hours hold the same timetable.
    expect(diffLessons([lesson({ isParked: true, dayOfWeek: 4 })], [lesson({ isParked: true, dayOfWeek: 5 })])).toEqual([]);
  });

  it("says a lesson that stands where it stood and has another room is changed, with what", () => {
    expect(diffLessons([lesson()], [lesson({ roomId: "r2" })])).toEqual([{ kind: "changed", from: lesson(), to: lesson({ roomId: "r2" }), aspects: ["room"] }]);
  });

  it.each([
    ["teacher", { teacherId: "bo" }],
    ["coTeacher", { coTeacherId: "eva" }],
    ["weeks", { recurrence: "ODD_WEEKS" as const }],
    ["weeks", { startDate: "2026-10-05" }],
    ["groups", { extraGroupIds: ["8a"] }],
    ["pupils", { studentIds: ["p1"] }],
  ])("says %s when it is what changed in a lesson that stands where it stood", (aspect, change) => {
    const [entry] = diffLessons([lesson()], [lesson(change)]);
    expect(entry).toMatchObject({ kind: "changed", aspects: [aspect] });
  });

  it("says each thing that changed, in a fixed order", () => {
    const [entry] = diffLessons([lesson()], [lesson({ teacherId: "bo", roomId: "r9", studentIds: ["p1"] })]);
    expect(entry).toMatchObject({ kind: "changed", aspects: ["teacher", "room", "pupils"] });
  });

  it("calls a lesson only on one side added or removed", () => {
    const added = diffLessons([], [lesson()]);
    const removed = diffLessons([lesson()], []);
    expect(added).toEqual([{ kind: "added", to: lesson() }]);
    expect(removed).toEqual([{ kind: "removed", from: lesson() }]);
    // Another subject or class is another lesson, however it stands.
    expect(kinds(diffLessons([lesson()], [lesson({ subjectId: "sv", dayOfWeek: 2 })]))).toEqual(["removed", "added"]);
    expect(kinds(diffLessons([lesson()], [lesson({ studentGroupId: "7b", dayOfWeek: 2 })]))).toEqual(["removed", "added"]);
  });

  it("counts lessons that are alike: three of them against two is one removed", () => {
    const three = [lesson(), lesson(), lesson()];
    expect(kinds(diffLessons(three, [lesson(), lesson()]))).toEqual(["removed"]);
    expect(kinds(diffLessons([lesson(), lesson()], three))).toEqual(["added"]);
  });

  it("pairs lessons that are alike in order, so that two lessons that both moved are two entries and none is left over", () => {
    const from = [lesson({ dayOfWeek: 1 }), lesson({ dayOfWeek: 2 })];
    const to = [lesson({ dayOfWeek: 3 }), lesson({ dayOfWeek: 4 })];
    const entries = diffLessons(from, to);
    expect(kinds(entries)).toEqual(["moved", "moved"]);
    expect(entries.map((entry) => (entry.kind === "moved" ? [entry.from.dayOfWeek, entry.to.dayOfWeek] : null))).toEqual([[1, 3], [2, 4]]);
  });

  it("gives the same entries whatever order the lessons come in", () => {
    const from = [lesson({ dayOfWeek: 2 }), lesson({ dayOfWeek: 1 }), lesson({ subjectId: "sv" })];
    const to = [lesson({ dayOfWeek: 4 }), lesson({ dayOfWeek: 3 }), lesson({ subjectId: "sv", roomId: "r2" })];
    expect(diffLessons([...from].reverse(), [...to].reverse())).toEqual(diffLessons(from, to));
  });

  it("uses a lesson once: a lesson cannot both move and be changed", () => {
    // Anna's Monday lesson moves to Tuesday; Bo's lesson takes its old place, with the same subject and class.
    const entries = diffLessons([lesson({ dayOfWeek: 1 })], [lesson({ dayOfWeek: 2 }), lesson({ dayOfWeek: 1, teacherId: "bo" })]);
    expect(kinds(entries).sort()).toEqual(["added", "moved"]);
  });

  it("counts the entries of each kind, and says the class an entry is about on whichever side it stands", () => {
    const entries = diffLessons([lesson(), lesson({ studentGroupId: "8b", subjectId: "sv" })], [lesson({ dayOfWeek: 2 }), lesson({ studentGroupId: "9c", subjectId: "no" })]);
    expect(countsOf(entries)).toEqual({ moved: 1, changed: 0, added: 1, removed: 1 });
    expect(entries.map(classOf).sort()).toEqual(["7a", "8b", "9c"]);
    expect(KIND_ORDER).toEqual(["moved", "changed", "added", "removed"]);
  });
});
