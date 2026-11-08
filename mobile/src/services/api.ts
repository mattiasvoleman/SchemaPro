import { getAccessToken } from './supabase';
import { assertSecureBaseUrl } from './network/secureUrl';

/**
 * The one way the app talks to the NestJS gateway.
 *
 * Every read of another person's data comes through here, and the gateway
 * records it in the read log (Läslogg): a guardian's children, their absence
 * reports and leave requests, a lesson's roster, the family schedule (its
 * teacher labels come from a SECURITY DEFINER function). So do the writes
 * beside them, where the gateway derives the school and the reporter rather
 * than taking the phone's word, and attendance ingestion, push registration
 * and notice preferences. What still reads Supabase directly under RLS is the
 * signed-in person's own row (their profile, authService), their own notices
 * and the schedule tables. The base URL must be TLS (secureUrl), the bearer is
 * the Supabase session's, and a refusal carries the gateway's machine-readable
 * `code` so a screen can say it in the reader's language rather than show the
 * gateway's Swedish sentence.
 */

/**
 * Sent on every request, a public one too: the gateway records the channel of
 * a read as APP from it. It describes the client to whoever reads the log and
 * grants nothing — any caller can send it. The app is no browser, so a custom
 * header costs no CORS preflight. The name is from before the product was
 * renamed Rastra; the gateway reads it by this name, so it stays.
 */
export const CLIENT_HEADER = 'X-SchemaPro-Client';

/** The values a refusal's sentence substitutes (the gateway sends them flat, beside a code). */
export type ApiErrorParams = Readonly<Record<string, string | number>>;

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly code?: string,
    /** The refusal's `params` (LEAVE_REQUEST_TOO_LATE names `days`); only ever beside a code. */
    readonly params?: ApiErrorParams,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export interface ApiRequestOptions {
  readonly method?: 'GET' | 'POST' | 'PUT' | 'DELETE';
  readonly body?: unknown;
  readonly signal?: AbortSignal;
  /** A bearer the caller already holds (the sync worker reads it once per cycle). */
  readonly token?: string;
  /**
   * A public route that takes no bearer (/public/v1/…): the sign-in screen's
   * school-account lookup, before anyone is signed in. Nothing is sent but
   * the request itself.
   */
  readonly anonymous?: true;
}

function baseUrl(): string {
  const raw = process.env['EXPO_PUBLIC_API_BASE_URL'];
  if (!raw) throw new ApiError(0, 'EXPO_PUBLIC_API_BASE_URL is not set.', 'NOT_CONFIGURED');
  return assertSecureBaseUrl(raw, 'EXPO_PUBLIC_API_BASE_URL').replace(/\/+$/, '');
}

/** A refusal's flat string and number params; anything else the body carried under that name is dropped. */
function paramsOf(raw: unknown): Record<string, string | number> | undefined {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const kept: Record<string, string | number> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (typeof value === 'string' || (typeof value === 'number' && Number.isFinite(value))) kept[key] = value;
  }
  return Object.keys(kept).length > 0 ? kept : undefined;
}

/** JSON in, JSON out; 204 resolves to undefined. Throws ApiError on anything else. */
export async function apiRequest<T>(path: string, options: ApiRequestOptions = {}): Promise<T> {
  const url = `${baseUrl()}${path}`;
  const headers: Record<string, string> = { [CLIENT_HEADER]: 'app' };
  if (!options.anonymous) {
    const token = options.token ?? (await getAccessToken());
    if (!token) throw new ApiError(401, 'Not authenticated.', 'NOT_AUTHENTICATED');
    headers['Authorization'] = `Bearer ${token}`;
  }
  if (options.body !== undefined) headers['Content-Type'] = 'application/json';

  const response = await fetch(url, {
    method: options.method ?? 'GET',
    headers,
    ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
    ...(options.signal ? { signal: options.signal } : {}),
  });

  if (!response.ok) {
    let code: string | undefined;
    let params: Record<string, string | number> | undefined;
    let message = `HTTP ${response.status}`;
    try {
      const problem = (await response.json()) as { code?: unknown; params?: unknown; message?: unknown; detail?: unknown };
      if (typeof problem.code === 'string') code = problem.code;
      if (code !== undefined) params = paramsOf(problem.params);
      const text = typeof problem.detail === 'string' ? problem.detail : problem.message;
      if (typeof text === 'string') message = text;
    } catch {
      // Not JSON: the status is all there is.
    }
    throw new ApiError(response.status, message, code, params);
  }
  if (response.status === 204) return undefined as T;
  const text = await response.text();
  return (text ? JSON.parse(text) : undefined) as T;
}
