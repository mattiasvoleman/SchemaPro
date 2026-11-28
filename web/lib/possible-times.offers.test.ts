import { beforeEach, describe, expect, it, vi } from "vitest";
import { TIMES } from "./possible-times.fixture";
import { letsStartAt, OFFER_WAIT_MS, startsTheGatewayLets } from "./possible-times";
import { possibleStore, RELEASED_FOR_MS } from "./possible-store";

const post = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api", () => ({ api: { post } }));

beforeEach(() => {
  post.mockReset();
  possibleStore.set(null);
});

describe("the starts the dialog of other times may offer", () => {
  it("are the starts the gateway calls free, and the lesson's own square", () => {
    const lets = letsStartAt(TIMES);
    // Tuesday 08:00 to 09:30: free. Monday 09:00 is where the lesson stands.
    expect(lets(2, 480)).toBe(true);
    expect(lets(2, 570)).toBe(true);
    expect(lets(1, 540)).toBe(true);
  });

  it("are not a start another school holds, a rule shuts, a lesson is in, several hold, or that is free only in another room", () => {
    const lets = letsStartAt(TIMES);
    expect(lets(2, 585)).toBe(false); // OTHER_SCHOOL
    expect(lets(1, 420)).toBe(false); // FRAME
    expect(lets(1, 675)).toBe(false); // LUNCH
    expect(lets(1, 570)).toBe(false); // IN_THE_WAY
    expect(lets(1, 630)).toBe(false); // CROWDED
    expect(lets(3, 630)).toBe(false); // CHANGE: the dialog moves the lesson in its own room
  });

  it("judge nothing the answer does not: a start it has no run for, and the answer for a unit of several lessons", () => {
    expect(letsStartAt(TIMES)(5, 480)).toBe(true);
    const block = { ...TIMES, subject: { ...TIMES.subject, lessonIds: ["a", "b"] } };
    expect(letsStartAt(block)(2, 585)).toBe(true);
  });
});

describe("asking the gateway for them", () => {
  it("reads the answer the board already holds for the lesson, and asks nothing", async () => {
    possibleStore.set({ lessonId: "a", status: "done", times: TIMES });
    const lets = await startsTheGatewayLets("a");
    expect(lets(2, 585)).toBe(false);
    expect(post).not.toHaveBeenCalled();
  });

  it("asks the gateway for the lesson when the board holds none", async () => {
    post.mockResolvedValue(TIMES);
    const lets = await startsTheGatewayLets("a");
    expect(post).toHaveBeenCalledTimes(1);
    expect(post.mock.calls[0]![1]).toMatchObject({ lessonId: "a" });
    expect(lets(2, 585)).toBe(false);
    expect(lets(2, 480)).toBe(true);
  });

  it("lets every start through when the gateway has no answer: it fails, it answers something that is not its shape, or it does not answer in time", async () => {
    post.mockRejectedValue(new Error("502"));
    expect((await startsTheGatewayLets("a"))(2, 585)).toBe(true);
    for (const odd of [undefined, null, {}, { days: [] }, "<html>"]) {
      post.mockResolvedValue(odd);
      expect((await startsTheGatewayLets("a"))(2, 585), String(odd)).toBe(true);
    }
    vi.useFakeTimers();
    try {
      post.mockImplementation((_path: string, _body: unknown, signal?: AbortSignal) => new Promise((_resolve, reject) => signal?.addEventListener("abort", () => reject(new Error("aborted")))));
      const waiting = startsTheGatewayLets("a");
      await vi.advanceTimersByTimeAsync(OFFER_WAIT_MS);
      expect((await waiting)(2, 585)).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("lets every start through when the client throws before it asks", async () => {
    post.mockImplementation(() => {
      throw new Error("not a function");
    });
    expect((await startsTheGatewayLets("a"))(2, 585)).toBe(true);
  });
});

describe("the answer of a lesson that was let go a moment ago", () => {
  it("is read by the dialog of other times for a few seconds, for that lesson only, and asked for again after them", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-11-28T10:00:00Z"));
      possibleStore.set({ lessonId: "a", status: "done", times: TIMES });
      possibleStore.release();
      expect(possibleStore.get()).toBeNull();
      vi.setSystemTime(Date.now() + 200);
      expect((await startsTheGatewayLets("a"))(2, 585)).toBe(false);
      expect(post).not.toHaveBeenCalled();
      // Another lesson's answer is none of this one's: it is asked for.
      post.mockResolvedValue(TIMES);
      await startsTheGatewayLets("z");
      expect(post).toHaveBeenCalledTimes(1);
      post.mockClear();
      // And a lesson let go long ago is asked for again.
      vi.setSystemTime(Date.now() + RELEASED_FOR_MS + 1);
      await startsTheGatewayLets("a");
      expect(post).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("is not kept for a lesson that had no answer when it was let go", async () => {
    possibleStore.set({ lessonId: "a", status: "loading" });
    possibleStore.release();
    post.mockResolvedValue(TIMES);
    await startsTheGatewayLets("a");
    expect(post).toHaveBeenCalledTimes(1);
  });
});
