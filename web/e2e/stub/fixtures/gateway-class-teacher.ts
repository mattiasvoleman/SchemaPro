import { Reply, route, type GatewayContext, type GatewayRoute } from "../gateway-routes";
import { CHECK, MINE, weekOf } from "./class-teacher-world";
import { GROUPS } from "./world";

/**
 * Klasslärarens schema, the klasslärare's side (src/class-teacher,
 * /api/v1/class-teacher): the classes the reader is klasslärare of, a week of
 * one of them, and the check of its waiting drafts (class-teacher-world.ts).
 * The route admits teachers alone, as the real one does; the teacher persona
 * is Anna, klasslärare of 7A. A class that is not hers answers 403
 * CLASS_TEACHER_NOT_APPOINTED, the way the gateway tells it.
 */

function refuse(context: GatewayContext): Reply | null {
  if (!context.person) return new Reply(401, { message: "Unauthorized" });
  if (context.person.persona !== "teacher") return new Reply(403, { message: "Forbidden resource" });
  return null;
}

const notAppointed = () => new Reply(403, { message: "Not appointed.", code: "CLASS_TEACHER_NOT_APPOINTED" });

export const classTeacherRoutes: GatewayRoute[] = [
  route("GET", "/api/v1/class-teacher/mine", (context) => refuse(context) ?? MINE),
  route("GET", "/api/v1/class-teacher/classes/:classId/week", (context) => {
    const refused = refuse(context);
    if (refused) return refused;
    if (context.params.classId !== GROUPS.g7A.id) return notAppointed();
    return weekOf(context.query.get("from"));
  }),
  route("GET", "/api/v1/class-teacher/classes/:classId/check", (context) => {
    const refused = refuse(context);
    if (refused) return refused;
    return context.params.classId === GROUPS.g7A.id ? CHECK : notAppointed();
  }),
];
