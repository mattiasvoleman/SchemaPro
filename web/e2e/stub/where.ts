import { ROUTE_FILES } from "./fixtures/gateway";

/**
 * Where a request the stub could not answer gets its fixture, as one line a
 * failing run prints — so whoever adds a page with a new read knows which
 * file to open:
 *
 *  - PostgREST (`/rest/v1/<Table>`): a table in e2e/stub/fixtures/tables.ts;
 *  - the gateway (`/api/…`, `/public/…`): a route in the area file whose
 *    routes share the most leading segments with the path, or a new
 *    gateway-<area>.ts listed in gateway.ts when none does.
 *
 * The pattern it suggests writes ids as `:id`. ASCII only: the line travels
 * in a response header (x-stub-where), where Node refuses anything else.
 */

const FIXTURES = "e2e/stub/fixtures";
const ID = /^(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[A-Za-z0-9_-]{24,})$/i;

const segmentsOf = (path: string) => path.split("/").filter(Boolean);

export function whereToStub(method: string, path: string): string {
  const table = /^\/rest\/v1\/([A-Za-z_]+)$/.exec(path)?.[1];
  if (table) return `add a "${table}" table to ${FIXTURES}/tables.ts (rows as in the database; embeds resolve by naming)`;
  if (!path.startsWith("/api/") && !path.startsWith("/public/")) return `answer it in e2e/stub/server.ts`;

  const segments = segmentsOf(path);
  const pattern = `/${segments.map((segment) => (ID.test(segment) ? ":id" : segment)).join("/")}`;
  let best: { file: string; shared: number } | null = null;
  for (const { file, routes } of ROUTE_FILES) {
    for (const candidate of routes) {
      const theirs = segmentsOf(candidate.pattern);
      let shared = 0;
      while (shared < Math.min(theirs.length, segments.length) && theirs[shared] === segments[shared]) shared++;
      if (!best || shared > best.shared) best = { file, shared };
    }
  }
  // /api/v1 is shared by every route; an area shares its resource too.
  const resource = segments[2] ?? segments[1] ?? "area";
  const into =
    best && best.shared >= 3
      ? `${FIXTURES}/${best.file}`
      : `a new ${FIXTURES}/gateway-${resource}.ts, listed in ${FIXTURES}/gateway.ts`;
  return `add route("${method}", "${pattern}", ...) to ${into}`;
}
