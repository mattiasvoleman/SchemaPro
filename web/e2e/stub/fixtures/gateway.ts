import { route, type GatewayRoute } from "../gateway-routes";
import { coverRoutes } from "./gateway-cover";
import { familyRoutes } from "./gateway-family";
import { leaveRoutes } from "./gateway-leave";
import { miscRoutes } from "./gateway-misc";
import { publicRoutes } from "./gateway-public";
import { readRoutes } from "./gateway-reads";
import { roleRoutes } from "./gateway-roles";
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
];

export const gatewayRoutes: GatewayRoute[] = ROUTE_FILES.flatMap((entry) => entry.routes);
