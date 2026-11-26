import { isTimeoutError } from './request-timeout';

/**
 * One mail to Resend (POST /emails), told by what the queue does next with it.
 *
 * IDEMPOTENCY. Every mail goes under an Idempotency-Key (24 hours at Resend, 256 characters at most): the same key and
 * the same content again is answered as the first request was, without a second mail. That is what lets a packet the
 * process sent right before it died be sent again by the next one: the key is the row's and the packet's, and the
 * packet is the frozen plan's, so the content is the same. A key that comes back with other content is answered 409
 * (invalid_idempotent_request), and one whose first request is still being served 409 (concurrent_idempotent_requests).
 *
 * WHAT THE ANSWER MEANS FOR THE QUEUE (MailResult):
 *   taken    Resend took it (2xx; also the answer to a repeated key).
 *   refused  Resend will not take this packet however often it is asked: a field it rejects (400, 404, 422, one address
 *            that is not one is enough), or a key reused with other content. Counted as failed, and the queue goes on.
 *   retry    Resend did not take it and may later: a rate limit or a quota (429, with the wait it names), a 5xx, a 408,
 *            a request still being served (409), no answer or no connection, and our own key refused (401, 403: a wrong
 *            key is mended by a right one, and the rows wait for it rather than lose the mail). The queue hands the row
 *            back and asks again after the wait.
 *
 * Nothing here logs an address, a subject or a body.
 */

export interface MailPacket {
  from: string;
  /** The recipients, on BCC, so that none of them sees another's address. */
  bcc: string[];
  subject: string;
  body: string;
  key: string;
}

export type MailResult =
  | { kind: 'taken' }
  | { kind: 'refused'; status: number; name: string | null }
  /**
   * `backoff` is false only for a request still being served under our key: that is nobody failing, and it is asked about again
   * shortly. Every other wait is a failure, and the queue never waits less than its own backoff for one (see `send`).
   */
  | { kind: 'retry'; why: string; delayMs: number | null; backoff?: boolean };

/** Resend's endpoint. */
export const RESEND_URL = 'https://api.resend.com/emails';

/** What a wait the provider names is held to. */
const MAX_WAIT_MS = 60 * 60 * 1000;
/** A quota (the day's or the month's) opens again at a boundary we are not told: ask again in half an hour. */
const QUOTA_WAIT_MS = 30 * 60 * 1000;
/** A key the provider refuses is not mended by asking again at once. */
const KEY_WAIT_MS = 15 * 60 * 1000;
/** A request still being served under our key is asked about again shortly. */
const IN_FLIGHT_WAIT_MS = 5_000;

/** The address a mail is sent from, as the `to` of a BCC mail (the sender's own, so `to` is never empty). */
export function senderAddress(from: string): string {
  return from.replace(/^.*<|>$/g, '');
}

export async function sendMailPacket(apiKey: string, packet: MailPacket, timeoutMs: number): Promise<MailResult> {
  let response: Response;
  try {
    response = await fetch(RESEND_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'Idempotency-Key': packet.key,
      },
      body: JSON.stringify({
        from: packet.from,
        to: [senderAddress(packet.from)],
        bcc: packet.bcc,
        subject: packet.subject,
        text: packet.body,
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    return { kind: 'retry', why: isTimeoutError(error) ? `timeout ${timeoutMs} ms` : 'network', delayMs: null };
  }
  if (response.ok) return { kind: 'taken' };

  const status = response.status;
  const name = await errorName(response);
  if (status === 409) {
    if (name === 'concurrent_idempotent_requests') return { kind: 'retry', why: `status=${status}`, delayMs: IN_FLIGHT_WAIT_MS, backoff: false };
    return { kind: 'refused', status, name };
  }
  if (status === 429) {
    const quota = name === 'daily_quota_exceeded' || name === 'monthly_quota_exceeded';
    return { kind: 'retry', why: `status=${status}${quota ? ' quota' : ''}`, delayMs: quota ? QUOTA_WAIT_MS : retryAfterMs(response) };
  }
  if (status === 401 || status === 403) return { kind: 'retry', why: `status=${status}`, delayMs: KEY_WAIT_MS };
  if (status === 408 || status === 425 || status >= 500) return { kind: 'retry', why: `status=${status}`, delayMs: retryAfterMs(response) };
  return { kind: 'refused', status, name };
}

/** The `retry-after` the provider names, in milliseconds and held to an hour; null when it names none. */
function retryAfterMs(response: Response): number | null {
  const header = response.headers?.get?.('retry-after');
  const secs = header === null || header === undefined ? NaN : Number(header);
  return Number.isFinite(secs) && secs >= 0 ? Math.min(Math.ceil(secs * 1000), MAX_WAIT_MS) : null;
}

/** The provider's error name (`rate_limit_exceeded`, `validation_error`...), or null when the body has none. */
async function errorName(response: Response): Promise<string | null> {
  try {
    const body = (await response.json()) as { name?: unknown };
    return typeof body?.name === 'string' && /^[a-z_]{1,60}$/.test(body.name) ? body.name : null;
  } catch {
    return null;
  }
}

/**
 * How long the queue waits before it asks again, when the provider has not said: half a minute, doubling at each try, and
 * never more than a quarter of an hour. `attempts` is the claim that just failed (the first is 1).
 */
export function retryDelayMs(attempts: number): number {
  return Math.min(15 * 60 * 1000, 30_000 * 2 ** Math.max(0, Math.min(attempts, 10) - 1));
}
