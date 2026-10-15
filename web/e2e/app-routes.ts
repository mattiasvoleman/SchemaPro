import { readdirSync, statSync } from "node:fs";
import path from "node:path";
import type { Persona } from "./stub/sessions";
import { CALENDAR_LESSON_TEACHERS, CALENDAR_LESSONS, TEACHERS } from "./stub/fixtures/world";

/**
 * Every signed-in page, and who it is checked as.
 *
 * `pagesOnDisk()` reads app/[locale]/(app) the way the router does, so a new
 * page under a known area is checked by axe from the day it lands. A page
 * outside every area below, or with a `[param]` PARAMS has no value for, is
 * not covered, and the signed-in suite's coverage test fails naming it and
 * the line to add here (see `lacks`).
 *
 * Each page is checked as the role its layout lets in: /admin/* as the
 * administrator, /teacher/* as a teacher and so on (the role layouts send
 * everyone else to their own start page, so there is nothing else to see).
 * /notifications is everybody's and is checked as all four.
 */

const APP_DIR = path.join(__dirname, "..", "app", "[locale]", "(app)");

/** Route paths of every page.tsx under (app), with `[param]` segments kept. */
export function pagesOnDisk(dir = APP_DIR, prefix = ""): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) {
      // A route group, (name), adds nothing to the path.
      const segment = /^\(.*\)$/.test(entry) ? "" : `/${entry}`;
      found.push(...pagesOnDisk(full, prefix + segment));
    } else if (entry === "page.tsx") {
      found.push(prefix || "/");
    }
  }
  return found.sort();
}

export interface AppRoute {
  /** As on disk, `[param]` segments included; what the coverage test compares. */
  page: string;
  /** What the browser opens, params filled from the fixtures. */
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

const AREAS: Array<[prefix: string, personas: Persona[]]> = [
  ["/admin", ["admin"]],
  ["/teacher", ["teacher"]],
  ["/student", ["student"]],
  ["/guardian", ["guardian"]],
  ["/notifications", ALL],
];

const personasFor = (page: string): Persona[] =>
  AREAS.find(([prefix]) => page === prefix || page.startsWith(`${prefix}/`))?.[1] ?? [];

/** The page with its params filled, or null when PARAMS lacks one. */
function urlFor(page: string): string | null {
  let missing = false;
  const url = page.replace(/\[([^\]]+)\]/g, (_, name: string) => {
    const value = PARAMS[name];
    if (!value) missing = true;
    return value ?? "";
  });
  return missing ? null : url;
}

const HERE = "e2e/app-routes.ts";

/**
 * What a page the suite cannot open lacks, one line per addition, each
 * naming the constant and the file it is in; empty when the suite opens it.
 * Once it opens, a read the stub cannot answer fails the page's own test
 * with the fixture file to add it to (e2e/stub/where.ts).
 */
function lacks(page: string): string[] {
  const lines: string[] = [];
  if (personasFor(page).length === 0) {
    const area = `/${page.split("/")[1] ?? ""}`;
    lines.push(`add ["${area}", [<the personas its layout lets in>]] to AREAS in ${HERE}`);
  }
  for (const [, name] of page.matchAll(/\[([^\]]+)\]/g)) {
    if (!PARAMS[name!]) lines.push(`add "${name}": <a fixture id from e2e/stub/fixtures/world.ts> to PARAMS in ${HERE}`);
  }
  return lines;
}

export const PAGES: Array<{ page: string; url: string | null; personas: Persona[]; lacks: string[] }> =
  pagesOnDisk().map((page) => ({
    page,
    url: urlFor(page),
    personas: personasFor(page),
    lacks: lacks(page),
  }));

/** The pages the suite can open, with whom. */
export const APP_ROUTES: AppRoute[] = PAGES.flatMap(({ page, url, personas }) =>
  url !== null && personas.length > 0 ? [{ page, url, personas }] : [],
);
