import { createClient } from "@/utils/supabase/client";

/**
 * Typed client for the NestJS gateway. All mutations and AI actions go
 * through this API; reads happen directly against Supabase under RLS.
 */

// Trailing slashes are stripped: every `path` below already starts with one,
// and the resulting `//api/v1/...` is a different route that the API 404s.
const API_BASE_URL = process.env.NEXT_PUBLIC_API_BASE_URL?.replace(/\/+$/, "");

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    /**
     * The gateway's machine-readable reason, when it sends one.
     *
     * The status alone cannot tell two 409s apart, and they ask for different
     * things of the reader: ROOM_PROPOSAL_STALE means "the schedule moved,
     * compute again", while a clash is a message to show. The message is
     * English prose written for a log, so it is no key to branch on.
     */
    public readonly code?: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

async function authHeader(): Promise<Record<string, string>> {
  const supabase = createClient();
  const {
    data: { session },
  } = await supabase.auth.getSession();
  if (!session) {
    throw new ApiError(401, "Not authenticated.");
  }
  return { Authorization: `Bearer ${session.access_token}` };
}

async function request<T>(
  method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE",
  path: string,
  body?: unknown,
): Promise<T> {
  if (!API_BASE_URL) {
    throw new ApiError(0, "NEXT_PUBLIC_API_BASE_URL is not configured.");
  }

  const headers: Record<string, string> = await authHeader();
  if (body !== undefined) {
    headers["Content-Type"] = "application/json";
  }

  const response = await fetch(`${API_BASE_URL}${path}`, {
    method,
    headers,
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });

  if (!response.ok) {
    let detail = `HTTP ${response.status}`;
    let code: string | undefined;
    try {
      const problem = (await response.json()) as {
        detail?: string;
        message?: string;
        code?: unknown;
      };
      detail = problem.detail ?? problem.message ?? detail;
      if (typeof problem.code === "string") code = problem.code;
    } catch {
      // Non-JSON error body; keep the generic message.
    }
    throw new ApiError(response.status, detail, code);
  }

  if (response.status === 204) {
    return undefined as T;
  }
  return (await response.json()) as T;
}

export const api = {
  get: <T>(path: string) => request<T>("GET", path),
  post: <T>(path: string, body?: unknown) => request<T>("POST", path, body),
  put: <T>(path: string, body?: unknown) => request<T>("PUT", path, body),
  patch: <T>(path: string, body?: unknown) => request<T>("PATCH", path, body),
  delete: <T>(path: string) => request<T>("DELETE", path),
};
