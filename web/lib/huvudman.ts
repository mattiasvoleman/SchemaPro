import "server-only";

/**
 * The huvudman's own pages' gateway calls (Huvudman, 20261212090000), from
 * the server with the session's token and no school named: the routes under
 * /api/v1/huvudman hold every read and write to the login's membership, at
 * whichever school, if any, the session is.
 */

export type HuvudmanRole = "KOMMUNADMINISTRATOR" | "PLANERARE";

export interface MyHuvudman {
  id: string;
  name: string;
  organisationNumber: string | null;
  municipalityCode: string | null;
  role: HuvudmanRole;
  memberId: string;
}

export interface HuvudmanView extends MyHuvudman {
  schools: Array<{ id: string; name: string; slug: string; state: "OWNED" | "REQUESTED"; since: string; requestedBy: string | null }>;
  members: Array<{ id: string; email: string; firstName: string; lastName: string; role: HuvudmanRole; isActive: boolean; invited: boolean }>;
  keys: Array<{ id: string; name: string; scopes: string[]; createdAt: string; lastUsedAt: string | null; revokedAt: string | null }> | null;
  history: Array<{ at: string; kind: string; schoolId: string; schoolName: string; byMember: string | null; bySchool: boolean }>;
}

/** The read scopes a huvudman's key may hold (src/integration/ss12000-v2/scopes.ts HUVUDMAN_SCOPES). */
export const HUVUDMAN_SCOPES = [
  "organisations.read",
  "persons.read",
  "responsibles.read",
  "groups.read",
  "duties.read",
  "activities.read",
  "calendarEvents.read",
  "rooms.read",
  "syllabuses.read",
] as const;

const API_BASE_URL = process.env.NEXT_PUBLIC_API_BASE_URL?.replace(/\/+$/, "");

/**
 * How long a page waits for one of the gateway's reads: /huvudman reads
 * twice in a row, so at most 4 s before it says it could not read, as the
 * school switcher's second ask waits 2 s (lib/auth.ts).
 */
export const HUVUDMAN_READ_TIMEOUT_MS = 2000;

/**
 * A write waits longer: an invitation waits on Supabase sending its mail,
 * and a write cut short would say it failed although the gateway went on to
 * do it.
 */
export const HUVUDMAN_WRITE_TIMEOUT_MS = 10_000;

export interface GatewayAnswer<T> {
  status: number;
  body: T | null;
  /** The gateway's code, on a refusal. */
  code: string | null;
}

export async function huvudmanGateway<T>(
  accessToken: string | null,
  method: "GET" | "POST" | "PATCH" | "DELETE",
  path: string,
  body?: unknown,
): Promise<GatewayAnswer<T>> {
  if (!API_BASE_URL || !accessToken) return { status: 0, body: null, code: null };
  try {
    const response = await fetch(`${API_BASE_URL}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${accessToken}`,
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      cache: "no-store",
      signal: AbortSignal.timeout(method === "GET" ? HUVUDMAN_READ_TIMEOUT_MS : HUVUDMAN_WRITE_TIMEOUT_MS),
    });
    const text = await response.text();
    const parsed = text ? (JSON.parse(text) as unknown) : null;
    const code =
      !response.ok && parsed && typeof parsed === "object" && typeof (parsed as { code?: unknown }).code === "string"
        ? (parsed as { code: string }).code
        : null;
    return { status: response.status, body: response.ok ? (parsed as T) : null, code };
  } catch {
    return { status: 0, body: null, code: null };
  }
}
