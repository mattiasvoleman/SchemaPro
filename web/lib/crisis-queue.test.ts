import { describe, expect, it, vi } from "vitest";
import { ApiError } from "@/lib/api";
import type { MarkResult, PupilName, QueuedMark } from "@/lib/crisis-types";
import { MAX_MARKS_PER_CALL } from "./crisis-view";
import {
  LEGACY_KEYS,
  SNAPSHOT_MAX_AGE_MS,
  UNRESOLVED,
  applyQueue,
  classify,
  flushMarks,
  forgetLegacy,
  loadQueue,
  loadSnapshot,
  pendingKey,
  queueKey,
  saveQueue,
  saveSnapshot,
  skewOf,
  snapshotKey,
} from "./crisis-queue";
import { foundHere, mine, myAlarm, myCall, pupil } from "./__fixtures__/crisis";

const ME = "u-me";
const QUEUE_KEY = queueKey(ME);
const SNAPSHOT_KEY = snapshotKey(ME);

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

const mark = (id: string, studentId: string, state: QueuedMark["state"] = "FOUND", at = "2027-01-12T09:20:00.000Z", callId = "c-1"): QueuedMark => ({
  id,
  callId,
  studentId,
  state,
  at,
});
/** A mark made with no group: the alarm's own. */
const freeMark = (id: string, studentId: string, state: QueuedMark["state"] = "FOUND", at = "2027-01-12T09:20:00.000Z", alarmId = "a-1"): QueuedMark => ({
  id,
  alarmId,
  studentId,
  state,
  at,
});
const named = (made: QueuedMark, pupilName: PupilName): QueuedMark => ({ ...made, pupil: pupilName });
const NILS: PupilName = { firstName: "Nils", lastName: "Holm", className: "9C" };
const OLGA: PupilName = { firstName: "Olga", lastName: "Dahl", className: null };
const ok = (extra: Partial<MarkResult> = {}): MarkResult => ({ stored: 0, duplicates: 0, unresolved: [], ...extra });
const refuse = (status: number, code?: string) => new ApiError(status, "no", code);

describe("what the page remembers", () => {
  it("keeps the queue and reads it back, oldest first", () => {
    const store = memory();
    expect(saveQueue(ME, [mark("m1", "s1"), mark("m2", "s2", "MISSING")], store)).toBe(true);
    expect(loadQueue(ME, store).map((one) => one.id)).toEqual(["m1", "m2"]);
  });

  it("forgets an empty queue rather than keeping '[]'", () => {
    const store = memory({ [QUEUE_KEY]: "[]" });
    saveQueue(ME, [], store);
    expect(store.items.has(QUEUE_KEY)).toBe(false);
  });

  it("reads whatever in the storage is not a mark as nothing, and a broken value as an empty queue", () => {
    expect(loadQueue(ME, memory({ [QUEUE_KEY]: JSON.stringify([mark("m1", "s1"), { id: 3 }, "x", null, { ...mark("m2", "s2"), state: "UNKNOWN" }]) }))).toHaveLength(1);
    expect(loadQueue(ME, memory({ [QUEUE_KEY]: "{not json" }))).toEqual([]);
    expect(loadQueue(ME, memory({ [QUEUE_KEY]: '{"a":1}' }))).toEqual([]);
    expect(loadQueue(ME, memory())).toEqual([]);
  });

  it("keeps a find with the name and class it carries, and one made with no group by the alarm, and nothing that names both or neither", () => {
    const store = memory();
    const queue = [named(mark("m1", "s8"), NILS), freeMark("m2", "s9"), named(freeMark("m3", "s7", "RETRACTED"), OLGA)];
    saveQueue(ME, queue, store);
    expect(loadQueue(ME, store)).toEqual(queue);
    const odd = [{ ...mark("m4", "s1"), alarmId: "a-1" }, { id: "m5", studentId: "s1", state: "FOUND", at: "2027-01-12T09:20:00.000Z" }, { ...mark("m6", "s1"), pupil: { firstName: 1 } }, mark("m7", "s1", "AWAY")];
    expect(loadQueue(ME, memory({ [QUEUE_KEY]: JSON.stringify(odd) })).map((one) => one.id)).toEqual(["m7"]);
  });

  it("never writes a roster of the school's pupils to the device, nor reads one back: the list is what the gateway gave this teacher", () => {
    const roster = [{ studentId: "s99", firstName: "Zeb", lastName: "Wall", className: "9C" }];
    const withRoster = { data: mine([{ ...myAlarm([myCall("c-1", "7A", [pupil("s1", "Ines", "Ek")])]), others: roster } as never]), receivedAt: Date.now() - 60_000 };
    const store = memory();
    saveSnapshot(ME, withRoster, store);
    expect(store.items.get(SNAPSHOT_KEY)).not.toContain("others");
    expect(store.items.get(SNAPSHOT_KEY)).not.toContain("Zeb");
    expect(store.items.get(SNAPSHOT_KEY)).toContain("7A");
    // One an earlier version wrote is read without it.
    const older = memory({ [SNAPSHOT_KEY]: JSON.stringify(withRoster) });
    expect(JSON.stringify(loadSnapshot(ME, Date.now(), older))).not.toContain("others");
    expect(loadSnapshot(ME, Date.now(), older)?.data.alarms[0]?.calls).toHaveLength(1);
  });

  it("works without a storage at all: a private window, blocked site data, a full quota", () => {
    expect(loadQueue(ME, hostile)).toEqual([]);
    expect(saveQueue(ME, [mark("m1", "s1")], hostile)).toBe(false);
    expect(loadSnapshot(ME, Date.now(), hostile)).toBeNull();
    expect(saveSnapshot(ME, { data: mine([]), receivedAt: Date.now() }, hostile)).toBe(false);
    expect(loadQueue(ME, null)).toEqual([]);
    expect(saveQueue(ME, [mark("m1", "s1")], null)).toBe(false);
    expect(() => forgetLegacy(hostile)).not.toThrow();
  });

  it("keeps the last list and shows it again, unless it is hours old or from the future", () => {
    const now = Date.parse("2027-01-12T10:00:00.000Z");
    const store = memory();
    saveSnapshot(ME, { data: mine([myAlarm([])]), receivedAt: now - 60_000 }, store);
    expect(loadSnapshot(ME, now, store)?.data.alarms).toHaveLength(1);
    expect(loadSnapshot(ME, now + SNAPSHOT_MAX_AGE_MS, store)).toBeNull();
    expect(loadSnapshot(ME, now - 10 * 60_000, store)).toBeNull();
    expect(loadSnapshot(ME, now, memory({ [SNAPSHOT_KEY]: JSON.stringify({ receivedAt: now, data: { asOf: 1 } }) }))).toBeNull();
    expect(loadSnapshot(ME, now, memory({ [SNAPSHOT_KEY]: "nope" }))).toBeNull();
  });

  it("tells how far the gateway's clock was from the device's when the list came", () => {
    const snapshot = { data: mine([], "2027-01-12T09:20:05.000Z"), receivedAt: Date.parse("2027-01-12T09:20:00.000Z") };
    expect(skewOf(snapshot)).toBe(5_000);
    expect(skewOf(null)).toBe(0);
  });
});

describe("whose queue and list these are: one browser, several logins", () => {
  const now = Date.parse("2027-01-12T10:00:00.000Z");
  const list = (label: string) => ({ data: mine([myAlarm([myCall("c-1", label, [pupil("s1", "Ines", "Ek")])])]), receivedAt: now - 60_000 });

  it("keeps each login's marks and list apart in the one storage, and reads and sends only the signed-in login's", () => {
    const store = memory();
    saveQueue("u-anna", [mark("m-anna", "s1")], store);
    saveQueue("u-bo", [mark("m-bo", "s2"), mark("m-bo-2", "s3")], store);
    saveSnapshot("u-anna", list("7A"), store);
    saveSnapshot("u-bo", list("8B"), store);

    expect(loadQueue("u-anna", store).map((one) => one.id)).toEqual(["m-anna"]);
    expect(loadQueue("u-bo", store).map((one) => one.id)).toEqual(["m-bo", "m-bo-2"]);
    expect(loadSnapshot("u-anna", now, store)?.data.alarms[0]?.calls[0]?.groupName).toBe("7A");
    expect(loadSnapshot("u-bo", now, store)?.data.alarms[0]?.calls[0]?.groupName).toBe("8B");
    // A third login finds nothing, and what it saves is its own.
    expect(loadQueue("u-cia", store)).toEqual([]);
    expect(loadSnapshot("u-cia", now, store)).toBeNull();
    saveQueue("u-anna", [], store);
    expect(loadQueue("u-bo", store)).toHaveLength(2);
    expect(store.items.has(queueKey("u-anna"))).toBe(false);
  });

  it("puts nothing of a login under the keys of another, or of the first version", () => {
    expect(new Set([queueKey("a"), queueKey("b"), snapshotKey("a"), snapshotKey("b"), ...LEGACY_KEYS]).size).toBe(6);
    expect(queueKey("a")).toMatch(/^rastra\.crisis\./);
  });

  it("does not read the first version's un-keyed queue and list as anybody's, and removes them when it sees them", () => {
    const store = memory({
      [LEGACY_KEYS[0]]: JSON.stringify([mark("m-old", "s1")]),
      [LEGACY_KEYS[1]]: JSON.stringify(list("7A")),
    });
    expect(loadQueue(ME, store)).toEqual([]);
    expect(loadSnapshot(ME, now, store)).toBeNull();
    forgetLegacy(store);
    expect(store.items.size).toBe(0);
    // Another login's current keys are not touched by it.
    const other = memory({ [queueKey("u-bo")]: JSON.stringify([mark("m-bo", "s2")]), [LEGACY_KEYS[0]]: "[]" });
    forgetLegacy(other);
    expect([...other.items.keys()]).toEqual([queueKey("u-bo")]);
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

  describe("a pupil found who is not on the group's list (found with me)", () => {
    // No roster of the school is held anywhere: the mark itself carries the name and class that draw the row.
    const elsewhere = mine([myAlarm([myCall("c-1", "7A", [pupil("s1", "Ines", "Ek")]), myCall("c-2", "7B", [pupil("s2", "Maja", "Ek")])])]);

    it("lists the pupil under the group by the name the mark carries, waiting, and counts nobody on the group's own list for it", () => {
      const { data, pending } = applyQueue(elsewhere, [named(mark("m1", "s8", "FOUND", "2027-01-12T09:22:00.000Z", "c-1"), NILS)]);
      const [sevenA, sevenB] = data.alarms[0]!.calls;
      expect(sevenA!.foundHere).toEqual([{ studentId: "s8", firstName: "Nils", lastName: "Holm", className: "9C", markedAt: "2027-01-12T09:22:00.000Z" }]);
      expect(sevenB!.foundHere).toEqual([]);
      expect(sevenA!.counts).toEqual(elsewhere.alarms[0]!.calls[0]!.counts);
      expect(sevenA!.pupils).toEqual(elsewhere.alarms[0]!.calls[0]!.pupils);
      expect([...pending]).toEqual([pendingKey("c-1", "s8")]);
    });

    it("never shows a missing mark for a pupil who is not on the list: the gateway refuses it, and it is not a find", () => {
      const { data, pending } = applyQueue(elsewhere, [named(mark("m1", "s8", "MISSING", undefined, "c-1"), NILS)]);
      expect(data.alarms[0]!.calls[0]!.foundHere).toEqual([]);
      expect(pending.size).toBe(0);
    });

    it("does not list the pupil twice when the gateway's list already has them, and draws nothing for a mark that carries no name", () => {
      const had = mine([myAlarm([myCall("c-1", "7A", [pupil("s1", "Ines", "Ek")], { foundHere: [foundHere("s8", "Nils", "Holm", "9C")] })])]);
      const { data } = applyQueue(had, [named(mark("m1", "s8", "FOUND", undefined, "c-1"), NILS), mark("m2", "s-unknown", "FOUND", undefined, "c-1")]);
      expect(data.alarms[0]!.calls[0]!.foundHere.map((one) => one.studentId)).toEqual(["s8"]);
    });

    it("keeps the pupils the gateway listed and adds the queued ones after them, and reads a list from a gateway without the field as empty", () => {
      const had = mine([myAlarm([myCall("c-1", "7A", [pupil("s1", "Ines", "Ek")], { foundHere: [foundHere("s8", "Nils", "Holm", "9C")] })])]);
      const { data } = applyQueue(had, [named(mark("m1", "s9", "FOUND", undefined, "c-1"), OLGA)]);
      expect(data.alarms[0]!.calls[0]!.foundHere.map((one) => one.studentId)).toEqual(["s8", "s9"]);
      const old = JSON.parse(JSON.stringify(elsewhere));
      delete old.alarms[0].foundFree;
      delete old.alarms[0].calls[0].foundHere;
      const applied = applyQueue(old, [named(mark("m1", "s8", "FOUND", undefined, "c-1"), NILS)]).data.alarms[0];
      expect(applied.calls[0].foundHere.map((one: { studentId: string }) => one.studentId)).toEqual(["s8"]);
      expect(applied.foundFree).toEqual([]);
    });

    it("takes a pupil the gateway lists away again at once, when a retraction is queued, and shows them again if they are found again", () => {
      const had = mine([myAlarm([myCall("c-1", "7A", [pupil("s1", "Ines", "Ek")], { foundHere: [foundHere("s8", "Nils", "Holm", "9C")] })])]);
      const taken = applyQueue(had, [mark("m1", "s8", "RETRACTED", "2027-01-12T09:25:00.000Z", "c-1")]);
      expect(taken.data.alarms[0]!.calls[0]!.foundHere).toEqual([]);
      const again = applyQueue(had, [
        mark("m1", "s8", "RETRACTED", "2027-01-12T09:25:00.000Z", "c-1"),
        named(mark("m2", "s8", "FOUND", "2027-01-12T09:26:00.000Z", "c-1"), NILS),
      ]);
      expect(again.data.alarms[0]!.calls[0]!.foundHere.map((one) => one.studentId)).toEqual(["s8"]);
      // Nothing of the found pupil is left to wait for in the rows once they are gone.
      expect(taken.pending.size).toBe(0);
    });

    it("lets a retraction touch no pupil on the group's own list: it takes back a find and nothing else", () => {
      const { data } = applyQueue(elsewhere, [mark("m1", "s1", "RETRACTED", undefined, "c-1")]);
      expect(data.alarms[0]!.calls[0]!.pupils[0]!.status).toBe("UNREPORTED");
      expect(data.alarms[0]!.calls[0]!.counts).toEqual(elsewhere.alarms[0]!.calls[0]!.counts);
    });
  });

  describe("a pupil found by a teacher with no group (the alarm's own)", () => {
    const noGroup = mine([myAlarm([], { foundFree: [foundHere("s7", "Pia", "Sten")] })]);

    it("lists the pupil under the alarm by the name the mark carries, waiting, and keeps the pupils the gateway listed", () => {
      const { data, pending } = applyQueue(noGroup, [named(freeMark("m1", "s8", "FOUND", "2027-01-12T09:22:00.000Z"), NILS)]);
      expect(data.alarms[0]!.foundFree.map((one) => [one.studentId, one.className])).toEqual([["s7", null], ["s8", "9C"]]);
      expect([...pending]).toEqual([pendingKey("a-1", "s8")]);
    });

    it("takes a pupil back off the alarm when a retraction is queued, and a retraction for another alarm touches nothing", () => {
      expect(applyQueue(noGroup, [freeMark("m1", "s7", "RETRACTED")]).data.alarms[0]!.foundFree).toEqual([]);
      expect(applyQueue(noGroup, [freeMark("m1", "s7", "RETRACTED", undefined, "a-2")]).data.alarms[0]!.foundFree).toHaveLength(1);
    });

    it("keeps a mark for a group and a mark for the alarm apart even for the same pupil", () => {
      const both = mine([myAlarm([myCall("c-1", "7A", [pupil("s1", "Ines", "Ek")])])]);
      const { data } = applyQueue(both, [named(mark("m1", "s8", "FOUND", undefined, "c-1"), NILS), named(freeMark("m2", "s9"), OLGA)]);
      expect(data.alarms[0]!.calls[0]!.foundHere.map((one) => one.studentId)).toEqual(["s8"]);
      expect(data.alarms[0]!.foundFree.map((one) => one.studentId)).toEqual(["s9"]);
    });
  });

  describe("a pupil the administration says is not in the building", () => {
    it("is shown so and counted for itself, never as found: not found, not missing, and not unreported", () => {
      const base = mine([myAlarm([myCall("c-1", "7A", [pupil("s1", "Ines", "Ek"), pupil("s2", "Jamal", "Ali")])])]);
      const { data } = applyQueue(base, [mark("m1", "s1", "AWAY")]);
      expect(data.alarms[0]!.calls[0]!.pupils[0]).toMatchObject({ status: "AWAY" });
      expect(data.alarms[0]!.calls[0]!.counts).toMatchObject({ found: 0, missing: 0, away: 1, unreported: 1 });
    });
  });

  it("does not touch the list it was given", () => {
    const before = JSON.stringify(base);
    applyQueue(base, [mark("m1", "s1", "MISSING")]);
    expect(JSON.stringify(base)).toBe(before);
  });
});

describe("what a failure means", () => {
  it("is final when the gateway answered no to the mark: refused, not yours, too big, or the alarm is gone or over", () => {
    for (const status of [400, 403, 410, 413, 422]) {
      expect(classify(refuse(status, "CRISIS_MARK_INVALID"))).toEqual({ kind: "permanent", code: "CRISIS_MARK_INVALID" });
    }
    expect(classify(refuse(400))).toEqual({ kind: "permanent", code: "HTTP_400" });
    expect(classify(refuse(403, "CRISIS_NOT_YOURS"))).toEqual({ kind: "permanent", code: "CRISIS_NOT_YOURS" });
    expect(classify(refuse(409, "CRISIS_ALARM_ENDED"))).toEqual({ kind: "permanent", code: "CRISIS_ALARM_ENDED" });
    expect(classify(refuse(404, "CRISIS_ALARM_NOT_FOUND"))).toEqual({ kind: "permanent", code: "CRISIS_ALARM_NOT_FOUND" });
  });

  it("is not final for a 404 or a 409 without the code that says why, as the phone's queue does not drop them either", () => {
    // A deadlock the gateway lost (409 WRITE_CONFLICT), a gateway without the route, a proxy's page.
    for (const error of [refuse(409, "WRITE_CONFLICT"), refuse(409), refuse(404), refuse(404, "NOT_FOUND"), refuse(404, "CRISIS_ALARM_ENDED"), refuse(409, "CRISIS_ALARM_NOT_FOUND")]) {
      expect(classify(error)).toEqual({ kind: "transient" });
    }
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

  it("keeps the marks of a request that lost a deadlock (409 WRITE_CONFLICT), whole and in order, and sends them again with the same ids", async () => {
    const queue = [mark("m1", "s1"), mark("m2", "s2"), mark("m3", "s3")];
    let answer: "conflict" | "ok" = "conflict";
    const sent: string[][] = [];
    const send = vi.fn(async (marks: QueuedMark[]) => {
      sent.push(marks.map((one) => one.id));
      if (answer === "conflict") throw refuse(409, "WRITE_CONFLICT");
      return ok({ stored: marks.length });
    });
    const first = await flushMarks(queue, send);
    expect(first.unsent.map((one) => one.id)).toEqual(["m1", "m2", "m3"]);
    expect(first.dropped).toEqual([]);
    // Not halved, not split: one call, and nothing after it is tried.
    expect(send).toHaveBeenCalledTimes(1);
    answer = "ok";
    const second = await flushMarks(first.unsent, send);
    expect(second.sent.map((one) => one.id)).toEqual(["m1", "m2", "m3"]);
    expect(sent).toEqual([["m1", "m2", "m3"], ["m1", "m2", "m3"]]);
  });

  it("keeps a mark answered with a 404 or a 409 that names no reason, as the phone does", async () => {
    for (const error of [refuse(404), refuse(409)]) {
      const result = await flushMarks([mark("m1", "s1")], async () => {
        throw error;
      });
      expect(result.unsent.map((one) => one.id)).toEqual(["m1"]);
      expect(result.dropped).toEqual([]);
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

  it("sends a find with no group the way it sends the others, and drops those of an alarm that is over together, one call per alarm", async () => {
    const queue = [freeMark("f1", "s1"), freeMark("f2", "s2"), freeMark("f3", "s3", "FOUND", undefined, "a-live")];
    const send = vi.fn(async (marks: QueuedMark[]) => {
      if (marks.some((one) => one.alarmId === "a-1")) throw refuse(409, "CRISIS_ALARM_ENDED");
      return ok({ stored: marks.length });
    });
    const result = await flushMarks(queue, send);
    expect(result.dropped.map((one) => [one.mark.id, one.code])).toEqual([["f1", "CRISIS_ALARM_ENDED"], ["f2", "CRISIS_ALARM_ENDED"]]);
    expect(result.sent.map((one) => one.id)).toEqual(["f3"]);
    // The whole batch, then a-1's two together, then a-live's.
    expect(send).toHaveBeenCalledTimes(3);
  });

  it("drops a retraction the gateway refuses (400 CRISIS_MARK_INVALID: nothing of the teacher's to take back) and keeps the others", async () => {
    const queue = [mark("r1", "s1", "RETRACTED"), mark("r2", "s2", "RETRACTED"), mark("m3", "s3")];
    const result = await flushMarks(queue, async (marks) => {
      if (marks.some((one) => one.id === "r1")) throw refuse(400, "CRISIS_MARK_INVALID");
      return ok({ stored: marks.length });
    });
    expect(result.dropped.map((one) => [one.mark.id, one.code])).toEqual([["r1", "CRISIS_MARK_INVALID"]]);
    expect(result.sent.map((one) => one.id).sort()).toEqual(["m3", "r2"]);
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
    const send = vi.fn(async (marks: QueuedMark[]) => {
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
