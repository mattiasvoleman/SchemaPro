import { Reply, route, type GatewayContext, type GatewayRoute } from "../gateway-routes";
import { APPOINTMENTS, DRAFT_ROWS, OPEN_TIMES, SELF_PUBLISH } from "./class-teacher-world";

/**
 * Klasslärarens schema, the administrators' side (src/class-teacher,
 * /api/v1/class-teachers): who is klasslärare of which class in a läsår, the
 * hours open to them, whether they publish for themselves, and the drafts
 * waiting (class-teacher-world.ts). Every administrator reads these; the
 * läsare personas of the accessibility suite are the admin persona, whose
 * writes the page hides. The lists are the one läsår's: a läsår the fixtures
 * hold nothing for answers empty.
 */

function refuse(context: GatewayContext): Reply | null {
  if (!context.person) return new Reply(401, { message: "Unauthorized" });
  if (context.person.persona !== "admin") return new Reply(403, { message: "Forbidden resource" });
  return null;
}

const ofYear = <T extends { academicYearId: string }>(rows: T[], context: GatewayContext): T[] => {
  const year = context.query.get("academicYearId");
  return year === null ? rows : rows.filter((row) => row.academicYearId === year);
};

export const classTeachersRoutes: GatewayRoute[] = [
  route("GET", "/api/v1/class-teachers/appointments", (context) => refuse(context) ?? ofYear(APPOINTMENTS, context)),
  route("GET", "/api/v1/class-teachers/open-times", (context) => refuse(context) ?? ofYear(OPEN_TIMES, context)),
  route("GET", "/api/v1/class-teachers/settings", (context) => refuse(context) ?? { selfPublish: SELF_PUBLISH }),
  route("GET", "/api/v1/class-teachers/drafts", (context) => refuse(context) ?? DRAFT_ROWS),
];
