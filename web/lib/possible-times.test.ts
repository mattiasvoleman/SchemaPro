import { beforeEach, describe, expect, it, vi } from "vitest";
import { TIMES } from "./possible-times.fixture";
import { askPossibleTimes, askRoomChoices, NUMBERED, optionAt, optionNumbered, runAt } from "./possible-times";
import { possibleOf, possibleStore } from "./possible-store";

const post = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api", () => ({ api: { post } }));

beforeEach(() => {
  post.mockReset();
  possibleStore.set(null);
});

describe("asking where a lesson can stand", () => {
  it("posts the lesson, the board's day, five-minute steps and as many best times as there are keys", async () => {
    post.mockResolvedValue(TIMES);
    const controller = new AbortController();
    await expect(askPossibleTimes("a", controller.signal)).resolves.toBe(TIMES);
    expect(post).toHaveBeenCalledWith(
      "/api/v1/master-lessons/possible-times",
      { lessonId: "a", from: "07:00", to: "18:00", stepMinutes: 5, limit: NUMBERED },
      controller.signal,
    );
    expect(NUMBERED).toBe(9);
  });
});

describe("asking about a brick of Att lägga, which is no lesson yet", () => {
  const brick = { academicYearId: "y", studentGroupId: "g", subjectId: "s", minutes: 60, teacherId: "t", recurrence: "ALL_WEEKS" as const };

  it("names the brick and no lesson: the gateway takes exactly one of them", async () => {
    post.mockResolvedValue(TIMES);
    await askPossibleTimes(brick);
    expect(post).toHaveBeenCalledWith(
      "/api/v1/master-lessons/possible-times",
      { brick, from: "07:00", to: "18:00", stepMinutes: 5, limit: NUMBERED },
      undefined,
    );
    expect(post.mock.calls[0]![1]).not.toHaveProperty("lessonId");
  });

  it("asks which rooms the brick can have at a day and a clock in the same way, and a lesson as before", async () => {
    post.mockResolvedValue({ rooms: [] });
    await askRoomChoices(brick, 2, "09:00");
    expect(post).toHaveBeenLastCalledWith("/api/v1/master-lessons/room-choices", { brick, dayOfWeek: 2, startTime: "09:00" }, undefined);
    await askRoomChoices("a", 2, "09:00");
    expect(post).toHaveBeenLastCalledWith("/api/v1/master-lessons/room-choices", { lessonId: "a", dayOfWeek: 2, startTime: "09:00" }, undefined);
  });
});

describe("reading the answer", () => {
  it("finds the run a start lies in, the first and the last start of it included", () => {
    expect(runAt(TIMES, 1, 480)?.kind).toBe("FREE");
    expect(runAt(TIMES, 1, 525)?.kind).toBe("FREE");
    expect(runAt(TIMES, 1, 540)?.kind).toBe("STANDS");
    expect(runAt(TIMES, 1, 555)).toMatchObject({ kind: "IN_THE_WAY", blockerId: "b" });
    expect(runAt(TIMES, 1, 700)).toMatchObject({ kind: "CLOSED", code: "LUNCH" });
    expect(runAt(TIMES, 3, 630)?.kind).toBe("CHANGE");
  });

  it("has no run where the lesson cannot start at all, nor on a day it was not asked about", () => {
    expect(runAt(TIMES, 1, 530)).toBeNull();
    expect(runAt(TIMES, 1, 100)).toBeNull();
    expect(runAt(TIMES, 4, 600)).toBeNull();
  });

  it("finds a numbered time by its start and by its number", () => {
    expect(optionAt(TIMES, 2, 480)?.rank).toBe(1);
    expect(optionAt(TIMES, 2, 490)).toBeNull();
    expect(optionNumbered(TIMES, 3)).toMatchObject({ dayOfWeek: 3, startMinutes: 600, roomChanged: true });
    expect(optionNumbered(TIMES, 4)).toBeNull();
  });
});

describe("the store of the lesson in hand", () => {
  it("knows the answer only for the lesson it was asked for, and only once it has come", () => {
    possibleStore.set({ lessonId: "a", status: "loading" });
    expect(possibleOf("a")).toBeNull();
    possibleStore.set({ lessonId: "a", status: "done", times: TIMES });
    expect(possibleOf("a")).toBe(TIMES);
    expect(possibleOf("b")).toBeNull();
    possibleStore.set({ lessonId: "a", status: "failed" });
    expect(possibleOf("a")).toBeNull();
  });

  it("tells whoever follows it, once for each change, and stops when they stop", () => {
    const heard = vi.fn();
    const stop = possibleStore.subscribe(heard);
    possibleStore.set({ lessonId: "a", status: "loading" });
    possibleStore.set(null);
    expect(heard).toHaveBeenCalledTimes(2);
    stop();
    possibleStore.set({ lessonId: "a", status: "loading" });
    expect(heard).toHaveBeenCalledTimes(2);
  });
});
