import type { CalendarFeed, CalendarFeeds, FeedCounts } from "../../../lib/calendar-feed";
import type { CancellationSelection } from "../../../lib/publication-types";
import { Reply, route, type GatewayRoute } from "../gateway-routes";
import { KIND, uid } from "../sessions";
import {
  ATTENDANCE_SHARING,
  PROVIDER_KEYS,
  PROVISIONING,
  runChanges,
  SIGN_IN_SETTINGS,
  SS12000_SOURCE,
  syncRuns,
} from "./misc-integrations";
import {
  CANCELLATION_BATCHES,
  cancellationPreview,
  draftState,
  HIDDEN_TEACHERS,
  PUBLIC_LINKS,
  publicationPreview,
  PUBLICATION_SETTINGS,
  publicationTimeline,
  reversePreview,
  SCHEDULE_VERSIONS,
} from "./misc-publication";
import {
  ago,
  LUNCH_SETTINGS,
  OPTIMIZATION_JOBS,
  optimizationJobsFor,
  PURGED_BEFORE,
  RETENTION_OVERVIEW,
  retentionPreview,
  ROOM_PREFERENCES,
  SCHOOL_UNITS,
  roomProposal,
  yearRosters,
  SITES,
  SHARING,
  ROOM_LOANS,
  LENDABLE_ROOMS,
} from "./misc-school";
import { byId, GROUPS, NEXT_YEAR, ROOM_TYPES, STUDENTS, YEAR } from "./world";
import { addDays, THIS_MONDAY } from "./calendar";
import { weekOf } from "./gateway-public";

/**
 * The school's settings and the admin tools: /admin/generate, publishing,
 * dataskydd, integrations, cancellations, rooms, constraints and the year
 * tools. The data is in misc-school.ts, misc-publication.ts and
 * misc-integrations.ts; this file is the gateway's paths for it, reads only —
 * the suites scan pages, they save nothing.
 */

const YEARS = [YEAR, NEXT_YEAR];

/** The gateway's 404: its sentence, and its code where it sends one. */
const notFound = (message: string, code?: string) => new Reply(404, { statusCode: 404, message, ...(code ? { code } : {}) });
const NO_YEAR = "Läsåret finns inte.";

/** One of the two läsår, or null for an id the school has no year by. */
const yearOf = (id: string | null) => byId(YEARS, id);

export const miscRoutes: GatewayRoute[] = [
  // --- Lunch, generation, room rules ---------------------------------------------
  route("GET", "/api/v1/lunch-settings", () => LUNCH_SETTINGS),
  route("GET", "/api/v1/optimization/jobs", ({ query }) => optimizationJobsFor(query.get("academicYearId"))),
  route("GET", "/api/v1/optimization/jobs/:id", ({ params }) => byId(OPTIMIZATION_JOBS, params.id) ?? notFound("Optimization job not found.")),
  route("GET", "/api/v1/room-types", () => ROOM_TYPES),
  route("GET", "/api/v1/room-preferences", () => ROOM_PREFERENCES),
  // Klasser's skolenheter card.
  route("GET", "/api/v1/school-units", () => SCHOOL_UNITS),
  // Salar's skolområden card and the room dialog's site.
  route("GET", "/api/v1/sites", () => SITES),
  // Salar's card of the huvudman's other schools (Delade lokaler och lärare).
  route("GET", "/api/v1/sharing", () => SHARING),
  route("GET", "/api/v1/room-loans", () => ROOM_LOANS),
  route("GET", "/api/v1/room-loans/rooms", () => LENDABLE_ROOMS),
  // A solve the timetable's Salar dialog asks for; it writes nothing.
  route("POST", "/api/v1/optimization/rooms/proposal", ({ body }) => {
    const { academicYearId } = body as { academicYearId: string };
    return yearOf(academicYearId) ? roomProposal(academicYearId) : notFound(NO_YEAR);
  }),

  // --- Publicering ----------------------------------------------------------------------
  route("GET", "/api/v1/publication-settings", () => PUBLICATION_SETTINGS),
  route("GET", "/api/v1/publications", ({ query }) => {
    const year = yearOf(query.get("academicYearId"));
    return year ? publicationTimeline(year) : notFound(NO_YEAR);
  }),
  route("GET", "/api/v1/publications/state", ({ query }) => {
    const year = yearOf(query.get("academicYearId"));
    return year ? draftState(year) : notFound(NO_YEAR);
  }),
  // A POST that writes nothing: the dry run behind the review dialog.
  route("POST", "/api/v1/publications/preview", ({ body }) => {
    const window = body as { academicYearId: string; validFrom: string; validTo: string };
    return yearOf(window.academicYearId) ? publicationPreview(window) : notFound(NO_YEAR);
  }),
  route("GET", "/api/v1/public-links", ({ query }) =>
    PUBLIC_LINKS.filter((link) => link.academicYearId === query.get("academicYearId")),
  ),
  route("GET", "/api/v1/teacher-public-labels", () => HIDDEN_TEACHERS),
  // Kalenderprenumeration: each person's own feeds, as PUBLICATION_SETTINGS
  // has the audiences (teachers and guardians on, pupils off). Anna has her
  // week's, Sara Ella's but not yet Hugo's; the admin none of her own.
  route("GET", "/api/v1/calendar-feeds", ({ person }): CalendarFeeds | Reply => {
    if (!person) return new Reply(401, { message: "Unauthorized" });
    const feed = (id: number, extra: Partial<CalendarFeed>): CalendarFeed => ({
      id: uid(KIND.misc, id),
      audience: "TEACHER",
      studentId: null,
      locale: "sv",
      createdAt: ago(12, "19:05"),
      lastUsedAt: ago(0, "06:40"),
      ...extra,
    });
    switch (person.persona) {
      case "teacher":
        return { enabled: PUBLICATION_SETTINGS.calendarFeedTeachers, feeds: [feed(9301, {})] };
      case "guardian":
        return { enabled: PUBLICATION_SETTINGS.calendarFeedGuardians, feeds: [feed(9302, { audience: "GUARDIAN", studentId: STUDENTS.ella.id })] };
      case "student":
        return { enabled: PUBLICATION_SETTINGS.calendarFeedStudents, feeds: [] };
      default:
        return { enabled: PUBLICATION_SETTINGS.calendarFeedTeachers, feeds: [] };
    }
  }),
  route("GET", "/api/v1/calendar-feeds/counts", ({ person }): FeedCounts | Reply =>
    person?.persona === "admin" ? { TEACHER: 6, STUDENT: 0, GUARDIAN: 41 } : new Reply(403, { message: "Forbidden resource" }),
  ),
  // Skriv ut scheman: the classes' set of this week, each sheet the viewer's
  // week of the class. Teachers' and rooms' sets are not modelled.
  route("GET", "/api/v1/print/timetables", ({ query }) => {
    const kind = query.get("kind");
    if (kind !== "GROUP") return new Reply(200, { sheets: [] }, { miss: true });
    const classes = Object.values(GROUPS).filter((group) => group.academicYearId === YEAR.id && group.kind === "CLASS");
    return {
      kind,
      school: weekOf(classes[0]!.id).school,
      academicYearId: YEAR.id,
      week: { from: THIS_MONDAY, to: addDays(THIS_MONDAY, 6), isoWeek: weekOf(classes[0]!.id).week.isoWeek },
      validity: [{ from: YEAR.startDate, to: YEAR.endDate }],
      teachers: query.get("teachers") ?? PUBLICATION_SETTINGS.publicTeacherDisplay,
      meals: query.get("meals") !== "false",
      sheets: classes
        .map((group) => ({ id: group.id, title: group.name, days: weekOf(group.id).days }))
        .sort((a, b) => a.title.localeCompare(b.title, "sv")),
    };
  }),
  route("GET", "/api/v1/timetable-validity", () => ({
    week: { from: THIS_MONDAY, to: addDays(THIS_MONDAY, 6) },
    validity: [{ from: YEAR.startDate, to: YEAR.endDate }],
  })),
  route("GET", "/api/v1/schedule-versions", ({ query }) =>
    SCHEDULE_VERSIONS.filter((version) => version.academicYearId === query.get("academicYearId")).map(
      ({ lessons: _lessons, ...version }) => version,
    ),
  ),
  route("GET", "/api/v1/schedule-versions/:id", ({ params }) => byId(SCHEDULE_VERSIONS, params.id) ?? notFound("Version not found.")),

  // --- Bulk avbokning ----------------------------------------------------------------------
  route("GET", "/api/v1/cancellation-batches", ({ query }) =>
    query.get("academicYearId") === YEAR.id ? CANCELLATION_BATCHES : [],
  ),
  route("POST", "/api/v1/cancellation-batches/preview", ({ body }) => cancellationPreview(body as CancellationSelection)),
  route("POST", "/api/v1/cancellation-batches/:id/reverse/preview", ({ params }) => {
    const batch = byId(CANCELLATION_BATCHES, params.id);
    if (!batch) return notFound("Avbokningen finns inte.");
    // The card offers no reversal for these; a stale dialog gets the gateway's refusal.
    if (batch.reversedAt) return new Reply(409, { statusCode: 409, code: "CANCELLATION_REVERSED", message: "Avbokningen är redan återställd." });
    return reversePreview(batch);
  }),

  // --- Dataskydd -------------------------------------------------------------------------------
  route("GET", "/api/v1/retention", () => RETENTION_OVERVIEW),
  route("GET", "/api/v1/retention/purged-before", () => PURGED_BEFORE),
  route("GET", "/api/v1/retention/preview", ({ query }) => retentionPreview(Number(query.get("months") ?? 12))),

  // --- Integrationer -----------------------------------------------------------------------------
  route("GET", "/api/v1/ss12000-source", () => SS12000_SOURCE),
  route("GET", "/api/v1/ss12000-sync/runs", ({ query }) => syncRuns(Number(query.get("limit") ?? 20), query.get("before"))),
  route("GET", "/api/v1/ss12000-sync/runs/:id/changes", ({ params }) => runChanges(params.id!) ?? notFound("Run not found.", "SS12000_RUN_NOT_FOUND")),
  route("GET", "/api/v1/ss12000-sync/provisioning", () => PROVISIONING),
  route("GET", "/api/v1/integration-keys/provider", () => PROVIDER_KEYS),
  route("GET", "/api/v1/integrations/attendance-sharing", () => ATTENDANCE_SHARING),
  route("GET", "/api/v1/sign-in-method", () => SIGN_IN_SETTINGS),

  // --- The year tools ---------------------------------------------------------------------------
  // /admin/generate and /admin/timetable with next year chosen. Its rollover and
  // activation previews are gateway-family.ts's, beside the classes they name.
  route("GET", "/api/v1/academic-years/:id/rosters", ({ params }) => {
    const year = yearOf(params.id ?? null);
    return year ? yearRosters(year) : notFound(NO_YEAR);
  }),
];
