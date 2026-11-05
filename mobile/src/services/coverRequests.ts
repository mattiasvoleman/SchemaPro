import { ApiError, apiRequest } from './api';
import { deviceOffline } from './network/deviceOffline';
import { formatDateTime, formatTime, localDate } from '../i18n/format';
import type { Locale, MessageKey, Translate } from '../i18n';
import type { Tone } from '../theme/tokens';

/**
 * Vikariefrågan (D4), the colleague's side: the questions the school has
 * asked, the passes a cover decision gave them, a yes, a no and the tap that
 * confirms a pass. All through the gateway's /api/v1/cover-requests, a
 * TEACHER's and nobody else's.
 *
 * A request names the lessons (subject, group, room, times) and until when it
 * can be answered. The gateway never sends who is away or why, and nothing
 * here asks.
 *
 * NOTHING HERE IS QUEUED. The attendance register waits for a network in an
 * offline queue; a yes cannot: the first yes gets the lessons, so a yes
 * delivered an hour later would be a lie about who said it first. A device
 * that says it is offline, or a request that never reached the gateway, is
 * answered OFFLINE and nothing is kept. The answer is the gateway's, in the
 * code its refusal carries (cover-errors.ts, cover-request-rules.ts), and the
 * screen words it in the reader's language; only a rule's own sentence (it
 * names the rule) is shown as the gateway wrote it.
 */

export type MyRequestState = 'OPEN' | 'ACCEPTED_BY_ME' | 'DECLINED_BY_ME' | 'TAKEN' | 'WITHDRAWN' | 'EXPIRED' | 'CLOSED';

export interface CoverLesson {
  readonly lessonId: string;
  /** The lesson's calendar day, YYYY-MM-DD. */
  readonly date: string;
  readonly startsAt: string;
  readonly endsAt: string;
  readonly subjectName: string;
  readonly groupName: string;
  readonly roomName: string | null;
  /** No longer held: the question cannot be said yes to. */
  readonly cancelled: boolean;
}

export interface MyCoverRequest {
  readonly id: string;
  /** OPEN is the only state that can be answered; the gateway reads an OPEN past its time as EXPIRED. */
  readonly state: MyRequestState;
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly lessons: readonly CoverLesson[];
}

/** A lesson a cover decision gave the teacher in the next 28 days. */
export interface MyCoverPass {
  readonly lessonId: string;
  readonly date: string;
  readonly startsAt: string;
  readonly endsAt: string;
  readonly subjectName: string;
  readonly groupName: string;
  readonly roomName: string | null;
  /** Null until the teacher taps Bekräfta. */
  readonly confirmedAt: string | null;
}

export interface MyCover {
  readonly requests: readonly MyCoverRequest[];
  readonly passes: readonly MyCoverPass[];
}

const BASE = '/api/v1/cover-requests';

/** The earlier requests the screen lists: the gateway sends the last 14 days, newest first. */
export const PAST_SHOWN = 20;

/**
 * GET /api/v1/cover-requests/mine. A 404 WITHOUT a code is a gateway that has
 * no such route (one from before Vikariefrågan, or rolled back past it) and
 * has nothing to ask: an empty list, not an error on every visit. The
 * route's own refusals carry a code.
 */
export async function fetchMyCover(): Promise<MyCover> {
  try {
    const answer = await apiRequest<Partial<MyCover> | undefined>(`${BASE}/mine`);
    return { requests: answer?.requests ?? [], passes: answer?.passes ?? [] };
  } catch (error) {
    if (error instanceof ApiError && error.status === 404 && !error.code) return { requests: [], passes: [] };
    throw error;
  }
}

function startOf(request: MyCoverRequest): number {
  return Math.min(...request.lessons.map((lesson) => Date.parse(lesson.startsAt)));
}

/**
 * The questions still to answer, soonest lesson first, and the earlier ones
 * in the gateway's order (newest question first). A request the teacher has
 * just answered stays with the first group for as long as `held` names it, so
 * its confirmation is read where the buttons were.
 */
export function splitRequests(
  requests: readonly MyCoverRequest[],
  held: ReadonlySet<string> = new Set(),
): { readonly open: MyCoverRequest[]; readonly past: MyCoverRequest[] } {
  const isOpen = (request: MyCoverRequest): boolean => request.state === 'OPEN' || held.has(request.id);
  return {
    open: requests.filter(isOpen).sort((a, b) => startOf(a) - startOf(b) || a.id.localeCompare(b.id)),
    past: requests.filter((request) => !isOpen(request)).slice(0, PAST_SHOWN),
  };
}

/** Whether the question can be said yes to: open, with lessons, and none of them cancelled. */
export function answerable(request: MyCoverRequest): boolean {
  return request.state === 'OPEN' && request.lessons.length > 0 && !request.lessons.some((lesson) => lesson.cancelled);
}

/** The lessons grouped by their day, in the order given: one heading per day, not per lesson. */
export function lessonsByDay<T extends { readonly date: string }>(lessons: readonly T[]): Array<{ date: string; lessons: T[] }> {
  const days: Array<{ date: string; lessons: T[] }> = [];
  for (const lesson of lessons) {
    const last = days[days.length - 1];
    if (last && last.date === lesson.date) last.lessons.push(lesson);
    else days.push({ date: lesson.date, lessons: [lesson] });
  }
  return days;
}

/**
 * "08:30" when the time to answer by is today on the phone, otherwise the day
 * as well ("tis 13 okt 08:30"): "Svara senast 08:30" is read at once, and a
 * question open until tomorrow must not look like one that closes this
 * morning.
 */
export function untilText(expiresAt: string, locale: Locale, now: Date = new Date()): string {
  const at = new Date(expiresAt);
  if (Number.isNaN(at.getTime())) return '';
  return localDate(at) === localDate(now) ? formatTime(expiresAt) : formatDateTime(expiresAt, locale);
}

// ─── The answers ──────────────────────────────────────────────────────────────

/** A refusal that keeps the card and its buttons, and whose sentence names the reason. */
export type RefusedCode = 'COVER_REQUEST_RULE' | 'COVER_REQUEST_SENDER_GONE';

/** The question has moved on without the teacher: the list is read again. */
export type StaleCode =
  | 'COVER_REQUEST_GONE'
  | 'COVER_REQUEST_ANSWERED'
  | 'COVER_REQUEST_NOT_FOUND'
  | 'COVER_REQUEST_LESSON_CANCELLED'
  | 'COVER_REQUEST_LESSON_COVERED'
  | 'COVER_PASS_NOT_FOUND';

const STALE_CODES: ReadonlySet<string> = new Set<StaleCode>([
  'COVER_REQUEST_GONE',
  'COVER_REQUEST_ANSWERED',
  'COVER_REQUEST_NOT_FOUND',
  'COVER_REQUEST_LESSON_CANCELLED',
  'COVER_REQUEST_LESSON_COVERED',
  'COVER_PASS_NOT_FOUND',
]);

type Failure =
  /** Another colleague said yes first. */
  | { readonly kind: 'TAKEN' }
  | { readonly kind: 'REFUSED'; readonly code: RefusedCode; readonly message: string | null }
  | { readonly kind: 'STALE'; readonly code: StaleCode }
  /** Nothing reached the gateway: no connection. Never queued. */
  | { readonly kind: 'OFFLINE' }
  | { readonly kind: 'FAILED' };

export type AnswerOutcome = { readonly kind: 'ACCEPTED'; readonly lessons: number } | { readonly kind: 'DECLINED' } | Failure;
export type ConfirmOutcome = { readonly kind: 'CONFIRMED' } | Failure;
export type CoverOutcome = AnswerOutcome | ConfirmOutcome;

/**
 * Whether a request died in the phone's own network layer: React Native's
 * fetch rejects with a TypeError ("Network request failed") when nothing was
 * reached, and with an AbortError when it was cut off. A gateway's refusal is
 * an ApiError and never this.
 */
export function isNetworkError(error: unknown): boolean {
  return error instanceof TypeError || (error instanceof Error && error.name === 'AbortError');
}

/** The gateway's own sentence, when it sent one: apiRequest falls back to "HTTP 409". */
const sentenceOf = (error: ApiError): string | null => (/^HTTP \d{3}$/.test(error.message) ? null : error.message || null);

function failureOf(error: unknown): Failure {
  if (!(error instanceof ApiError)) return isNetworkError(error) ? { kind: 'OFFLINE' } : { kind: 'FAILED' };
  const code = error.code;
  if (code === 'COVER_REQUEST_TAKEN') return { kind: 'TAKEN' };
  if (code === 'COVER_REQUEST_RULE' || code === 'COVER_REQUEST_SENDER_GONE') {
    return { kind: 'REFUSED', code, message: sentenceOf(error) };
  }
  if (code !== undefined && STALE_CODES.has(code)) return { kind: 'STALE', code: code as StaleCode };
  return { kind: 'FAILED' };
}

/** Why a read failed: no connection, or anything else. Asks the device too, as a read can fail on a stale session first. */
export async function loadProblem(error: unknown): Promise<'OFFLINE' | 'FAILED'> {
  return isNetworkError(error) || (await deviceOffline()) ? 'OFFLINE' : 'FAILED';
}

/**
 * The teacher's yes or no. The first yes gets all the lessons (atomically, in
 * the gateway), so this is sent now or not at all.
 */
export async function answerCoverRequest(requestId: string, answer: 'YES' | 'NO'): Promise<AnswerOutcome> {
  if (await deviceOffline()) return { kind: 'OFFLINE' };
  const path = `${BASE}/${encodeURIComponent(requestId)}`;
  try {
    if (answer === 'NO') {
      await apiRequest<{ requestId: string }>(`${path}/decline`, { method: 'POST' });
      return { kind: 'DECLINED' };
    }
    const done = await apiRequest<{ requestId: string; lessons: number } | undefined>(`${path}/accept`, { method: 'POST' });
    return { kind: 'ACCEPTED', lessons: Number(done?.lessons ?? 0) };
  } catch (error) {
    return failureOf(error);
  }
}

/** The tap on a pass. Idempotent in the gateway, so a second tap is harmless. */
export async function confirmCoverPass(lessonId: string): Promise<ConfirmOutcome> {
  if (await deviceOffline()) return { kind: 'OFFLINE' };
  try {
    await apiRequest<{ lessonId: string; confirmed: number }>(`${BASE}/lessons/${encodeURIComponent(lessonId)}/confirm`, {
      method: 'POST',
    });
    return { kind: 'CONFIRMED' };
  } catch (error) {
    return failureOf(error);
  }
}

// ─── What the screen says of an answer ────────────────────────────────────────

export interface Note {
  readonly tone: Tone;
  readonly text: string;
}

const REFUSED_KEY: Record<RefusedCode, MessageKey> = {
  COVER_REQUEST_RULE: 'coverRequests.refused.COVER_REQUEST_RULE',
  COVER_REQUEST_SENDER_GONE: 'coverRequests.refused.COVER_REQUEST_SENDER_GONE',
};

const STALE_KEY: Record<StaleCode, MessageKey> = {
  COVER_REQUEST_GONE: 'coverRequests.stale.COVER_REQUEST_GONE',
  COVER_REQUEST_ANSWERED: 'coverRequests.stale.COVER_REQUEST_ANSWERED',
  COVER_REQUEST_NOT_FOUND: 'coverRequests.stale.COVER_REQUEST_NOT_FOUND',
  COVER_REQUEST_LESSON_CANCELLED: 'coverRequests.stale.COVER_REQUEST_LESSON_CANCELLED',
  COVER_REQUEST_LESSON_COVERED: 'coverRequests.stale.COVER_REQUEST_LESSON_COVERED',
  COVER_PASS_NOT_FOUND: 'coverRequests.stale.COVER_PASS_NOT_FOUND',
};

/** Whether the card keeps its buttons after this outcome: a refusal by rule, no connection, or a failure. */
export function keepsButtons(outcome: CoverOutcome | undefined): boolean {
  return outcome === undefined || outcome.kind === 'REFUSED' || outcome.kind === 'OFFLINE' || outcome.kind === 'FAILED';
}

/**
 * A line under the card for an outcome that has one: TAKEN in the catalogue's
 * words (reader's language), a rule's sentence as the gateway wrote it (it
 * names the rule, in Swedish), the rest by their codes. A successful answer
 * has none: the card itself turns into the confirmation.
 */
export function noteOf(outcome: CoverOutcome, t: Translate): Note | null {
  switch (outcome.kind) {
    case 'TAKEN':
      return { tone: 'warning', text: t('coverRequests.taken') };
    case 'REFUSED':
      return { tone: 'danger', text: outcome.message ?? t(REFUSED_KEY[outcome.code]) };
    case 'STALE':
      return { tone: 'neutral', text: t(STALE_KEY[outcome.code]) };
    case 'OFFLINE':
      return { tone: 'warning', text: t('coverRequests.offline') };
    case 'FAILED':
      return { tone: 'danger', text: t('coverRequests.failed') };
    default:
      return null;
  }
}
