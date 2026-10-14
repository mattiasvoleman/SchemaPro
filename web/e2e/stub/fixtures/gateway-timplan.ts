import { Reply, route, type GatewayRoute } from "../gateway-routes";
import { plannedCoverage, teachingTimeCard } from "./timplan-coverage";
import { NATIONAL_TIMPLANS } from "./timplan-national";
import { CHECKS, CREDITS, PLAN_LIST, PLANS, YEAR_TIMPLANS } from "./timplan-plans";
import { GUARDIAN_LINKS, NEXT_YEAR, YEAR } from "./world";

/**
 * The timplan area: the national timplan, the school's lokala timplaner and
 * what each läsår attaches, Täckning's planned layer, tillgodoräknad tid and
 * the pupil's "Undervisningstid" card. The data is in timplan-*.ts.
 *
 * Täckning's other three tabs (layer=scheduled and layer=delivered here, and
 * GET /timplan-stages) are read only when a tab is chosen, which no suite
 * does; they answer 404 rather than an invented document.
 */

const KNOWN_YEARS = new Set([YEAR.id, NEXT_YEAR.id]);
const notFound = (what: string) => new Reply(404, { message: `${what} finns inte.` });

export const timplanRoutes: GatewayRoute[] = [
  route("GET", "/api/v1/national-timplans", () => NATIONAL_TIMPLANS),

  route("GET", "/api/v1/local-timplans", () => PLAN_LIST),
  route("GET", "/api/v1/local-timplans/:id", ({ params }) => PLANS.find((plan) => plan.id === params.id) ?? notFound("Timplanen")),
  route("GET", "/api/v1/local-timplans/:id/check", ({ params }) => CHECKS[params.id!] ?? notFound("Timplanen")),

  route("GET", "/api/v1/academic-years/:id/timplans", ({ params }) => YEAR_TIMPLANS[params.id!] ?? notFound("Läsåret")),

  route("GET", "/api/v1/timplan-coverage", ({ query }) => {
    const yearId = query.get("academicYearId") ?? "";
    if (!KNOWN_YEARS.has(yearId)) return notFound("Läsåret");
    const layer = query.get("layer") ?? "planned";
    if (layer === "planned") return plannedCoverage(yearId);
    return new Reply(404, undefined, { miss: true });
  }),

  route("GET", "/api/v1/timplan-credits", ({ query }) =>
    CREDITS.filter((credit) => credit.academicYearId === query.get("academicYearId")),
  ),

  // The gateway answers a pupil with their own statement whatever is asked,
  // a guardian with a child of theirs, and refuses a teacher the route.
  route("GET", "/api/v1/timplan-stages/card", ({ person, query }) => {
    if (!person) return new Reply(401, { message: "Inte inloggad." });
    if (person.role === "TEACHER") return new Reply(403, { message: "Åtkomst nekad." });
    const studentId = person.role === "STUDENT" ? person.userId : (query.get("studentId") ?? "");
    if (
      person.role === "GUARDIAN" &&
      !GUARDIAN_LINKS.some((link) => link.guardianId === person.userId && link.studentId === studentId)
    ) {
      return { statement: null };
    }
    return teachingTimeCard(studentId);
  }),
];
