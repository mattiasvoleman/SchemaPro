import { describe, expect, it, vi } from "vitest";
import { CHUNK, hoursToInvite, inviteInParts, parts, type InvitationReport, type MassProgress } from "@/lib/mass-invitation";

const ids = (n: number) => Array.from({ length: n }, (_, i) => `id-${i + 1}`);
const sentAll = (part: string[]): InvitationReport => ({ sent: part.length, alreadyRegistered: 0, errors: [] });

describe("parts", () => {
  it("cuts a list in parts of a size, the last one short", () => {
    expect(parts([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
    expect(parts([], 2)).toEqual([]);
    expect(parts([1, 2], 5)).toEqual([[1, 2]]);
  });
});

describe("inviteInParts", () => {
  it("sends 300 people in parts of twenty, one part at a time, and says how far it has got after each", async () => {
    const calls: number[] = [];
    let running = 0;
    let overlapped = false;
    const send = vi.fn(async (part: string[]) => {
      running += 1;
      if (running > 1) overlapped = true;
      calls.push(part.length);
      await Promise.resolve();
      running -= 1;
      return sentAll(part);
    });
    const seen: MassProgress[] = [];

    const result = await inviteInParts(ids(300), send, { onProgress: (progress) => seen.push(progress) });

    expect(CHUNK).toBe(20);
    expect(calls).toEqual(Array(15).fill(20));
    expect(overlapped).toBe(false);
    expect(result).toMatchObject({ phase: "done", total: 300, handled: 300, sent: 300, failed: [] });
    // At the start with nothing done, after every part, and at the end.
    expect(seen.map((progress) => progress.handled)).toEqual([0, ...Array.from({ length: 15 }, (_, i) => (i + 1) * 20), 300]);
    expect(seen[0]).toMatchObject({ phase: "running", handled: 0 });
  });

  it("adds up what every part says: sent, an address that had an account, people skipped as invited, no address, and the ones that failed", async () => {
    const reports: InvitationReport[] = [
      { sent: 1, alreadyRegistered: 1, alreadyInvited: 1, noAddress: 0, errors: [{ userId: "id-4", message: "x" }] },
      { sent: 0, alreadyRegistered: 0, alreadyInvited: 0, noAddress: 2, errors: [] },
    ];
    const result = await inviteInParts(ids(6), async () => reports.shift()!, { chunk: 3 });

    expect(result).toMatchObject({ phase: "done", handled: 6, sent: 1, alreadyRegistered: 1, alreadyInvited: 1, noAddress: 2 });
    expect(result.failed).toEqual([{ userId: "id-4", message: "x" }]);
  });

  it("reads a gateway older than the web: the fields it does not send count for nothing", async () => {
    const result = await inviteInParts(ids(2), async () => ({ sent: 2, alreadyRegistered: 0, errors: [] }));
    expect(result).toMatchObject({ alreadyInvited: 0, noAddress: 0, phase: "done" });
  });

  it("pauses when the project's mail limit is spent, counts only those the part tried, and tries no further part", async () => {
    const send = vi.fn(async (part: string[]): Promise<InvitationReport> =>
      send.mock.calls.length === 2
        ? { sent: 4, alreadyRegistered: 0, errors: [], stopped: "RATE_LIMITED", notTried: 6 }
        : sentAll(part),
    );

    const result = await inviteInParts(ids(50), send, { chunk: 10 });

    expect(send).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({ phase: "paused", pausedFor: "RATE_LIMITED", total: 50, handled: 14, sent: 14 });
  });

  it("never counts more as not tried than the part had", async () => {
    const result = await inviteInParts(ids(5), async () => ({ sent: 0, alreadyRegistered: 0, errors: [], stopped: "RATE_LIMITED", notTried: 99 }), { chunk: 5 });
    expect(result.handled).toBe(0);
  });

  it("pauses on a call that fails, with its words, and leaves that part to the register to say: it counts none of it", async () => {
    const send = vi.fn(async (part: string[]): Promise<InvitationReport> => {
      if (send.mock.calls.length === 3) throw new Error("HTTP 429");
      return sentAll(part);
    });

    const result = await inviteInParts(ids(100), send, { chunk: 10 });

    expect(result).toMatchObject({ phase: "paused", pausedFor: "ERROR", handled: 20, sent: 20 });
    expect(result.error).toEqual(new Error("HTTP 429"));
    expect(send).toHaveBeenCalledTimes(3);
  });

  it("stops where it is asked to, before the next part, with everything before it kept", async () => {
    let stop = false;
    const send = vi.fn(async (part: string[]) => {
      if (send.mock.calls.length === 2) stop = true;
      return sentAll(part);
    });

    const result = await inviteInParts(ids(100), send, { chunk: 10, shouldStop: () => stop });

    expect(result).toMatchObject({ phase: "stopped", handled: 20, sent: 20 });
    expect(send).toHaveBeenCalledTimes(2);
  });

  it("is done at once for nobody", async () => {
    const send = vi.fn();
    const result = await inviteInParts([], send);
    expect(result).toMatchObject({ phase: "done", total: 0, handled: 0 });
    expect(send).not.toHaveBeenCalled();
  });

  it("takes up again from the register's list and invites nobody twice: a second run over what is left sends only those", async () => {
    // The register: who has been invited. A run is stopped after 3 parts; the second is asked with the list the register gives again.
    const invited = new Set<string>();
    const gateway = async (part: string[]): Promise<InvitationReport> => {
      let sent = 0;
      let skipped = 0;
      for (const id of part) {
        if (invited.has(id)) skipped += 1;
        else {
          invited.add(id);
          sent += 1;
        }
      }
      return { sent, alreadyRegistered: 0, alreadyInvited: skipped, errors: [] };
    };
    const everybody = ids(100);
    let parts = 0;
    const first = await inviteInParts(everybody, async (part) => { parts += 1; return gateway(part); }, { chunk: 10, shouldStop: () => parts === 3 });
    expect(first).toMatchObject({ phase: "stopped", sent: 30 });

    const left = everybody.filter((id) => !invited.has(id));
    expect(left).toHaveLength(70);
    const second = await inviteInParts(left, gateway, { chunk: 10 });

    expect(second).toMatchObject({ phase: "done", sent: 70, alreadyInvited: 0 });
    expect(invited.size).toBe(100);
    // And a run over the same list again, which a double click or a second tab would be, invites nobody a second time.
    const again = await inviteInParts(everybody, gateway, { chunk: 10 });
    expect(again).toMatchObject({ phase: "done", sent: 0, alreadyInvited: 100 });
  });
});

describe("hoursToInvite", () => {
  it("says how many hours a run takes at the limit, when it does not fit in the first", () => {
    expect(hoursToInvite(300, 30)).toBe(10);
    expect(hoursToInvite(301, 30)).toBe(11);
    expect(hoursToInvite(30, 30)).toBeNull();
    expect(hoursToInvite(5, 2)).toBe(3);
  });

  it("says nothing when the limit is not known or is none", () => {
    expect(hoursToInvite(300, null)).toBeNull();
    expect(hoursToInvite(300, 0)).toBeNull();
  });
});
