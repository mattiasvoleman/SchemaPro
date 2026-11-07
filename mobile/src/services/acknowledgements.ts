import { ApiError, apiRequest } from './api';
import { isNetworkError } from './coverRequests';
import { noNetwork } from './network/deviceOffline';
import type { MessageKey, Translate } from '../i18n';
import type { Tone } from '../theme/tokens';

/**
 * Kvittens (F4), the guardian's side: the messages the school has asked them
 * to confirm, and the tap that confirms one. Through the gateway's
 * /api/v1/acknowledgements, a GUARDIAN's and nobody else's (the staff's
 * routes under the same prefix are the web's).
 *
 * THE GATEWAY SENDS ONLY THE GUARDIAN'S OWN ROW. `ackedAt` is when this
 * person confirmed, and nothing says whether the other guardian of the child
 * has: under ANY the school is satisfied by either of them, under ALL it
 * needs both, and neither is ever said here. The screen words the rule and
 * stops there.
 *
 * THE LIST COMES IN PAGES, newest first (fetchMyAcks): a guardian with many
 * messages reaches the oldest one that still waits by asking for the page
 * after the last they have. Nothing here counts what the gateway has not sent:
 * the messages that wait are counted among the ones in hand (waitingCount).
 *
 * NOTHING HERE IS QUEUED. A confirmation is a statement that the person has
 * read the message now; one delivered later by a queue would say they had
 * when they had not. A phone with no network, or a request that never
 * reached the gateway, is answered OFFLINE and nothing is kept: the button
 * stays and the person taps again. The gateway answers a second tap with the
 * time of the first, so a double tap is harmless, and the screen closes the
 * button while a request is in the air all the same.
 *
 * The refusals carry a `code` (ack.service.ts): ACK_NOT_FOUND (404, the
 * message is gone or is not this person's), ACK_CUSTODY_ENDED (409, they are
 * no longer the child's guardian) and ACK_NOT_A_GUARDIAN (403). The screen
 * words each in the reader's language rather than show the gateway's Swedish.
 */

export type AckRule = 'ANY' | 'ALL';

export interface AckChild {
  readonly id: string;
  readonly name: string;
}

/** A request as its guardian sees it (ack-views.ts AckMine): their own children and their own confirmation. */
export interface AckMine {
  readonly id: string;
  readonly title: string;
  readonly body: string;
  readonly rule: AckRule;
  readonly authorName: string;
  readonly createdAt: string;
  readonly children: readonly AckChild[];
  /** When this guardian confirmed; null while they have not. */
  readonly ackedAt: string | null;
}

/** A page of a list (ack-views.ts AckPage): the items, newest first, and the id to ask after for the next, older page (null: that was the last). */
export interface AckPage<T> {
  readonly items: readonly T[];
  readonly next: string | null;
}

/** Which page to ask for: after the message with this id, at most this many (the gateway answers 50 and allows 100). */
export interface AckPageQuery {
  readonly after?: string;
  readonly limit?: number;
}

const BASE = '/api/v1/acknowledgements';

/** Newest first, as the gateway sends them: sorted here too, so the list never depends on that. */
export function newestFirst(rows: readonly AckMine[]): AckMine[] {
  return [...rows].sort((a, b) => b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id));
}

/** How many of the messages in hand still wait for this guardian (more may wait on a page not yet asked for). */
export function waitingCount(rows: readonly AckMine[]): number {
  return rows.filter((row) => row.ackedAt === null).length;
}

/** The query string for what is set, and nothing for what is not. */
function queryOf(query: AckPageQuery): string {
  const parts: string[] = [];
  if (query.after !== undefined) parts.push(`after=${encodeURIComponent(query.after)}`);
  if (query.limit !== undefined) parts.push(`limit=${encodeURIComponent(String(query.limit))}`);
  return parts.length === 0 ? '' : `?${parts.join('&')}`;
}

/**
 * GET /api/v1/acknowledgements/mine, one page: without `after` the newest
 * messages, with it the page of older ones that follows that message. A page
 * can hold fewer than asked (the gateway leaves out a request that concerns
 * none of the guardian's children), and still have an older one behind it:
 * only `next` says whether there is more. A bare array is the answer from
 * before the route paged (capped at 100); it is read as the one page it is.
 * A 404 WITHOUT a code is a gateway that has no such route (one from before
 * Kvittens, or rolled back past it) and has nothing to ask: an empty page, not
 * an error on every visit. The route's own refusals carry a code.
 */
export async function fetchMyAcks(query: AckPageQuery = {}): Promise<AckPage<AckMine>> {
  try {
    const page = await apiRequest<AckMine[] | { items?: AckMine[]; next?: unknown } | undefined>(`${BASE}/mine${queryOf(query)}`);
    if (Array.isArray(page)) return { items: newestFirst(page), next: null };
    return { items: newestFirst(page?.items ?? []), next: typeof page?.next === 'string' ? page.next : null };
  } catch (error) {
    if (error instanceof ApiError && error.status === 404 && !error.code) return { items: [], next: null };
    throw error;
  }
}

export type ConfirmOutcome =
  | { readonly kind: 'CONFIRMED'; readonly ackedAt: string }
  /** ACK_CUSTODY_ENDED: the message no longer concerns this guardian. */
  | { readonly kind: 'ENDED' }
  /** ACK_NOT_FOUND: the message is gone, or never was this person's. */
  | { readonly kind: 'GONE' }
  /** ACK_NOT_A_GUARDIAN: only a guardian confirms. */
  | { readonly kind: 'NOT_GUARDIAN' }
  /** Nothing reached the gateway: no connection. Never queued. */
  | { readonly kind: 'OFFLINE' }
  | { readonly kind: 'FAILED' };

function failureOf(error: unknown): ConfirmOutcome {
  if (!(error instanceof ApiError)) return isNetworkError(error) ? { kind: 'OFFLINE' } : { kind: 'FAILED' };
  switch (error.code) {
    case 'ACK_CUSTODY_ENDED':
      return { kind: 'ENDED' };
    case 'ACK_NOT_FOUND':
      return { kind: 'GONE' };
    case 'ACK_NOT_A_GUARDIAN':
      return { kind: 'NOT_GUARDIAN' };
    default:
      return { kind: 'FAILED' };
  }
}

/**
 * POST /api/v1/acknowledgements/:id/confirm, no body. The answer is the time
 * of the first confirmation (the gateway's, not the phone's clock); an answer
 * without one is read as now, and the next read of the list corrects it.
 * A phone joined to no network at all says OFFLINE without asking; one that
 * only doubts its network tries, because the gateway may well be reachable.
 */
export async function confirmAck(id: string): Promise<ConfirmOutcome> {
  if (await noNetwork()) return { kind: 'OFFLINE' };
  try {
    const done = await apiRequest<{ ackedAt?: unknown } | undefined>(`${BASE}/${encodeURIComponent(id)}/confirm`, { method: 'POST' });
    return { kind: 'CONFIRMED', ackedAt: typeof done?.ackedAt === 'string' ? done.ackedAt : new Date().toISOString() };
  } catch (error) {
    return failureOf(error);
  }
}

// ─── What the screen says of an outcome ───────────────────────────────────────

export interface Note {
  readonly tone: Tone;
  readonly text: string;
}

const NOTE_KEY: Record<Exclude<ConfirmOutcome['kind'], 'CONFIRMED'>, { readonly tone: Tone; readonly key: MessageKey }> = {
  ENDED: { tone: 'neutral', key: 'acks.custodyEnded' },
  GONE: { tone: 'neutral', key: 'acks.gone' },
  NOT_GUARDIAN: { tone: 'danger', key: 'acks.notGuardian' },
  OFFLINE: { tone: 'warning', key: 'acks.offline' },
  FAILED: { tone: 'danger', key: 'acks.failed' },
};

/** The sentence for an outcome that is not a confirmation, in the reader's language. */
export function noteOf(outcome: ConfirmOutcome, t: Translate): Note | null {
  if (outcome.kind === 'CONFIRMED') return null;
  const note = NOTE_KEY[outcome.kind];
  return { tone: note.tone, text: t(note.key) };
}

/** The refusals after which the message has moved on without the guardian: the list is read again. */
export function isStale(outcome: ConfirmOutcome): outcome is { readonly kind: 'ENDED' } | { readonly kind: 'GONE' } {
  return outcome.kind === 'ENDED' || outcome.kind === 'GONE';
}
