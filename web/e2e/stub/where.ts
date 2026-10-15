import { gatewayRoutes, ROUTE_FILES } from "./fixtures/gateway";
import { matchGateway } from "./gateway-routes";

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
 * A request the stub threw on says the same about the file that threw
 * (`whereItThrew`).
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

/** A thrown message as a header carries it: accents dropped, anything else not ASCII a "?". */
const ascii = (text: string) =>
  text
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^\x20-\x7e]/g, "?");

/**
 * Where to fix a request the stub threw on: the gateway file whose handler
 * threw, or the PostgREST emulator and its rows. A 500 from the stub is a
 * page rendering its error state, which axe would pass as readily as the
 * page, so it fails the run as a miss does.
 */
export function whereItThrew(method: string, path: string, error: unknown): string {
  const message = ascii(error instanceof Error ? error.message : String(error)).slice(0, 160);
  let file = "e2e/stub/server.ts";
  if (path.startsWith("/rest/v1/")) {
    file = `e2e/stub/postgrest.ts, or the table's rows or scope in ${FIXTURES}/tables.ts`;
  } else {
    const match = matchGateway(gatewayRoutes, method, path);
    const entry = match && ROUTE_FILES.find(({ routes }) => routes.includes(match.route));
    if (entry) file = `${FIXTURES}/${entry.file}`;
  }
  return `the stub threw "${message}"; fix it in ${file}`;
}
