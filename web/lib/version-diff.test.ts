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
    ["locked", { isLocked: true }],
    ["exempt", { exemptFrom: ["FRAME"] }],
  ])("says %s when it is what changed in a lesson that stands where it stood", (aspect, change) => {
    const [entry] = diffLessons([lesson()], [lesson(change)]);
    expect(entry).toMatchObject({ kind: "changed", aspects: [aspect] });
  });

  it("does not call two lessons the same when a restore would lock or unlock one of them, and calls two locked ones the same", () => {
    expect(diffLessons([lesson({ isLocked: true })], [lesson({ isLocked: false })])).toHaveLength(1);
    expect(diffLessons([lesson({ isLocked: true, exemptFrom: ["FRAME", "LUNCH"] })], [lesson({ isLocked: true, exemptFrom: ["LUNCH", "FRAME"] })])).toEqual([]);
    // A snapshot from before the lock was written has no key: not locked.
    expect(diffLessons([lesson()], [lesson({ isLocked: false })])).toEqual([]);
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

  it("does not call a lesson that moved AND has another teacher one that changed where it stands: it is one removed and one added, so that the move is not hidden", () => {
    // Same class and subject, but another day and another teacher: nothing says it is the same lesson, and "teacher: Anna to Bo" under Tuesday would say nothing of Monday.
    const entries = diffLessons([lesson({ dayOfWeek: 1 })], [lesson({ dayOfWeek: 2, teacherId: "bo" })]);
    expect(kinds(entries)).toEqual(["removed", "added"]);
  });

  it("counts the entries of each kind, and says the class an entry is about on whichever side it stands", () => {
    const entries = diffLessons([lesson(), lesson({ studentGroupId: "8b", subjectId: "sv" })], [lesson({ dayOfWeek: 2 }), lesson({ studentGroupId: "9c", subjectId: "no" })]);
    expect(countsOf(entries)).toEqual({ moved: 1, changed: 0, added: 1, removed: 1 });
    expect(entries.map(classOf).sort()).toEqual(["7a", "8b", "9c"]);
    expect(KIND_ORDER).toEqual(["moved", "changed", "added", "removed"]);
  });
});

describe("pairing as many lessons as can be paired", () => {
  it("does not take a lesson's partner from another that has no other: the Monday lesson that got a new teacher stays Monday, and the Tuesday one moved", () => {
    // Monday and Tuesday of one lesson; then Monday with Bo, and Wednesday with Anna. Pairing the Monday lesson with the Wednesday one first said "Monday to
    // Wednesday", left "Tuesday removed" and "Monday with Bo added": a move that did not happen, and a line too many.
    const entries = diffLessons([lesson({ dayOfWeek: 1 }), lesson({ dayOfWeek: 2 })], [lesson({ dayOfWeek: 1, teacherId: "bo" }), lesson({ dayOfWeek: 3 })]);
    expect(entries).toEqual([
      { kind: "moved", from: lesson({ dayOfWeek: 2 }), to: lesson({ dayOfWeek: 3 }), room: false },
      { kind: "changed", from: lesson({ dayOfWeek: 1 }), to: lesson({ dayOfWeek: 1, teacherId: "bo" }), aspects: ["teacher"] },
    ]);
  });

  it("prefers the same lesson in the same place (another room) to the same lesson at another place", () => {
    // Tuesday in R1 is on both sides in some form: with another room on Tuesday, and again on Monday. The lesson that stays is the one that changed room.
    const entries = diffLessons([lesson({ dayOfWeek: 2 })], [lesson({ dayOfWeek: 1 }), lesson({ dayOfWeek: 2, roomId: "r2" })]);
    expect(entries.map((entry) => entry.kind)).toEqual(["changed", "added"]);
    expect(entries[0]).toMatchObject({ aspects: ["room"] });
  });

  it("gives as few entries as any pairing of the lessons could: checked against every pairing on small random schedules", () => {
    let state = 20261128;
    const random = (n: number) => ((state = (state * 1103515245 + 12345) & 0x7fffffff) % n);
    const some = (): DiffLesson =>
      lesson({ subjectId: ["ma", "sv"][random(2)]!, teacherId: ["anna", "bo", null][random(3)] ?? null, roomId: ["r1", "r2"][random(2)]!, dayOfWeek: 1 + random(3), startTime: ["08:00", "09:00"][random(2)]! });
    const what = (l: DiffLesson) => `${l.subjectId}|${l.teacherId}`;
    const place = (l: DiffLesson) => `${l.dayOfWeek}|${l.startTime}`;
    const whole = (l: DiffLesson) => `${what(l)}|${l.roomId}|${place(l)}`;
    const rest = (side: DiffLesson[], other: DiffLesson[]) => {
      const left = new Map<string, number>();
      for (const l of other) left.set(whole(l), (left.get(whole(l)) ?? 0) + 1);
      return side.filter((l) => {
        const n = left.get(whole(l)) ?? 0;
        if (n > 0) left.set(whole(l), n - 1);
        return n === 0;
      });
    };
    // The most pairs any choice of partners gives, where two lessons may be partners when they are the same lesson, or of one subject in one place.
    const mostPairs = (from: DiffLesson[], to: DiffLesson[], at = 0, used = new Set<number>()): number => {
      if (at === from.length) return 0;
      let best = mostPairs(from, to, at + 1, used);
      to.forEach((other, index) => {
        if (used.has(index) || !(what(from[at]!) === what(other) || (from[at]!.subjectId === other.subjectId && place(from[at]!) === place(other)))) return;
        used.add(index);
        best = Math.max(best, 1 + mostPairs(from, to, at + 1, used));
        used.delete(index);
      });
      return best;
    };
    for (let round = 0; round < 400; round++) {
      const a = Array.from({ length: 1 + random(5) }, some);
      const b = Array.from({ length: 1 + random(5) }, some);
      const onlyA = rest(a, b);
      const onlyB = rest(b, a);
      expect(diffLessons(a, b).length, JSON.stringify({ a, b })).toBe(onlyA.length + onlyB.length - mostPairs(onlyA, onlyB));
    }
  });
});
