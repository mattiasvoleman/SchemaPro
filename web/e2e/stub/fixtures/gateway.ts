import { route, type GatewayRoute } from "../gateway-routes";
import { coverRoutes } from "./gateway-cover";
import { familyRoutes } from "./gateway-family";
import { miscRoutes } from "./gateway-misc";
import { publicRoutes } from "./gateway-public";
import { readRoutes } from "./gateway-reads";
import { staffingRoutes } from "./gateway-staffing";
import { timplanRoutes } from "./gateway-timplan";
import { YEAR } from "./world";

/**
 * The gateway's answers, as `route(method, path, handler)`. Paths are the ones
 * the web app's lib/ files call; a handler returns the JSON body (or a Reply).
 * One file per area, so a session changing one area's endpoints touches one
 * file.
 */
export const gatewayRoutes: GatewayRoute[] = [
  route("GET", "/api/v1/academic-years/current", () => YEAR),
  ...staffingRoutes,
  ...timplanRoutes,
  ...coverRoutes,
  ...miscRoutes,
  ...familyRoutes,
  ...publicRoutes,
  ...readRoutes,
];
