import { DiscoveryService, MetadataScanner, Reflector } from '@nestjs/core';
import { HEADERS_METADATA, METHOD_METADATA, PATH_METADATA, ROUTE_ARGS_METADATA } from '@nestjs/common/constants';
import { RequestMethod } from '@nestjs/common';
import { RouteParamtypes } from '@nestjs/common/enums/route-paramtypes.enum';
import { AREA_KEY, AS_TEACHER_KEY, type AreaRequirement } from '../src/auth/decorators/area.decorator';
import request from 'supertest';
import { IS_PUBLIC_KEY } from '../src/auth/decorators/public.decorator';
import { HUVUDMAN_NO_SCHOOL } from '../src/auth/huvudman.guard';
import { READS_ONLY_KEY } from '../src/auth/huvudman-reader';
import { ROLES_KEY } from '../src/auth/decorators/roles.decorator';
import { createTestApp, type TestHarness } from './utils/test-app';
import { FILE_ROUTE, PEOPLE_ROUTES, peopleRouteOf } from '../src/common/people-files';
import { OPEN_ROUTES, openRouteOf } from '../src/publication/open-routes';

/**
 * Whole-graph guard invariants.
 *
 * The hand-written e2e specs cover routes one by one and therefore only cover
 * the ones somebody remembered to write. These tests enumerate the routing
 * table itself, so a controller added next year is covered the moment it is
 * registered — the drift that matters is a new endpoint shipping without a
 * @Roles, not an old one losing it.
 */

/** Route paths that are deliberately reachable without a principal. */
// public/v1/timetables: Schemavisaren, behind share links and its own rate
// limit (src/publication/public-timetable.controller.ts).
// ss12000/v2.0: the SS12000 2.1 provider, authenticated by an integration key
// as S1's bearer and limited per key (src/integration/ss12000-v2), like v1.
// public/v1/sign-in-methods: /login's lookup of a domain's school-account
// provider, before anyone has signed in (src/sign-in).
// public/v1/calendar-feeds: Kalenderprenumeration, a calendar app asking a
// person's feed by its secret address, with its own rate limit
// (src/calendar-feed/public-calendar-feed.controller.ts).
const PUBLIC_PATHS = ['health', 'public/v1/timetables', 'public/v1/calendar-feeds', 'public/v1/sign-in-methods', 'ss12000/v1', 'ss12000/v2.0'];

interface RouteInfo {
  controller: string;
  method: string;
  verb: string;
  path: string;
  roles: unknown;
  area: AreaRequirement | undefined;
  isPublic: boolean;
  /** The whole path as Express routes it, the handler's part included. */
  full: string;
  /** @ReadsOnly's reason, on a write verb that only reads (Huvudman). */
  readsOnly: string | undefined;
  /** @AsTeacher's reason: the route an administrator who teaches may use as the teacher. */
  asTeacher: string | undefined;
  /** Sets Content-Disposition, or writes the response itself (@Res): what a file route does. */
  writesAFile: boolean;
}

describe('Route guard coverage (e2e)', () => {
  let harness: TestHarness;
  let routes: RouteInfo[];

  beforeAll(async () => {
    harness = await createTestApp();

    const discovery = harness.app.get(DiscoveryService);
    const scanner = new MetadataScanner();
    const reflector = harness.app.get(Reflector);

    routes = discovery.getControllers().flatMap((wrapper) => {
      const instance = wrapper.instance as Record<string, unknown> | undefined;
      if (!instance) return [];
      const cls = wrapper.metatype as new (...args: never[]) => unknown;
      const basePath = Reflect.getMetadata(PATH_METADATA, cls) as string;

      return scanner
        .getAllMethodNames(Object.getPrototypeOf(instance) as object)
        .filter((name) =>
          Reflect.hasMetadata(PATH_METADATA, (instance as never)[name]),
        )
        .map((name) => {
          const handler = (instance as never)[name] as () => unknown;
          const own = Reflect.getMetadata(PATH_METADATA, handler) as string | string[] | undefined;
          const ownPath = (Array.isArray(own) ? own[0] : own) ?? '';
          const full = `/${[basePath, ownPath].map((part) => String(part ?? '').replace(/^\/+|\/+$/g, '')).filter(Boolean).join('/')}`;
          const headers = (Reflect.getMetadata(HEADERS_METADATA, handler) as Array<{ name: string }> | undefined) ?? [];
          const args = (Reflect.getMetadata(ROUTE_ARGS_METADATA, cls, name) as Record<string, unknown> | undefined) ?? {};
          return {
            full,
            writesAFile:
              headers.some((header) => header.name.toLowerCase() === 'content-disposition') ||
              Object.keys(args).some((key) => key.startsWith(`${RouteParamtypes.RESPONSE}:`)),
            readsOnly: reflector.getAllAndOverride<string | undefined>(READS_ONLY_KEY, [handler, cls]),
            asTeacher: reflector.getAllAndOverride<string | undefined>(AS_TEACHER_KEY, [handler, cls]),
            controller: cls.name,
            method: name,
            verb: RequestMethod[Reflect.getMetadata(METHOD_METADATA, handler) as RequestMethod],
            path: basePath,
            roles: reflector.getAllAndOverride(ROLES_KEY, [handler, cls]),
            area: reflector.getAllAndOverride<AreaRequirement | undefined>(AREA_KEY, [handler, cls]),
            isPublic:
              reflector.getAllAndOverride(IS_PUBLIC_KEY, [handler, cls]) === true,
          };
        });
    });
  });

  afterAll(async () => {
    await harness.close();
  });

  it('discovers the whole routing table, not a subset of it', () => {
    // A guard on the guard: if discovery silently returned nothing, every
    // assertion below would pass vacuously.
    const controllers = new Set(routes.map((route) => route.controller));
    expect(routes.length).toBeGreaterThan(50);
    expect(controllers.size).toBeGreaterThanOrEqual(20);
    expect(controllers).toContain('ImportController');
    expect(controllers).toContain('RoomTypesController');
  });

  // Skyddad identitet (20270107090000): a route that answers a file or a feed
  // naming people is decided, by name, in src/common/people-files.ts: held
  // out, kept and counted, or why it names no pupil. A new one fails here.
  it('decides every route that hands out a file or a feed of people, for a protected identity', () => {
    const files = routes.filter((route) => FILE_ROUTE.test(route.full) || route.writesAFile);
    // The detection is not vacuous: the two feeds that write their own response are found by it.
    expect(routes.filter((route) => route.writesAFile).map((route) => route.full).sort()).toEqual(
      expect.arrayContaining(['/public/v1/calendar-feeds/:file', '/public/v1/timetables/:token']),
    );
    expect(FILE_ROUTE.test('/api/v1/person-protections/pupils.csv')).toBe(true);
    expect(files.length).toBeGreaterThanOrEqual(10);
    const undecided = files.filter((route) => peopleRouteOf(route.verb, route.full) === null);
    expect(undecided.map((route) => `${route.verb} ${route.full} (${route.controller}.${route.method})`)).toEqual([]);
    // And no decision outlives its route.
    const gone = Object.keys(PEOPLE_ROUTES).filter((key) => {
      const [verb, path] = key.split(' ');
      return path!.endsWith('/*')
        ? !files.some((route) => route.verb === verb && route.full.startsWith(path!.slice(0, -1)))
        : !files.some((route) => `${route.verb} ${route.full}` === key);
    });
    expect(gone).toEqual([]);
  });

  it('gates every route behind @Roles unless it is explicitly @Public', () => {
    const ungated = routes.filter(
      (route) => !route.isPublic && !Array.isArray(route.roles),
    );

    expect(ungated.map((r) => `${r.controller}.${r.method}`)).toEqual([]);
  });

  // Roller i skolan: an administrator's profile writes some areas and not
  // others, and RolesGuard can only hold a route to the areas it names. A
  // route an administrator can write through without naming them is one
  // every profile writes through, as far as the gateway knows; the database
  // still refuses the write, but as a 500 halfway through instead of a 403
  // that says why. So every such route names its areas, @Decides, or says
  // with @AnyAdministrator why it needs neither.
  it("names the areas of every route an administrator can write through", () => {
    const unnamed = routes.filter(
      (route) =>
        !route.isPublic &&
        Array.isArray(route.roles) &&
        (route.roles as string[]).includes('SCHOOL_ADMIN') &&
        !['GET', 'HEAD', 'OPTIONS'].includes(route.verb) &&
        route.area === undefined,
    );

    expect(unnamed.map((r) => `${r.verb} ${r.controller}.${r.method}`)).toEqual([]);
  });

  it('finds the areas on the routes that write them, not a vacuous pass', () => {
    const named = routes.filter((route) => route.area !== undefined && route.verb !== 'GET');
    expect(named.length).toBeGreaterThan(100);
    const of = (controller: string, method: string) =>
      routes.find((r) => r.controller === controller && r.method === method)?.area;
    expect(of('UsersController', 'update')).toEqual({ kind: 'area', areas: ['PERSONAL'] });
    expect(of('TeacherEmploymentsController', 'upsert')).toEqual({ kind: 'decides' });
    expect(of('GallringController', 'decide')).toEqual({ kind: 'decides' });
    // Frånvarobevakning: the switch and the limits are Drift's, the findings are read by three roles.
    expect(of('AbsenceWatchController', 'updateSettings')).toEqual({ kind: 'area', areas: ['DRIFT'] });
    expect(of('AbsenceWatchController', 'createLimit')).toEqual({ kind: 'area', areas: ['DRIFT'] });
    // Kvittens: the switch is Drift's; a request is written by a teacher or an administrator under Drift.
    expect(of('AckController', 'updateSettings')).toEqual({ kind: 'area', areas: ['DRIFT'] });
    expect(of('AckController', 'create')).toEqual({ kind: 'area', areas: ['DRIFT'] });
    expect(of('AckController', 'stopReminder')).toEqual({ kind: 'area', areas: ['DRIFT'] });
    // Checklistor: the templates, the ticks, the lists and their answers are Drift's; a teacher ticks and writes too.
    for (const method of ['createTemplate', 'updateTemplate', 'tick', 'voidProof', 'createList', 'record', 'ask', 'close']) {
      expect(of('ChecklistsController', method)).toEqual({ kind: 'area', areas: ['DRIFT'] });
    }
    // Lokal: the kinds of resource and the resources are Planering's (as the rooms are); a teacher reads them and books.
    for (const method of ['create', 'update', 'remove']) {
      expect(of('ResourceTypesController', method)).toEqual({ kind: 'area', areas: ['PLANERING'] });
      expect(of('ResourcesController', method)).toEqual({ kind: 'area', areas: ['PLANERING'] });
    }
    // Lokal: a booking of a resource is decided and cancelled under Drift, as a room booking is; so is every write of a series
    // of external bookings (preview included: it is a POST, and a reader who cannot register has no use for it).
    for (const method of ['create', 'cancel', 'decide']) {
      expect(of('ResourceBookingsController', method)).toEqual({ kind: 'area', areas: ['DRIFT'] });
    }
    for (const method of ['preview', 'create', 'update', 'cancel', 'remove', 'cancelDay']) {
      expect(of('ExternalBookingsController', method)).toEqual({ kind: 'area', areas: ['DRIFT'] });
    }
    // Lokal: the utilisation report writes nothing and names no person: every administrator reads it, whatever the profile.
    for (const method of ['report', 'csv']) {
      expect(of('UtilisationController', method)).toMatchObject({ kind: 'any' });
    }
    // Rapporteringsgrad: the switches and the limit are Drift's; a teacher reads their own page.
    expect(of('ReportingRateController', 'updateSettings')).toEqual({ kind: 'area', areas: ['DRIFT'] });
    expect(of('PublicationsController', 'publish')).toEqual({ kind: 'area', areas: ['PUBLICERING', 'DRIFT'] });
    // Schemaförslag: a run and a discard write the candidate tables alone;
    // an apply replaces the draft as Generera does, which in DIRECT takes
    // the replaced lessons off the calendar, so it holds the class's two.
    expect(of('OptimizationController', 'startCandidates')).toEqual({ kind: 'area', areas: ['SCHEMALAGGNING'] });
    expect(of('OptimizationController', 'discardCandidates')).toEqual({ kind: 'area', areas: ['SCHEMALAGGNING'] });
    expect(of('OptimizationController', 'applyCandidate')).toEqual({ kind: 'area', areas: ['SCHEMALAGGNING', 'DRIFT'] });
  });

  // Rapporteringsgrad: the school's figures and the switches are the administrators',
  // and a teacher's own page is the teacher's alone; the class's @Roles is
  // overridden by the one route that names another.
  it('keeps the reporting rate’s school routes to the administrators and a teacher’s own page to teachers', () => {
    const rolesOf = (method: string) => routes.find((r) => r.controller === 'ReportingRateController' && r.method === method)?.roles;
    expect(rolesOf('overview')).toEqual(['SCHOOL_ADMIN']);
    expect(rolesOf('settings')).toEqual(['SCHOOL_ADMIN']);
    expect(rolesOf('updateSettings')).toEqual(['SCHOOL_ADMIN']);
    expect(rolesOf('mine')).toEqual(['TEACHER']);
  });

  // Checklistor: the school's templates are the administrators' to write; everything else on the controller is a
  // teacher's as well as an administrator's, and nobody else has a route (a guardian confirms a consent through
  // Kvittens, a pupil sees nothing).
  it('keeps the writing of Checklistor’s templates to the administrators and every other route (the sheets for paper included) to staff', () => {
    const checklists = routes.filter((r) => r.controller === 'ChecklistsController');
    expect(checklists.length).toBe(18);
    // The two sheets for paper are the screen's routes with a pupil held out, for a teacher too (a teacher can not read the marks).
    const sheets = checklists.filter((route) => route.method === 'rosterForPaper' || route.method === 'detailForPaper');
    expect(sheets.map((route) => `${route.verb} ${route.full}`).sort()).toEqual([
      'GET /api/v1/checklists/consent-lists/:id/print',
      'GET /api/v1/checklists/templates/:id/roster/print',
    ]);
    for (const route of sheets) expect(route.roles).toEqual(['SCHOOL_ADMIN', 'TEACHER']);
    for (const route of checklists) {
      const writesTemplates = route.method === 'createTemplate' || route.method === 'updateTemplate';
      expect([route.method, route.roles]).toEqual([route.method, writesTemplates ? ['SCHOOL_ADMIN'] : ['SCHOOL_ADMIN', 'TEACHER']]);
      expect(route.isPublic).toBe(false);
      expect(route.path).toBe('api/v1/checklists');
    }
    // Not a file or a feed of people: the list is printed from the screen, which holds out the protected identities.
    expect(checklists.some((route) => route.writesAFile)).toBe(false);
  });

  // Administratör som lärare (Users.teaches): a person who is an administrator and teaches may use the teacher's
  // own routes, one by one. The doors are written out, so that a fourth fails here until it is decided; every
  // other route that lists TEACHER (and not SCHOOL_ADMIN) is refused such a person, which is the decision that
  // the class teacher, the cover request's colleague side, krisläge, mentor and the reporting rate are not
  // opened by the mark in this change (PR 4 does krisläge, mentor and the reporting rate, with their arms).
  const TEACHING_ADMINISTRATOR_DOORS = [
    'GET LessonLogController.list',
    'GET LessonLogController.handedOver',
    'PUT LessonLogController.putNote',
  ];

  it("opens exactly three routes to an administrator who teaches, each one the teacher's own that lists TEACHER", () => {
    const doors = routes.filter((route) => route.asTeacher !== undefined);
    expect(doors.map((route) => `${route.verb} ${route.controller}.${route.method}`).sort()).toEqual([...TEACHING_ADMINISTRATOR_DOORS].sort());
    for (const door of doors) {
      expect(door.roles).toContain('TEACHER');
      expect(door.asTeacher!.length).toBeGreaterThanOrEqual(20);
    }
  });

  it('pins the routes that stay the teachers: the class teacher, the cover colleague side, krisläge, mentor, rapporteringsgrad', () => {
    const pinned = [
      ['ClassTeacherController', undefined],
      ['CoverRequestsTeacherController', undefined],
      ['CrisisTeacherController', undefined],
      ['ReportingRateController', 'mine'],
      ['FamilyController', 'referLeaveRequest'],
    ] as const;
    for (const [controller, method] of pinned) {
      const of = routes.filter((route) => route.controller === controller && (method === undefined || route.method === method));
      expect([controller, method, of.length > 0]).toEqual([controller, method, true]);
      for (const route of of) {
        expect([route.controller, route.method, route.roles, route.asTeacher]).toEqual([route.controller, route.method, ['TEACHER'], undefined]);
      }
    }
  });

  it('refuses an administrator who teaches every route that lists TEACHER and not SCHOOL_ADMIN, but the three doors', async () => {
    const person = JSON.stringify({
      authId: '11111111-1111-4111-8111-111111111111',
      role: 'SCHOOL_ADMIN',
      userId: '22222222-2222-4222-8222-222222222222',
      schoolId: '33333333-3333-4333-8333-333333333333',
      adminProfile: 'REKTOR',
      hrRead: true,
      teaches: true,
    });
    const uuid = '44444444-4444-4444-8444-444444444444';
    const teacherOnly = routes.filter(
      (route) => !route.isPublic && Array.isArray(route.roles) && (route.roles as string[]).includes('TEACHER') && !(route.roles as string[]).includes('SCHOOL_ADMIN'),
    );
    // Not vacuous: the teacher's own routes are many, and the doors are among them.
    expect(teacherOnly.length).toBeGreaterThanOrEqual(18);
    const wrong: string[] = [];
    let refused = 0;
    let admitted = 0;
    for (const route of teacherOnly) {
      const url = route.full.replace(/:[A-Za-z0-9_]+(\([^)]*\))?\??/g, uuid);
      const verb = route.verb.toLowerCase() as 'get' | 'post' | 'put' | 'patch' | 'delete';
      if (!['get', 'post', 'put', 'patch', 'delete'].includes(verb)) continue;
      const response = await request(harness.app.getHttpServer())[verb](url).set('x-test-user', person).send({});
      const door = route.asTeacher !== undefined;
      const refusedByTheGuard = response.status === 403 && (response.body as { detail?: unknown } | undefined)?.detail === 'You do not have permission to perform this action.';
      if (door && refusedByTheGuard) wrong.push(`${route.verb} ${route.full} is a door and was refused`);
      if (!door && !refusedByTheGuard) wrong.push(`${route.verb} ${route.full} answered ${response.status}`);
      if (door) admitted += 1;
      else refused += 1;
    }
    expect(wrong).toEqual([]);
    expect(admitted).toBe(TEACHING_ADMINISTRATOR_DOORS.length);
    expect(refused).toBeGreaterThanOrEqual(15);
  });

  it('refuses the same administrator without the mark at the three doors, and a teacher keeps them', async () => {
    const as = (overrides: Record<string, unknown>) =>
      JSON.stringify({
        authId: '11111111-1111-4111-8111-111111111111',
        role: 'SCHOOL_ADMIN',
        userId: '22222222-2222-4222-8222-222222222222',
        schoolId: '33333333-3333-4333-8333-333333333333',
        adminProfile: 'REKTOR',
        hrRead: true,
        ...overrides,
      });
    const server = harness.app.getHttpServer();
    const note = '/api/v1/lesson-logs/lessons/44444444-4444-4444-8444-444444444444/substitute-note';
    for (const principal of [as({}), as({ teaches: false }), as({ adminProfile: 'SCHEMALAGGARE' })]) {
      const response = await request(server).put(note).set('x-test-user', principal).send({ body: 'x' });
      expect([response.status, (response.body as { detail?: unknown }).detail]).toEqual([403, 'You do not have permission to perform this action.']);
    }
    // The teacher's own route is the teacher's, as it was: the guard lets them through.
    const teacher = await request(server).put(note).set('x-test-user', as({ role: 'TEACHER', adminProfile: undefined, hrRead: undefined })).send({ body: 'x' });
    expect((teacher.body as { detail?: unknown }).detail).not.toBe('You do not have permission to perform this action.');
  });

  it('keeps the public surface to the health probes, the public viewer and SS12000', () => {
    const publicPaths = [
      ...new Set(routes.filter((r) => r.isPublic).map((r) => r.path)),
    ].sort();

    expect(publicPaths).toEqual([...PUBLIC_PATHS].sort());
  });

  // Schemavisarens lägen (20270118090000): the school decides what a stranger
  // may read of a timetable, and a route that shows one to a stranger answers
  // to that decision or it is a leak. Every open route is classed in
  // src/publication/open-routes.ts: through the viewer's door, a person's own
  // address, or no schedule at all. A new one fails here until it is decided;
  // test/public-viewer.e2e-spec.ts then asks each viewer route whether it
  // keeps to its door.
  it('classes every open route by what it has to do with the viewer\'s modes, and keeps no class for a route that is gone', () => {
    const open = routes.filter((route) => route.isPublic);
    // Not vacuous: the viewer, the feed, the probes, the sign-in lookup and SS12000 are all found.
    expect(open.length).toBeGreaterThanOrEqual(10);
    expect(open.map((route) => route.full)).toEqual(
      expect.arrayContaining(['/public/v1/timetables/:token', '/public/v1/timetables/:token/embed', '/public/v1/calendar-feeds/:file']),
    );
    const unclassed = open.filter((route) => openRouteOf(route.verb, route.full) === null);
    expect(unclassed.map((route) => `${route.verb} ${route.full} (${route.controller}.${route.method})`)).toEqual([]);
    const gone = Object.keys(OPEN_ROUTES).filter((key) => {
      const [verb, path] = key.split(' ');
      return path!.endsWith('*')
        ? !open.some((route) => route.verb === verb && route.full.startsWith(path!.slice(0, -1)))
        : !open.some((route) => `${route.verb} ${route.full}` === key);
    });
    expect(gone).toEqual([]);
    // A route that shows a stranger a timetable names the door that asks the school.
    for (const [key, entry] of Object.entries(OPEN_ROUTES)) {
      if (entry.relation === 'VIEWER') expect(`${key} ${entry.door}`).toMatch(/ app\.[a-z_]+\($/);
    }
  });

  // The signed-in staff route of Schemavisaren is the other door of the same
  // viewer: it is not open, and a pupil, a guardian or a stranger do not get
  // through it.
  it('keeps the staff door of the viewer to teachers and administrators', () => {
    const staff = routes.find((route) => route.full === '/api/v1/schemavisaren/:token');
    expect(staff?.isPublic).toBe(false);
    expect(staff?.roles).toEqual(['TEACHER', 'SCHOOL_ADMIN']);
  });

  // Huvudman (20261212090000): a member with no school named reaches the
  // huvudman's own routes and /me and nothing else, by HuvudmanGuard's own
  // refusal (its code, not RolesGuard's), on every verb: asked of every
  // route of the table, with each path parameter a uuid. @Public routes are
  // anybody's, the member's as anonymous's, and are listed above.
  // What a member with no school may ask, by name: the huvudman's own pages
  // and the login's schools. Written out, not read from the guard, so that a
  // guard that allowed more (or less) fails here.
  const HUVUDMAN_MAY = [
    'HuvudmanController.mine',
    'HuvudmanController.view',
    'HuvudmanController.requestSchool',
    'HuvudmanController.withdrawRequest',
    'HuvudmanController.releaseSchool',
    'HuvudmanController.invite',
    'HuvudmanController.updateMember',
    'HuvudmanController.createKey',
    'HuvudmanController.revokeKey',
    'MeController.mySchools',
  ];

  it("refuses a huvudman's member with no school every route but the huvudman's own and /me", async () => {
    const member = JSON.stringify({ authId: '11111111-1111-4111-8111-111111111111', role: 'HUVUDMAN' });
    const uuid = '44444444-4444-4444-8444-444444444444';
    const named = new Set(routes.map((route) => `${route.controller}.${route.method}`));
    expect(HUVUDMAN_MAY.filter((name) => !named.has(name))).toEqual([]);
    const allowed = (route: RouteInfo) => HUVUDMAN_MAY.includes(`${route.controller}.${route.method}`);
    const wrong: string[] = [];
    let refused = 0;
    let reached = 0;
    for (const route of routes) {
      if (route.isPublic) continue;
      const url = route.full.replace(/:[A-Za-z0-9_]+(\([^)]*\))?\??/g, uuid);
      const verb = route.verb.toLowerCase() as 'get' | 'post' | 'put' | 'patch' | 'delete';
      if (!['get', 'post', 'put', 'patch', 'delete'].includes(verb)) continue;
      const response = await request(harness.app.getHttpServer())[verb](url).set('x-test-user', member).send({});
      const code = (response.body as { code?: unknown } | undefined)?.code;
      if (allowed(route)) {
        reached += 1;
        if (code === HUVUDMAN_NO_SCHOOL) wrong.push(`${route.verb} ${route.full} refused on the huvudman's own list`);
      } else {
        refused += 1;
        if (response.status !== 403 || code !== HUVUDMAN_NO_SCHOOL) wrong.push(`${route.verb} ${route.full} answered ${response.status} ${String(code)}`);
      }
    }
    expect(wrong).toEqual([]);
    // Not a vacuous pass: most of the table refused, the huvudman's own reached.
    expect(refused).toBeGreaterThanOrEqual(295);
    expect(reached).toBeGreaterThanOrEqual(10);
  });

  // The one write verb the huvudman's reader may use is the activation
  // preview, a POST that only reads (RolesGuard, READS_ONLY_KEY). A second
  // fails here until it is listed, with its reason.
  it('marks one route @ReadsOnly, the year activation preview', () => {
    const marked = routes.filter((route) => route.readsOnly !== undefined).map((route) => `${route.verb} ${route.controller}.${route.method}`);
    expect(marked).toEqual(['POST YearRolloverController.previewActivation']);
  });

  it('answers 401 on an authenticated route with no principal at all', async () => {
    await request(harness.app.getHttpServer())
      .get('/api/v1/room-types')
      .expect(401);
  });

  it('lets the liveness probe through without one', async () => {
    await request(harness.app.getHttpServer()).get('/health').expect(200);
  });
});
