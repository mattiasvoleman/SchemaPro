import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { TEACHING_ADMIN_ROWS } from "@/components/layout/teaching-admin-nav";

/**
 * The seam between "Min undervisning" and the gateway (Administratör som lärare,
 * the web's part). No call graph reaches across it: a page of the group calls a
 * route, and whether the route admits an administrator who teaches is written in
 * a controller in src/, which the web cannot import. So the gateway's source is
 * read as text, as class-teacher.contract.test.ts does, and three things are held:
 *
 *   (a) the doors the gateway opens to a marked administrator (`@AsTeacher`) are the
 *       ones the web's table knows. A ninth door opened in src/ fails the gateway's
 *       own test (test/route-guards.e2e-spec.ts, TEACHING_ADMINISTRATOR_DOORS)
 *       until it is decided there; this test fails with it until the web has
 *       decided too, so that a page cannot go on drawing a 403 for a door that
 *       moved, or leave a door unused without anyone saying so.
 *   (b) every route a page of the group calls either lists SCHOOL_ADMIN in its
 *       @Roles or is one of the doors. A page that calls a route the gateway
 *       refuses her is the page /teacher/franvaro was (GET /cover-requests/mine,
 *       a colleague's route, drew an error card every minute).
 *   (c) the table holds none of the routes that stay a teacher's: the cover
 *       request's colleague side (SP409), the class teacher's (CT400) and the
 *       substitute pool's. The mark does not open them, here or in any other part.
 *
 * And the other way: each route of the table is one the web asks for, so a row
 * cannot outlive the call it vouches for.
 */

const ROOT = join(__dirname, "..", "..");
const WEB = join(__dirname, "..");

interface Route {
  controller: string;
  method: string;
  verb: string;
  /** With the controller's prefix, `:id` as the gateway writes it, no leading slash. */
  path: string;
  /** The role names of @Roles (the method's, else the class's); null when there is none. */
  roles: string[] | null;
  /** Carries @AsTeacher on the method or the class. */
  asTeacher: boolean;
}

/** The routes of one controller file, read from its decorators. */
function routesOf(file: string): Route[] {
  const source = ts.createSourceFile(file, readFileSync(join(ROOT, file), "utf8"), ts.ScriptTarget.Latest, true);
  const decorators = (node: ts.Node) => (ts.canHaveDecorators(node) ? (ts.getDecorators(node) ?? []) : []);
  const callOf = (decorator: ts.Decorator) => (ts.isCallExpression(decorator.expression) ? decorator.expression : null);
  const nameOf = (decorator: ts.Decorator) => {
    const call = callOf(decorator);
    return call && ts.isIdentifier(call.expression) ? call.expression.text : ts.isIdentifier(decorator.expression) ? decorator.expression.text : null;
  };
  const argsOf = (decorator: ts.Decorator) => (callOf(decorator)?.arguments ?? []).map((argument) => argument.getText(source));
  const rolesOf = (list: readonly ts.Decorator[]) => {
    const roles = list.find((decorator) => nameOf(decorator) === "Roles");
    return roles ? argsOf(roles).map((argument) => argument.replace(/^Role\./, "")) : null;
  };
  const unquote = (text: string) => text.replace(/^['"`]|['"`]$/g, "");

  const found: Route[] = [];
  ts.forEachChild(source, (node) => {
    if (!ts.isClassDeclaration(node) || !node.name) return;
    const own = decorators(node);
    const controller = own.find((decorator) => nameOf(decorator) === "Controller");
    if (!controller) return;
    const prefix = unquote(argsOf(controller)[0] ?? "''");
    for (const member of node.members) {
      if (!ts.isMethodDeclaration(member)) continue;
      const list = decorators(member);
      const verb = list.find((decorator) => ["Get", "Post", "Put", "Patch", "Delete"].includes(nameOf(decorator) ?? ""));
      if (!verb) continue;
      found.push({
        controller: node.name.text,
        method: member.name.getText(source),
        verb: nameOf(verb)!.toUpperCase(),
        path: [prefix, unquote(argsOf(verb)[0] ?? "''")].filter(Boolean).join("/"),
        roles: rolesOf(list) ?? rolesOf(own),
        asTeacher: list.some((decorator) => nameOf(decorator) === "AsTeacher") || own.some((decorator) => nameOf(decorator) === "AsTeacher"),
      });
    }
  });
  return found;
}

/** One route of the table: where the gateway writes it, and how the web writes it. */
type Call = readonly [verb: string, path: string];

/**
 * The seven pages of "Min undervisning", the lesson page they open and the
 * notice settings, each with the gateway routes it calls. What a page reads
 * through PostgREST (Mitt schema's CalendarLessonTeachers, Min frånvaro's pool
 * membership) is not here: it is the database's arms, proved in the RLS suite.
 */
const PAGES: Record<string, { files: string[]; calls: Call[] }> = {
  "/teacher": { files: ["src/supervision/supervision.controller.ts"], calls: [["GET", "api/v1/supervision/week"]] },
  "/teacher/crisis": {
    files: ["src/crisis/crisis.controller.ts"],
    calls: [
      ["GET", "api/v1/crisis/mine"],
      ["POST", "api/v1/crisis/mine/pupils"],
      ["POST", "api/v1/crisis/mine/marks"],
    ],
  },
  "/teacher/attendance": {
    files: ["src/attendance/attendance.controller.ts", "src/lesson-moves/lesson-moves.controller.ts"],
    calls: [
      ["POST", "api/v1/attendance/report"],
      ["GET", "api/v1/attendance/lessons/:lessonId/roster"],
      ["GET", "api/v1/attendance/lessons/:lessonId/records"],
      ["GET", "api/v1/attendance/lessons/:lessonId/reported-absences"],
      ["GET", "api/v1/lesson-moves/lessons/:lessonId"],
    ],
  },
  "/teacher/tjanst": {
    files: ["src/staffing/staffing-load.controller.ts", "src/staffing/teacher-duties.controller.ts"],
    calls: [
      ["GET", "api/v1/staffing/load"],
      ["GET", "api/v1/teacher-duties"],
    ],
  },
  "/teacher/franvaro": {
    files: ["src/lesson-log/lesson-log.controller.ts", "src/cover/cover.controller.ts"],
    calls: [
      ["GET", "api/v1/lesson-logs"],
      ["GET", "api/v1/lesson-logs/handed-over"],
      ["GET", "api/v1/teacher-absences"],
      ["GET", "api/v1/teacher-absence-reasons"],
      ["GET", "api/v1/cover/settings"],
    ],
  },
  "/teacher/ledighet": {
    files: ["src/family/family.controller.ts"],
    calls: [
      ["GET", "api/v1/leave-requests"],
      ["GET", "api/v1/leave-delegation"],
      ["PATCH", "api/v1/leave-requests/:id/decide"],
      ["PATCH", "api/v1/leave-requests/:id/refer"],
    ],
  },
  "/teacher/reporting-rate": { files: ["src/reporting-rate/reporting-rate.controller.ts"], calls: [["GET", "api/v1/reporting-rate/mine"]] },
  "/teacher/lektion/[lessonId]": {
    files: ["src/lesson-log/lesson-log.controller.ts"],
    calls: [
      ["GET", "api/v1/lesson-logs/lessons/:id"],
      ["PUT", "api/v1/lesson-logs/lessons/:id"],
      ["PUT", "api/v1/lesson-logs/lessons/:id/substitute-note"],
    ],
  },
  "/notifications": {
    files: ["src/notifications/notification-preferences.controller.ts"],
    calls: [
      ["GET", "api/v1/notification-preferences"],
      ["PUT", "api/v1/notification-preferences"],
    ],
  },
};

/** The routes a teacher keeps for herself, whatever the mark: no page of the group calls them. */
const STAYS_A_TEACHERS = [
  "api/v1/cover-requests/mine",
  "api/v1/cover-requests/:id/accept",
  "api/v1/cover-requests/:id/decline",
  "api/v1/cover-requests/lessons/:lessonId/confirm",
];
const STAYS_A_TEACHERS_CONTROLLERS = ["ClassTeacherController", "CoverRequestsTeacherController", "SubstitutePoolController"];

/** The doors as the gateway's own test writes them: `VERB Controller.method`. */
const GUARDS = readFileSync(join(ROOT, "test", "route-guards.e2e-spec.ts"), "utf8");
const GATEWAY_DOORS = [...(/const TEACHING_ADMINISTRATOR_DOORS = \[([^\]]*)\]/.exec(GUARDS)?.[1] ?? "").matchAll(/'([A-Z]+ \w+\.\w+)'/g)].map((match) => match[1]!);

/** The doors as this table knows them: the routes of the table that carry @AsTeacher. */
const WEB_DOORS = [
  "GET LessonLogController.list",
  "GET LessonLogController.handedOver",
  "PUT LessonLogController.putNote",
  "GET CrisisTeacherController.mine",
  "POST CrisisTeacherController.pupils",
  "POST CrisisTeacherController.mark",
  "GET ReportingRateController.mine",
  "PATCH FamilyController.referLeaveRequest",
];

const gatewayRoutes = (file: string) => routesOf(file);
const find = (file: string, call: Call) => gatewayRoutes(file).find((route) => route.verb === call[0] && route.path === call[1]);

describe("the doors the gateway opens to an administrator who teaches", () => {
  it("are the ones the web knows, exactly, in the gateway's own list", () => {
    expect(GATEWAY_DOORS.length).toBe(8);
    expect([...WEB_DOORS].sort()).toEqual([...GATEWAY_DOORS].sort());
  });

  it("are the routes of the controllers that carry @AsTeacher, no more and no fewer than the list says", () => {
    const files = new Set(Object.values(PAGES).flatMap((page) => page.files));
    const carried = [...files].flatMap(gatewayRoutes).filter((route) => route.asTeacher);
    // A door the web has no page for is a door the table is missing: every route the web table touches that is a door is in the list.
    for (const route of carried) expect(WEB_DOORS, `${route.verb} ${route.controller}.${route.method}`).toContain(`${route.verb} ${route.controller}.${route.method}`);
    expect(carried.length).toBe(8);
  });
});

describe("every route a page of the group calls admits her", () => {
  for (const [page, { files, calls }] of Object.entries(PAGES)) {
    it(`${page}`, () => {
      const routes = files.flatMap(gatewayRoutes);
      for (const call of calls) {
        const route = routes.find((candidate) => candidate.verb === call[0] && candidate.path === call[1]);
        expect(route, `${call[0]} /${call[1]} is a route of ${files.join(" or ")}`).toBeDefined();
        const admitted = route!.roles?.includes("SCHOOL_ADMIN") === true || route!.asTeacher;
        expect(admitted, `${call[0]} /${call[1]} lists ${JSON.stringify(route!.roles)} and is no door: an administrator who teaches would be refused it`).toBe(true);
      }
    });
  }

  it("reads roles and doors from decorators, so that the checks above can fail", () => {
    // A route that is a teacher's alone is read as one, with and without the door: the reading is what the
    // checks stand on.
    const cover = find("src/cover/cover-requests.controller.ts", ["GET", "api/v1/cover-requests/mine"]);
    expect(cover).toMatchObject({ roles: ["TEACHER"], asTeacher: false });
    const crisis = find("src/crisis/crisis.controller.ts", ["GET", "api/v1/crisis/mine"]);
    expect(crisis).toMatchObject({ roles: ["TEACHER"], asTeacher: true });
    const administrators = find("src/staffing/staffing-load.controller.ts", ["GET", "api/v1/staffing/load"]);
    expect(administrators?.roles).toEqual(["SCHOOL_ADMIN", "TEACHER"]);
  });
});

describe("the routes that stay a teacher's are in no page's table", () => {
  const table = Object.values(PAGES).flatMap((page) => page.calls.map((call) => call[1]));

  it("holds none of the cover request's colleague side", () => {
    for (const stays of STAYS_A_TEACHERS) expect(table, stays).not.toContain(stays);
    expect(table.some((path) => path.startsWith("api/v1/cover-requests/"))).toBe(false);
  });

  it("holds none of the class teacher's, and none of the pool's", () => {
    expect(table.some((path) => /class-teacher|substitute-pool/.test(path))).toBe(false);
    const files = new Set(Object.values(PAGES).flatMap((page) => page.files));
    const stays = [...files].flatMap(gatewayRoutes).filter((route) => STAYS_A_TEACHERS_CONTROLLERS.includes(route.controller));
    expect(stays.map((route) => `${route.controller}.${route.method}`)).toEqual([]);
  });

  it("refuses to hold the colleague side's mine, which is what a table that took it would say", () => {
    // The mutant of this file: GET /cover-requests/mine in the table. It must fail (b), because the route
    // lists TEACHER alone and is no door.
    const route = find("src/cover/cover-requests.controller.ts", ["GET", "api/v1/cover-requests/mine"])!;
    expect(route.roles?.includes("SCHOOL_ADMIN") === true || route.asTeacher).toBe(false);
  });
});

describe("every route of the table is one the web asks for", () => {
  /** Every non-test source file of the web, as text. */
  const sources = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      if (["node_modules", ".next", "coverage", "e2e", "test-results", "playwright-report", "messages"].includes(entry.name)) return [];
      const path = join(dir, entry.name);
      if (entry.isDirectory()) return sources(path);
      return /\.tsx?$/.test(entry.name) && !/\.(test|spec)\.tsx?$/.test(entry.name) ? [readFileSync(path, "utf8")] : [];
    });
  const web = sources(WEB).join("\n");

  const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
  const HOLE = "\\$\\{[^}]+\\}";
  /** A path as the web writes it: `:id` is a template hole, and the front of it may be a constant (`${BASE}/mine`). */
  function asks(path: string): boolean {
    const segments = path.split("/");
    const written = (parts: string[]) => parts.map((part) => (part.startsWith(":") ? HOLE : escape(part))).join(escape("/"));
    const whole = new RegExp(`${escape("/")}${written(segments)}(?:["'\`?$])`);
    if (whole.test(web)) return true;
    // A base kept in a constant, and the rest appended to it: "/api/v1/crisis/mine" and `${PATH}/marks`.
    for (let at = segments.length - 1; at >= 3; at -= 1) {
      const base = new RegExp(`["'\`]${escape("/")}${written(segments.slice(0, at))}["'\`]`);
      const rest = new RegExp(`\\$\\{\\w+\\}${escape("/")}${written(segments.slice(at))}(?:["'\`?$])`);
      if (base.test(web) && rest.test(web)) return true;
    }
    return false;
  }

  for (const [page, { calls }] of Object.entries(PAGES)) {
    for (const [verb, path] of calls) {
      it(`${page}: ${verb} /${path}`, () => {
        expect(asks(path), `the web asks for ${verb} /${path}`).toBe(true);
      });
    }
  }

  it("does not find a route nobody asks for, so that the check can fail", () => {
    expect(asks("api/v1/cover-requests/mine/never-asked-for")).toBe(false);
    expect(asks("api/v1/leave-requests/:id/never-asked-for")).toBe(false);
  });
});

describe("the group's rows are pages the table knows", () => {
  it("has a page in the table for every row of the group but the calendar-less ones", () => {
    const hrefs = new Set(Object.keys(PAGES));
    const rows = TEACHING_ADMIN_ROWS.map((key) =>
      ({ mySchedule: "/teacher", myCrisis: "/teacher/crisis", attendance: "/teacher/attendance", myStaffing: "/teacher/tjanst", myCover: "/teacher/franvaro", myLeave: "/teacher/ledighet", myReporting: "/teacher/reporting-rate" })[key],
    );
    for (const href of rows) expect(hrefs.has(href), href).toBe(true);
  });
});
