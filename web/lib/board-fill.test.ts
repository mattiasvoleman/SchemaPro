import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@/lib/api";
import { applyFill, BOARD_FILL_STALE, clockOf, fillFailureOf, fillFigures, proposeFill, type FillProposal } from "./board-fill";
import { fillPreview } from "./fill-store";

const post = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api", async (original) => ({ ...(await original<typeof import("@/lib/api")>()), api: { post } }));

const brick = (key: string, over: Record<string, unknown> = {}) => ({ key, postId: "p", studentGroupId: "g", subjectId: "s", teacherId: "t", minutes: 60, lessonId: null, ...over });
const proposal = (over: Partial<FillProposal> = {}): FillProposal => ({
  academicYearId: "y1",
  answeredBy: "FILL",
  basis: "a".repeat(32),
  asked: 4,
  placed: [
    { ...brick("p|t|60|1"), dayOfWeek: 2, startMinutes: 545, endMinutes: 605, roomId: "r1", noRoom: false },
    { ...brick("p|t|60|2"), dayOfWeek: 4, startMinutes: 480, endMinutes: 540, roomId: null, noRoom: true },
  ],
  left: [
    { ...brick("p|t|60|3"), reason: "NO_FREE_START" },
    { ...brick("p|t|60|4"), reason: "TIME" },
  ],
  moved: [],
  truncated: true,
  ...over,
});

beforeEach(() => post.mockReset());

describe("proposeFill", () => {
  it("asks the gateway for the scope and hands on the answer, with the abort signal", async () => {
    post.mockResolvedValue(proposal());
    const controller = new AbortController();
    const answer = await proposeFill({ academicYearId: "y1", scope: "CLASS", studentGroupId: "g1" }, controller.signal);
    expect(post).toHaveBeenCalledWith("/api/v1/board-fill/propose", { academicYearId: "y1", scope: "CLASS", studentGroupId: "g1" }, controller.signal);
    expect(answer?.placed).toHaveLength(2);
  });

  it("is no answer for a body that is not the gateway's (a proxy's page, an older gateway)", async () => {
    for (const body of [null, "<html>", {}, { basis: 1, placed: [], left: [] }, { basis: "x", placed: {}, left: [] }]) {
      post.mockResolvedValue(body);
      expect(await proposeFill({ academicYearId: "y1", scope: "SCHOOL" })).toBeNull();
    }
  });
});

describe("applyFill", () => {
  it("takes the proposal in as it was read: its basis and, per lesson, the key, the day, the clock and the room", async () => {
    post.mockResolvedValue({ academicYearId: "y1", versionId: "v1", laid: [] });
    await applyFill(proposal());
    expect(post).toHaveBeenCalledWith("/api/v1/board-fill/apply", {
      academicYearId: "y1",
      basis: "a".repeat(32),
      items: [
        { key: "p|t|60|1", dayOfWeek: 2, startTime: "09:05", roomId: "r1" },
        { key: "p|t|60|2", dayOfWeek: 4, startTime: "08:00", roomId: null },
      ],
    });
  });
});

describe("what is said", () => {
  it("writes a minute of the day as a clock", () => {
    expect([clockOf(0), clockOf(485), clockOf(1439)]).toEqual(["00:00", "08:05", "23:59"]);
  });

  it("counts what was laid of what was asked about, and what was left for each reason", () => {
    expect(fillFigures(proposal())).toEqual({ laid: 2, asked: 4, left: 2, byReason: { NO_FREE_START: 1, TIME: 1 } });
  });

  it("tells a stale proposal and a time the judge now refuses from every other failure", () => {
    expect(fillFailureOf(new ApiError(409, "x", BOARD_FILL_STALE))).toEqual({ kind: "STALE" });
    expect(fillFailureOf(new ApiError(409, "x", "MASTER_LESSON_REFUSED"))).toEqual({ kind: "REFUSED" });
    expect(fillFailureOf(new ApiError(409, "x", "BOARD_ROOM_NOT_ALLOWED"))).toEqual({ kind: "REFUSED" });
    expect(fillFailureOf(new ApiError(500, "x"))).toEqual({ kind: "OTHER" });
    expect(fillFailureOf(new Error("x"))).toEqual({ kind: "OTHER" });
  });
});

describe("the preview store", () => {
  it("holds what the board draws, tells whoever follows it, and lets go of it", () => {
    const seen: Array<unknown> = [];
    const stop = fillPreview.subscribe(() => seen.push(fillPreview.get()?.proposal.asked ?? null));
    fillPreview.set({ proposal: proposal(), labels: new Map() });
    fillPreview.set(null);
    stop();
    fillPreview.set({ proposal: proposal(), labels: new Map() });
    expect(seen).toEqual([4, null]);
    fillPreview.set(null);
    expect(fillPreview.get()).toBeNull();
  });
});
