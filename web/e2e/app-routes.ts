import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import type { Persona } from "./stub/sessions";
import { addDays, THIS_MONDAY } from "./stub/fixtures/calendar";
import { CALENDAR_LESSON_TEACHERS, CALENDAR_LESSONS, GROUPS, TEACHERS, YEAR } from "./stub/fixtures/world";

/**
 * Every signed-in page, and who it is checked as.
 *
 * `pagesOnDisk()` reads app/[locale]/(app) the way the router does, so a new
 * page under a known area is checked by axe from the day it lands. A page
 * outside every area below, with a `[param]` PARAMS has no value for, or
 * reading a query QUERY has no entry for, is not covered, and the signed-in
 * suite's coverage test fails naming it and the line to add here (see
 * `lacks`).
 *
 * Each page is checked as the role its layout lets in: /admin/* as the
 * administrator, /teacher/* as a teacher and so on (the role layouts send
 * everyone else to their own start page, so there is nothing else to see).
 * /notifications is everybody's and is checked as all four.
 */

const APP_DIR = path.join(__dirname, "..", "app", "[locale]", "(app)");

/** Every page.tsx under (app): its route path, `[param]` segments kept, and the file. */
export function pagesOnDisk(dir = APP_DIR, prefix = ""): Array<{ page: string; file: string }> {
  const found: Array<{ page: string; file: string }> = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) {
      // A route group, (name), adds nothing to the path.
      const segment = /^\(.*\)$/.test(entry) ? "" : `/${entry}`;
      found.push(...pagesOnDisk(full, prefix + segment));
    } else if (entry === "page.tsx") {
      found.push({ page: prefix || "/", file: full });
    }
  }
  return found.sort((a, b) => (a.page < b.page ? -1 : a.page > b.page ? 1 : 0));
}

export interface AppRoute {
  /** As on disk, `[param]` segments included; what the coverage test compares. */
  page: string;
  /** What the browser opens, params and query filled from the fixtures. */
  url: string;
  personas: Persona[];
}

const ALL: Persona[] = ["admin", "teacher", "student", "guardian"];

/** A lesson Anna teaches this week, for /teacher/attendance/[lessonId]. */
const annasLesson = CALENDAR_LESSONS.find(
  (lesson) =>
    lesson.status === "SCHEDULED" &&
    CALENDAR_LESSON_TEACHERS.some((row) => row.calendarLessonId === lesson.id && row.teacherId === TEACHERS.anna.id),
)!;

const PARAMS: Record<string, string> = {
  lessonId: annasLesson.id,
};

/**
 * The query each page that reads one is opened with: `searchParams` on a
 * server page, `location.search` on a client one. A page that needs its
 * query shows only its empty state without one, and axe then checks that
 * and nothing of the page. "" is a decision too: the page as the menu opens
 * it, where the query is an optional deep link.
 */
const QUERY: Record<string, string> = {
  // As /admin/years links it for this year, which already has its successor:
  // the wizard with the refusal that says so (gateway-family.ts).
  "/admin/years/rollover": `from=${YEAR.id}`,
  // As the staffing drawer links it: Anna's, this year.
  "/admin/staffing/uppdragsbeskrivning": `teacher=${TEACHERS.anna.id}&year=${YEAR.id}`,
  // As Min tjänst links it.
  "/teacher/tjanst/uppdragsbeskrivning": `year=${YEAR.id}`,
  // Today by day; ?date= and ?view=week come from the board's own controls.
  "/admin/cover": "",
  // Närvaro; ?tab= opens another tab.
  "/admin/reports": "",
  // The active year; ?year= comes from links that pick another.
  "/admin/requirements": "",
  "/admin/staffing": "",
  "/admin/timplan/tackning": "",
  // ?guardians= opens one pupil's guardians, from the integration review.
  "/admin/people": "",
  // Lektionslogg's klassbok, opened on 7A's week so axe reads the book itself.
  "/admin/klassbok": `group=${GROUPS.g7A.id}&from=${THIS_MONDAY}&to=${addDays(THIS_MONDAY, 4)}`,
  "/teacher/klassbok": `group=${GROUPS.g7A.id}&from=${THIS_MONDAY}&to=${addDays(THIS_MONDAY, 4)}`,
};

/** What makes a page.tsx read a query, the two ways (app) does it. */
const READS_QUERY = /\bsearchParams\b|\blocation\.search\b/;

const AREAS: Array<[prefix: string, personas: Persona[]]> = [
  ["/admin", ["admin"]],
  ["/teacher", ["teacher"]],
  ["/student", ["student"]],
  ["/guardian", ["guardian"]],
  ["/notifications", ALL],
  // Kalenderprenumeration: everybody's own, as Notiser is.
  ["/calendar-feed", ALL],
];

const personasFor = (page: string): Persona[] =>
  AREAS.find(([prefix]) => page === prefix || page.startsWith(`${prefix}/`))?.[1] ?? [];

/** The page with its params and query filled, or null when PARAMS lacks one. */
function urlFor(page: string): string | null {
  let missing = false;
  const url = page.replace(/\[([^\]]+)\]/g, (_, name: string) => {
    const value = PARAMS[name];
    if (!value) missing = true;
    return value ?? "";
  });
  const query = QUERY[page];
  return missing ? null : query ? `${url}?${query}` : url;
}

const HERE = "e2e/app-routes.ts";

/**
 * What a page the suite cannot open lacks, one line per addition, each
 * naming the constant and the file it is in; empty when the suite opens it.
 * Once it opens, a read the stub cannot answer fails the page's own test
 * with the fixture file to add it to (e2e/stub/where.ts).
 */
function lacks(page: string, readsQuery: boolean): string[] {
  const lines: string[] = [];
  if (personasFor(page).length === 0) {
    const area = `/${page.split("/")[1] ?? ""}`;
    lines.push(`add ["${area}", [<the personas its layout lets in>]] to AREAS in ${HERE}`);
  }
  for (const [, name] of page.matchAll(/\[([^\]]+)\]/g)) {
    if (!PARAMS[name!]) lines.push(`add "${name}": <a fixture id from e2e/stub/fixtures/world.ts> to PARAMS in ${HERE}`);
  }
  if (readsQuery && !(page in QUERY)) {
    lines.push(`add "${page}": "<the query its links open it with, or \"\" for none>" to QUERY in ${HERE}`);
  }
  return lines;
}

const ON_DISK = pagesOnDisk().map((entry) => ({ ...entry, readsQuery: READS_QUERY.test(readFileSync(entry.file, "utf8")) }));

export const PAGES: Array<{ page: string; url: string | null; personas: Persona[]; lacks: string[] }> = ON_DISK.map(
  ({ page, readsQuery }) => ({
    page,
    url: urlFor(page),
    personas: personasFor(page),
    lacks: lacks(page, readsQuery),
  }),
);

/** QUERY entries no page needs any more: each a line to take out. */
export const STALE_QUERIES: string[] = Object.keys(QUERY)
  .filter((page) => !ON_DISK.some((entry) => entry.page === page && entry.readsQuery))
  .map((page) => `remove "${page}" from QUERY in ${HERE}: no page.tsx there reads a query`);

/** The pages the suite can open, with whom. */
export const APP_ROUTES: AppRoute[] = PAGES.flatMap(({ page, url, personas }) =>
  url !== null && personas.length > 0 ? [{ page, url, personas }] : [],
);
