import type { BoardConfirmation, BoardRequest, FairnessRow } from "@/lib/cover-request-types";
import type { BoardItem, Candidate, Candidates, CoverMessage, RankReason } from "@/lib/cover-types";
import { shiftDate } from "@/lib/cover-absence-form";

/*
 * What the board says of a request and what it offers, as pure functions of the
 * board's pairs, its requests and the clock, so the rules the gateway enforces
 * (cover-requests.service.ts) are the rules the buttons follow and a test pins
 * both.
 *
 * A REQUEST BELONGS TO PAIRS, not to lessons: it asks for (absence, lesson)
 * pairs, and a lesson with two absent teachers has two. It is "on" a pair when
 * the pair is among its own.
 */

/** A request asks for at most this many lessons and colleagues, and stands this long (minutes). */
export const MAX_REQUEST_LESSONS = 12;
export const MAX_REQUEST_RECIPIENTS = 25;
export const MIN_EXPIRY_MINUTES = 5;
export const MAX_EXPIRY_MINUTES = 720;
/** A lesson that starts sooner than this cannot be asked for (COVER_REQUEST_LESSON_STARTED). */
export const MIN_ANSWER_MS = 60_000;
/** The fairness view's longest period, in days. */
export const FAIRNESS_MAX_DAYS = 366;
export const FAIRNESS_DEFAULT_DAYS = 30;

const onPair = (request: BoardRequest, item: Pick<BoardItem, "lessonId" | "absenceId">) =>
  request.pairs.some((pair) => pair.lessonId === item.lessonId && pair.absenceId === item.absenceId);

export interface RequestTally {
  asked: number;
  declined: number;
  accepted: number;
  pending: number;
}

/** "Fråga skickad till 4 kollegor (1 har tackat nej)": how the colleagues have answered. */
export function requestTally(request: Pick<BoardRequest, "recipients">): RequestTally {
  const count = (answer: BoardRequest["recipients"][number]["answer"]) =>
    request.recipients.filter((recipient) => recipient.answer === answer).length;
  return {
    asked: request.recipients.length,
    declined: count("DECLINED"),
    accepted: count("ACCEPTED"),
    pending: count("PENDING"),
  };
}

/** What a pair shows of the requests that asked for it, if anything. */
export type PairRequest =
  | { kind: "OPEN"; request: BoardRequest }
  | { kind: "ACCEPTED"; request: BoardRequest }
  | { kind: "WITHDRAWN" | "EXPIRED" | "CLOSED"; request: BoardRequest };

/**
 * The one request worth a line on a pair:
 *   - an OPEN one, whatever else, since it is the one that can be withdrawn;
 *   - on a COVERED pair, the request whose yes put the vikarie there ("Tillsatt
 *     via förfrågan") — a pair covered another way says nothing of a request
 *     that ran out before;
 *   - on an OPEN pair, the latest request that ended without a vikarie (it ran
 *     out, was withdrawn or closed), since the administrator has to act again.
 *     An ACCEPTED one there is a yes whose decision was undone since: history.
 */
export function pairRequest(item: BoardItem, requests: readonly BoardRequest[]): PairRequest | null {
  const asked = requests.filter((request) => onPair(request, item));
  if (asked.length === 0) return null;
  const open = asked.find((request) => request.status === "OPEN");
  if (open) return { kind: "OPEN", request: open };
  if (item.status === "COVERED") {
    const accepted = asked.find((request) => request.status === "ACCEPTED" && request.acceptedByUserId === item.substituteId);
    return accepted ? { kind: "ACCEPTED", request: accepted } : null;
  }
  if (item.status !== "OPEN") return null;
  const ended = asked
    .filter((request) => request.status === "WITHDRAWN" || request.status === "EXPIRED" || request.status === "CLOSED")
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id))[0];
  return ended ? { kind: ended.status as "WITHDRAWN" | "EXPIRED" | "CLOSED", request: ended } : null;
}

/**
 * Whether "Fråga kollegor" is offered on a pair, by the gateway's refusals:
 * the pair OPEN, the lesson not cancelled (a lesson a schemabrytande aktivitet
 * took is shown as inställd and asks nobody), starting more than a minute
 * from now, and no open request already asking for it (COVER_REQUEST_EXISTS).
 */
export function canAskColleagues(item: BoardItem, now: number, requests: readonly BoardRequest[]): boolean {
  if (item.status !== "OPEN" || item.lessonStatus === "CANCELLED") return false;
  if (new Date(item.startsAt).getTime() - now < MIN_ANSWER_MS) return false;
  return !requests.some((request) => request.status === "OPEN" && onPair(request, item));
}

/** The vikarie's tap on a covered pair: when, or null while they have not. */
export function confirmedAt(item: BoardItem, confirmations: readonly BoardConfirmation[]): string | null {
  if (item.status !== "COVERED" || item.decision !== "SUBSTITUTE" || !item.substituteId) return null;
  return (
    confirmations.find(
      (confirmation) =>
        confirmation.lessonId === item.lessonId &&
        confirmation.absenceId === item.absenceId &&
        confirmation.userId === item.substituteId,
    )?.confirmedAt ?? null
  );
}

// ---------------------------------------------------------------------------
// How long the question stands
// ---------------------------------------------------------------------------

export interface ExpiryChoice {
  /** "30", "60", "120" or "START" (until the first lesson starts). */
  id: string;
  minutes: number;
}

/** Minutes until the earliest lesson, rounded up, within what the gateway accepts. */
export function minutesUntil(startsAt: number, now: number): number {
  return Math.min(MAX_EXPIRY_MINUTES, Math.max(MIN_EXPIRY_MINUTES, Math.ceil((startsAt - now) / 60_000)));
}

/**
 * The lengths offered: 30 min, 1 h and 2 h that fall before the first lesson,
 * and "until the lesson starts" when that is within the 12 hours the gateway
 * allows. The gateway never lets a question outlive the first lesson, so a
 * length past it would be a promise the answer breaks.
 */
export function expiryChoices(earliestStartsAt: number, now: number): ExpiryChoice[] {
  const until = Math.ceil((earliestStartsAt - now) / 60_000);
  const choices: ExpiryChoice[] = [30, 60, 120]
    .filter((minutes) => minutes < until)
    .map((minutes) => ({ id: String(minutes), minutes }));
  if (until <= MAX_EXPIRY_MINUTES) choices.push({ id: "START", minutes: minutesUntil(earliestStartsAt, now) });
  return choices;
}

/** One hour when there is time for it, else until the lesson starts. */
export function defaultExpiry(choices: readonly ExpiryChoice[]): ExpiryChoice {
  return choices.find((choice) => choice.id === "60") ?? choices[choices.length - 1]!;
}

// ---------------------------------------------------------------------------
// The colleagues to choose from, for one lesson or several
// ---------------------------------------------------------------------------

export interface RankedColleague {
  userId: string;
  kind: Candidate["kind"];
  /** The sum over the lessons asked for. */
  score: number;
  reasons: RankReason[];
  counter: Candidate["counter"];
}

export interface CannotColleague {
  userId: string;
  codes: CoverMessage[];
  /** Fine for some of the lessons, not for all of them: a question is for all or none. */
  partial: boolean;
}

const reasonKey = (reason: CoverMessage) => `${reason.code}\u0000${JSON.stringify(reason.params)}`;

/**
 * The ranked colleagues of every lesson of a request, as one list. A question
 * goes to a colleague for ALL its lessons (the first yes takes them all, and
 * the gateway judges each colleague against each lesson), so only someone
 * every lesson's list holds is offered; their score is the sum, their reasons
 * the lessons' reasons added up per kind. Someone one lesson excludes is
 * listed as unable, with the reason that lesson gave, and someone only some
 * lessons list is marked partial.
 */
export function rankColleagues(lists: readonly Candidates[]): { ranked: RankedColleague[]; cannot: CannotColleague[] } {
  if (lists.length === 0) return { ranked: [], cannot: [] };
  const ranked: RankedColleague[] = [];
  const seen = new Set<string>();
  const [first, ...rest] = lists;
  for (const candidate of first!.candidates) {
    const others = rest.map((list) => list.candidates.find((other) => other.userId === candidate.userId));
    if (others.some((other) => other === undefined)) continue;
    const all = [candidate, ...(others as Candidate[])];
    const reasons = new Map<string, RankReason>();
    for (const part of all) {
      for (const reason of part.reasons) {
        const key = reasonKey(reason);
        const held = reasons.get(key);
        reasons.set(key, held ? { ...held, points: held.points + reason.points } : { ...reason });
      }
    }
    ranked.push({
      userId: candidate.userId,
      kind: all.some((part) => part.kind === "POOL") ? "POOL" : "STAFF",
      score: all.reduce((sum, part) => sum + part.score, 0),
      reasons: [...reasons.values()],
      counter: candidate.counter,
    });
    seen.add(candidate.userId);
  }
  ranked.sort((a, b) => b.score - a.score || a.userId.localeCompare(b.userId));

  const cannot = new Map<string, CannotColleague>();
  for (const list of lists) {
    for (const entry of list.excluded) {
      if (!cannot.has(entry.userId)) cannot.set(entry.userId, { userId: entry.userId, codes: entry.codes, partial: false });
    }
  }
  for (const list of lists) {
    for (const candidate of list.candidates) {
      if (seen.has(candidate.userId) || cannot.has(candidate.userId)) continue;
      cannot.set(candidate.userId, { userId: candidate.userId, codes: [], partial: true });
    }
  }
  return { ranked, cannot: [...cannot.values()].sort((a, b) => a.userId.localeCompare(b.userId)) };
}

// ---------------------------------------------------------------------------
// Rättvisa
// ---------------------------------------------------------------------------

/** The last `days` days up to and including `today`. */
export function lastDays(today: string, days = FAIRNESS_DEFAULT_DAYS): { from: string; to: string } {
  return { from: shiftDate(today, -(days - 1)), to: today };
}

/** Whether a period can be asked for: both days given, in order, no longer than the gateway reads. */
export function fairnessPeriodOk(from: string, to: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to) || from > to) return false;
  const span = (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000;
  return span <= FAIRNESS_MAX_DAYS;
}

/** Most asked first; the same number by name, in Swedish order. */
export function sortFairness(rows: readonly FairnessRow[], nameOf: (userId: string) => string): FairnessRow[] {
  return [...rows].sort(
    (a, b) =>
      b.received - a.received ||
      nameOf(a.userId).localeCompare(nameOf(b.userId), "sv") ||
      a.userId.localeCompare(b.userId),
  );
}
