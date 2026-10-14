import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { read, type Row } from "./postgrest";
import { authUser, personForToken, STUB_PORT } from "./sessions";
import { matchGateway, Reply } from "./gateway-routes";
import { rowScopes, tables } from "./fixtures/tables";
import { gatewayRoutes } from "./fixtures/gateway";

/**
 * One local server that stands in for both of the app's backends while the
 * browser suites run: Supabase (auth and PostgREST) and the NestJS gateway.
 * playwright.config.ts builds the app against it and starts it in
 * globalSetup.
 *
 * It has to be a real server, not page.route(): the (app) layout resolves the
 * session on the Next.js server, which Playwright's interception never sees.
 *
 * A request nothing here answers gets a 404 marked `x-stub: miss`, and the
 * signed-in suites fail on any such response, naming the path. So a page that
 * starts reading something new fails loudly until fixtures/ gains it, instead
 * of passing axe on its error state.
 */

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS",
  "access-control-allow-headers": "*",
  "access-control-expose-headers": "content-range, x-stub",
  "access-control-max-age": "600",
};

function send(response: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) {
  const payload = body === undefined ? "" : JSON.stringify(body);
  response.writeHead(status, {
    ...CORS,
    ...(body === undefined ? {} : { "content-type": "application/json; charset=utf-8" }),
    ...headers,
  });
  response.end(payload);
}

async function readBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  if (chunks.length === 0) return undefined;
  const text = Buffer.concat(chunks).toString("utf8");
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

const bearer = (request: IncomingMessage) => request.headers.authorization?.replace(/^Bearer\s+/i, "") ?? null;

/** Each miss is logged once, so the runner's output names what to add. */
const missed = new Set<string>();

/**
 * Every miss of the run, the Next.js server's own reads included — which no
 * spec sees as a response. globalSetup's teardown fails the run on any.
 */
export const missedRequests = () => [...missed];
/**
 * Answers a request no fixture covers, and counts it when it is the run's
 * own: signed in as one of the fixture people, as every read of a signed-in
 * page is, from the browser or from the Next.js server, or Schemavisaren's
 * anonymous read under /public/. Anything else is some other process on the
 * machine that found the port — another session's test sent DELETE
 * /api/v1/cover/pool/<its own fixture id> here once — and is answered and
 * logged but fails nothing.
 */
function miss(request: IncomingMessage, response: ServerResponse, method: string, path: string) {
  const key = `${method} ${path}`;
  if (!personForToken(bearer(request)) && !path.startsWith("/public/")) {
    console.warn(`[stub] not this run's, not counted: ${key}`);
  } else if (!missed.has(key)) {
    missed.add(key);
    console.warn(`[stub] no fixture for ${key}`);
  }
  send(response, 404, { message: `No stub fixture for ${key}` }, { "x-stub": "miss" });
}

async function handle(request: IncomingMessage, response: ServerResponse) {
  const method = request.method ?? "GET";
  const url = new URL(request.url ?? "/", "http://stub");
  const path = url.pathname;

  if (method === "OPTIONS") {
    response.writeHead(204, CORS);
    response.end();
    return;
  }

  // --- Supabase Auth -------------------------------------------------------
  if (path === "/auth/v1/user" && method === "GET") {
    const person = personForToken(bearer(request));
    if (!person) {
      send(response, 401, { code: 401, error_code: "bad_jwt", msg: "invalid JWT" });
      return;
    }
    send(response, 200, authUser(person));
    return;
  }
  if (path === "/auth/v1/token") {
    // The login form's error state (visual baseline login-en-error): any
    // password is wrong, as it was against the old placeholder project.
    send(response, 400, {
      code: 400,
      error_code: "invalid_credentials",
      msg: "Invalid login credentials",
    });
    return;
  }
  if (path === "/auth/v1/logout") {
    send(response, 204, undefined);
    return;
  }

  // --- PostgREST -----------------------------------------------------------
  const rest = /^\/rest\/v1\/([A-Za-z_]+)$/.exec(path);
  if (rest && rest[1] !== "rpc") {
    const table = rest[1]!;
    if (!(table in tables)) {
      miss(request, response, method, path);
      return;
    }
    if (method === "GET" || method === "HEAD") {
      // RLS, roughly: a pupil or a guardian reads the family tables' own rows.
      const person = personForToken(bearer(request));
      const scope = rowScopes[table];
      const visible =
        scope && person && (person.persona === "student" || person.persona === "guardian")
          ? { ...tables, [table]: (tables[table] as Row[]).filter((row) => scope(row, person)) }
          : tables;
      const result = read(table, url.searchParams, {
        accept: request.headers.accept,
        range: request.headers.range,
      }, visible);
      send(response, result.status, method === "HEAD" ? undefined : result.body, {
        "content-range": result.contentRange,
        "x-stub": "fixture",
      });
      return;
    }
    // A write: accepted and forgotten. The suites scan pages, they do not
    // save anything.
    await readBody(request);
    send(response, method === "POST" ? 201 : 204, method === "POST" ? [] : undefined, { "x-stub": "fixture" });
    return;
  }

  // --- Realtime: refused quietly; no page needs it to render. --------------
  if (path.startsWith("/realtime/") || path.startsWith("/socket.io")) {
    send(response, 404, undefined, { "x-stub": "ignored" });
    return;
  }

  // --- The gateway ---------------------------------------------------------
  // /public/v1 is Schemavisaren's door, read by the Next.js server.
  if (path.startsWith("/api/") || path.startsWith("/public/")) {
    const match = matchGateway(gatewayRoutes, method, path);
    if (!match) {
      miss(request, response, method, path);
      return;
    }
    const body = await readBody(request);
    const result = match.route.handler({
      person: personForToken(bearer(request)),
      params: match.params,
      query: url.searchParams,
      body,
    });
    if (result instanceof Reply) {
      if (result.options.miss) {
        miss(request, response, method, path);
        return;
      }
      send(response, result.status, result.body, { "x-stub": "fixture" });
    } else {
      send(response, result === undefined ? 204 : 200, result, { "x-stub": "fixture" });
    }
    return;
  }

  miss(request, response, method, path);
}

export function startStub(port = STUB_PORT): Promise<Server> {
  const server = createServer((request, response) => {
    handle(request, response).catch((error: unknown) => {
      console.error("[stub] handler failed", request.method, request.url, error);
      if (!response.headersSent) send(response, 500, { message: String(error) }, { "x-stub": "error" });
    });
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolve(server));
  });
}
