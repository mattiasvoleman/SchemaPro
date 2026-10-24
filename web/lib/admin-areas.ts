/**
 * Roller i skolan, the web's copy: which administrator writes which area, and
 * which admin page belongs to which area.
 *
 * The matrix is the gateway's src/auth/admin-areas.ts and the database's
 * app.admin_profile_writes() (migration 20261110090000). This copy exists
 * because the web cannot import either; src/auth/admin-areas.spec.ts imports
 * it and fails when it differs from the gateway's. Keep it free of imports,
 * so that test can.
 *
 * The menu and the /admin guard read it. Neither is what refuses a write: the
 * gateway and the database do that. They spare a person pages whose every
 * button would answer 403.
 *
 * Läsbehörighet adds the läsare (LASARE), who writes no area and decides
 * nothing. It would have no page left, so it opens every page it may read
 * read-only instead (readOnlyPages): a notice names the area and who changes
 * it, and the page's write controls are hidden by a style rule the (app)
 * layout writes (components/admin/area-refusal.tsx readOnlyStyle).
 */

export type AdminArea =
  | "PLANERING"
  | "SCHEMALAGGNING"
  | "PUBLICERING"
  | "DRIFT"
  | "PERSONAL"
  | "INTEGRATIONER";

export type AdminProfile = "FULL" | "REKTOR" | "SCHEMALAGGARE" | "EXPEDITION" | "LASARE";

export const ADMIN_AREAS: readonly AdminArea[] = [
  "PLANERING",
  "SCHEMALAGGNING",
  "PUBLICERING",
  "DRIFT",
  "PERSONAL",
  "INTEGRATIONER",
];

export const ADMIN_PROFILES: readonly AdminProfile[] = ["FULL", "REKTOR", "SCHEMALAGGARE", "EXPEDITION", "LASARE"];

export const PROFILE_WRITES: Readonly<Record<AdminProfile, readonly AdminArea[]>> = {
  FULL: ["PLANERING", "SCHEMALAGGNING", "PUBLICERING", "DRIFT", "PERSONAL", "INTEGRATIONER"],
  REKTOR: ["PLANERING", "SCHEMALAGGNING", "PUBLICERING", "DRIFT", "PERSONAL", "INTEGRATIONER"],
  SCHEMALAGGARE: ["PLANERING", "SCHEMALAGGNING", "PUBLICERING", "DRIFT"],
  EXPEDITION: ["DRIFT", "PERSONAL"],
  LASARE: [],
};

export const PROFILE_DECIDES: Readonly<Record<AdminProfile, boolean>> = {
  FULL: true,
  REKTOR: true,
  SCHEMALAGGARE: false,
  EXPEDITION: false,
  LASARE: false,
};

/** The profiles HR-läs is given to; rektor and full read tjänst % anyway. */
export const HR_READ_PROFILES: readonly AdminProfile[] = ["SCHEMALAGGARE", "EXPEDITION", "LASARE"];

/**
 * The profiles that open a page whose area they do not write read-only, in
 * place of the page that says why: the läsare, which writes nothing and would
 * otherwise have no page left. The narrower profiles keep the closed pages
 * Roller i skolan gave them. A decision page stays closed to every profile
 * that does not decide: /admin/dataskydd holds the läslogg, which only the
 * deciders read.
 */
export const READS_EVERY_PAGE: readonly AdminProfile[] = ["LASARE"];

/** Who changes an area, in the order a sentence names them: rektor first. */
export const WRITER_ORDER: readonly AdminProfile[] = ["REKTOR", "FULL", "SCHEMALAGGARE", "EXPEDITION", "LASARE"];

export function profileWrites(profile: AdminProfile | null | undefined, area: AdminArea): boolean {
  return profile != null && PROFILE_WRITES[profile].includes(area);
}

export function profileDecides(profile: AdminProfile | null | undefined): boolean {
  return profile != null && PROFILE_DECIDES[profile];
}

export function profileReadsHr(profile: AdminProfile | null | undefined, hrRead: boolean | null | undefined): boolean {
  return profileDecides(profile) || (profile != null && hrRead === true);
}

/** What an admin page needs: an area, the decisions, or nothing (every administrator). */
export type PageGate = AdminArea | "DECIDES" | null;

/**
 * Each admin page's gate, by its path under /admin. A page reads what every
 * administrator reads, so the gate is the area its buttons write. A path
 * not listed here (a new page) is shown to every administrator, and its
 * writes are still the gateway's to refuse.
 */
export const PAGE_GATES: Readonly<Record<string, PageGate>> = {
  "/admin": null,
  "/admin/setup": "PLANERING",
  "/admin/years": "PLANERING",
  "/admin/subjects": "PLANERING",
  "/admin/rooms": "PLANERING",
  "/admin/groups": "PLANERING",
  // Two areas' buttons: the register (personal) and the staff's arbetstid,
  // behörigheter and uppdrag (planering). Open to every administrator, and
  // each control offered to the profile that writes it.
  "/admin/people": null,
  "/admin/timplan": "PLANERING",
  "/admin/requirements": "PLANERING",
  "/admin/staffing": "PLANERING",
  "/admin/constraints": "PLANERING",
  "/admin/breaks": "PLANERING",
  "/admin/frame-times": "PLANERING",
  "/admin/rasts": "PLANERING",
  // Rastvaktsschema: the areas and the passes, planering's as the uppdrag are.
  "/admin/supervision": "PLANERING",
  "/admin/lunch-servings": "PLANERING",
  "/admin/generate": "SCHEMALAGGNING",
  "/admin/timetable": "SCHEMALAGGNING",
  "/admin/gaps": "SCHEMALAGGNING",
  "/admin/publishing": "PUBLICERING",
  // Kalenderprenumeration's switches are PublicationSettings, Publicering's.
  "/admin/calendar-feeds": "PUBLICERING",
  "/admin/lessons": "DRIFT",
  "/admin/teacher-absence": "DRIFT",
  "/admin/cover": "DRIFT",
  "/admin/cancellations": "DRIFT",
  "/admin/leave": "DRIFT",
  "/admin/room-bookings": "DRIFT",
  "/admin/reports": "DRIFT",
  // Lektionslogg: the klassbok reads for everyone; removing a log is drift's.
  "/admin/klassbok": "DRIFT",
  "/admin/dataskydd": "DECIDES",
  "/admin/integrations": "INTEGRATIONER",
};

/** The gate of a path, its locale prefix and any sub-path included: /sv/admin/people/x is /admin/people's. */
export function gateOfPath(pathname: string): PageGate {
  const path = pathname.replace(/^\/(sv|en)(?=\/|$)/, "") || "/";
  let best: string | null = null;
  for (const page of Object.keys(PAGE_GATES)) {
    if ((path === page || path.startsWith(`${page}/`)) && (best === null || page.length > best.length)) {
      best = page;
    }
  }
  return best === null ? null : PAGE_GATES[best]!;
}

/** May the profile use a page with this gate? */
export function profileOpens(profile: AdminProfile | null | undefined, gate: PageGate): boolean {
  if (gate === null) return true;
  return gate === "DECIDES" ? profileDecides(profile) : profileWrites(profile, gate);
}

/** Does the profile open a page with this gate read-only (Läsbehörighet)? */
export function profileReadsPage(profile: AdminProfile | null | undefined, gate: PageGate): boolean {
  return profile != null && READS_EVERY_PAGE.includes(profile) && gate !== "DECIDES" && !profileOpens(profile, gate);
}

/** A page the profile may not use, and why: its area or the decisions. */
export interface ClosedPage {
  path: string;
  gate: AdminArea | "DECIDES";
}

/**
 * The admin pages a profile may not use. Computed on the server, in the
 * (app) layout, so AppShell (the menu, and the page shown in place of a
 * closed one) ships a list of paths and not this module: the shell is on
 * every route's bill.
 */
export function closedPages(profile: AdminProfile | null | undefined): ClosedPage[] {
  return Object.entries(PAGE_GATES)
    .filter(([, gate]) => gate !== null && !profileOpens(profile, gate) && !profileReadsPage(profile, gate))
    .map(([path, gate]) => ({ path, gate: gate as AdminArea | "DECIDES" }));
}

/** A page the profile reads but does not change, and the areas its notice names, in order. */
export interface ReadOnlyPage {
  path: string;
  areas: readonly AdminArea[];
}

/**
 * The areas named on a page whose gate names none. /admin/people holds the
 * register, personal's, and beside it each teacher's arbetstid, behörigheter
 * and uppdrag, planering's: a läsare reads both, so its notice names who
 * changes each.
 */
const NOTICE_AREAS: Readonly<Record<string, readonly AdminArea[]>> = { "/admin/people": ["PERSONAL", "PLANERING"] };

/**
 * The admin pages a profile opens read-only (Läsbehörighet): every page a
 * profile in READS_EVERY_PAGE does not write, decision pages aside. Computed
 * on the server, in the (app) layout, as closedPages is.
 */
export function readOnlyPages(profile: AdminProfile | null | undefined): ReadOnlyPage[] {
  if (profile == null || !READS_EVERY_PAGE.includes(profile)) return [];
  return Object.entries(PAGE_GATES).flatMap(([path, gate]) => {
    const areas = (gate === null ? (NOTICE_AREAS[path] ?? []) : gate === "DECIDES" ? [] : [gate]).filter(
      (area) => !profileWrites(profile, area),
    );
    return areas.length > 0 ? [{ path, areas }] : [];
  });
}
