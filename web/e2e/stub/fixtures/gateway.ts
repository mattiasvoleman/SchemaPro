import { route, type GatewayRoute } from "../gateway-routes";
import { absenceStatsRoutes } from "./gateway-absence-stats";
import { absenceWatchRoutes } from "./gateway-absence-watch";
import { ackRoutes } from "./gateway-ack";
import { candidateRoutes } from "./gateway-candidates";
import { coverRoutes } from "./gateway-cover";
import { crisisRoutes } from "./gateway-crisis";
import { familyRoutes } from "./gateway-family";
import { huvudmanRoutes } from "./gateway-huvudman";
import { leaveRoutes } from "./gateway-leave";
import { lessonLogRoutes } from "./gateway-lesson-logs";
import { lessonMoveRoutes } from "./gateway-lesson-moves";
import { miscRoutes } from "./gateway-misc";
import { publicRoutes } from "./gateway-public";
import { readRoutes } from "./gateway-reads";
import { reportingRateRoutes } from "./gateway-reporting-rate";
import { roleRoutes } from "./gateway-roles";
import { schoolDayRoutes } from "./gateway-school-day";
import { staffingRoutes } from "./gateway-staffing";
import { timplanRoutes } from "./gateway-timplan";
import { YEAR } from "./world";

/**
 * The gateway's answers, as `route(method, path, handler)`. Paths are the ones
 * the web app's lib/ files call; a handler returns the JSON body (or a Reply).
 * One file per area, so a session changing one area's endpoints touches one
 * file — and a stub miss names the file whose routes are nearest the path
 * (../where.ts). A new area gets a gateway-<area>.ts, listed here.
 */
export const ROUTE_FILES: Array<{ file: string; routes: GatewayRoute[] }> = [
  { file: "gateway.ts", routes: [route("GET", "/api/v1/academic-years/current", () => YEAR)] },
  { file: "gateway-staffing.ts", routes: staffingRoutes },
  { file: "gateway-timplan.ts", routes: timplanRoutes },
  { file: "gateway-cover.ts", routes: coverRoutes },
  { file: "gateway-misc.ts", routes: miscRoutes },
  { file: "gateway-family.ts", routes: familyRoutes },
  { file: "gateway-public.ts", routes: publicRoutes },
  { file: "gateway-reads.ts", routes: readRoutes },
  { file: "gateway-leave.ts", routes: leaveRoutes },
  { file: "gateway-roles.ts", routes: roleRoutes },
  { file: "gateway-candidates.ts", routes: candidateRoutes },
  { file: "gateway-lesson-logs.ts", routes: lessonLogRoutes },
  { file: "gateway-lesson-moves.ts", routes: lessonMoveRoutes },
  { file: "gateway-huvudman.ts", routes: huvudmanRoutes },
  { file: "gateway-absence-watch.ts", routes: absenceWatchRoutes },
  { file: "gateway-absence-stats.ts", routes: absenceStatsRoutes },
  { file: "gateway-crisis.ts", routes: crisisRoutes },
  { file: "gateway-reporting-rate.ts", routes: reportingRateRoutes },
  { file: "gateway-school-day.ts", routes: schoolDayRoutes },
  { file: "gateway-ack.ts", routes: ackRoutes },
];

export const gatewayRoutes: GatewayRoute[] = ROUTE_FILES.flatMap((entry) => entry.routes);
