import { describe, expect, it } from "vitest";
import type { BoardKept, BoardPlacement, BoardPost, PlacementBoard } from "./placement-board";
import { dropOf, insideSchoolDay, minutesOfField, moverOfRow, nextFreeSpot, suggestedRoom, type Mover, type OtherNames } from "./placement-drop";
import { buildMirror, bufferMapOfBoard } from "./placement-mirror";
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
  const board: PlacementBoard = { academicYearId: "y1", placements: rows, posts: [post()], kept: keptLessons, meals: [], blocks: [] };
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
    const board: PlacementBoard = { academicYearId: "y1", placements: rows, posts: [post(), post({ id: "post-2", studentGroupId: "g-7b", subjectId: "s-sv" })], kept: [], meals: [], blocks: [] };
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

describe("the pupils' minutes around an idrott (review of #326, MEDEL-3)", () => {
  /** Idrott for 7A with ten minutes of ombyte before and fifteen of dusch and ombyte after; the post of its own, and the class's matematik. */
  const idrott = (over: Partial<BoardPost> = {}) => post({ id: "post-id", subjectId: "s-id", teacherId: "cy", minutesBefore: 10, minutesAfter: 15, ...over });
  const mirrorWith = (posts: BoardPost[], keptLessons: BoardKept[] = [], rows: BoardPlacement[] = []) => {
    const board: PlacementBoard = { academicYearId: "y1", placements: rows, posts, kept: keptLessons, meals: [], blocks: [] };
    return buildMirror({ board, keys: keyByRowId(rows), groups: [group("g-7a"), group("g-7b")], studentGroupOf: new Map(), memberships: [], constraints: [], frames: undefined, academicYearId: "y1" });
  };
  const spot = (startMinutes: number, minutes = 60, dayOfWeek = 2) => ({ dayOfWeek, startMinutes, endMinutes: startMinutes + minutes });
  const at = (clock: string) => Number(clock.slice(0, 2)) * 60 + Number(clock.slice(3, 5));
  /** Another lesson of 7A, with another teacher: only the class's pupils can be in the way. */
  const lessonOf7A = (from: string, to: string, over: Partial<BoardKept> = {}) => kept({ studentGroupId: "g-7a", subjectId: "s-ma", teacherId: "x", roomId: null, startTime: from, endTime: to, ...over });
  const row = (over: Partial<BoardPlacement> = {}): BoardPlacement => ({
    id: "r1", requirementId: "post-id", dayOfWeek: 2, startTime: "10:00", endTime: "11:00", minutes: 60, roomId: null, roomName: null, recurrence: "ALL_WEEKS", teacherId: null, changedAt: "x", verdict: { ok: true }, ...over,
  });
  const mathBrick = () => mover({ id: "brick:ma", post: post({ id: "post-ma" }), teacherId: "anna" });

  it("holds the class's other lessons out of the minutes after the lesson being placed, and no longer than that", () => {
    const ctx = mirrorWith([idrott()], [lessonOf7A("11:05", "12:00")]);
    const brick = mover({ id: "brick:id", post: idrott(), teacherId: "cy" });
    expect(dropOf(ctx, brick, spot(at("10:00")), names)).toMatchObject({ kind: "CLASH", reason: "GROUP" });
    // The pupils are free at 11:15, which is where the other lesson starts when it starts at 11:15.
    expect(dropOf(mirrorWith([idrott()], [lessonOf7A("11:15", "12:00")]), brick, spot(at("10:00")), names)).toEqual({ kind: "OK" });
  });

  it("holds them out of the minutes before it, where the other lesson ends", () => {
    const brick = mover({ id: "brick:id", post: idrott(), teacherId: "cy" });
    expect(dropOf(mirrorWith([idrott()], [lessonOf7A("08:55", "09:55")]), brick, spot(at("10:00")), names)).toMatchObject({ kind: "CLASH", reason: "GROUP" });
    expect(dropOf(mirrorWith([idrott()], [lessonOf7A("08:50", "09:50")]), brick, spot(at("10:00")), names)).toEqual({ kind: "OK" });
  });

  it("holds a lesson placed beside an idrott the gateway keeps out of the idrott's minutes after it", () => {
    const ctx = mirrorWith([idrott(), post({ id: "post-ma" })], [kept({ studentGroupId: "g-7a", subjectId: "s-id", teacherId: "cy", roomId: null })]);
    expect(dropOf(ctx, mathBrick(), spot(at("11:05")), names)).toMatchObject({ kind: "CLASH", reason: "GROUP" });
    expect(dropOf(ctx, mathBrick(), spot(at("11:15")), names)).toEqual({ kind: "OK" });
    // Ten minutes of ombyte before: the lesson that ends at 09:55 is in them.
    expect(dropOf(ctx, mathBrick(), spot(at("08:55")), names)).toMatchObject({ kind: "CLASH", reason: "GROUP" });
    expect(dropOf(ctx, mathBrick(), spot(at("08:50")), names)).toEqual({ kind: "OK" });
  });

  it("holds it out of a förläggning of another post just the same: the buffer is the post's, whoever has placed it", () => {
    const ctx = mirrorWith([idrott(), post({ id: "post-ma" })], [], [row()]);
    expect(dropOf(ctx, mathBrick(), spot(at("11:05")), names)).toMatchObject({ kind: "CLASH", reason: "GROUP" });
    expect(dropOf(ctx, mathBrick(), spot(at("11:15")), names)).toEqual({ kind: "OK" });
  });

  it("takes the widest buffer of the classes on a lesson opened to a second class, as the gateway does", () => {
    // 7B's idrott is kept, opened to 7A; the buffer of 7B's post reaches 7A's lessons through the lesson.
    const post7b = idrott({ id: "post-id-7b", studentGroupId: "g-7b" });
    const ctx = mirrorWith([post7b, post({ id: "post-ma" })], [kept({ studentGroupId: "g-7b", extraGroupIds: ["g-7a"], subjectId: "s-id", teacherId: "cy", roomId: null })]);
    expect(dropOf(ctx, mathBrick(), spot(at("11:05")), names)).toMatchObject({ kind: "CLASH", reason: "GROUP" });
  });

  it("is what it was where no post names a minute: a lesson straight after the idrott holds", () => {
    const ctx = mirrorWith([idrott({ minutesBefore: 0, minutesAfter: 0 }), post({ id: "post-ma" })], [kept({ studentGroupId: "g-7a", subjectId: "s-id", teacherId: "cy", roomId: null })]);
    expect(dropOf(ctx, mathBrick(), spot(at("11:05")), names)).toEqual({ kind: "OK" });
    expect(ctx.buffers.size).toBe(0);
  });

  it("is not asked of a lesson of another class or another subject: the buffer is the (class, subject)'s", () => {
    const ctx = mirrorWith([idrott(), post({ id: "post-sv", studentGroupId: "g-7b", subjectId: "s-sv" })], [kept({ studentGroupId: "g-7a", subjectId: "s-id", teacherId: "cy", roomId: null })]);
    const other = mover({ id: "brick:sv", post: post({ id: "post-sv", studentGroupId: "g-7b", subjectId: "s-sv" }), teacherId: "anna" });
    expect(dropOf(ctx, other, spot(at("11:05")), names)).toEqual({ kind: "OK" });
  });

  it("is skipped over by the next free time: the quarter after the idrott is no time offered", () => {
    const ctx = mirrorWith([idrott(), post({ id: "post-ma" })], [kept({ studentGroupId: "g-7a", subjectId: "s-id", teacherId: "cy", roomId: null })]);
    // From 09:00 on the Tuesday: 09:15 to 10:45 overlap the idrott and 11:00 stands in the dusch.
    expect(nextFreeSpot(ctx, mathBrick(), 60, { dayOfWeek: 2, startMinutes: at("09:00") }, names)).toEqual({ dayOfWeek: 2, startMinutes: at("11:15") });
    const without = mirrorWith([idrott({ minutesBefore: 0, minutesAfter: 0 }), post({ id: "post-ma" })], [kept({ studentGroupId: "g-7a", subjectId: "s-id", teacherId: "cy", roomId: null })]);
    expect(nextFreeSpot(without, mathBrick(), 60, { dayOfWeek: 2, startMinutes: at("09:00") }, names)).toEqual({ dayOfWeek: 2, startMinutes: at("11:00") });
  });
});

describe("bufferMapOfBoard", () => {
  it("holds only the posts that name a minute, and the widest of two posts of one class and subject", () => {
    const map = bufferMapOfBoard([
      { studentGroupId: "g-7a", subjectId: "s-id", minutesBefore: 10, minutesAfter: 5 },
      { studentGroupId: "g-7a", subjectId: "s-id", minutesBefore: 0, minutesAfter: 15 },
      { studentGroupId: "g-7a", subjectId: "s-ma", minutesBefore: 0, minutesAfter: 0 },
      { studentGroupId: "g-7b", subjectId: "s-ma" },
    ]);
    expect([...map]).toEqual([["g-7a:s-id", { minutesBefore: 10, minutesAfter: 15 }]]);
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
