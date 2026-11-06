import { describe, expect, it, vi } from "vitest";
import { ApiError } from "@/lib/api";
import type { MarkInput, MarkResult } from "@/lib/crisis-types";
import { MAX_MARKS_PER_CALL } from "./crisis-view";
import {
  QUEUE_KEY,
  SNAPSHOT_KEY,
  SNAPSHOT_MAX_AGE_MS,
  UNRESOLVED,
  applyQueue,
  classify,
  flushMarks,
  loadQueue,
  loadSnapshot,
  pendingKey,
  saveQueue,
  saveSnapshot,
  skewOf,
} from "./crisis-queue";
import { mine, myAlarm, myCall, pupil } from "./__fixtures__/crisis";

/** A storage in memory, with the three calls the queue makes. */
function memory(initial: Record<string, string> = {}) {
  const items = new Map(Object.entries(initial));
  return {
    items,
    getItem: (key: string) => items.get(key) ?? null,
    setItem: (key: string, value: string) => void items.set(key, value),
    removeItem: (key: string) => void items.delete(key),
  };
}

/** A storage that throws on every use: a private window, blocked site data, a full quota. */
const hostile = {
  getItem: () => {
    throw new Error("SecurityError");
  },
  setItem: () => {
    throw new Error("QuotaExceededError");
  },
  removeItem: () => {
    throw new Error("SecurityError");
  },
};

const mark = (id: string, studentId: string, state: MarkInput["state"] = "FOUND", at = "2027-01-12T09:20:00.000Z", callId = "c-1"): MarkInput => ({
  id,
  callId,
  studentId,
  state,
  at,
});
const ok = (extra: Partial<MarkResult> = {}): MarkResult => ({ stored: 0, duplicates: 0, unresolved: [], ...extra });
const refuse = (status: number, code?: string) => new ApiError(status, "no", code);

describe("what the page remembers", () => {
  it("keeps the queue and reads it back, oldest first", () => {
    const store = memory();
    expect(saveQueue([mark("m1", "s1"), mark("m2", "s2", "MISSING")], store)).toBe(true);
    expect(loadQueue(store).map((one) => one.id)).toEqual(["m1", "m2"]);
  });

  it("forgets an empty queue rather than keeping '[]'", () => {
    const store = memory({ [QUEUE_KEY]: "[]" });
    saveQueue([], store);
    expect(store.items.has(QUEUE_KEY)).toBe(false);
  });

  it("reads whatever in the storage is not a mark as nothing, and a broken value as an empty queue", () => {
    expect(loadQueue(memory({ [QUEUE_KEY]: JSON.stringify([mark("m1", "s1"), { id: 3 }, "x", null, { ...mark("m2", "s2"), state: "UNKNOWN" }]) }))).toHaveLength(1);
    expect(loadQueue(memory({ [QUEUE_KEY]: "{not json" }))).toEqual([]);
    expect(loadQueue(memory({ [QUEUE_KEY]: '{"a":1}' }))).toEqual([]);
    expect(loadQueue(memory())).toEqual([]);
  });

  it("works without a storage at all: a private window, blocked site data, a full quota", () => {
    expect(loadQueue(hostile)).toEqual([]);
    expect(saveQueue([mark("m1", "s1")], hostile)).toBe(false);
    expect(loadSnapshot(Date.now(), hostile)).toBeNull();
    expect(saveSnapshot({ data: mine([]), receivedAt: Date.now() }, hostile)).toBe(false);
    expect(loadQueue(null)).toEqual([]);
    expect(saveQueue([mark("m1", "s1")], null)).toBe(false);
  });

  it("keeps the last list and shows it again, unless it is hours old or from the future", () => {
    const now = Date.parse("2027-01-12T10:00:00.000Z");
    const store = memory();
    saveSnapshot({ data: mine([myAlarm([])]), receivedAt: now - 60_000 }, store);
    expect(loadSnapshot(now, store)?.data.alarms).toHaveLength(1);
    expect(loadSnapshot(now + SNAPSHOT_MAX_AGE_MS, store)).toBeNull();
    expect(loadSnapshot(now - 10 * 60_000, store)).toBeNull();
    expect(loadSnapshot(now, memory({ [SNAPSHOT_KEY]: JSON.stringify({ receivedAt: now, data: { asOf: 1 } }) }))).toBeNull();
    expect(loadSnapshot(now, memory({ [SNAPSHOT_KEY]: "nope" }))).toBeNull();
  });

  it("tells how far the gateway's clock was from the device's when the list came", () => {
    const snapshot = { data: mine([], "2027-01-12T09:20:05.000Z"), receivedAt: Date.parse("2027-01-12T09:20:00.000Z") };
    expect(skewOf(snapshot)).toBe(5_000);
    expect(skewOf(null)).toBe(0);
  });
});

describe("the list with the queue laid over it", () => {
  const base = mine([
    myAlarm([
      myCall("c-1", "7A", [pupil("s1", "Ines", "Ek"), pupil("s2", "Jamal", "Ali", "FOUND"), pupil("s3", "Klara", "Nyman", "ABSENT_BEFORE")]),
      myCall("c-2", "7B", [pupil("s1", "Maja", "Ek")]),
    ]),
  ]);

  it("shows a queued mark on its pupil in its group only, counted so, and says it is waiting", () => {
    const { data, pending } = applyQueue(base, [mark("m1", "s1", "MISSING")]);
    const [sevenA, sevenB] = data.alarms[0]!.calls;
    expect(sevenA!.pupils.map((one) => one.status)).toEqual(["MISSING", "FOUND", "ABSENT_BEFORE"]);
    expect(sevenA!.counts).toMatchObject({ found: 1, missing: 1, absentBefore: 1, unreported: 0 });
    // The same pupil id in another group is another row.
    expect(sevenB!.pupils[0]!.status).toBe("UNREPORTED");
    expect([...pending]).toEqual([pendingKey("c-1", "s1")]);
  });

  it("lets a mark overrule 'absent before', as the gateway's lists do", () => {
    const { data } = applyQueue(base, [mark("m1", "s3", "FOUND")]);
    expect(data.alarms[0]!.calls[0]!.pupils[2]!.status).toBe("FOUND");
    expect(data.alarms[0]!.calls[0]!.counts.absentBefore).toBe(0);
  });

  it("takes the latest of several marks for a pupil, by the time they were made", () => {
    const { data } = applyQueue(base, [
      mark("m2", "s1", "FOUND", "2027-01-12T09:25:00.000Z"),
      mark("m1", "s1", "MISSING", "2027-01-12T09:21:00.000Z"),
    ]);
    expect(data.alarms[0]!.calls[0]!.pupils[0]).toMatchObject({ status: "FOUND", markedAt: "2027-01-12T09:25:00.000Z" });
  });

  it("is the list itself when nothing is queued, or the queue names nobody on it", () => {
    expect(applyQueue(base, []).data).toBe(base);
    expect(applyQueue(base, [mark("m1", "s9")]).pending.size).toBe(0);
  });

  it("does not touch the list it was given", () => {
    const before = JSON.stringify(base);
    applyQueue(base, [mark("m1", "s1", "MISSING")]);
    expect(JSON.stringify(base)).toBe(before);
  });
});

describe("what a failure means", () => {
  it("is final when the gateway answered no to the mark: refused, not yours, not found, ended, or too big", () => {
    for (const status of [400, 403, 404, 409, 410, 413, 422]) {
      expect(classify(refuse(status, "CRISIS_ALARM_ENDED"))).toEqual({ kind: "permanent", code: "CRISIS_ALARM_ENDED" });
    }
    expect(classify(refuse(400))).toEqual({ kind: "permanent", code: "HTTP_400" });
  });

  it("is not final when the network, the session or the gateway could not answer", () => {
    for (const error of [new TypeError("Failed to fetch"), new DOMException("aborted", "AbortError"), new Error("timeout"), refuse(0), refuse(401), refuse(408), refuse(429), refuse(500), refuse(502), refuse(503)]) {
      expect(classify(error)).toEqual({ kind: "transient" });
    }
  });
});

describe("sending what is queued", () => {
  it("sends it in one call and clears it, whether it was stored or was there already", async () => {
    const send = vi.fn(async () => ok({ stored: 1, duplicates: 1 }));
    const result = await flushMarks([mark("m1", "s1"), mark("m2", "s2")], send);
    expect(send).toHaveBeenCalledTimes(1);
    expect(result.sent.map((one) => one.id)).toEqual(["m1", "m2"]);
    expect(result.dropped).toEqual([]);
    expect(result.unsent).toEqual([]);
  });

  it("sends nothing for an empty queue", async () => {
    const send = vi.fn(async () => ok());
    expect(await flushMarks([], send)).toEqual({ sent: [], dropped: [], unsent: [] });
    expect(send).not.toHaveBeenCalled();
  });

  it("splits the queue at what a call may carry", async () => {
    const queue = Array.from({ length: MAX_MARKS_PER_CALL * 2 + 5 }, (_, index) => mark(`m${index}`, `s${index}`));
    const sizes: number[] = [];
    const result = await flushMarks(queue, async (marks) => {
      sizes.push(marks.length);
      return ok();
    });
    expect(sizes).toEqual([MAX_MARKS_PER_CALL, MAX_MARKS_PER_CALL, 5]);
    expect(result.sent).toHaveLength(queue.length);
  });

  it("keeps everything when the network does not answer, and tries nothing after the first miss", async () => {
    const send = vi.fn(async () => {
      throw new TypeError("Failed to fetch");
    });
    const queue = Array.from({ length: MAX_MARKS_PER_CALL + 1 }, (_, index) => mark(`m${index}`, `s${index}`));
    const result = await flushMarks(queue, send);
    expect(send).toHaveBeenCalledTimes(1);
    expect(result.sent).toEqual([]);
    expect(result.dropped).toEqual([]);
    expect(result.unsent).toHaveLength(queue.length);
  });

  it("keeps the marks of a gateway that is overloaded or asleep (429, 500, 401), as it keeps those of a dead network", async () => {
    for (const error of [refuse(429), refuse(500), refuse(401)]) {
      const result = await flushMarks([mark("m1", "s1")], async () => {
        throw error;
      });
      expect(result.unsent).toHaveLength(1);
    }
  });

  it("throws away the marks the alarm no longer takes, and says why", async () => {
    const result = await flushMarks([mark("m1", "s1"), mark("m2", "s2")], async () => {
      throw refuse(409, "CRISIS_ALARM_ENDED");
    });
    expect(result.sent).toEqual([]);
    expect(result.unsent).toEqual([]);
    expect(result.dropped.map((one) => [one.mark.id, one.code])).toEqual([
      ["m1", "CRISIS_ALARM_ENDED"],
      ["m2", "CRISIS_ALARM_ENDED"],
    ]);
  });

  it("finds the one refused mark of a batch by halving it, so the others still arrive", async () => {
    // The gateway stores a batch in one transaction: a pupil who is not on the list refuses the lot.
    const queue = Array.from({ length: 7 }, (_, index) => mark(`m${index}`, `s${index}`));
    const calls: string[][] = [];
    const result = await flushMarks(queue, async (marks) => {
      calls.push(marks.map((one) => one.id));
      if (marks.some((one) => one.id === "m4")) throw refuse(400, "CRISIS_MARK_INVALID");
      return ok({ stored: marks.length });
    });
    expect(result.dropped.map((one) => [one.mark.id, one.code])).toEqual([["m4", "CRISIS_MARK_INVALID"]]);
    expect(result.sent.map((one) => one.id).sort()).toEqual(["m0", "m1", "m2", "m3", "m5", "m6"]);
    expect(result.unsent).toEqual([]);
    // Not a call per mark: the clean halves went whole.
    expect(calls.length).toBeLessThan(queue.length * 2);
  });

  it("drops a whole group at once when the refusal is about the group, one call per group and not per mark", async () => {
    const queue = [
      mark("m1", "s1", "FOUND", undefined, "c-gone"),
      mark("m2", "s2", "FOUND", undefined, "c-gone"),
      mark("m3", "s3", "FOUND", undefined, "c-gone"),
      mark("m4", "s4", "FOUND", undefined, "c-live"),
    ];
    const send = vi.fn(async (marks: MarkInput[]) => {
      if (marks.some((one) => one.callId === "c-gone")) throw refuse(403, "CRISIS_NOT_YOURS");
      return ok({ stored: marks.length });
    });
    const result = await flushMarks(queue, send);
    expect(result.dropped.map((one) => one.mark.id)).toEqual(["m1", "m2", "m3"]);
    expect(result.dropped.every((one) => one.code === "CRISIS_NOT_YOURS")).toBe(true);
    expect(result.sent.map((one) => one.id)).toEqual(["m4"]);
    // The whole batch, then c-gone's marks together, then c-live's.
    expect(send).toHaveBeenCalledTimes(3);
  });

  it("stops where the network gives out while isolating a refused mark, and keeps what it did not reach", async () => {
    const queue = Array.from({ length: 4 }, (_, index) => mark(`m${index}`, `s${index}`));
    let calls = 0;
    const result = await flushMarks(queue, async (marks) => {
      calls += 1;
      if (calls === 1) throw refuse(400, "CRISIS_MARK_INVALID");
      if (calls === 2) return ok({ stored: marks.length });
      throw new TypeError("Failed to fetch");
    });
    expect(result.sent.map((one) => one.id)).toEqual(["m0", "m1"]);
    expect(result.unsent.map((one) => one.id)).toEqual(["m2", "m3"]);
    expect(result.dropped).toEqual([]);
  });

  it("drops the marks the gateway says belong to no alarm of the teacher's, and keeps the rest", async () => {
    const result = await flushMarks([mark("m1", "s1"), mark("m2", "s2")], async () => ok({ stored: 1, unresolved: ["m2"] }));
    expect(result.sent.map((one) => one.id)).toEqual(["m1"]);
    expect(result.dropped).toEqual([{ mark: expect.objectContaining({ id: "m2" }), code: UNRESOLVED }]);
  });
});
