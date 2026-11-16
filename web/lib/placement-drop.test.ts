import { describe, expect, it } from "vitest";
import type { BoardKept, BoardPlacement, BoardPost, PlacementBoard } from "./placement-board";
import { dropOf, insideSchoolDay, minutesOfField, moverOfRow, nextFreeSpot, suggestedRoom, type Mover, type OtherNames } from "./placement-drop";
import { buildMirror } from "./placement-mirror";
import { keyByRowId } from "./placement-rows";
import type { RoomPreference } from "./queries";
import type { StudentGroup } from "./types";

const names: OtherNames = {
  group: (id) => ({ "g-7a": "7A", "g-7b": "7B" })[id],
  subject: (id) => ({ "s-ma": "Matematik", "s-sv": "Svenska" })[id],
};

const post = (over: Partial<BoardPost> = {}): BoardPost => ({
  id: "post-1",
  studentGroupId: "g-7a",
  subjectId: "s-ma",
  teacherId: "anna",
  coTeacherId: null,
  recurrence: "ALL_WEEKS",
  startDate: null,
  endDate: null,
  cannotPlace: null,
  parts: [],
  rowsKey: "e3b0c44298fc1c14",
  ...over,
});

const kept = (over: Partial<BoardKept> = {}): BoardKept => ({
  id: "k-1",
  dayOfWeek: 2,
  startTime: "10:00",
  endTime: "11:00",
  studentGroupId: "g-7b",
  extraGroupIds: [],
  subjectId: "s-sv",
  teacherId: "anna",
  coTeacherId: null,
  roomId: "r-b3",
  recurrence: "ALL_WEEKS",
  startDate: null,
  endDate: null,
  locked: true,
  generated: false,
  ...over,
});

const group = (id: string): StudentGroup => ({ id, academicYearId: "y1", name: id, kind: "CLASS", gradeLevel: 7 });

const mirrorOf = (keptLessons: BoardKept[], rows: BoardPlacement[] = []) => {
  const board: PlacementBoard = { academicYearId: "y1", placements: rows, posts: [post()], kept: keptLessons, meals: [] };
  return buildMirror({ board, keys: keyByRowId(rows), groups: [group("g-7a"), group("g-7b")], studentGroupOf: new Map(), memberships: [], constraints: [], frames: undefined, academicYearId: "y1" });
};

const mover = (over: Partial<Mover> = {}): Mover => ({ id: "brick:1", post: post(), teacherId: "anna", roomId: null, recurrence: "ALL_WEEKS", ...over });

describe("the school day", () => {
  it("is Monday to Friday, 08:00 to 18:00, on the five-minute grid", () => {
    expect(insideSchoolDay({ dayOfWeek: 1, startMinutes: 480, endMinutes: 540 })).toBe(true);
    expect(insideSchoolDay({ dayOfWeek: 5, startMinutes: 1020, endMinutes: 1080 })).toBe(true);
    expect(insideSchoolDay({ dayOfWeek: 6, startMinutes: 600, endMinutes: 660 })).toBe(false);
    expect(insideSchoolDay({ dayOfWeek: 0, startMinutes: 600, endMinutes: 660 })).toBe(false);
    expect(insideSchoolDay({ dayOfWeek: 2, startMinutes: 475, endMinutes: 535 })).toBe(false);
    expect(insideSchoolDay({ dayOfWeek: 2, startMinutes: 1025, endMinutes: 1085 })).toBe(false);
    expect(insideSchoolDay({ dayOfWeek: 2, startMinutes: 602, endMinutes: 662 })).toBe(false);
  });

  it("reads 17:00 as inside, which the grundschema's own search (17:00 as its day's end) does not", () => {
    expect(insideSchoolDay({ dayOfWeek: 3, startMinutes: 17 * 60 + 15, endMinutes: 18 * 60 })).toBe(true);
  });
});

describe("dropOf", () => {
  const spot = (startMinutes: number, minutes = 60, dayOfWeek = 2) => ({ dayOfWeek, startMinutes, endMinutes: startMinutes + minutes });

  it("is OK where nothing is in the way", () => {
    expect(dropOf(mirrorOf([]), mover(), spot(600), names)).toEqual({ kind: "OK" });
  });

  it("says the school day before the clash rule", () => {
    expect(dropOf(mirrorOf([kept()]), mover(), spot(17 * 60 + 30), names)).toEqual({ kind: "DAY" });
    expect(dropOf(mirrorOf([]), mover(), spot(600, 60, 6), names)).toEqual({ kind: "DAY" });
  });

  it("says what is in the way as the gateway's reason with the other lesson's class, subject, day and time, never a person", () => {
    const drop = dropOf(mirrorOf([kept()]), mover(), spot(600), names);
    expect(drop).toEqual({
      kind: "CLASH",
      reason: "TEACHER",
      params: { otherKind: "LESSON", className: "7B", subjectName: "Svenska", day: 2, start: "10:00", end: "11:00" },
    });
    expect(JSON.stringify(drop)).not.toContain("anna");
  });

  it("says a förläggning in the way is one, and carries no figures when the other lesson is not named", () => {
    const rows: BoardPlacement[] = [
      { id: "r1", requirementId: "post-2", dayOfWeek: 2, startTime: "10:00", endTime: "11:00", minutes: 60, roomId: null, roomName: null, recurrence: "ALL_WEEKS", teacherId: null, changedAt: "x", verdict: { ok: true } },
    ];
    const board: PlacementBoard = { academicYearId: "y1", placements: rows, posts: [post(), post({ id: "post-2", studentGroupId: "g-7b", subjectId: "s-sv" })], kept: [], meals: [] };
    const ctx = buildMirror({ board, keys: keyByRowId(rows), groups: [group("g-7a"), group("g-7b")], studentGroupOf: new Map(), memberships: [], constraints: [], frames: undefined });
    expect(dropOf(ctx, mover(), spot(600), names)).toMatchObject({ kind: "CLASH", reason: "TEACHER", params: { otherKind: "PLACEMENT", className: "7B", subjectName: "Svenska" } });
    expect(dropOf(ctx, mover(), spot(600), { group: () => undefined, subject: () => undefined })).toEqual({ kind: "CLASH", reason: "TEACHER" });
  });

  it("answers for the room the lesson would have", () => {
    const ctx = mirrorOf([kept({ teacherId: "x", roomId: "r-a12" })]);
    expect(dropOf(ctx, mover({ roomId: "r-a12" }), spot(600), names)).toMatchObject({ kind: "CLASH", reason: "ROOM" });
    expect(dropOf(ctx, mover({ roomId: null }), spot(600), names)).toEqual({ kind: "OK" });
  });
});

describe("the mover of a row", () => {
  it("is the row's room and weeks and its lesson's teacher, the post's when the row has none", () => {
    const row = { roomId: "r-a12", teacherId: null, recurrence: "ODD_WEEKS" as const };
    expect(moverOfRow("placement:k", row, post())).toMatchObject({ id: "placement:k", teacherId: "anna", roomId: "r-a12", recurrence: "ODD_WEEKS" });
    expect(moverOfRow("placement:k", { ...row, teacherId: "bo" }, post()).teacherId).toBe("bo");
  });
});

describe("the next free time", () => {
  it("steps forward by a quarter of an hour to the first time nothing is in the way, and not the one it started from", () => {
    const ctx = mirrorOf([kept({ startTime: "10:00", endTime: "11:00" })]);
    expect(nextFreeSpot(ctx, mover(), 60, { dayOfWeek: 2, startMinutes: 540 }, names)).toEqual({ dayOfWeek: 2, startMinutes: 660 });
    // From a free time: the next one, not that one.
    expect(nextFreeSpot(mirrorOf([]), mover(), 60, { dayOfWeek: 2, startMinutes: 600 }, names)).toEqual({ dayOfWeek: 2, startMinutes: 615 });
  });

  it("goes on to the next weekday and round the week", () => {
    const ctx = mirrorOf([kept({ dayOfWeek: 5, startTime: "08:00", endTime: "18:00", teacherId: "anna" })]);
    // From Friday's last start the next free time is Monday's first.
    expect(nextFreeSpot(ctx, mover(), 60, { dayOfWeek: 4, startMinutes: 17 * 60 }, names)).toEqual({ dayOfWeek: 1, startMinutes: 480 });
  });

  it("reaches the end of the day, 18:00, which the grundschema's search stops short of", () => {
    const ctx = mirrorOf([kept({ dayOfWeek: 2, startTime: "08:00", endTime: "17:00" })]);
    expect(nextFreeSpot(ctx, mover(), 60, { dayOfWeek: 2, startMinutes: 480 }, names)).toEqual({ dayOfWeek: 2, startMinutes: 17 * 60 });
  });

  it("is null when the whole week is taken, and for a lesson longer than the day", () => {
    const week = [1, 2, 3, 4, 5].map((day) => kept({ id: `k-${day}`, dayOfWeek: day, startTime: "08:00", endTime: "18:00" }));
    expect(nextFreeSpot(mirrorOf(week), mover(), 60, { dayOfWeek: 1, startMinutes: 480 }, names)).toBeNull();
    expect(nextFreeSpot(mirrorOf([]), mover(), 11 * 60, { dayOfWeek: 1, startMinutes: 480 }, names)).toBeNull();
  });
});

describe("a time in a field", () => {
  it("is minutes, or null when it is no time", () => {
    expect(minutesOfField("10:05")).toBe(605);
    expect(minutesOfField("9:30")).toBe(570);
    expect(minutesOfField("")).toBeNull();
    expect(minutesOfField("tisdag")).toBeNull();
  });
});

describe("the room to offer", () => {
  const rule = (over: Partial<RoomPreference> = {}): RoomPreference => ({ id: "rp", subjectId: "s-ma", kind: "WISH", minGradeLevel: null, maxGradeLevel: null, roomTypeId: null, weight: 1, rooms: [{ roomId: "r-lab" }], ...over });
  const base = { postRows: [], rules: [], subjectId: "s-ma", gradeLevel: 7, filterRooms: [] as string[] };

  it("is the room the post's other förläggningar stand in, the most common of them", () => {
    expect(suggestedRoom({ ...base, postRows: [{ roomId: "r-a" }, { roomId: "r-b" }, { roomId: "r-b" }, { roomId: null }], rules: [rule()], filterRooms: ["r-f"] })).toBe("r-b");
  });

  it("is a room the subject's rule names when the post has none placed, for the class's year", () => {
    expect(suggestedRoom({ ...base, rules: [rule()] })).toBe("r-lab");
    expect(suggestedRoom({ ...base, rules: [rule({ minGradeLevel: 4, maxGradeLevel: 6 })] })).toBeNull();
    expect(suggestedRoom({ ...base, rules: [rule({ subjectId: "s-sv" })] })).toBeNull();
    expect(suggestedRoom({ ...base, rules: [rule({ rooms: [] })] })).toBeNull();
    expect(suggestedRoom({ ...base, gradeLevel: null, rules: [rule({ minGradeLevel: 7 })] })).toBeNull();
  });

  it("is the room the filter picked when it picked exactly one, and none otherwise (the engine chooses)", () => {
    expect(suggestedRoom({ ...base, filterRooms: ["r-f"] })).toBe("r-f");
    expect(suggestedRoom({ ...base, filterRooms: ["r-f", "r-g"] })).toBeNull();
    expect(suggestedRoom(base)).toBeNull();
  });
});
