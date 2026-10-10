import { createHash } from 'node:crypto';
import type { Ss12000AuthKind, Ss12000SecretKind, Ss12000TokenAuthStyle } from '@prisma/client';
import { Ss12000SourceError } from './errors';
import { sendOutbound, type OutboundPolicy, type OutboundResponse, type OutboundSender } from './outbound';

/**
 * An SS12000 2.1.0 client for one source, per S1 (SIS TK450,
 * openapi_ss12000_version2_1_0.yaml, sha256 aee9a95a…cd28) and what IST
 * documents beside it.
 *
 * AUTHENTICATION. S1 defines only how a token is presented
 * (securitySchemes.BearerAuth: `Authorization: Bearer <token>`). How it is
 * obtained is the provider's:
 *
 *   OAUTH2_CLIENT_CREDENTIALS  POST tokenUrl, application/x-www-form-urlencoded,
 *     grant_type=client_credentials[&scope=…], the client in HTTP Basic
 *     (base64(urlencode(id):urlencode(secret)), RFC 6749 §2.3.1) or as
 *     client_id/client_secret form fields. IST EduCloud, "Fetch and use
 *     access token" (2021-12-30): https://skolid.se/connect/token, HTTP
 *     Basic allowed, an empty scope means every allowed scope, expires_in
 *     3600. The access token is cached IN PROCESS MEMORY ONLY, per source,
 *     client and secret, until expires_in − 60 s; it is never stored. A 401
 *     on a data call drops it and asks once more, then fails
 *     SS12000_UNAUTHORIZED.
 *   BEARER_TOKEN  the stored token, as is.
 *   MTLS_CLIENT_CERT  the TLS client certificate and key on every request
 *     (node:https; Node's fetch takes no client certificate without undici),
 *     plus a bearer from an OAuth2 client or a stored token when configured
 *     (Tieto Edlevo per Skolon's support article, 2025-02-27: API keys and a
 *     client certificate). Skolfederation's Moa/MATF metadata is not
 *     implemented; the server is verified against the CA store.
 *
 * PAGING (S1 `limit`/`pageToken`; IST "Paginating results", 2022-05-13).
 * The first request carries the filters and `limit`; every later one only
 * `pageToken` and `limit` ("Kan inte kombineras med andra filter men väl med
 * limit"). A null or empty pageToken ends the walk. A token seen twice, or
 * more than 2 000 pages, is SS12000_PAGE_LOOP.
 *
 * LIMITS. 30 s per request, 32 MB per body, JSON only, no redirects. 429
 * and 503 ("Svaret är förstort") are retried 3 times, honouring Retry-After
 * (at most 60 s) or else 2, 8 and 30 s. Every failure is a code
 * (Ss12000SourceError); nothing the far side says is kept.
 *
 * CLOCK. The Date header of the first response is the provider's clock,
 * which the run's cursors are taken from (§2.5 of the design).
 */

export interface SourceConnection {
  sourceId: string;
  baseUrl: string;
  authKind: Ss12000AuthKind;
  tokenUrl: string | null;
  clientId: string | null;
  tokenScope: string | null;
  tokenAuthStyle: Ss12000TokenAuthStyle;
  /** Decrypted for this run only; never logged, never stored. */
  secrets: Partial<Record<Ss12000SecretKind, string>>;
}

export interface ClientOptions {
  policy: OutboundPolicy;
  send?: OutboundSender;
  /** Waits before the 1st, 2nd and 3rd retry when no Retry-After is sent. */
  retryDelaysMs?: number[];
  /** Cap on a Retry-After. */
  maxRetryAfterMs?: number;
  timeoutMs?: number;
  maxBytes?: number;
  maxPages?: number;
  sleep?: (ms: number) => Promise<void>;
}

export interface ClientStats {
  requests: number;
  retries: number;
  pages: number;
}

export type Query = Array<[string, string]>;

const DEFAULTS = {
  retryDelaysMs: [2_000, 8_000, 30_000],
  maxRetryAfterMs: 60_000,
  timeoutMs: 30_000,
  maxBytes: 32 * 1024 * 1024,
  maxPages: 2_000,
};

interface CachedToken {
  token: string;
  expiresAt: number;
}

/** Access tokens, in this process only, keyed so a changed client or secret never reuses one. */
const TOKENS = new Map<string, CachedToken>();

/** For tests: forget every cached access token. */
export function clearTokenCache(): void {
  TOKENS.clear();
}

const realSleep = (ms: number) =>
  new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref();
  });

function retryAfterMs(response: OutboundResponse, cap: number): number | null {
  const header = response.headers['retry-after'];
  const value = Array.isArray(header) ? header[0] : header;
  if (!value) return null;
  if (/^\d+$/.test(value.trim())) return Math.min(Number(value.trim()) * 1000, cap);
  const at = Date.parse(value);
  return Number.isNaN(at) ? null : Math.max(0, Math.min(at - Date.now(), cap));
}

export class Ss12000Client {
  readonly stats: ClientStats = { requests: 0, retries: 0, pages: 0 };
  /** The provider's clock, from the first response's Date header. */
  providerClock: Date | null = null;
  private readonly send: OutboundSender;
  private readonly opts: typeof DEFAULTS & { sleep: (ms: number) => Promise<void> };

  constructor(
    private readonly conn: SourceConnection,
    private readonly options: ClientOptions,
  ) {
    this.send = options.send ?? sendOutbound;
    this.opts = {
      retryDelaysMs: options.retryDelaysMs ?? DEFAULTS.retryDelaysMs,
      maxRetryAfterMs: options.maxRetryAfterMs ?? DEFAULTS.maxRetryAfterMs,
      timeoutMs: options.timeoutMs ?? DEFAULTS.timeoutMs,
      maxBytes: options.maxBytes ?? DEFAULTS.maxBytes,
      maxPages: options.maxPages ?? DEFAULTS.maxPages,
      sleep: options.sleep ?? realSleep,
    };
  }

  private get usesOAuth(): boolean {
    return this.conn.tokenUrl !== null && this.conn.clientId !== null;
  }

  private tlsClient(): { cert?: string; key?: string } {
    if (this.conn.authKind !== 'MTLS_CLIENT_CERT') return {};
    const cert = this.conn.secrets.CLIENT_CERT_PEM;
    const key = this.conn.secrets.CLIENT_KEY_PEM;
    if (!cert || !key) throw new Ss12000SourceError('SS12000_SECRET_MISSING');
    return { cert, key };
  }

  private tokenCacheKey(): string {
    const secret = this.conn.secrets.CLIENT_SECRET ?? '';
    const fingerprint = createHash('sha256').update(secret).digest('hex');
    return `${this.conn.sourceId}|${this.conn.tokenUrl}|${this.conn.clientId}|${this.conn.tokenScope ?? ''}|${fingerprint}`;
  }

  /** The bearer to present, or null (mTLS alone). Fetches an OAuth2 token when none is cached. */
  private async bearer(refresh = false): Promise<string | null> {
    if (this.usesOAuth) {
      const cacheKey = this.tokenCacheKey();
      const cached = TOKENS.get(cacheKey);
      if (!refresh && cached && cached.expiresAt > Date.now()) return cached.token;
      TOKENS.delete(cacheKey);
      const fresh = await this.requestToken();
      TOKENS.set(cacheKey, fresh);
      return fresh.token;
    }
    if (this.conn.authKind === 'BEARER_TOKEN') {
      const token = this.conn.secrets.BEARER_TOKEN;
      if (!token) throw new Ss12000SourceError('SS12000_SECRET_MISSING');
      return token;
    }
    if (this.conn.authKind === 'MTLS_CLIENT_CERT') return this.conn.secrets.BEARER_TOKEN ?? null;
    throw new Ss12000SourceError('SS12000_SECRET_MISSING');
  }

  private async requestToken(): Promise<CachedToken> {
    const secret = this.conn.secrets.CLIENT_SECRET;
    const clientId = this.conn.clientId;
    const tokenUrl = this.conn.tokenUrl;
    if (!secret || !clientId || !tokenUrl) throw new Ss12000SourceError('SS12000_SECRET_MISSING');
    const form = new URLSearchParams({ grant_type: 'client_credentials' });
    if (this.conn.tokenScope) form.set('scope', this.conn.tokenScope);
    const headers: Record<string, string> = {
      'content-type': 'application/x-www-form-urlencoded',
      accept: 'application/json',
    };
    if (this.conn.tokenAuthStyle === 'FORM') {
      form.set('client_id', clientId);
      form.set('client_secret', secret);
    } else {
      const basic = `${encodeURIComponent(clientId)}:${encodeURIComponent(secret)}`;
      headers.authorization = `Basic ${Buffer.from(basic, 'utf8').toString('base64')}`;
    }
    this.stats.requests++;
    const response = await this.send(
      {
        method: 'POST',
        url: new URL(tokenUrl),
        headers,
        body: form.toString(),
        timeoutMs: this.opts.timeoutMs,
        maxBytes: 64 * 1024,
        ...this.tlsClient(),
      },
      this.options.policy,
    );
    if (response.status >= 300 && response.status < 400) throw new Ss12000SourceError('SS12000_REDIRECT_REFUSED');
    // The token endpoint's body is never read on a refusal: IST-like servers
    // may echo the request, secret included.
    if (response.status !== 200) throw new Ss12000SourceError('SS12000_TOKEN_REFUSED', response.status);
    let parsed: unknown;
    try {
      parsed = JSON.parse(response.body.toString('utf8'));
    } catch {
      throw new Ss12000SourceError('SS12000_TOKEN_REFUSED');
    }
    const token = (parsed as { access_token?: unknown }).access_token;
    const expiresIn = (parsed as { expires_in?: unknown }).expires_in;
    if (typeof token !== 'string' || token.length === 0 || token.length > 8192) {
      throw new Ss12000SourceError('SS12000_TOKEN_REFUSED');
    }
    const seconds = typeof expiresIn === 'number' && Number.isFinite(expiresIn) ? expiresIn : 300;
    return { token, expiresAt: Date.now() + Math.max(0, seconds - 60) * 1000 };
  }

  /** Obtains a token (or checks the stored one is there): "Testa anslutning"'s first half. */
  async authenticate(): Promise<void> {
    this.tlsClient();
    await this.bearer(true);
  }

  private url(path: string, query: Query): URL {
    const url = new URL(`${this.conn.baseUrl}${path}`);
    for (const [key, value] of query) url.searchParams.append(key, value);
    return url;
  }

  /** One JSON call with auth, retries and the 401 refresh. */
  async call(method: 'GET' | 'POST', path: string, query: Query = [], body?: unknown): Promise<unknown> {
    let refreshed = false;
    let retries = 0;
    for (;;) {
      const token = await this.bearer();
      const headers: Record<string, string> = { accept: 'application/json' };
      if (token) headers.authorization = `Bearer ${token}`;
      if (body !== undefined) headers['content-type'] = 'application/json';
      this.stats.requests++;
      const response = await this.send(
        {
          method,
          url: this.url(path, query),
          headers,
          body: body === undefined ? undefined : JSON.stringify(body),
          timeoutMs: this.opts.timeoutMs,
          maxBytes: this.opts.maxBytes,
          ...this.tlsClient(),
        },
        this.options.policy,
      );
      if (!this.providerClock) {
        const date = response.headers.date;
        const at = typeof date === 'string' ? Date.parse(date) : NaN;
        this.providerClock = Number.isNaN(at) ? new Date() : new Date(at);
      }
      const { status } = response;
      if (status === 401 && this.usesOAuth && !refreshed) {
        refreshed = true;
        await this.bearer(true);
        continue;
      }
      if ((status === 429 || status === 503) && retries < this.opts.retryDelaysMs.length) {
        const wait = retryAfterMs(response, this.opts.maxRetryAfterMs) ?? this.opts.retryDelaysMs[retries] ?? 0;
        retries++;
        this.stats.retries++;
        await this.opts.sleep(wait);
        continue;
      }
      if (status >= 300 && status < 400) throw new Ss12000SourceError('SS12000_REDIRECT_REFUSED', status);
      if (status === 401) throw new Ss12000SourceError('SS12000_UNAUTHORIZED', status);
      if (status === 403) throw new Ss12000SourceError('SS12000_FORBIDDEN', status);
      if (status === 429) throw new Ss12000SourceError('SS12000_RATE_LIMITED', status);
      if (status < 200 || status >= 300) throw new Ss12000SourceError(`SS12000_HTTP_${status}`, status);
      const type = response.headers['content-type'];
      if (typeof type !== 'string' || !/json/i.test(type)) throw new Ss12000SourceError('SS12000_NOT_JSON');
      try {
        return JSON.parse(response.body.toString('utf8'));
      } catch {
        throw new Ss12000SourceError('SS12000_INVALID_JSON');
      }
    }
  }

  /**
   * Every item of a paged list resource, walked per S1: filters and limit on
   * the first request, then pageToken and limit only.
   */
  async list(path: string, query: Query, limit: number, maxItems = Number.POSITIVE_INFINITY): Promise<unknown[]> {
    const items: unknown[] = [];
    const seen = new Set<string>();
    let pageToken: string | null = null;
    for (let page = 0; ; page++) {
      if (page >= this.opts.maxPages) throw new Ss12000SourceError('SS12000_PAGE_LOOP');
      const pageQuery: Query =
        pageToken === null ? [...query, ['limit', String(limit)]] : [['pageToken', pageToken], ['limit', String(limit)]];
      const body = await this.call('GET', path, pageQuery);
      this.stats.pages++;
      const data = (body as { data?: unknown } | null)?.data;
      if (!Array.isArray(data)) throw new Ss12000SourceError('SS12000_INVALID_RESPONSE');
      items.push(...data);
      const next = (body as { pageToken?: unknown }).pageToken;
      if (next === null || next === undefined || next === '' || items.length >= maxItems) return items;
      if (typeof next !== 'string' || seen.has(next)) throw new Ss12000SourceError('SS12000_PAGE_LOOP');
      seen.add(next);
      pageToken = next;
    }
  }

  /** GET /deletedEntities, walked like a list; the `data` object of every page merged. */
  async deletedEntities(after: Date, entities: readonly string[], limit: number): Promise<unknown[]> {
    const pages: unknown[] = [];
    const seen = new Set<string>();
    let pageToken: string | null = null;
    for (let page = 0; ; page++) {
      if (page >= this.opts.maxPages) throw new Ss12000SourceError('SS12000_PAGE_LOOP');
      const query: Query =
        pageToken === null
          ? [['after', after.toISOString()], ...entities.map((entity): [string, string] => ['entities', entity]), ['limit', String(limit)]]
          : [['pageToken', pageToken], ['limit', String(limit)]];
      const body = await this.call('GET', '/deletedEntities', query);
      this.stats.pages++;
      const data = (body as { data?: unknown } | null)?.data;
      if (typeof data !== 'object' || data === null || Array.isArray(data)) throw new Ss12000SourceError('SS12000_INVALID_RESPONSE');
      pages.push(data);
      const next = (body as { pageToken?: unknown }).pageToken;
      if (next === null || next === undefined || next === '') return pages;
      if (typeof next !== 'string' || seen.has(next)) throw new Ss12000SourceError('SS12000_PAGE_LOOP');
      seen.add(next);
      pageToken = next;
    }
  }

  /**
   * POST /persons/lookup {ids}: S1 answers PersonsExpandedArray, a bare
   * array; a provider wrapping it in {data} is read too.
   */
  async lookupPersons(ids: string[]): Promise<unknown[]> {
    const body = await this.call('POST', '/persons/lookup', [], { ids });
    if (Array.isArray(body)) return body;
    const data = (body as { data?: unknown } | null)?.data;
    if (Array.isArray(data)) return data;
    throw new Ss12000SourceError('SS12000_INVALID_RESPONSE');
  }
}
