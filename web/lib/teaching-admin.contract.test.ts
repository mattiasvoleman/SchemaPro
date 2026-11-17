import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { TEACHING_ADMIN_ROWS } from "@/components/layout/teaching-admin-nav";
import { ApiLiterals } from "./api-literals";

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
 *
 * And the third way, from the page to the table (LÅG-3 of the review of #329):
 * every `/api/v1/` route the code of a page can name, found by reading the page's
 * imports with the compiler (lib/api-literals.ts), is in the table or is said, with
 * a reason, not to be called for her (NOT_CALLED_FOR_HER). A hook that starts asking
 * for a colleague's route, or any route the table does not know, fails here: the
 * table is no longer only what somebody remembered to write.
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
  "/teacher": {
    files: ["src/supervision/supervision.controller.ts", "src/publication/print.controller.ts"],
    calls: [
      ["GET", "api/v1/supervision/week"],
      // The print button's "which week does this timetable hold" (components/timetable-sheet/print-week-button.tsx).
      ["GET", "api/v1/timetable-validity"],
    ],
  },
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
    files: ["src/lesson-log/lesson-log.controller.ts", "src/cover/cover.controller.ts", "src/gallring/gallring.controller.ts"],
    calls: [
      ["GET", "api/v1/lesson-logs"],
      ["GET", "api/v1/lesson-logs/handed-over"],
      ["GET", "api/v1/teacher-absences"],
      ["GET", "api/v1/teacher-absence-reasons"],
      ["GET", "api/v1/cover/settings"],
      // Her own absence: registered, ended and withdrawn through the dialogs the page shares with Lärarfrånvaro.
      ["POST", "api/v1/teacher-absences"],
      ["PATCH", "api/v1/teacher-absences/:id"],
      ["POST", "api/v1/teacher-absences/:id/end"],
      ["POST", "api/v1/teacher-absences/:id/withdraw"],
      // The pool's windows, in the section only a teacher is drawn (below); the routes admit both roles.
      ["GET", "api/v1/cover/availability"],
      ["POST", "api/v1/cover/availability"],
      ["DELETE", "api/v1/cover/availability/:id"],
      ["GET", "api/v1/retention/purged-before"],
    ],
  },
  "/teacher/ledighet": {
    files: ["src/family/family.controller.ts", "src/gallring/gallring.controller.ts"],
    calls: [
      ["GET", "api/v1/leave-requests"],
      ["GET", "api/v1/leave-delegation"],
      ["POST", "api/v1/leave-delegation"],
      ["PATCH", "api/v1/leave-requests/:id/decide"],
      ["PATCH", "api/v1/leave-requests/:id/refer"],
      ["GET", "api/v1/retention/purged-before"],
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

/**
 * The page files of each entry of PAGES (the App Router pages the group's rows open), from which the walker
 * reads the imports. `/teacher/attendance` is two pages: the list and a lesson's.
 */
const APP = "app/[locale]/(app)";
const PAGE_FILES: Record<string, string[]> = {
  "/teacher": [`${APP}/teacher/page.tsx`],
  "/teacher/crisis": [`${APP}/teacher/crisis/page.tsx`],
  "/teacher/attendance": [`${APP}/teacher/attendance/page.tsx`, `${APP}/teacher/attendance/[lessonId]/page.tsx`],
  "/teacher/tjanst": [`${APP}/teacher/tjanst/page.tsx`],
  "/teacher/franvaro": [`${APP}/teacher/franvaro/page.tsx`],
  "/teacher/ledighet": [`${APP}/teacher/ledighet/page.tsx`],
  "/teacher/reporting-rate": [`${APP}/teacher/reporting-rate/page.tsx`],
  "/teacher/lektion/[lessonId]": [`${APP}/teacher/lektion/[lessonId]/page.tsx`],
  "/notifications": [`${APP}/notifications/page.tsx`],
};

/**
 * Routes a page's code names and does not call for an administrator who teaches, each with the reason. A
 * route here is a teacher's alone (SP409, the colleague side of a cover request): the page imports the hook, and
 * the mark keeps the hook switched off or the card undrawn. Each one is found in the page's imports (a stale
 * row fails) and is in no table.
 */
const NOT_CALLED_FOR_HER: Record<string, { paths: string[]; why: string }[]> = {
  "/teacher/franvaro": [
    {
      paths: [
        "api/v1/cover-requests/mine",
        "api/v1/cover-requests/:id/accept",
        "api/v1/cover-requests/:id/decline",
        "api/v1/cover-requests/lessons/:lessonId/confirm",
      ],
      why:
        "the colleague side of a cover request (SP409): useMyCover(!admin) is off for an administrator and the cards that answer or " +
        "confirm are not drawn for her (franvaro/page.tsx; page.test.tsx holds that no /cover-requests/mine is asked and no error card is drawn)",
    },
  ],
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

describe("every route the code of a page can name is in the table, or is said not to be called for her", () => {
  const reader = new ApiLiterals(WEB);
  const segments = (path: string) => path.split("/");
  const alike = (a: string, b: string) => a === b || a.startsWith(":") || b.startsWith(":");
  /** The same route, `:id` of the gateway and `:p` of a template hole alike. */
  const sameRoute = (a: string, b: string) => segments(a).length === segments(b).length && segments(a).every((part, at) => alike(part, segments(b)[at]!));
  /** `base` is the front of `path`: a constant kept apart from the end appended to it (`const PATH = "/api/v1/crisis"`). */
  const frontOf = (base: string, path: string) => segments(base).length < segments(path).length && segments(base).every((part, at) => alike(part, segments(path)[at]!));

  for (const [page, { files, calls }] of Object.entries(PAGES)) {
    it(`${page}`, () => {
      const literals = reader.reach(PAGE_FILES[page]!);
      expect(literals.length, `the walker reads the imports of ${page}`).toBeGreaterThan(0);
      const excepted = (path: string) => (NOT_CALLED_FOR_HER[page] ?? []).some((row) => row.paths.some((listed) => sameRoute(listed, path)));
      const unexplained = literals.filter(
        (literal) => !calls.some((call) => sameRoute(call[1], literal.path) || frontOf(literal.path, call[1])) && !excepted(literal.path),
      );
      expect(
        unexplained.map((literal) => `/${literal.path} in ${literal.file} (${literal.name})`),
        `a route the code of ${page} can name is in neither its table nor NOT_CALLED_FOR_HER`,
      ).toEqual([]);

      // And a route the table vouches for is admitted in every verb the web writes it in: the walker sees
      // paths, so every route of the controllers with that path has to admit her.
      const routes = files.flatMap(gatewayRoutes);
      for (const literal of literals.filter((each) => calls.some((call) => sameRoute(call[1], each.path)))) {
        for (const route of routes.filter((each) => sameRoute(each.path, literal.path))) {
          const admitted = route.roles?.includes("SCHOOL_ADMIN") === true || route.asTeacher;
          expect(admitted, `${route.verb} /${route.path} (${route.controller}.${route.method}), written in ${literal.file} (${literal.name}), lists ${JSON.stringify(route.roles)}`).toBe(true);
        }
      }
    });
  }

  it("holds every exception to a route the page's imports do name, and to none of the table's", () => {
    for (const [page, rows] of Object.entries(NOT_CALLED_FOR_HER)) {
      const literals = reader.reach(PAGE_FILES[page]!);
      for (const row of rows) {
        expect(row.why.length, `${page} says why`).toBeGreaterThan(40);
        for (const path of row.paths) {
          expect(literals.some((literal) => sameRoute(literal.path, path)), `${page}: /${path} is named in its imports`).toBe(true);
          expect(PAGES[page]!.calls.some((call) => sameRoute(call[1], path)), `${page}: /${path} is in its table too`).toBe(false);
        }
      }
    }
  });

  it("finds the colleague side where /teacher/franvaro imports it, so that the exception is a fact and not a hope", () => {
    const paths = reader.reach(PAGE_FILES["/teacher/franvaro"]!).map((literal) => literal.path);
    expect(paths.some((path) => sameRoute(path, "api/v1/cover-requests/mine"))).toBe(true);
  });
});
