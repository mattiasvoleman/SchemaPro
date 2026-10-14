import type { SignedInPerson } from "./sessions";

/**
 * The gateway half of the stub: a list of `[method, path pattern, handler]`.
 * A pattern is the gateway's own path with `:name` segments, written as the
 * web app's lib/ files call it (`/api/v1/academic-years/:id/rollover-preview`).
 * A handler returns the JSON body, or a Reply for another status.
 */

export interface GatewayContext {
  person: SignedInPerson | null;
  params: Record<string, string>;
  query: URLSearchParams;
  body: unknown;
}

export class Reply {
  constructor(
    public readonly status: number,
    public readonly body?: unknown,
    /**
     * A shape the fixtures do not model (yet): answered, but marked as a
     * stub miss, so a page that reaches it fails the suite rather than
     * passing axe on its error state.
     */
    public readonly options: { miss?: boolean } = {},
  ) {}
}

export type GatewayHandler = (context: GatewayContext) => unknown;
export type GatewayMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

export interface GatewayRoute {
  method: GatewayMethod;
  pattern: string;
  handler: GatewayHandler;
}

export const route = (method: GatewayMethod, pattern: string, handler: GatewayHandler): GatewayRoute => ({
  method,
  pattern,
  handler,
});

/** A literal segment beats a `:param` one, so `/years/current` wins over `/years/:id`. */
export function matchGateway(
  routes: GatewayRoute[],
  method: string,
  path: string,
): { route: GatewayRoute; params: Record<string, string> } | null {
  const segments = path.split("/").filter(Boolean);
  let best: { route: GatewayRoute; params: Record<string, string>; literals: number } | null = null;
  for (const candidate of routes) {
    if (candidate.method !== method) continue;
    const pattern = candidate.pattern.split("/").filter(Boolean);
    if (pattern.length !== segments.length) continue;
    const params: Record<string, string> = {};
    let literals = 0;
    let ok = true;
    for (let index = 0; index < pattern.length; index++) {
      const part = pattern[index]!;
      if (part.startsWith(":")) {
        params[part.slice(1)] = decodeURIComponent(segments[index]!);
      } else if (part === segments[index]) {
        literals++;
      } else {
        ok = false;
        break;
      }
    }
    if (ok && (!best || literals > best.literals)) best = { route: candidate, params, literals };
  }
  return best ? { route: best.route, params: best.params } : null;
}
