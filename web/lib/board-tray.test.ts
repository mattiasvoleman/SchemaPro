import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@/lib/api";
import {
  BOARD_BRICK_CANNOT_BE_LAID,
  BOARD_ROOM_NOT_ALLOWED,
  MASTER_LESSON_REFUSED,
  REQUIREMENT_PLACEMENTS_STALE,
  bricksOf,
  brickKey,
  brickSubject,
  fetchTray,
  headFigures,
  layBodyOf,
  layBrick,
  layFailureOf,
  type BoardTray,
  type TrayBrick,
} from "./board-tray";

const get = vi.hoisted(() => vi.fn());
const post = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api", async (original) => ({ ...(await original<typeof import("@/lib/api")>()), api: { get, post } }));

const brick = (over: Partial<TrayBrick> = {}): TrayBrick => ({
  postId: "p1",
  nth: 1,
  partKey: "0123456789abcdef",
  lessonId: null,
  studentGroupId: "g1",
  subjectId: "s1",
  teacherId: "t1",
  coTeacherId: null,
  minutes: 60,
  recurrence: "ALL_WEEKS",
  startDate: null,
  endDate: null,
  blockId: null,
  cannotPlace: null,
  possibleTimes: null,
  ...over,
});
const TRAY: BoardTray = {
  academicYearId: "y1",
  bricks: [brick(), brick({ nth: 2 }), brick({ postId: "p2", studentGroupId: "g2" })],
  tally: { lessons: 10, laid: 7, placedByRow: 1, left: 3 },
  groups: [{ studentGroupId: "g1", left: 2 }, { studentGroupId: "g2", left: 1 }],
};

beforeEach(() => {
  get.mockReset();
  post.mockReset();
});

describe("Att lägga, the page's reading of the tray", () => {
  it("asks for the year's tray and returns the gateway's answer", async () => {
    get.mockResolvedValue(TRAY);
    await expect(fetchTray("y 1")).resolves.toBe(TRAY);
    expect(get).toHaveBeenCalledWith("/api/v1/board-tray?academicYearId=y%201");
  });

  it("takes an answer that is not the gateway's for no answer: a proxy's page, an older gateway's body", async () => {
    for (const body of [undefined, null, "<html>", {}, { bricks: [], groups: [] }, { bricks: [], groups: [], tally: {} }, { bricks: {}, groups: [], tally: TRAY.tally }]) {
      get.mockResolvedValue(body);
      await expect(fetchTray("y1")).resolves.toBeNull();
    }
  });

  it("says the head's figures: the lessons that stand, of those the posts ask for, and the förläggningar apart", () => {
    expect(headFigures(TRAY.tally)).toEqual({ laid: 7, of: 10, placedByRow: 1 });
  });

  it("keeps the gateway's order, and shows one class's bricks or all", () => {
    expect(bricksOf(TRAY, null)).toBe(TRAY.bricks);
    expect(bricksOf(TRAY, "g2").map((entry) => entry.postId)).toEqual(["p2"]);
    expect(bricksOf(TRAY, "nobody")).toEqual([]);
  });

  it("keys a brick by its part and which of them it is, or by the lesson it is", () => {
    expect(brickKey(brick())).toBe("p1:t1:60:1");
    expect(brickKey(brick({ nth: 2 }))).toBe("p1:t1:60:2");
    expect(brickKey(brick({ teacherId: null }))).toBe("p1::60:1");
    expect(brickKey(brick({ lessonId: "l9" }))).toBe("l9");
    // Two lengths of one post have the same nth and are two bricks.
    expect(brickKey(brick({ minutes: 90 }))).not.toBe(brickKey(brick()));
  });

  it("asks about a brick as the gateway's brick subject: what is known of it, and nothing that is not", () => {
    expect(brickSubject(brick(), "y1")).toEqual({ academicYearId: "y1", studentGroupId: "g1", subjectId: "s1", minutes: 60, teacherId: "t1", recurrence: "ALL_WEEKS" });
    expect(brickSubject(brick({ teacherId: null, coTeacherId: "c1", startDate: "2027-01-11", endDate: "2027-06-11", recurrence: "ODD_WEEKS" }), "y1")).toEqual({
      academicYearId: "y1",
      studentGroupId: "g1",
      subjectId: "s1",
      minutes: 60,
      coTeacherId: "c1",
      recurrence: "ODD_WEEKS",
      startDate: "2027-01-11",
      endDate: "2027-06-11",
    });
  });

  describe("the lay", () => {
    it("names the brick's part and the picture it was read in, and where it is put", () => {
      expect(layBodyOf(brick(), "y1", { dayOfWeek: 2, startTime: "09:00", roomId: "r1" })).toEqual({
        academicYearId: "y1",
        postId: "p1",
        teacherId: "t1",
        minutes: 60,
        partKey: "0123456789abcdef",
        dayOfWeek: 2,
        startTime: "09:00",
        roomId: "r1",
      });
    });

    it("names the lesson only when the brick is a lesson on the tray, and the exemptions only when there are some", () => {
      const parked = layBodyOf(brick({ lessonId: "l9" }), "y1", { dayOfWeek: 2, startTime: "09:00", roomId: null, exempt: ["FRAME"] });
      expect(parked).toMatchObject({ lessonId: "l9", roomId: null, exempt: ["FRAME"] });
      expect(layBodyOf(brick(), "y1", { dayOfWeek: 2, startTime: "09:00", roomId: null, exempt: [] })).not.toHaveProperty("exempt");
      expect(layBodyOf(brick(), "y1", { dayOfWeek: 2, startTime: "09:00", roomId: null })).not.toHaveProperty("lessonId");
    });

    it("posts it to the gateway's route and returns what it answered", async () => {
      post.mockResolvedValue({ lesson: { id: "n1" }, noRoom: false });
      const body = layBodyOf(brick(), "y1", { dayOfWeek: 2, startTime: "09:00", roomId: "r1" });
      await expect(layBrick(body)).resolves.toEqual({ lesson: { id: "n1" }, noRoom: false });
      expect(post).toHaveBeenCalledWith("/api/v1/board-tray/lay", body);
    });
  });

  describe("what a refused lay is", () => {
    const refused = (code: string, params?: Record<string, string | number>) => new ApiError(409, "x", code, params);

    it("is a stale picture when another administrator changed the part", () => {
      expect(layFailureOf(refused(REQUIREMENT_PLACEMENTS_STALE))).toEqual({ kind: "STALE" });
    });

    it("is a room that does not suit, with the reason, and only for the three the gateway has", () => {
      for (const reason of ["SEATS", "TYPE", "YEARS"]) expect(layFailureOf(refused(BOARD_ROOM_NOT_ALLOWED, { roomId: "r1", reason }))).toEqual({ kind: "ROOM", reason });
      expect(layFailureOf(refused(BOARD_ROOM_NOT_ALLOWED, { reason: "SOMETHING" }))).toEqual({ kind: "OTHER" });
      expect(layFailureOf(refused(BOARD_ROOM_NOT_ALLOWED))).toEqual({ kind: "OTHER" });
    });

    it("is a brick that cannot be laid alone", () => {
      expect(layFailureOf(refused(BOARD_BRICK_CANNOT_BE_LAID, { reason: "BLOCK" }))).toEqual({ kind: "CANNOT" });
    });

    it("is a refusal by the judge, and says which rules the answer Lägg ändå can be given to: all of them exemptable, or none", () => {
      expect(layFailureOf(refused(MASTER_LESSON_REFUSED, { reasons: "FRAME" }))).toEqual({ kind: "REFUSED", exemptable: ["FRAME"] });
      expect(layFailureOf(refused(MASTER_LESSON_REFUSED, { reasons: "LUNCH,FRAME" }))).toEqual({ kind: "REFUSED", exemptable: ["FRAME", "LUNCH"] });
      expect(layFailureOf(refused(MASTER_LESSON_REFUSED, { reasons: "FRAME,TEACHER" }))).toEqual({ kind: "REFUSED", exemptable: null });
      expect(layFailureOf(refused(MASTER_LESSON_REFUSED, { reason: "TEACHER" }))).toEqual({ kind: "REFUSED", exemptable: null });
    });

    it("is anything else for what the gateway does not say, and for what is not the gateway's", () => {
      expect(layFailureOf(refused("SOMETHING_ELSE"))).toEqual({ kind: "OTHER" });
      expect(layFailureOf(new Error("network"))).toEqual({ kind: "OTHER" });
      expect(layFailureOf(undefined)).toEqual({ kind: "OTHER" });
    });
  });
});
