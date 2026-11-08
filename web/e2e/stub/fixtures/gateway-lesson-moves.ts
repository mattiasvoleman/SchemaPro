import { Reply, route, type GatewayContext, type GatewayRoute } from "../gateway-routes";

/**
 * Elevens lektion för dagen as the gateway answers it (src/lesson-moves/): the
 * register asks which pupils were moved to or from the lesson it opens, and in
 * this world nobody was. The candidates and the move itself are the lazy
 * dialog's, opened by a click, which no browser suite makes; their wiring has
 * its own component test (components/lesson-moves/lesson-moves.test.tsx).
 */
function moves(context: GatewayContext): unknown {
  if (!context.person) return new Reply(401, { message: "Unauthorized" });
  if (context.person.persona !== "teacher" && context.person.persona !== "admin") return new Reply(403, { message: "Forbidden resource" });
  return { departures: [], arrivals: [] };
}

export const lessonMoveRoutes: GatewayRoute[] = [route("GET", "/api/v1/lesson-moves/lessons/:id", moves)];
