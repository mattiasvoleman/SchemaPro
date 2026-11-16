import { describe, expect, it } from "vitest";
import { blockKeyByRowId, blockMemberId } from "./placement-block-rows";
import type { BoardBlock, BoardBlockRow, BoardKept, BoardPlacement, BoardPost, PlacementBoard } from "./placement-board";
import {
  dropOf,
  dropOfBlock,
  insideSchoolDay,
  minutesOfField,
  moverOfBlockBrick,
  moverOfBlockRow,
  moverOfRow,
  nextFreeSpot,
  nextFreeSpotOfBlock,
  suggestedBlockRooms,
  suggestedRoom,
  type BlockMover,
  type Mover,
  type OtherNames,
} from "./placement-drop";
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

describe("a lesson of a block", () => {
  // Three posts of a block "Språkval", each for a teaching group of its own with its own teacher: they sit the lesson at once.
  const members = (over: Record<string, Partial<BoardPost>> = {}) =>
    ["fr", "sp", "ty"].map((id) => post({ id, studentGroupId: `g-${id}`, subjectId: `s-${id}`, teacherId: `t-${id}`, cannotPlace: "BLOCK", ...(over[id] ?? {}) }));
  const lesson = (over: Partial<BoardBlockRow> = {}): BoardBlockRow => ({
    id: "bl-1",
    dayOfWeek: 3,
    startTime: "10:00",
    endTime: "11:00",
    minutes: 60,
    recurrence: "ALL_WEEKS",
    rooms: [],
    changedAt: "x",
    verdicts: [],
    ...over,
  });
  const theBlock = (rows: BoardBlockRow[] = []): BoardBlock => ({
    id: "b-sv",
    name: "Språkval",
    memberIds: ["fr", "sp", "ty"],
    lengths: [60, 60],
    recurrence: "ALL_WEEKS",
    followsBlockId: null,
    cannotPlace: null,
    rows,
    rowsKey: "k",
  });
  const groupNames: OtherNames = { group: (id) => id.replace("g-", "G "), subject: (id) => id.replace("s-", "S ") };
  const mirrorWithBlock = (rows: BoardBlockRow[], over: { posts?: BoardPost[]; kept?: BoardKept[]; extraRows?: BoardPlacement[] } = {}) => {
    const board: PlacementBoard = { academicYearId: "y1", placements: over.extraRows ?? [], posts: over.posts ?? members(), kept: over.kept ?? [], meals: [], blocks: [theBlock(rows)] };
    return buildMirror({
      board,
      keys: keyByRowId(board.placements),
      groups: [group("g-7a"), group("g-fr"), group("g-sp"), group("g-ty")],
      studentGroupOf: new Map(),
      memberships: [],
      constraints: [],
      frames: undefined,
      academicYearId: "y1",
    });
  };
  const postsOf = (list: BoardPost[]) => new Map(list.map((entry) => [entry.id, entry]));
  const brick = (posts: BoardPost[], rooms: Record<string, string | null> = {}, rows: BoardBlockRow[] = []) =>
    moverOfBlockBrick("block:b-sv|60#1", { ...theBlock(rows), memberIds: posts.map((entry) => entry.id) }, postsOf(posts), new Map(Object.entries(rooms)));
  const span = (startMinutes: number, minutes = 60, dayOfWeek = 3) => ({ dayOfWeek, startMinutes, endMinutes: startMinutes + minutes });

  it("is OK on a week where nothing is in the way, for every post at once", () => {
    expect(dropOfBlock(mirrorWithBlock([]), brick(members()), span(600), groupNames)).toEqual({ kind: "OK" });
  });

  it("says the school day first", () => {
    expect(dropOfBlock(mirrorWithBlock([]), brick(members()), span(17 * 60 + 30), groupNames)).toEqual({ kind: "DAY" });
    expect(dropOfBlock(mirrorWithBlock([]), brick(members()), span(600, 60, 6), groupNames)).toEqual({ kind: "DAY" });
  });

  it("names the post whose teacher is busy, and what is in the way of it, never the person", () => {
    const week = mirrorWithBlock([], { kept: [kept({ dayOfWeek: 3, teacherId: "t-sp" })] });
    const drop = dropOfBlock(week, brick(members()), span(600), groupNames);
    expect(drop).toEqual({
      kind: "CLASH",
      reason: "TEACHER",
      requirementId: "sp",
      params: { otherKind: "LESSON", className: "G 7b", subjectName: "S sv", day: 3, start: "10:00", end: "11:00" },
    });
    expect(JSON.stringify(drop)).not.toContain("t-sp");
  });

  it("names the first post in the order the gateway judges them when several clash", () => {
    const week = mirrorWithBlock([], { kept: [kept({ dayOfWeek: 3, teacherId: "t-ty" }), kept({ id: "k-2", dayOfWeek: 3, teacherId: "t-fr", roomId: null })] });
    expect(dropOfBlock(week, brick(members()), span(600), groupNames)).toMatchObject({ kind: "CLASH", requirementId: "fr" });
  });

  it("holds each post's lesson against the class and the room of the week: a post's own room, and no room for a post that chose none", () => {
    const week = mirrorWithBlock([], { kept: [kept({ dayOfWeek: 3, teacherId: "x", roomId: "r-hall", studentGroupId: "g-7a" })] });
    // The post "ty" chose the room that is taken; "fr" and "sp" have none (the engine chooses): only "ty" clashes.
    expect(dropOfBlock(week, brick(members(), { ty: "r-hall" }), span(600), groupNames)).toMatchObject({ kind: "CLASH", reason: "ROOM", requirementId: "ty" });
    expect(dropOfBlock(week, brick(members(), { ty: null }), span(600), groupNames)).toEqual({ kind: "OK" });
    // A room another post chose is no other post's room: the taken room is "fr"'s here.
    expect(dropOfBlock(week, brick(members(), { fr: "r-hall" }), span(600), groupNames)).toMatchObject({ requirementId: "fr" });
  });

  it("holds the posts against each other: a teacher, a room or a class two of them share is a real clash, the lesson being the same one", () => {
    const sharedTeacher = members({ sp: { teacherId: "t-fr" } });
    expect(dropOfBlock(mirrorWithBlock([], { posts: sharedTeacher }), brick(sharedTeacher), span(600), groupNames)).toMatchObject({ kind: "CLASH", reason: "TEACHER", requirementId: "fr" });
    expect(dropOfBlock(mirrorWithBlock([]), brick(members(), { fr: "r-a", sp: "r-a" }), span(600), groupNames)).toMatchObject({ kind: "CLASH", reason: "ROOM", requirementId: "fr" });
    const sharedClass = members({ ty: { studentGroupId: "g-fr" } });
    expect(dropOfBlock(mirrorWithBlock([], { posts: sharedClass }), brick(sharedClass), span(600), groupNames)).toMatchObject({ kind: "CLASH", reason: "GROUP" });
    // Different rooms, different teachers, different groups: the same lesson stands in nobody's way.
    expect(dropOfBlock(mirrorWithBlock([]), brick(members(), { fr: "r-a", sp: "r-b", ty: null }), span(600), groupNames)).toEqual({ kind: "OK" });
  });

  it("says the other post of the block as the lesson in the way, with its group and subject", () => {
    const sharedTeacher = members({ sp: { teacherId: "t-fr" } });
    const drop = dropOfBlock(mirrorWithBlock([], { posts: sharedTeacher }), brick(sharedTeacher), span(600), groupNames);
    expect(drop).toMatchObject({ params: { otherKind: "PLACEMENT", className: "G sp", subjectName: "S sp", day: 3, start: "10:00", end: "11:00" } });
  });

  it("holds the block's other lessons in the way, and a lesson of an ordinary post that has the same teacher as one of its posts", () => {
    const rows = [lesson({ id: "bl-9", dayOfWeek: 3, startTime: "10:00", endTime: "11:00" })];
    const week = mirrorWithBlock(rows);
    expect(dropOfBlock(week, brick(members(), {}, rows), span(630), groupNames)).toMatchObject({ kind: "CLASH", reason: "TEACHER" });
    const withOther = mirrorWithBlock([], { posts: [...members(), post({ id: "own", teacherId: "t-ty", studentGroupId: "g-7a", subjectId: "s-ma" })], extraRows: [{ id: "r1", requirementId: "own", dayOfWeek: 3, startTime: "10:00", endTime: "11:00", minutes: 60, roomId: null, roomName: null, recurrence: "ALL_WEEKS", teacherId: null, changedAt: "x", verdict: { ok: true } }] });
    expect(dropOfBlock(withOther, brick(members()), span(600), groupNames)).toMatchObject({ kind: "CLASH", reason: "TEACHER", requirementId: "ty", params: { otherKind: "PLACEMENT" } });
  });

  describe("a lesson that is moved", () => {
    const stored = [lesson({ id: "bl-1", dayOfWeek: 3, startTime: "10:00", endTime: "11:00", rooms: [{ requirementId: "ty", roomId: "r-ty", roomName: "Tyska" }] })];
    const key = blockKeyByRowId([theBlock(stored)]).get("bl-1")!;
    const moving = (over: Partial<BlockMover> = {}): BlockMover => ({ ...moverOfBlockRow(`blockplacement:${key}`, key, theBlock(stored), stored[0]!, postsOf(members())), ...over });

    it("is not in its own way: a quarter of an hour later is free for the lesson that stands there now", () => {
      const week = mirrorWithBlock(stored);
      expect(dropOfBlock(week, moving(), span(615), groupNames)).toEqual({ kind: "OK" });
    });

    it("takes the rooms the lesson has, and every member's old placement is named by the card and the post", () => {
      const mover = moving();
      expect(mover.members.map((entry) => [entry.post.id, entry.roomId])).toEqual([
        ["fr", null],
        ["sp", null],
        ["ty", "r-ty"],
      ]);
      expect([...mover.ownIds].sort()).toEqual(["fr", "sp", "ty"].map((id) => blockMemberId(key, id)));
    });

    it("is not in the way of its own posts' new rooms either: a room that passes from one post to another in a quarter of an hour's move is free (the mutant that does not hold the lesson's own out)", () => {
      const fr = [lesson({ id: "bl-1", dayOfWeek: 3, startTime: "10:00", endTime: "11:00", rooms: [{ requirementId: "fr", roomId: "r-1", roomName: "A1" }] })];
      const week = mirrorWithBlock(fr);
      const frKey = blockKeyByRowId([theBlock(fr)]).get("bl-1")!;
      const rooms = new Map<string, string | null>([["sp", "r-1"], ["fr", null]]);
      const mover = moverOfBlockRow(`blockplacement:${frKey}`, frKey, theBlock(fr), fr[0]!, postsOf(members()), rooms);
      expect(dropOfBlock(week, mover, span(615), groupNames)).toEqual({ kind: "OK" });
      // Held out of nothing, the old place of "fr" in room r-1 stands in the way of "sp" in room r-1.
      expect(dropOfBlock(week, { ...mover, ownIds: new Set() }, span(615), groupNames)).toMatchObject({ kind: "CLASH", reason: "ROOM", requirementId: "sp" });
    });

    it("holds out only the lesson that moves: the block's other lesson stays in the way", () => {
      const both = [...stored, lesson({ id: "bl-2", dayOfWeek: 3, startTime: "13:00", endTime: "14:00" })];
      const week = mirrorWithBlock(both);
      const mover = moverOfBlockRow(`blockplacement:${key}`, key, theBlock(both), both[0]!, postsOf(members()));
      expect(dropOfBlock(week, mover, span(780), groupNames)).toMatchObject({ kind: "CLASH", reason: "TEACHER" });
      expect(dropOfBlock(week, mover, span(615), groupNames)).toEqual({ kind: "OK" });
    });

    it("is held out on every day: the old place on another day than the new one is nobody's business either", () => {
      const week = mirrorWithBlock(stored);
      expect(dropOfBlock(week, moving(), span(600, 60, 4), groupNames)).toEqual({ kind: "OK" });
    });

    it("can be given other rooms than the row's, which are then the ones tried", () => {
      const week = mirrorWithBlock(stored, { kept: [kept({ dayOfWeek: 4, teacherId: "x", roomId: "r-hall", startTime: "10:00", endTime: "11:00" })] });
      const mover = moverOfBlockRow(`blockplacement:${key}`, key, theBlock(stored), stored[0]!, postsOf(members()), new Map([["sp", "r-hall"]]));
      expect(dropOfBlock(week, mover, span(600, 60, 4), groupNames)).toMatchObject({ reason: "ROOM", requirementId: "sp" });
    });
  });

  describe("against a naive check on an hour grid (the property)", () => {
    /** A small deterministic generator, so that a failure can be reproduced. */
    const generator = (seed: number) => () => {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return seed / 2 ** 32;
    };

    it("says OK exactly where no lesson of the week or of the block's other posts overlaps a teacher of the block, and a moved lesson's own place is nobody's", () => {
      const random = generator(7);
      const pick = <T,>(list: readonly T[]): T => list[Math.floor(random() * list.length)]!;
      const teachers = ["t-fr", "t-sp", "t-ty", "t-x", "t-y"];
      let refused = 0;
      let allowed = 0;
      for (let trial = 0; trial < 400; trial++) {
        // The week: up to six lessons Generera keeps, on an hour grid, of teachers and classes of their own (no room, no class in common).
        const lessons = Array.from({ length: Math.floor(random() * 7) }, (_, at) => ({
          id: `k-${at}`,
          day: 1 + Math.floor(random() * 3),
          start: 8 + Math.floor(random() * 9),
          teacher: pick(teachers),
        }));
        const keptLessons = lessons.map((entry) =>
          kept({ id: entry.id, dayOfWeek: entry.day, startTime: `${String(entry.start).padStart(2, "0")}:00`, endTime: `${String(entry.start + 1).padStart(2, "0")}:00`, teacherId: entry.teacher, roomId: null, studentGroupId: `g-other-${entry.id}`, subjectId: "s-x" }),
        );
        // A block with a post whose teacher is one of the first three and sometimes shared by two posts (a real clash between them).
        const memberTeachers = [pick(["t-fr", "t-sp"]), pick(["t-sp", "t-ty"]), pick(["t-ty", "t-fr"])];
        const posts = members().map((entry, at) => ({ ...entry, teacherId: memberTeachers[at]! }));
        // The lesson being moved, sometimes: its old place is in the week, held out of it.
        const old = random() < 0.5 ? { day: 1 + Math.floor(random() * 3), start: 8 + Math.floor(random() * 9) } : null;
        const rows = old ? [lesson({ id: "bl-1", dayOfWeek: old.day, startTime: `${String(old.start).padStart(2, "0")}:00`, endTime: `${String(old.start + 1).padStart(2, "0")}:00` })] : [];
        const board: PlacementBoard = { academicYearId: "y1", placements: [], posts, kept: keptLessons, meals: [], blocks: [{ ...theBlock(rows) }] };
        const week = buildMirror({ board, keys: new Map(), groups: [group("g-fr"), group("g-sp"), group("g-ty"), ...lessons.map((entry) => group(`g-other-${entry.id}`))], studentGroupOf: new Map(), memberships: [], constraints: [], frames: undefined, academicYearId: "y1" });
        const to = { day: 1 + Math.floor(random() * 3), start: 8 + Math.floor(random() * 9) };
        const key = old ? blockKeyByRowId(board.blocks).get("bl-1")! : "";
        const mover = old
          ? moverOfBlockRow(`blockplacement:${key}`, key, board.blocks[0]!, rows[0]!, postsOf(posts))
          : moverOfBlockBrick("block:b-sv|60#1", board.blocks[0]!, postsOf(posts), new Map());

        // The naive rule: a teacher of the block is busy if a kept lesson has that teacher at an overlapping hour of the same day,
        // or two posts of the block have the same teacher. The lesson's own old place is not a lesson of the week.
        const busyTeachers = new Set(lessons.filter((entry) => entry.day === to.day && entry.start === to.start).map((entry) => entry.teacher));
        const clash = memberTeachers.some((teacher) => busyTeachers.has(teacher)) || new Set(memberTeachers).size < memberTeachers.length;
        const drop = dropOfBlock(week, mover, span(to.start * 60, 60, to.day), groupNames);
        if (clash) refused++;
        else allowed++;
        expect(drop.kind === "OK", `trial ${trial}: ${JSON.stringify({ lessons, memberTeachers, old, to })} -> ${JSON.stringify(drop)}`).toBe(!clash);
      }
      // The property is not vacuous: both answers were given.
      expect(refused).toBeGreaterThan(50);
      expect(allowed).toBeGreaterThan(50);
    });
  });

  it("finds the next time that is free for every post of the block, round the week", () => {
    const week = mirrorWithBlock([], { kept: [kept({ dayOfWeek: 3, startTime: "10:00", endTime: "11:00", teacherId: "t-fr" }), kept({ id: "k-2", dayOfWeek: 3, startTime: "11:00", endTime: "12:00", teacherId: "t-ty", roomId: null })] });
    expect(nextFreeSpotOfBlock(week, brick(members()), 60, { dayOfWeek: 3, startMinutes: 540 }, groupNames)).toEqual({ dayOfWeek: 3, startMinutes: 12 * 60 });
    expect(nextFreeSpotOfBlock(mirrorWithBlock([]), brick(members()), 60, { dayOfWeek: 3, startMinutes: 600 }, groupNames)).toEqual({ dayOfWeek: 3, startMinutes: 615 });
    const taken = [1, 2, 3, 4, 5].map((day) => kept({ id: `k-${day}`, dayOfWeek: day, startTime: "08:00", endTime: "18:00", teacherId: "t-sp", roomId: null }));
    expect(nextFreeSpotOfBlock(mirrorWithBlock([], { kept: taken }), brick(members()), 60, { dayOfWeek: 1, startMinutes: 480 }, groupNames)).toBeNull();
  });

  it("is seen by an ordinary post's lesson too: the block's lesson is a neighbour of the post's row", () => {
    const rows = [lesson({ dayOfWeek: 3, startTime: "10:00", endTime: "11:00", rooms: [{ requirementId: "sp", roomId: "r-sp", roomName: "Spanska" }] })];
    const own = post({ id: "own", studentGroupId: "g-7a", subjectId: "s-ma", teacherId: "t-ty" });
    const week = mirrorWithBlock(rows, { posts: [...members(), own] });
    const moverOfOwn: Mover = { id: "brick:own", post: own, teacherId: "t-ty", roomId: null, recurrence: "ALL_WEEKS" };
    expect(dropOf(week, moverOfOwn, span(600), groupNames)).toMatchObject({ kind: "CLASH", reason: "TEACHER", params: { otherKind: "PLACEMENT", className: "G ty" } });
    // The room "sp" chose is taken for an ordinary post that wants it; a room nobody chose is not.
    expect(dropOf(week, { ...moverOfOwn, teacherId: "t-free", roomId: "r-sp" }, span(600), groupNames)).toMatchObject({ kind: "CLASH", reason: "ROOM" });
    expect(dropOf(week, { ...moverOfOwn, teacherId: "t-free", roomId: "r-other" }, span(600), groupNames)).toEqual({ kind: "OK" });
  });

  describe("the rooms to offer a post of the block", () => {
    const rule = { id: "rp", subjectId: "s-fr", kind: "WISH" as const, minGradeLevel: null, maxGradeLevel: null, roomTypeId: null, weight: 1, rooms: [{ roomId: "r-rule" }] };
    const withRooms = (rows: BoardBlockRow[]) => ({ block: theBlock(rows), posts: postsOf(members()), rules: [rule], gradeLevelOf: () => 7 });

    it("is the room the post's own lessons of the block stand in, per post, else the subject's rule, else none", () => {
      const rows = [lesson({ rooms: [{ requirementId: "ty", roomId: "r-ty", roomName: "Tyska" }] }), lesson({ id: "bl-2", rooms: [{ requirementId: "ty", roomId: "r-ty", roomName: "Tyska" }, { requirementId: "sp", roomId: "r-sp", roomName: "Spanska" }] })];
      const rooms = suggestedBlockRooms(withRooms(rows));
      expect(Object.fromEntries(rooms)).toEqual({ fr: "r-rule", sp: "r-sp", ty: "r-ty" });
    });

    it("is never one room for every post, which the room filter's would be: no room for a post with no rule", () => {
      const rooms = suggestedBlockRooms({ ...withRooms([]), rules: [] });
      expect(Object.fromEntries(rooms)).toEqual({ fr: null, sp: null, ty: null });
    });

    it("leaves out a post the board does not have", () => {
      const rooms = suggestedBlockRooms({ ...withRooms([]), posts: postsOf(members().slice(0, 1)) });
      expect([...rooms.keys()]).toEqual(["fr"]);
    });
  });
});
