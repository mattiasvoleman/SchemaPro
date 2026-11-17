import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const ts = require('typescript') as typeof import('typescript');

/**
 * The seam between the app and the gateway for an administrator who teaches
 * (Users.teaches, PR 6 of 7). No call graph reaches across it: a screen calls
 * a route, and whether the route admits an administrator who teaches is written
 * in a controller in src/, which the app cannot import. So the gateway's source
 * is read as text, as the web's teaching-admin.contract.test.ts does and as
 * appGate.contract.test.ts reads prisma/schema.prisma (CI's mobile job checks
 * out the whole repository), and four things are held:
 *
 *   (a) every call the staff shell makes is to a route that lists SCHOOL_ADMIN
 *       or is one of the doors the mark opens (@AsTeacher): none can answer a
 *       marked administrator 403. That is the roll call of an alarm (the three
 *       doors of CrisisTeacherController) and the administration's view of it,
 *       the register, the week's supervision, push and the notice settings.
 *   (b) every call the Vikarie screen makes is to a route that is a teacher's
 *       alone (CoverRequestsTeacherController, SP409), so the tab stays off the
 *       bar for her: a gateway that opened the cover routes to her would fail
 *       here until the app has decided too.
 *   (c) no source file of the app calls a gateway route without being sorted into
 *       one of the three: a new call in a staff screen is a call this test must
 *       be told of, with the gateway's answer for a marked administrator.
 *   (d) no screen of the staff shell reads the guardian's services, among them
 *       the leave requests: the app has no staff view of Ledighet, so there is
 *       no inbox of a mentor's here to narrow (the web narrows its own).
 *
 * The doors are the gateway's own list (test/route-guards.e2e-spec.ts), read the
 * way the web reads it, and the mobile table of them is written out below: a
 * ninth door fails the gateway's test until it is decided there, and this one
 * until the app has decided too.
 */

const APP = join(__dirname, '..', '..', '..');
const ROOT = join(APP, '..');

interface Route {
  readonly controller: string;
  readonly method: string;
  readonly verb: string;
  /** With the controller's prefix, a parameter as `:x`, no leading slash. */
  readonly path: string;
  /** The role names of @Roles (the method's, else the class's); null when there is none. */
  readonly roles: readonly string[] | null;
  /** Carries @AsTeacher on the method or the class. */
  readonly asTeacher: boolean;
}

/** The segments of a path with every parameter named alike, so that `:id` and `:alarmId` meet. */
const shape = (path: string): string =>
  path
    .replace(/^\//, '')
    .split('/')
    .map((segment) => (segment.startsWith(':') ? ':x' : segment))
    .join('/');

function walk(dir: string, keep: (name: string) => boolean, skip: readonly string[] = ['node_modules']): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (skip.includes(entry.name)) return [];
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return walk(path, keep, skip);
    return keep(entry.name) ? [path] : [];
  });
}

/** The routes of one controller file, read from its decorators. */
function routesOf(file: string): Route[] {
  const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
  const decorators = (node: import('typescript').Node) => (ts.canHaveDecorators(node) ? (ts.getDecorators(node) ?? []) : []);
  const callOf = (decorator: import('typescript').Decorator) => (ts.isCallExpression(decorator.expression) ? decorator.expression : null);
  const nameOf = (decorator: import('typescript').Decorator): string | null => {
    const call = callOf(decorator);
    return call && ts.isIdentifier(call.expression) ? call.expression.text : ts.isIdentifier(decorator.expression) ? decorator.expression.text : null;
  };
  const argsOf = (decorator: import('typescript').Decorator) => (callOf(decorator)?.arguments ?? []).map((argument) => argument.getText(source));
  const rolesOf = (list: readonly import('typescript').Decorator[]) => {
    const roles = list.find((decorator) => nameOf(decorator) === 'Roles');
    return roles ? argsOf(roles).map((argument) => argument.replace(/^Role\./, '')) : null;
  };
  const unquote = (text: string) => text.replace(/^['"`]|['"`]$/g, '');

  const found: Route[] = [];
  ts.forEachChild(source, (node) => {
    if (!ts.isClassDeclaration(node) || !node.name) return;
    const own = decorators(node);
    const controller = own.find((decorator) => nameOf(decorator) === 'Controller');
    if (!controller) return;
    const prefix = unquote(argsOf(controller)[0] ?? "''");
    for (const member of node.members) {
      if (!ts.isMethodDeclaration(member)) continue;
      const list = decorators(member);
      const verb = list.find((decorator) => ['Get', 'Post', 'Put', 'Patch', 'Delete'].includes(nameOf(decorator) ?? ''));
      if (!verb) continue;
      found.push({
        controller: node.name.text,
        method: member.name.getText(source),
        verb: nameOf(verb)!.toUpperCase(),
        path: shape([prefix, unquote(argsOf(verb)[0] ?? "''")].filter(Boolean).join('/')),
        roles: rolesOf(list) ?? rolesOf(own),
        asTeacher: list.some((decorator) => nameOf(decorator) === 'AsTeacher') || own.some((decorator) => nameOf(decorator) === 'AsTeacher'),
      });
    }
  });
  return found;
}

const GATEWAY: readonly Route[] = walk(join(ROOT, 'src'), (name) => name.endsWith('.controller.ts')).flatMap(routesOf);

/** Whether the gateway lets an administrator who teaches (and no more than that) through to the route. */
const admitsMarkedAdministrator = (route: Route): boolean => route.roles?.includes('SCHOOL_ADMIN') === true || route.asTeacher;

const routeFor = (verb: string, path: string): Route | undefined => GATEWAY.find((route) => route.verb === verb && route.path === shape(path));

// ─── What the app asks for ────────────────────────────────────────────────────

interface Call {
  readonly verb: string;
  /** `/api/v1/...`, a parameter as `:x`, no query. */
  readonly path: string;
  readonly file: string;
}

/** Calls to apiRequest whose path the reading could not render (a path built by a function, a join, a parameter): never silently skipped. */
const UNREADABLE: string[] = [];

/** The gateway calls one source file makes through apiRequest, read from its syntax. */
function callsOf(file: string): Call[] {
  const text = readFileSync(file, 'utf8');
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);

  // A name the file gives a path (`const BASE = '/api/v1/crisis'`, `const path = `${BASE}/${id}``), at any depth.
  const named = new Map<string, import('typescript').Expression>();
  const collect = (node: import('typescript').Node): void => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) named.set(node.name.text, node.initializer);
    ts.forEachChild(node, collect);
  };
  collect(source);

  const HOLE = '\u0000';
  const render = (node: import('typescript').Expression, seen: readonly string[] = []): string | null => {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
    if (ts.isParenthesizedExpression(node)) return render(node.expression, seen);
    if (ts.isIdentifier(node)) {
      const value = named.get(node.text);
      return value && !seen.includes(node.text) ? render(value, [...seen, node.text]) : null;
    }
    if (ts.isTemplateExpression(node)) {
      let out = node.head.text;
      for (const span of node.templateSpans) {
        const inner = ts.isIdentifier(span.expression) ? render(span.expression, seen) : null;
        out += (inner ?? HOLE) + span.literal.text;
      }
      return out;
    }
    return null;
  };
  /** A hole that is a whole segment is a parameter; one glued to a segment (a query helper) is nothing. */
  const normalise = (raw: string): string => {
    const path = raw.split('?')[0]!;
    return path
      .split('/')
      .map((segment) => (segment === HOLE ? ':x' : segment.split(HOLE).join('')))
      .join('/');
  };

  const calls: Call[] = [];
  const visit = (node: import('typescript').Node): void => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'apiRequest' && node.arguments[0]) {
      const rendered = render(node.arguments[0]);
      if (rendered === null) UNREADABLE.push(`${relative(APP, file)}: ${node.arguments[0].getText(source)}`);
      if (rendered !== null && rendered.startsWith('/api/v1/')) {
        const options = node.arguments[1];
        let verb = 'GET';
        if (options && ts.isObjectLiteralExpression(options)) {
          for (const property of options.properties) {
            if (ts.isPropertyAssignment(property) && property.name.getText(source) === 'method' && ts.isStringLiteral(property.initializer)) {
              verb = property.initializer.text.toUpperCase();
            }
          }
        }
        calls.push({ verb, path: normalise(rendered), file: relative(APP, file) });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return calls;
}

const SRC = join(APP, 'src');
const sourcesOf = (dir: string): string[] => walk(dir, (name) => /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name), ['node_modules', '__testing__']);
const ALL_CALLS: readonly Call[] = [...sourcesOf(SRC), ...sourcesOf(join(APP, 'app'))].flatMap(callsOf);

/** Where each service that calls the gateway is read: the staff shell, the Vikarie tab, or the family's shells. */
const STAFF_SHELL = [
  // Schema: the week's own supervision. Närvaro: the roster and the register (also sent from the offline queue).
  'src/services/supervisionWeek.ts',
  'src/services/roster.ts',
  'src/services/sync/attendance_sync_worker.ts',
  // Larm: the roll call of her own groups and the administration's view of the alarm, both in one file.
  'src/services/crisis.ts',
  // Inställningar and push, which every shell has.
  'src/services/notificationPreferences.ts',
  'src/services/pushRegistration.ts',
];
const VIKARIE_TAB = ['src/services/coverRequests.ts'];
const FAMILY_SHELLS = [
  'src/services/absenceReports.ts',
  'src/services/acknowledgements.ts',
  'src/services/children.ts',
  'src/services/familySchedule.ts',
  'src/services/leaveRequests.ts',
];

const callsIn = (files: readonly string[]): Call[] => ALL_CALLS.filter((call) => files.includes(call.file));

/** The doors, as the gateway's own test writes them: `VERB Controller.method`. */
const GUARDS = readFileSync(join(ROOT, 'test', 'route-guards.e2e-spec.ts'), 'utf8');
const GATEWAY_DOORS = [...(/const TEACHING_ADMINISTRATOR_DOORS = \[([^\]]*)\]/.exec(GUARDS)?.[1] ?? '').matchAll(/'([A-Z]+ \w+\.\w+)'/g)].map((match) => match[1]!);

/** The doors as the app knows them: three are the roll call's own routes; the rest are the web's. */
const APP_USES = ['GET CrisisTeacherController.mine', 'POST CrisisTeacherController.pupils', 'POST CrisisTeacherController.mark'];
const NOT_ASKED_BY_THE_APP = [
  'GET LessonLogController.list',
  'GET LessonLogController.handedOver',
  'PUT LessonLogController.putNote',
  'GET ReportingRateController.mine',
  'PATCH FamilyController.referLeaveRequest',
];

describe('the doors the gateway opens to an administrator who teaches', () => {
  it('are the ones the app knows, exactly: three it asks for, five it has no screen for', () => {
    expect(GATEWAY_DOORS).toHaveLength(8);
    expect([...APP_USES, ...NOT_ASKED_BY_THE_APP].sort()).toEqual([...GATEWAY_DOORS].sort());
  });

  it('are read from the decorators as doors, so that the checks below can fail', () => {
    const doors = GATEWAY.filter((route) => route.asTeacher).map((route) => `${route.verb} ${route.controller}.${route.method}`);
    expect(doors.sort()).toEqual([...GATEWAY_DOORS].sort());
    // A teacher's own route that is no door, and an administrator's that admits her without one: the reading tells them apart.
    expect(routeFor('GET', 'api/v1/cover-requests/mine')).toMatchObject({ roles: ['TEACHER'], asTeacher: false });
    expect(routeFor('GET', 'api/v1/crisis/mine')).toMatchObject({ roles: ['TEACHER'], asTeacher: true });
    expect(routeFor('POST', 'api/v1/crisis/alarms')?.roles).toEqual(['SCHOOL_ADMIN']);
    expect(admitsMarkedAdministrator(routeFor('GET', 'api/v1/cover-requests/mine')!)).toBe(false);
    expect(admitsMarkedAdministrator(routeFor('GET', 'api/v1/crisis/mine')!)).toBe(true);
    expect(admitsMarkedAdministrator(routeFor('POST', 'api/v1/crisis/alarms')!)).toBe(true);
  });
});

describe('every call the staff shell makes admits an administrator who teaches (a)', () => {
  const staff = callsIn(STAFF_SHELL);
  const distinct = [...new Map(staff.map((call) => [`${call.verb} ${call.path}`, call])).values()];

  it('finds the calls it is about, so that the check is not vacuous', () => {
    expect(distinct.map((call) => `${call.verb} ${call.path}`).sort()).toEqual(
      [
        'GET /api/v1/attendance/lessons/:x/roster',
        'GET /api/v1/crisis/alarms',
        'GET /api/v1/crisis/alarms/:x',
        'GET /api/v1/crisis/mine',
        'GET /api/v1/notification-preferences',
        'GET /api/v1/push/config',
        'GET /api/v1/supervision/week',
        'POST /api/v1/attendance/report',
        'POST /api/v1/crisis/alarms',
        'POST /api/v1/crisis/alarms/:x/end',
        'POST /api/v1/crisis/alarms/:x/marks',
        'POST /api/v1/crisis/mine/marks',
        'POST /api/v1/crisis/mine/pupils',
        'POST /api/v1/devices',
        'POST /api/v1/devices/release',
        'POST /api/v1/devices/unregister',
        'PUT /api/v1/notification-preferences',
      ].sort(),
    );
  });

  for (const call of distinct) {
    it(`${call.verb} ${call.path} (${call.file})`, () => {
      const route = routeFor(call.verb, call.path);
      // The pair is what a failure prints: which route, what it lists, and that it is no door.
      expect([`${call.verb} ${call.path}`, route !== undefined]).toEqual([`${call.verb} ${call.path}`, true]);
      expect([`${call.verb} ${call.path}`, route!.roles, route!.asTeacher, admitsMarkedAdministrator(route!)]).toEqual([
        `${call.verb} ${call.path}`,
        route!.roles,
        route!.asTeacher,
        true,
      ]);
    });
  }

  it('asks for all three doors of the roll call, and for no other door', () => {
    const doors = distinct.map((call) => routeFor(call.verb, call.path)!).filter((route) => route.asTeacher);
    expect(doors.map((route) => `${route.verb} ${route.controller}.${route.method}`).sort()).toEqual([...APP_USES].sort());
  });
});

describe('every call the Vikarie tab makes is a teacher’s alone, so the mark opens no tab (b)', () => {
  const cover = callsIn(VIKARIE_TAB);

  it('finds the four colleague routes, so that the check is not vacuous', () => {
    expect([...new Set(cover.map((call) => `${call.verb} ${call.path}`))].sort()).toEqual(
      [
        'GET /api/v1/cover-requests/mine',
        'POST /api/v1/cover-requests/:x/accept',
        'POST /api/v1/cover-requests/:x/decline',
        'POST /api/v1/cover-requests/lessons/:x/confirm',
      ].sort(),
    );
  });

  for (const call of cover) {
    it(`${call.verb} ${call.path}`, () => {
      const route = routeFor(call.verb, call.path);
      expect([`${call.verb} ${call.path}`, route !== undefined]).toEqual([`${call.verb} ${call.path}`, true]);
      expect(route!.roles).toEqual(['TEACHER']);
      expect(route!.controller).toBe('CoverRequestsTeacherController');
      // True here means the gateway opened the colleague side to her: decide whether she has a Vikarie tab before changing this.
      expect([`${call.verb} ${call.path}`, admitsMarkedAdministrator(route!)]).toEqual([`${call.verb} ${call.path}`, false]);
    });
  }
});

describe('every gateway call in the app is sorted (c)', () => {
  it('can read the path of every call it sorts: one it cannot read is one it would let through', () => {
    expect(UNREADABLE).toEqual([]);
  });

  it('belongs to one of the staff shell, the Vikarie tab or the family’s shells', () => {
    const known = new Set([...STAFF_SHELL, ...VIKARIE_TAB, ...FAMILY_SHELLS]);
    const unsorted = [...new Set(ALL_CALLS.filter((call) => !known.has(call.file)).map((call) => `${call.file}: ${call.verb} ${call.path}`))];
    expect(unsorted).toEqual([]);
  });

  it('lists no file that makes no call, so a moved service is noticed', () => {
    for (const file of [...STAFF_SHELL, ...VIKARIE_TAB, ...FAMILY_SHELLS]) expect([file, callsIn([file]).length > 0]).toEqual([file, true]);
  });

  it('keeps the family’s shells out of the routes of the staff shell: nothing is shared by accident', () => {
    const staff = new Set(callsIn(STAFF_SHELL).map((call) => `${call.verb} ${call.path}`));
    for (const call of callsIn(FAMILY_SHELLS)) expect([`${call.verb} ${call.path}`, staff.has(`${call.verb} ${call.path}`)]).toEqual([`${call.verb} ${call.path}`, false]);
  });
});

describe('no screen of the staff shell reads the guardian’s services (d)', () => {
  const STAFF_SCREEN_DIRS = ['attendance', 'cover', 'crisis', 'notifications', 'schedule', 'settings'];
  const files = [...STAFF_SCREEN_DIRS.flatMap((dir) => sourcesOf(join(SRC, 'screens', dir))), ...sourcesOf(join(APP, 'app', '(app)'))];

  it('has screens to look at', () => {
    expect(files.length).toBeGreaterThan(10);
  });

  it('imports none of the family’s services, among them the leave requests', () => {
    const family = FAMILY_SHELLS.map((path) => path.replace(/^src\/services\//, '').replace(/\.ts$/, ''));
    const importing: string[] = [];
    for (const file of files) {
      const text = readFileSync(file, 'utf8');
      for (const service of family) {
        if (new RegExp(`from ['"][./]*services/${service}['"]`).test(text) || new RegExp(`from ['"]\\./${service}['"]`).test(text)) importing.push(`${relative(APP, file)} imports ${service}`);
      }
    }
    expect(importing).toEqual([]);
  });

  it('has no leave screen under (app): the mentor’s inbox is the web’s', () => {
    expect(readdirSync(join(APP, 'app', '(app)')).some((name) => /leave|ledighet/i.test(name))).toBe(false);
    expect(sourcesOf(join(SRC, 'screens')).filter((path) => /staff|teacher|mentor/i.test(relative(join(SRC, 'screens'), path)) && /leave/i.test(path))).toEqual([]);
  });
});
