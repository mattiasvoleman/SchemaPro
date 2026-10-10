import { Logger } from '@nestjs/common';

/**
 * Expo's push service, by plain fetch (no SDK): POST {apiUrl}/send with at
 * most 100 messages, POST {apiUrl}/getReceipts with at most 1000 ids
 * (https://docs.expo.dev/push-notifications/sending-notifications/).
 *
 *   * The access token is sent as a Bearer only when configured: Expo asks
 *     for it once "enhanced push security" is on for the EAS project.
 *   * At most five requests a second, process-wide — at most 500 messages a
 *     second, under Expo's 600 per second per project.
 *   * A 429, a 5xx or a network error is retried up to three times, after
 *     1, 2 and 4 s plus up to 250 ms of jitter; any other 4xx is not (Expo
 *     says a 400 will not get better). A chunk that still fails is answered
 *     with an error ticket per message (RequestFailed), never thrown: one
 *     chunk's failure does not stop the next.
 *
 * Nothing here logs a token, a title or a body.
 */

export interface ExpoMessage {
  to: string;
  title: string;
  body: string;
  data: { notificationId: string; type: string };
  ttl: number;
  channelId: string;
  sound: 'default';
  priority: 'default';
}

export type ExpoTicket =
  | { status: 'ok'; id: string }
  | { status: 'error'; message?: string; details?: { error?: string } };

export type ExpoReceipt = { status: 'ok' } | { status: 'error'; message?: string; details?: { error?: string } };

export interface ExpoPushClientOptions {
  apiUrl: string;
  accessToken?: string;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  random?: () => number;
}

export const SEND_CHUNK = 100;
export const RECEIPT_CHUNK = 1000;
/** 200 ms between request starts: five a second. */
export const MIN_REQUEST_INTERVAL_MS = 200;
const RETRY_DELAYS_MS = [1000, 2000, 4000];

/** The process-wide pacing, shared by every client (there is one per app). */
const pacing = { nextAt: 0 };

/** For specs: forget earlier requests' slots. */
export function resetExpoPacing(): void {
  pacing.nextAt = 0;
}

class RetryableError extends Error {}

export class ExpoPushClient {
  private readonly logger = new Logger(ExpoPushClient.name);
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;
  private readonly random: () => number;

  constructor(private readonly options: ExpoPushClientOptions) {
    this.fetchImpl = options.fetch ?? ((...args) => fetch(...args));
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.now = options.now ?? (() => Date.now());
    this.random = options.random ?? Math.random;
  }

  /** One ticket per message, in order. */
  async send(messages: readonly ExpoMessage[]): Promise<ExpoTicket[]> {
    const tickets: ExpoTicket[] = [];
    for (let at = 0; at < messages.length; at += SEND_CHUNK) {
      const chunk = messages.slice(at, at + SEND_CHUNK);
      const answer = await this.post<{ data?: unknown }>('send', chunk);
      const data = Array.isArray(answer?.data) ? (answer.data as ExpoTicket[]) : null;
      if (!data || data.length !== chunk.length) {
        this.logger.warn(`Expo send failed [messages=${chunk.length}]`);
        tickets.push(...chunk.map((): ExpoTicket => ({ status: 'error', details: { error: 'RequestFailed' } })));
      } else {
        tickets.push(...data);
      }
    }
    return tickets;
  }

  /** The receipts Expo has for these ids; an id it has none for yet is absent. */
  async receipts(ids: readonly string[]): Promise<Record<string, ExpoReceipt>> {
    const out: Record<string, ExpoReceipt> = {};
    for (let at = 0; at < ids.length; at += RECEIPT_CHUNK) {
      const chunk = ids.slice(at, at + RECEIPT_CHUNK);
      const answer = await this.post<{ data?: unknown }>('getReceipts', { ids: chunk });
      const data = answer?.data;
      if (data && typeof data === 'object' && !Array.isArray(data)) {
        for (const id of chunk) {
          const receipt = (data as Record<string, ExpoReceipt>)[id];
          if (receipt && (receipt.status === 'ok' || receipt.status === 'error')) out[id] = receipt;
        }
      } else {
        this.logger.warn(`Expo receipts failed [ids=${chunk.length}]`);
      }
    }
    return out;
  }

  private async post<T>(path: 'send' | 'getReceipts', body: unknown): Promise<T | null> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.once<T>(path, body);
      } catch (error) {
        if (!(error instanceof RetryableError) || attempt >= RETRY_DELAYS_MS.length) return null;
        await this.sleep(RETRY_DELAYS_MS[attempt]! + Math.floor(this.random() * 250));
      }
    }
  }

  private async once<T>(path: string, body: unknown): Promise<T> {
    await this.paced();
    const headers: Record<string, string> = {
      accept: 'application/json',
      'accept-encoding': 'gzip, deflate',
      'content-type': 'application/json',
    };
    if (this.options.accessToken) headers['authorization'] = `Bearer ${this.options.accessToken}`;
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.options.apiUrl}/${path}`, { method: 'POST', headers, body: JSON.stringify(body) });
    } catch {
      throw new RetryableError('network');
    }
    if (response.status === 429 || response.status >= 500) throw new RetryableError(String(response.status));
    if (!response.ok) {
      this.logger.warn(`Expo refused a request [status=${response.status}]`);
      throw new Error('refused');
    }
    return (await response.json()) as T;
  }

  /** Waits for the next of the process's five slots a second. */
  private async paced(): Promise<void> {
    const now = this.now();
    const at = Math.max(now, pacing.nextAt);
    pacing.nextAt = at + MIN_REQUEST_INTERVAL_MS;
    if (at > now) await this.sleep(at - now);
  }
}
