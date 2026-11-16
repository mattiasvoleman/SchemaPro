import { describe, expect, it } from "vitest";
import type { BoardKept, BoardMeal, BoardPlacement, BoardPost, PlacementBoard } from "./placement-board";
import { keyByRowId } from "./placement-rows";
import { buildMirror, lunchOfBoard, mirrorHits, placementOfKept, placementOfRow, REASON_OF_HIT, type MirrorFacts } from "./placement-mirror";
import type { AvailabilityConstraint, StudentGroup } from "./types";

/**
 * The mirror of the judge, as the page uses it for the ghost: the week's lessons and förläggningar recounted as the
 * grundschema's `Placement`, held against the school's lists. It must never be milder than the gateway's judge for the
 * rules it has; placement-mirror.contract.test.ts holds that against the shared fixture, and here the plumbing: what
 * a row and a kept lesson become, and that each rule is reached.
 */

const group = (id: string, gradeLevel: number | null, over: Partial<StudentGroup> = {}): StudentGroup => ({
  id,
  academicYearId: "y1",
  name: id,
  kind: "CLASS",
  gradeLevel,
  ...over,
});

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

let ids = 0;
const row = (over: Partial<BoardPlacement> = {}): BoardPlacement => ({
  id: `row-${++ids}`,
  requirementId: "post-1",
  dayOfWeek: 2,
  startTime: "10:00",
  endTime: "11:00",
  minutes: 60,
  roomId: "r-a12",
  roomName: "A12",
  recurrence: "ALL_WEEKS",
  teacherId: null,
  changedAt: "2026-11-13T08:00:00.000Z",
  verdict: { ok: true },
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
  teacherId: "bo",
  coTeacherId: null,
  roomId: "r-b3",
  recurrence: "ALL_WEEKS",
  startDate: null,
  endDate: null,
  locked: true,
  generated: false,
  ...over,
});

const meal = (over: Partial<BoardMeal> = {}): BoardMeal => ({ id: "m-1", studentGroupId: "g-7a", dayOfWeek: 2, startTime: "11:00", endTime: "11:30", startDate: null, endDate: null, ...over });

const unavailable = (over: Partial<AvailabilityConstraint>): AvailabilityConstraint => ({
  id: "c-1",
  resourceType: "TEACHER",
  userId: null,
  roomId: null,
  studentGroupId: null,
  minGradeLevel: null,
  maxGradeLevel: null,
  dayOfWeek: 2,
  date: null,
  startTime: "10:00",
  endTime: "11:00",
  type: "UNAVAILABLE",
  reason: null,
  ...over,
});

function mirror(world: { rows?: BoardPlacement[]; kept?: BoardKept[]; meals?: BoardMeal[]; posts?: BoardPost[] } & Partial<MirrorFacts> = {}) {
  const board: PlacementBoard = {
    academicYearId: "y1",
    placements: world.rows ?? [],
    posts: world.posts ?? [post()],
    kept: world.kept ?? [],
    meals: world.meals ?? [],
    blocks: [],
  };
  return buildMirror({
    board,
    keys: keyByRowId(board.placements),
    groups: world.groups ?? [group("g-7a", 7), group("g-7b", 7)],
    studentGroupOf: world.studentGroupOf ?? new Map(),
    memberships: world.memberships ?? [],
    constraints: world.constraints ?? [],
    frames: world.frames,
    academicYearId: "y1",
  });
}

const candidate = (over: Record<string, unknown> = {}) => ({
  id: "brick:1",
  dayOfWeek: 2,
  startMinutes: 600,
  endMinutes: 660,
  teacherId: "anna",
  coTeacherId: null,
  roomId: "r-a12" as string | null,
  studentGroupId: "g-7a",
  subjectId: "s-ma",
  recurrence: "ALL_WEEKS" as const,
  startDate: null,
  endDate: null,
  ...over,
});

describe("what the week becomes for the clash rule", () => {
  it("turns a förläggning into its post's class, subject, teachers and weeks with its own day, time and room", () => {
    const placement = placementOfRow(row({ teacherId: "bo", recurrence: "ODD_WEEKS", roomId: null }), post({ coTeacherId: "cy", startDate: "2026-08-24", endDate: "2026-12-20" }), "placement:k");
    expect(placement).toMatchObject({
      id: "placement:k",
      dayOfWeek: 2,
      startMinutes: 600,
      endMinutes: 660,
      // The row's own teacher on a shared post, the medlärare of the post, no room.
      teacherId: "bo",
      coTeacherId: "cy",
      roomId: null,
      studentGroupId: "g-7a",
      subjectId: "s-ma",
      recurrence: "ODD_WEEKS",
      startDate: "2026-08-24",
      endDate: "2026-12-20",
    });
  });

  it("takes the post's teacher for a row of a post that shares nothing", () => {
    expect(placementOfRow(row(), post(), "p").teacherId).toBe("anna");
  });

  it("turns a lesson Generera keeps into its classes, teachers, room and weeks, named by its id", () => {
    expect(placementOfKept(kept({ extraGroupIds: ["g-7a"], coTeacherId: "cy" }))).toMatchObject({
      id: "kept:k-1",
      studentGroupId: "g-7b",
      extraGroupIds: ["g-7a"],
      teacherId: "bo",
      coTeacherId: "cy",
      roomId: "r-b3",
    });
  });

  it("holds the rows against the meals the school placed by hand, by group and weekday", () => {
    const meals = lunchOfBoard([meal(), meal({ id: "m-2", startDate: "2026-08-24", endDate: "2026-12-20", startTime: "12:00", endTime: "12:30" })]);
    expect(meals.get("g-7a:2")).toEqual([
      { startMinutes: 660, endMinutes: 690, startDate: null, endDate: null },
      { startMinutes: 720, endMinutes: 750, startDate: "2026-08-24", endDate: "2026-12-20" },
    ]);
  });
});

describe("the rules the mirror has", () => {
  it("holds the teacher against a lesson Generera keeps, and a förläggning of another post", () => {
    expect(mirrorHits(mirror({ kept: [kept({ teacherId: "anna" })] }), candidate()).map((hit) => hit.kind)).toEqual(["TEACHER"]);
    const other = row({ requirementId: "post-2" });
    expect(
      mirrorHits(mirror({ rows: [other], posts: [post(), post({ id: "post-2", teacherId: "anna", studentGroupId: "g-7b" })] }), candidate()).map((hit) => hit.kind),
    ).toEqual(["TEACHER", "ROOM"]);
  });

  it("holds the medlärare as a teacher: the post's own and the other lesson's", () => {
    const ctx = mirror({ kept: [kept({ teacherId: "cy" })] });
    expect(mirrorHits(ctx, candidate({ teacherId: "anna", coTeacherId: "cy" })).map((hit) => hit.kind)).toEqual(["TEACHER"]);
    expect(mirrorHits(mirror({ kept: [kept({ teacherId: "anna" })] }), candidate({ teacherId: "dd" })).map((hit) => hit.kind)).toEqual([]);
    expect(mirrorHits(mirror({ kept: [kept({ teacherId: "x", coTeacherId: "anna" })] }), candidate()).map((hit) => hit.kind)).toEqual(["TEACHER"]);
  });

  it("holds the room, and no room is no room clash", () => {
    const ctx = mirror({ kept: [kept({ teacherId: "x", roomId: "r-a12" })] });
    expect(mirrorHits(ctx, candidate()).map((hit) => hit.kind)).toEqual(["ROOM"]);
    expect(mirrorHits(ctx, candidate({ roomId: null }))).toEqual([]);
  });

  it("holds the class, and a class that shares pupils with another (a teaching group of 7A's pupils)", () => {
    expect(mirrorHits(mirror({ kept: [kept({ teacherId: "x", roomId: "r-9", studentGroupId: "g-7a" })] }), candidate()).map((hit) => hit.kind)).toEqual(["GROUP"]);
    const ctx = mirror({
      kept: [kept({ teacherId: "x", roomId: "r-9", studentGroupId: "g-ma7" })],
      groups: [group("g-7a", 7), group("g-ma7", null, { kind: "TEACHING_GROUP" })],
      studentGroupOf: new Map([["s-1", "g-7a"]]),
      memberships: [{ studentId: "s-1", studentGroupId: "g-ma7" }],
    });
    expect(mirrorHits(ctx, candidate()).map((hit) => hit.kind)).toEqual(["GROUP"]);
  });

  it("holds a lesson opened to a second class against that class", () => {
    const ctx = mirror({ kept: [kept({ teacherId: "x", roomId: "r-9", studentGroupId: "g-7b", extraGroupIds: ["g-7a"] })] });
    expect(mirrorHits(ctx, candidate()).map((hit) => hit.kind)).toEqual(["GROUP"]);
  });

  it("lets odd and even weeks share a slot, a teacher and a room", () => {
    const ctx = mirror({ kept: [kept({ teacherId: "anna", roomId: "r-a12", recurrence: "EVEN_WEEKS" })] });
    expect(mirrorHits(ctx, candidate({ recurrence: "ODD_WEEKS" }))).toEqual([]);
    expect(mirrorHits(ctx, candidate({ recurrence: "ALL_WEEKS" })).map((hit) => hit.kind)).toContain("TEACHER");
  });

  it("holds the unavailability of a teacher, a room and a class, and a year rule that reaches the class", () => {
    expect(mirrorHits(mirror({ constraints: [unavailable({ userId: "anna" })] }), candidate()).map((hit) => hit.kind)).toEqual(["AVAILABILITY"]);
    expect(mirrorHits(mirror({ constraints: [unavailable({ resourceType: "ROOM", roomId: "r-a12" })] }), candidate()).map((hit) => hit.kind)).toEqual(["AVAILABILITY"]);
    expect(mirrorHits(mirror({ constraints: [unavailable({ resourceType: "STUDENT_GROUP", studentGroupId: "g-7a" })] }), candidate()).map((hit) => hit.kind)).toEqual(["AVAILABILITY"]);
    expect(mirrorHits(mirror({ constraints: [unavailable({ resourceType: "GRADE_LEVEL", minGradeLevel: 7, maxGradeLevel: 9 })] }), candidate()).map((hit) => hit.kind)).toEqual(["AVAILABILITY"]);
    expect(mirrorHits(mirror({ constraints: [unavailable({ resourceType: "GRADE_LEVEL", minGradeLevel: 4, maxGradeLevel: 6 })] }), candidate())).toEqual([]);
  });

  it("holds the class's ramtid, and does not check frames that have not arrived", () => {
    const frames = [{ id: "f", minGradeLevel: 7, maxGradeLevel: 9, dayOfWeek: null, startTime: "08:00", endTime: "10:30" }];
    expect(mirrorHits(mirror({ frames }), candidate()).map((hit) => hit.kind)).toEqual(["FRAME"]);
    expect(mirrorHits(mirror({ frames }), candidate({ startMinutes: 540, endMinutes: 600 }))).toEqual([]);
    expect(mirrorHits(mirror({ frames: undefined }), candidate())).toEqual([]);
  });

  it("holds the class's meal that the school placed by hand, and no other", () => {
    expect(mirrorHits(mirror({ meals: [meal({ startTime: "10:30", endTime: "11:30" })] }), candidate()).map((hit) => hit.kind)).toEqual(["LUNCH"]);
    expect(mirrorHits(mirror({ meals: [meal({ studentGroupId: "g-7b", startTime: "10:30", endTime: "11:30" })] }), candidate())).toEqual([]);
  });

  it("does not hold a lesson against its own place: a row moved is not in its own way, and a half-open end is free", () => {
    const own = row({ id: "mine" });
    const ctx = mirror({ rows: [own] });
    const key = ctx.others.find((placement) => placement.id?.startsWith("placement:"))!.id!;
    expect(mirrorHits(ctx, candidate({ id: key }))).toEqual([]);
    // Another lesson of the same teacher straight after: the end of one is the start of the next.
    expect(mirrorHits(mirror({ kept: [kept({ teacherId: "anna", startTime: "09:00", endTime: "10:00" })] }), candidate())).toEqual([]);
  });

  it("names the rows by their lesson key, so that a row saved again is still the same lesson", () => {
    const first = mirror({ rows: [row({ id: "a" })] }).others[0]!.id;
    const again = mirror({ rows: [row({ id: "b" })] }).others[0]!.id;
    expect(first).toBe(again);
  });

  it("reports the room lock as no reason of a förläggning's judge, and every other kind as the judge's own", () => {
    expect(REASON_OF_HIT).toEqual({
      TEACHER: "TEACHER",
      ROOM: "ROOM",
      GROUP: "GROUP",
      AVAILABILITY: "AVAILABILITY",
      FRAME: "FRAME",
      LUNCH: "LUNCH",
      ROOM_LOCK: null,
    });
  });
});
