import { describe, expect, it } from "vitest";
import type { BoardConfirmation, BoardRequest } from "@/lib/cover-request-types";
import type { BoardItem, Candidate, Candidates } from "@/lib/cover-types";
import {
  canAskColleagues,
  confirmedAt,
  defaultExpiry,
  expiryChoices,
  fairnessPeriodOk,
  lastDays,
  minutesUntil,
  pairRequest,
  rankColleagues,
  requestTally,
  sortFairness,
} from "@/lib/cover-request-view";

const NOW = Date.parse("2030-10-14T06:00:00Z");
const MIN = 60_000;

function item(overrides: Partial<BoardItem> = {}): BoardItem {
  return {
    absenceId: "a-1",
    absentTeacherId: "t-anna",
    absentRole: "LEAD",
    lessonId: "l-1",
    date: "2030-10-14",
    startsAt: "2030-10-14T08:00:00.000Z",
    endsAt: "2030-10-14T09:00:00.000Z",
    subjectId: "s-ma",
    studentGroupId: "g-7a",
    extraGroupIds: [],
    roomId: null,
    lessonStatus: "SCHEDULED",
    cancelCause: null,
    teachers: [{ teacherId: "t-anna", role: "LEAD" }],
    substituteId: null,
    decision: null,
    decidedAt: null,
    status: "OPEN",
    decisionStale: false,
    passed: false,
    outsideAbsence: false,
    ...overrides,
  };
}

function request(overrides: Partial<BoardRequest> = {}): BoardRequest {
  return {
    id: "r-1",
    status: "OPEN",
    createdAt: "2030-10-14T05:00:00.000Z",
    expiresAt: "2030-10-14T07:00:00.000Z",
    requestedByUserId: "u-admin",
    acceptedByUserId: null,
    pairs: [{ absenceId: "a-1", lessonId: "l-1" }],
    recipients: [
      { userId: "t-bo", answer: "PENDING", answeredAt: null },
      { userId: "t-cia", answer: "DECLINED", answeredAt: "2030-10-14T05:10:00.000Z" },
    ],
    ...overrides,
  };
}

describe("requestTally", () => {
  it("counts how many were asked and how they answered", () => {
    expect(requestTally(request())).toEqual({ asked: 2, declined: 1, accepted: 0, pending: 1 });
    expect(requestTally({ recipients: [] })).toEqual({ asked: 0, declined: 0, accepted: 0, pending: 0 });
  });
});

describe("pairRequest", () => {
  it("shows an open request on its pair and on no other", () => {
    expect(pairRequest(item(), [request()])).toMatchObject({ kind: "OPEN" });
    expect(pairRequest(item({ lessonId: "l-2" }), [request()])).toBeNull();
    // A lesson with two absent teachers has two pairs: the request names one.
    expect(pairRequest(item({ absenceId: "a-2" }), [request()])).toBeNull();
  });

  it("shows 'Tillsatt via förfrågan' only on the covered pair whose vikarie said the yes", () => {
    const accepted = request({ status: "ACCEPTED", acceptedByUserId: "t-bo" });
    const covered = item({ status: "COVERED", decision: "SUBSTITUTE", substituteId: "t-bo" });
    expect(pairRequest(covered, [accepted])).toMatchObject({ kind: "ACCEPTED" });
    // Covered another way afterwards: the old request says nothing about it.
    expect(pairRequest({ ...covered, substituteId: "t-dan" }, [accepted])).toBeNull();
    // The decision undone since: the lesson needs a vikarie again and the old yes is history.
    expect(pairRequest(item(), [accepted])).toBeNull();
  });

  it("shows the latest request that ended without a vikarie on an open pair, and nothing on a handled one", () => {
    const older = request({ id: "r-old", status: "WITHDRAWN", createdAt: "2030-10-14T04:00:00.000Z" });
    const newer = request({ id: "r-new", status: "EXPIRED", createdAt: "2030-10-14T05:00:00.000Z" });
    expect(pairRequest(item(), [older, newer])).toMatchObject({ kind: "EXPIRED", request: { id: "r-new" } });
    expect(pairRequest(item({ status: "CANCELLED" }), [newer])).toBeNull();
    expect(pairRequest(item({ status: "HANDLED" }), [newer])).toBeNull();
  });

  it("puts an open request before an older one that ended", () => {
    const ended = request({ id: "r-old", status: "EXPIRED" });
    expect(pairRequest(item(), [ended, request({ id: "r-open" })])).toMatchObject({ kind: "OPEN", request: { id: "r-open" } });
  });
});

describe("canAskColleagues", () => {
  it("offers the question on an open pair whose lesson is ahead and has no open request", () => {
    expect(canAskColleagues(item(), NOW, [])).toBe(true);
    expect(canAskColleagues(item(), NOW, [request({ status: "EXPIRED" }), request({ status: "WITHDRAWN" })])).toBe(true);
  });

  it("offers none while a request is open for the pair (COVER_REQUEST_EXISTS), but does for another pair", () => {
    expect(canAskColleagues(item(), NOW, [request()])).toBe(false);
    expect(canAskColleagues(item({ lessonId: "l-2" }), NOW, [request()])).toBe(true);
  });

  it("offers none for a cancelled lesson, a decided pair, or a lesson starting within the minute", () => {
    expect(canAskColleagues(item({ lessonStatus: "CANCELLED" }), NOW, [])).toBe(false);
    expect(canAskColleagues(item({ status: "COVERED" }), NOW, [])).toBe(false);
    expect(canAskColleagues(item({ status: "CANCELLED" }), NOW, [])).toBe(false);
    expect(canAskColleagues(item({ startsAt: new Date(NOW + 59_000).toISOString() }), NOW, [])).toBe(false);
    expect(canAskColleagues(item({ startsAt: new Date(NOW + 61_000).toISOString() }), NOW, [])).toBe(true);
    expect(canAskColleagues(item({ startsAt: new Date(NOW - MIN).toISOString() }), NOW, [])).toBe(false);
  });
});

describe("confirmedAt", () => {
  const confirmation: BoardConfirmation = { absenceId: "a-1", lessonId: "l-1", userId: "t-bo", confirmedAt: "2030-10-14T05:30:00.000Z" };
  const covered = item({ status: "COVERED", decision: "SUBSTITUTE", substituteId: "t-bo" });

  it("reads the tap of the vikarie on the pair", () => {
    expect(confirmedAt(covered, [confirmation])).toBe("2030-10-14T05:30:00.000Z");
    expect(confirmedAt(covered, [])).toBeNull();
  });

  it("ignores a tap by somebody else, on another lesson or for another absence", () => {
    expect(confirmedAt({ ...covered, substituteId: "t-dan" }, [confirmation])).toBeNull();
    expect(confirmedAt({ ...covered, lessonId: "l-2" }, [confirmation])).toBeNull();
    expect(confirmedAt({ ...covered, absenceId: "a-2" }, [confirmation])).toBeNull();
  });

  it("has nothing to say of a pair without a vikarie", () => {
    expect(confirmedAt(item(), [confirmation])).toBeNull();
    expect(confirmedAt(item({ status: "HANDLED", decision: "CO_TEACHER" }), [confirmation])).toBeNull();
  });
});

describe("expiryChoices", () => {
  it("offers half an hour, an hour, two hours and 'until the lesson starts' for a lesson within the 12 hours the gateway allows", () => {
    const choices = expiryChoices(NOW + 300 * MIN, NOW);
    expect(choices).toEqual([
      { id: "30", minutes: 30 },
      { id: "60", minutes: 60 },
      { id: "120", minutes: 120 },
      { id: "START", minutes: 300 },
    ]);
    expect(defaultExpiry(choices).id).toBe("60");
  });

  it("drops the lengths that outlast the first lesson, and defaults to the start when an hour does not fit", () => {
    const soon = expiryChoices(NOW + 45 * MIN, NOW);
    expect(soon).toEqual([
      { id: "30", minutes: 30 },
      { id: "START", minutes: 45 },
    ]);
    const veryClose = expiryChoices(NOW + 20 * MIN, NOW);
    expect(veryClose).toEqual([{ id: "START", minutes: 20 }]);
    expect(defaultExpiry(veryClose).id).toBe("START");
  });

  it("offers no 'until the start' past the 12 hours the gateway accepts, and never less than 5 minutes", () => {
    const far = expiryChoices(NOW + 3 * 24 * 60 * MIN, NOW);
    expect(far.map((choice) => choice.id)).toEqual(["30", "60", "120"]);
    expect(minutesUntil(NOW + 2 * MIN, NOW)).toBe(5);
    expect(minutesUntil(NOW + 5000 * MIN, NOW)).toBe(720);
  });
});

describe("rankColleagues", () => {
  const candidate = (userId: string, score: number, extra: Partial<Candidate> = {}): Candidate => ({
    userId,
    kind: "STAFF",
    score,
    qualificationKind: null,
    reasons: [{ code: "GAP_FILL", params: {}, points: score }],
    counter: { weekLessons: 1, termLessons: 2 },
    load: { weekMinutes: 0, targetMinutes: null },
    ...extra,
  });
  const list = (lessonId: string, candidates: Candidate[], excluded: Candidates["excluded"] = []): Candidates => ({
    lessonId,
    candidates,
    excluded,
  });

  it("keeps one lesson's ranking as it is", () => {
    const { ranked, cannot } = rankColleagues([list("l-1", [candidate("t-bo", 52), candidate("t-cia", 10, { kind: "POOL" })], [{ userId: "t-dan", codes: [{ code: "ABSENT", params: {} }] }])]);
    expect(ranked.map((colleague) => [colleague.userId, colleague.score, colleague.kind])).toEqual([
      ["t-bo", 52, "STAFF"],
      ["t-cia", 10, "POOL"],
    ]);
    expect(cannot).toEqual([{ userId: "t-dan", codes: [{ code: "ABSENT", params: {} }], partial: false }]);
  });

  it("offers a colleague only if every lesson holds them, adds the scores and the reasons up, and lists the rest as unable", () => {
    const { ranked, cannot } = rankColleagues([
      list("l-1", [candidate("t-bo", 40), candidate("t-cia", 30), candidate("t-eva", 99)]),
      list("l-2", [candidate("t-bo", 20), candidate("t-cia", 35)], [{ userId: "t-eva", codes: [{ code: "BUSY_LESSON", params: {} }] }]),
    ]);
    expect(ranked.map((colleague) => [colleague.userId, colleague.score])).toEqual([
      ["t-cia", 65],
      ["t-bo", 60],
    ]);
    // Same reason in both lessons: one line, the points added.
    expect(ranked[0]!.reasons).toEqual([{ code: "GAP_FILL", params: {}, points: 65 }]);
    // Excluded by one lesson: said so with its reason; not offered even though the other list held them.
    expect(cannot).toEqual([{ userId: "t-eva", codes: [{ code: "BUSY_LESSON", params: {} }], partial: false }]);
  });

  it("marks somebody only some of the lessons list as partial", () => {
    const { ranked, cannot } = rankColleagues([
      list("l-1", [candidate("t-bo", 40), candidate("t-cia", 30)]),
      list("l-2", [candidate("t-bo", 20)]),
    ]);
    expect(ranked.map((colleague) => colleague.userId)).toEqual(["t-bo"]);
    expect(cannot).toEqual([{ userId: "t-cia", codes: [], partial: true }]);
  });

  it("says nothing of no lists", () => {
    expect(rankColleagues([])).toEqual({ ranked: [], cannot: [] });
  });
});

describe("Rättvisa", () => {
  it("defaults to the last 30 days up to and including today", () => {
    expect(lastDays("2030-10-30")).toEqual({ from: "2030-10-01", to: "2030-10-30" });
    expect(lastDays("2030-03-05", 7)).toEqual({ from: "2030-02-27", to: "2030-03-05" });
  });

  it("accepts a period of at most 366 days with the first day first", () => {
    expect(fairnessPeriodOk("2030-01-01", "2030-01-31")).toBe(true);
    expect(fairnessPeriodOk("2030-01-01", "2030-01-01")).toBe(true);
    expect(fairnessPeriodOk("2030-01-02", "2030-01-01")).toBe(false);
    expect(fairnessPeriodOk("2030-01-01", "2031-01-02")).toBe(true);
    expect(fairnessPeriodOk("2030-01-01", "2031-01-03")).toBe(false);
    expect(fairnessPeriodOk("", "2030-01-01")).toBe(false);
  });

  it("sorts the most asked first and the same number by name", () => {
    const names: Record<string, string> = { a: "Åsa Berg", b: "Anna Lind", c: "Bo Ek", d: "Cia Holm" };
    const row = (userId: string, received: number) => ({ userId, received, accepted: 0, declined: 0, unanswered: received });
    const sorted = sortFairness([row("a", 2), row("c", 5), row("d", 2), row("b", 2)], (id) => names[id]!);
    // Swedish order: Å after A–Z.
    expect(sorted.map((entry) => entry.userId)).toEqual(["c", "b", "d", "a"]);
  });
});
