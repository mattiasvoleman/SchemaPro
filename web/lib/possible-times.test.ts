import { beforeEach, describe, expect, it, vi } from "vitest";
import { TIMES } from "./possible-times.fixture";
import { askPossibleTimes, askRoomChoices, NUMBERED, optionAt, optionNumbered, roomAt, runAt, type PossibleTimes } from "./possible-times";
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

describe("the room a start was judged in", () => {
  it("is the room of the numbered time there when that is another than the lesson's own, and of the stretch of another room otherwise", () => {
    // 3: Wednesday 10:00, a numbered time in room r2. Wednesday 10:30 is in the same stretch of another room, not numbered.
    expect(roomAt(TIMES, "a", 3, 600)).toBe("r2");
    expect(roomAt(TIMES, "a", 3, 630)).toBe("r2");
  });

  it("is undefined for a time in the lesson's own room, for a square the gateway has no answer for, and for a stretch that names no room", () => {
    expect(roomAt(TIMES, "a", 2, 480)).toBeUndefined();
    expect(roomAt(TIMES, "a", 2, 495)).toBeUndefined();
    expect(roomAt(TIMES, "a", 5, 480)).toBeUndefined();
    // A gateway older than the web names no room for the stretch: the page's own check is left to say what it can.
    const bare = { ...TIMES, days: TIMES.days.map((day) => ({ ...day, runs: day.runs.map(({ rooms: _rooms, ...run }) => run) })) };
    expect(roomAt(bare, "a", 3, 630)).toBeUndefined();
    // A lesson the run does not name gets no room from it.
    expect(roomAt(TIMES, "b", 3, 630)).toBeUndefined();
  });

  it("is found for a brick under the empty id the gateway gives it, asked with the brick's own id", () => {
    // A brick is not a lesson yet: the answer has `subject.lessonId` null and names its room under "" (src/calendar/possible-times.service.ts).
    const brick: PossibleTimes = {
      ...TIMES,
      subject: { ...TIMES.subject, lessonId: null, lessonIds: [], unplaced: true, current: null },
      options: TIMES.options.map((option) => ({ ...option, lessons: option.lessons.map((entry) => ({ ...entry, lessonId: "" })) })),
      days: TIMES.days.map((day) => ({ ...day, runs: day.runs.map((run) => (run.rooms ? { ...run, rooms: run.rooms.map((entry) => ({ ...entry, lessonId: "" })) } : run)) })),
    };
    // The numbered time in room r2 and the stretch of another room round it, as for a lesson.
    expect(roomAt(brick, "tray-1", 3, 600)).toBe("r2");
    expect(roomAt(brick, "tray-1", 3, 630)).toBe("r2");
    // And a time in the brick's own room has none.
    expect(roomAt(brick, "tray-1", 2, 480)).toBeUndefined();
    // The same answer asked for a lesson of the answer's own id finds nothing under it: it is not that lesson's.
    expect(roomAt({ ...brick, subject: { ...brick.subject, lessonId: "a" } }, "a", 3, 630)).toBeUndefined();
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
