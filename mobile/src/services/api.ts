import { getAccessToken } from './supabase';
import { assertSecureBaseUrl } from './network/secureUrl';

/**
 * The one way the app talks to the NestJS gateway.
 *
 * Reads that RLS can answer go straight to Supabase; what needs the gateway —
 * attendance ingestion, the family schedule (its teacher labels come from a
 * SECURITY DEFINER function), push registration and notice preferences —
 * comes through here. The base URL must be TLS (secureUrl), the bearer is the
 * Supabase session's, and a refusal carries the gateway's machine-readable
 * `code` so a screen can say it in the reader's language rather than show the
 * gateway's Swedish sentence.
 */

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly code?: string,
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
}

function baseUrl(): string {
  const raw = process.env['EXPO_PUBLIC_API_BASE_URL'];
  if (!raw) throw new ApiError(0, 'EXPO_PUBLIC_API_BASE_URL is not set.', 'NOT_CONFIGURED');
  return assertSecureBaseUrl(raw, 'EXPO_PUBLIC_API_BASE_URL').replace(/\/+$/, '');
}

/** JSON in, JSON out; 204 resolves to undefined. Throws ApiError on anything else. */
export async function apiRequest<T>(path: string, options: ApiRequestOptions = {}): Promise<T> {
  const url = `${baseUrl()}${path}`;
  const token = options.token ?? (await getAccessToken());
  if (!token) throw new ApiError(401, 'Not authenticated.', 'NOT_AUTHENTICATED');

  const headers: Record<string, string> = { Authorization: `Bearer ${token}` };
  if (options.body !== undefined) headers['Content-Type'] = 'application/json';

  const response = await fetch(url, {
    method: options.method ?? 'GET',
    headers,
    ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
    ...(options.signal ? { signal: options.signal } : {}),
  });

  if (!response.ok) {
    let code: string | undefined;
    let message = `HTTP ${response.status}`;
    try {
      const problem = (await response.json()) as { code?: unknown; message?: unknown; detail?: unknown };
      if (typeof problem.code === 'string') code = problem.code;
      const text = typeof problem.detail === 'string' ? problem.detail : problem.message;
      if (typeof text === 'string') message = text;
    } catch {
      // Not JSON: the status is all there is.
    }
    throw new ApiError(response.status, message, code);
  }
  if (response.status === 204) return undefined as T;
  const text = await response.text();
  return (text ? JSON.parse(text) : undefined) as T;
}
