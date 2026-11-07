/*
 * Schemavisaren on the web: what the gateway's GET public/v1/timetables/:token
 * answers, how the web server asks for it, and the arithmetic of the printed
 * week. The page (app/v/[token]/page.tsx) is a server component, so all of
 * this runs on the web server and none of it reaches the browser as script.
 *
 * WHAT THE DOCUMENT CAN HOLD is decided in the database
 * (app.public_timetable, migration 20261011120000) — a whitelist the API
 * cannot widen and this page does not either: times, subject, group names
 * (null for a group smaller than the school's minimum: drawn "Grupp"), room,
 * the teachers as the school chose to show them, cancelled (never in a
 * teacher's week, never with a cause), and "busy" for a lesson of named
 * pupils in a room's week. Never a note or an id, and never a pupil's name:
 * a pupil's own page (kind STUDENT, behind a code) names no group either.
 *
 * WHO MAY ASK, and which kinds are shown, is decided there too (the school's
 * lägen, 20270118090000): the same ONE 404 answers an unknown address, a kind
 * that is off, a viewer for staff, a hidden or protected schedule. The page
 * adds nothing to that, and asks again as a signed-in teacher or
 * administrator (staffViewerFetchOf) only when the anonymous answer was it.
 */

import { schoolHeaders } from "@/lib/school-choice";

// What an address may carry, and how it is read, is lib/viewer-token.ts's: here
// for the callers that have always imported it from this module.
export { codeForDisplay, TOKEN_PATTERN, viewerAddressOf, viewerTokenOf } from "@/lib/viewer-token";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

export type PublicKind = "GROUP" | "TEACHER" | "ROOM" | "STUDENT";

export interface PublicLesson {
  start: string;
  end: string;
  subject?: string | null;
  /** The lesson's own group first; null = a group too small to name. Empty on a pupil's page. */
  groups?: (string | null)[];
  room?: string | null;
  teachers?: string[];
  /** Absent in a teacher's week. */
  cancelled?: boolean;
  /** A room's lesson for named pupils: time only. */
  busy?: true;
}

export interface PublicDay {
  date: string;
  lessons: PublicLesson[];
  /** A class's meals, when the school shows them. */
  meals?: { start: string; end: string }[];
}

export interface PublicWeek {
  kind: PublicKind;
  /** The page's title; empty on a pupil's page whose link has no label ("Elevens schema" is the page's to say). */
  title: string;
  school: string;
  week: { from: string; to: string; isoWeek: string };
  days: PublicDay[];
}

export interface PublicIndex {
  /** A list of classes and groups, of teachers or of rooms; never of pupils. */
  kind: "GROUP" | "TEACHER" | "ROOM";
  school: string;
  targets: { id: string; label: string }[];
}

export type PublicDocument = PublicWeek | PublicIndex;

export const isIndex = (document: PublicDocument): document is PublicIndex => "targets" in document;

export interface ViewerQuery {
  target: string | null;
  date: string | null;
}

/** The query as the gateway takes it; anything malformed is dropped, not sent. */
export function viewerQueryOf(params: { target?: string | string[]; date?: string | string[] }): ViewerQuery {
  const one = (value: string | string[] | undefined) => (Array.isArray(value) ? value[0] : value) ?? null;
  const target = one(params.target);
  const date = one(params.date);
  return {
    target: target && UUID.test(target) ? target.toLowerCase() : null,
    date: date && isCalendarDay(date) ? date : null,
  };
}

/**
 * A real day, round-tripped: `Date.parse` accepts 2026-02-30 (V8 rolls it
 * into March), and the gateway answers its one 404 for such a date. Dropped
 * here, so the page shows the current week rather than "not available". The
 * gateway's isViewerDate, years 2000 to 2100 included, which the admin's
 * print set checks too.
 */
export function isCalendarDay(value: string): boolean {
  if (!DATE.test(value)) return false;
  const year = Number(value.slice(0, 4));
  if (year < 2000 || year > 2100) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

/**
 * The viewer's own address, as the web server forwards it for the gateway's
 * per-viewer rate limit: the RIGHTMOST X-Forwarded-For entry, the one the
 * platform's edge appended. Anything to its left is what the browser sent and
 * can be anything. Null when there is none.
 *
 * Behind more than one proxy that append their own address (a CDN in front
 * of the platform's edge) the rightmost entry is a proxy's, the same for
 * every visitor. `skipRight` is how many entries to the right of the
 * visitor's own those proxies have added (PUBLIC_VIEWER_TRUSTED_HOPS, 0 where
 * the platform's edge is the last; docs/DEPLOYMENT.md): the entry that many
 * from the right is taken. Null when there are not that many.
 */
export function clientIpOf(forwardedFor: string | null, skipRight = 0): string | null {
  if (!forwardedFor) return null;
  const hops = forwardedFor
    .split(",")
    .map((hop) => hop.trim())
    .filter(Boolean);
  const own = hops[hops.length - 1 - Math.max(0, Math.floor(skipRight))];
  return own && own.length <= 64 ? own : null;
}

/** PUBLIC_VIEWER_TRUSTED_HOPS as a count of proxies to skip: a whole number from 0 to 5, else 0. */
export function trustedHopsOf(value: string | undefined): number {
  const hops = Number(value);
  return Number.isInteger(hops) && hops >= 0 && hops <= 5 ? hops : 0;
}

export interface ViewerFetch {
  url: string;
  headers: Record<string, string>;
}

/**
 * What the web server asks the gateway. The proxy key and the client's
 * address travel together or not at all: the gateway trusts the address only
 * beside the key (PublicViewerThrottlerGuard), and without a key every family
 * shares the web server's bucket — which is why a deployment sets
 * PUBLIC_VIEWER_PROXY_KEY on both services.
 */
export function viewerFetchOf(
  base: string,
  token: string,
  query: ViewerQuery,
  forwardedFor: string | null,
  proxyKey: string | undefined,
  skipHops = 0,
): ViewerFetch {
  const search = new URLSearchParams();
  if (query.target) search.set("target", query.target);
  if (query.date) search.set("date", query.date);
  const qs = search.toString();
  const headers: Record<string, string> = { Accept: "application/json" };
  const client = clientIpOf(forwardedFor, skipHops);
  if (proxyKey && client) {
    headers["X-Viewer-Proxy-Key"] = proxyKey;
    headers["X-Viewer-Client-Ip"] = client;
  }
  return {
    url: `${base.replace(/\/+$/, "")}/public/v1/timetables/${encodeURIComponent(token)}${qs ? `?${qs}` : ""}`,
    headers,
  };
}

/**
 * What the web server asks the gateway's signed-in twin of the viewer
 * (GET /api/v1/schemavisaren/:token, for a school whose viewer is for staff):
 * the same question, as the teacher or administrator who holds the session.
 * The access token is only forwarded — the gateway verifies it — and the
 * school the browser chose is named as everywhere else (lib/school-choice.ts).
 * No proxy key and no client address: the twin is rate-limited by the person.
 */
export function staffViewerFetchOf(
  base: string,
  token: string,
  query: ViewerQuery,
  accessToken: string,
  school: string | null | undefined,
): ViewerFetch {
  const search = new URLSearchParams();
  if (query.target) search.set("target", query.target);
  if (query.date) search.set("date", query.date);
  const qs = search.toString();
  return {
    url: `${base.replace(/\/+$/, "")}/api/v1/schemavisaren/${encodeURIComponent(token)}${qs ? `?${qs}` : ""}`,
    headers: { Accept: "application/json", Authorization: `Bearer ${accessToken}`, ...schoolHeaders(school) },
  };
}

export type ViewerOutcome =
  | { kind: "document"; document: PublicDocument }
  | { kind: "notFound" }
  | { kind: "busy" }
  | { kind: "unavailable" };

/** The gateway's answer, as the page needs it: one "not found" for every 404, as the gateway sends one. */
export async function readViewerResponse(response: Response): Promise<ViewerOutcome> {
  if (response.status === 404) return { kind: "notFound" };
  if (response.status === 429) return { kind: "busy" };
  if (!response.ok) return { kind: "unavailable" };
  try {
    return { kind: "document", document: (await response.json()) as PublicDocument };
  } catch {
    return { kind: "unavailable" };
  }
}

/**
 * The twin's answer, as the page needs it. A 401 and a 403 (an expired
 * session, a role that is not staff's) and the 404 are all the one "not
 * found": the visitor is no better placed than before, and learns nothing
 * about which of the reasons it was.
 */
export async function readStaffViewerResponse(response: Response): Promise<ViewerOutcome> {
  if (response.status === 401 || response.status === 403) return { kind: "notFound" };
  return readViewerResponse(response);
}

const toMinutes = (clock: string): number => {
  const [hours, minutes] = clock.split(":").map(Number);
  return (hours ?? 0) * 60 + (minutes ?? 0);
};

export const DEFAULT_DAY = { start: 8 * 60, end: 16 * 60 };

/**
 * The hours the grid spans: from the earliest start to the latest end of the
 * week's lessons and meals, rounded out to whole hours, never narrower than
 * 08–16 — so an empty week, and a week of one short day, still read as a
 * school week.
 */
export function weekSpan(days: readonly PublicDay[]): { start: number; end: number } {
  let start = DEFAULT_DAY.start;
  let end = DEFAULT_DAY.end;
  for (const day of days) {
    for (const item of [...day.lessons, ...(day.meals ?? [])]) {
      start = Math.min(start, toMinutes(item.start));
      end = Math.max(end, toMinutes(item.end));
    }
  }
  return { start: Math.floor(start / 60) * 60, end: Math.ceil(end / 60) * 60 };
}

/** Monday to Friday always; a weekend day only when something is on it. */
export function shownDays<D extends PublicDay>(days: readonly D[]): D[] {
  return days.filter((day, index) => index < 5 || day.lessons.length > 0 || (day.meals?.length ?? 0) > 0);
}

/** Where an item sits in the day's column, in percent of the span. */
export function placement(item: { start: string; end: string }, span: { start: number; end: number }) {
  const total = span.end - span.start;
  return {
    top: ((toMinutes(item.start) - span.start) / total) * 100,
    height: ((toMinutes(item.end) - toMinutes(item.start)) / total) * 100,
  };
}

/** The lessons with their minutes, for lib/day-lanes.ts. */
export function timed<T extends PublicLesson>(lessons: readonly T[]): Array<T & { startMinutes: number; endMinutes: number }> {
  return lessons.map((lesson) => ({ ...lesson, startMinutes: toMinutes(lesson.start), endMinutes: toMinutes(lesson.end) }));
}

export function shiftWeek(monday: string, weeks: number): string {
  return new Date(Date.parse(`${monday}T00:00:00Z`) + weeks * 7 * 86_400_000).toISOString().slice(0, 10);
}

/**
 * Whether the week before `monday` is one the gateway still shows: a share
 * link reads this week and last week, never further back (20261011133000).
 * Judged on the UTC day the server renders on, which can trail the school's
 * by an hour at midnight — then the link leads to the shared not-found page.
 */
export function canGoBack(monday: string, today: string): boolean {
  const at = Date.parse(`${today}T00:00:00Z`);
  const thisMonday = new Date(at - ((new Date(at).getUTCDay() + 6) % 7) * 86_400_000).toISOString().slice(0, 10);
  return shiftWeek(monday, -1) >= shiftWeek(thisMonday, -1);
}

/**
 * A link inside the viewer: the same token, with what to show. Inside the
 * embedded frame (`embed`), to the frame's own pages, so a reader paging
 * through the weeks stays in the school's website.
 */
export function viewerHref(
  token: string,
  params: { target?: string | null; date?: string | null; lang?: string | null },
  options: { embed?: boolean } = {},
): string {
  const search = new URLSearchParams();
  if (params.target) search.set("target", params.target);
  if (params.date) search.set("date", params.date);
  if (params.lang && params.lang !== "sv") search.set("lang", params.lang);
  const qs = search.toString();
  return `/v/${token}${options.embed ? "/embed" : ""}${qs ? `?${qs}` : ""}`;
}
