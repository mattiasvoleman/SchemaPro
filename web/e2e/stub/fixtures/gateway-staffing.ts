import type { ScbFile } from "../../../lib/scb-file";
import type { HistoryResponse } from "../../../lib/staffing-history-queries";
import type { StaffingNotice, StaffingReconciliationResponse } from "../../../lib/staffing-reconciliation";
import type { UnstaffedRequirement } from "../../../lib/teacher-load";
import type {
  AcademicYear,
  StaffingPolicy,
  TeacherDuty,
  TeacherEmployment,
  TeacherQualification,
  TeacherSuggestions,
  UserRole,
} from "../../../lib/types";
import { route, Reply, type GatewayRoute } from "../gateway-routes";
import type { SignedInPerson } from "../sessions";
import { addDays, TODAY } from "./calendar";
import { scbFileOf } from "./scb-file";
import { delivered, loadReport, ownLoad, suggestTeachers, type LoadResponse } from "./staffing-load";
import { DUTIES, EMPLOYMENTS, historyOf, QUALIFICATIONS, STAFFING_POLICY } from "./staffing-rows";
import { NEXT_YEAR, YEAR } from "./world";

/**
 * Tjänstefördelningen (src/staffing): the policy, the posts, behörigheter,
 * uppdrag and their history, and the computed report. Data in
 * staffing-rows.ts, arithmetic in staffing-load.ts.
 *
 * The role cuts are the gateway's own: the policy and the admin's lists are
 * SCHOOL_ADMIN-only, and a TEACHER is answered with their own post, uppdrag,
 * history and report row — a colleague's id is a 403, as /teacher/tjanst
 * relies on. NEXT_YEAR, rolled and not yet activated, has no posts and no
 * timplansposter yet: an empty report, which offers the carry from YEAR.
 */

const STAFF: UserRole[] = ["SCHOOL_ADMIN", "TEACHER"];
const ADMIN_ONLY: UserRole[] = ["SCHOOL_ADMIN"];

/** Nest's own bodies for the guards' two refusals. */
function refusal(person: SignedInPerson | null, roles: UserRole[]): Reply | null {
  if (!person) return new Reply(401, { statusCode: 401, message: "Unauthorized" });
  if (!roles.includes(person.role)) {
    return new Reply(403, { statusCode: 403, message: "Forbidden resource", error: "Forbidden" });
  }
  return null;
}

/** A TEACHER asking for anybody but themselves. */
const forColleague = (person: SignedInPerson, userId: string | null) =>
  person.role === "TEACHER" && userId !== null && userId !== person.userId;

/** `?academicYearId=` as the gateway's ParseUUIDPipe and its 404 answer it. */
function yearOf(query: URLSearchParams): AcademicYear | Reply {
  const id = query.get("academicYearId");
  if (!id) {
    return new Reply(400, { statusCode: 400, message: "Validation failed (uuid is expected)", error: "Bad Request" });
  }
  return (
    [YEAR, NEXT_YEAR].find((year) => year.id === id) ??
    new Reply(404, { statusCode: 404, message: "Läsåret finns inte." })
  );
}

export const staffingRoutes: GatewayRoute[] = [
  route(
    "GET",
    "/api/v1/staffing-policy",
    ({ person }): StaffingPolicy | Reply => refusal(person, ADMIN_ONLY) ?? STAFFING_POLICY,
  ),

  route("GET", "/api/v1/staffing/load", ({ person, query }): LoadResponse | Reply => {
    const refused = refusal(person, STAFF);
    if (refused) return refused;
    const year = yearOf(query);
    if (year instanceof Reply) return year;
    // The web asks for planned only; scheduled (the grundschema) is not stubbed.
    const horizon = query.get("horizon") ?? "planned";
    if (horizon !== "planned") {
      return new Reply(400, { statusCode: 400, message: `Horisonten "${horizon}" finns inte i stubben.` });
    }
    const report = loadReport(year);
    return person!.role === "SCHOOL_ADMIN" ? report : ownLoad(report, person!.userId);
  }),

  route("GET", "/api/v1/staffing/unstaffed", ({ person, query }): UnstaffedRequirement[] | Reply => {
    const refused = refusal(person, ADMIN_ONLY);
    if (refused) return refused;
    const year = yearOf(query);
    return year instanceof Reply ? year : loadReport(year).unstaffedRequirements;
  }),

  route("GET", "/api/v1/staffing/suggest-teachers", ({ person, query }): TeacherSuggestions | Reply => {
    const refused = refusal(person, ADMIN_ONLY);
    if (refused) return refused;
    const requirementId = query.get("requirementId") ?? "";
    return (
      suggestTeachers(requirementId, YEAR) ??
      suggestTeachers(requirementId, NEXT_YEAR) ??
      new Reply(404, { statusCode: 404, message: "Timplansposten finns inte." })
    );
  }),

  // SCB:s Pedagogisk personal, the admin's alone (src/staffing/scb).
  route("GET", "/api/v1/staffing/scb-file", ({ person, query }): ScbFile | Reply => {
    const refused = refusal(person, ADMIN_ONLY);
    if (refused) return refused;
    const year = yearOf(query);
    return year instanceof Reply ? year : scbFileOf(year);
  }),

  route("GET", "/api/v1/staffing/delivered", ({ person, query }): StaffingReconciliationResponse | Reply => {
    const refused = refusal(person, STAFF);
    if (refused) return refused;
    const year = yearOf(query);
    if (year instanceof Reply) return year;
    // The gateway's defaults: the year's first day to the school's yesterday
    // (the first day itself before term has begun).
    const yesterday = addDays(TODAY, -1);
    const asked = {
      from: query.get("from") ?? year.startDate,
      to: query.get("to") ?? (yesterday < year.startDate ? year.startDate : yesterday),
    };
    if (asked.from > asked.to) {
      return new Reply(400, { statusCode: 400, message: "from/to: perioden måste börja innan den slutar" });
    }
    const range = {
      from: asked.from < year.startDate ? year.startDate : asked.from,
      to: asked.to > year.endDate ? year.endDate : asked.to,
    };
    if (range.from > range.to) {
      return new Reply(400, { statusCode: 400, message: "from/to: perioden ligger helt utanför läsåret" });
    }
    // Only a range the admin chose is said to be clamped; the default to-date before term is not theirs.
    const clamped = (query.has("from") || query.has("to")) && (range.from !== asked.from || range.to !== asked.to);
    const notices: StaffingNotice[] = clamped ? [{ code: "STAFFING_RANGE_CLAMPED", params: range }] : [];
    return delivered(year, range, notices, person!.role === "SCHOOL_ADMIN" ? null : person!.userId);
  }),

  route("GET", "/api/v1/teacher-employments", ({ person, query }): TeacherEmployment[] | Reply => {
    const refused = refusal(person, STAFF);
    if (refused) return refused;
    const year = yearOf(query);
    if (year instanceof Reply) return year;
    return EMPLOYMENTS.filter(
      (row) => row.academicYearId === year.id && (person!.role === "SCHOOL_ADMIN" || row.userId === person!.userId),
    );
  }),

  route("GET", "/api/v1/teacher-employments/:userId/history", ({ person, params, query }): HistoryResponse | Reply => {
    const refused = refusal(person, STAFF);
    if (refused) return refused;
    if (forColleague(person!, params.userId!)) return refusal(person, ADMIN_ONLY)!;
    const year = yearOf(query);
    if (year instanceof Reply) return year;
    return { entries: year.id === YEAR.id ? historyOf(params.userId!) : [], truncated: false };
  }),

  route("GET", "/api/v1/teacher-qualifications", ({ person, query }): TeacherQualification[] | Reply => {
    const refused = refusal(person, STAFF);
    if (refused) return refused;
    // The school's rows to any member of staff (RLS staff_select), or one teacher's.
    const userId = query.get("userId");
    return userId ? QUALIFICATIONS.filter((row) => row.userId === userId) : QUALIFICATIONS;
  }),

  route("GET", "/api/v1/teacher-duties", ({ person, query }): TeacherDuty[] | Reply => {
    const refused = refusal(person, STAFF);
    if (refused) return refused;
    const year = yearOf(query);
    if (year instanceof Reply) return year;
    const asked = query.get("userId");
    if (forColleague(person!, asked)) return refusal(person, ADMIN_ONLY)!;
    const userId = person!.role === "TEACHER" ? person!.userId : asked;
    return DUTIES.filter((row) => row.academicYearId === year.id && (userId === null || row.userId === userId));
  }),
];
