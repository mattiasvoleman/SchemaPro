import { DiscoveryService, MetadataScanner, Reflector } from '@nestjs/core';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { RequestMethod } from '@nestjs/common';
import { AREA_KEY, type AreaRequirement } from '../src/auth/decorators/area.decorator';
import request from 'supertest';
import { IS_PUBLIC_KEY } from '../src/auth/decorators/public.decorator';
import { ROLES_KEY } from '../src/auth/decorators/roles.decorator';
import { createTestApp, type TestHarness } from './utils/test-app';

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
          return {
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
    expect(of('PublicationsController', 'publish')).toEqual({ kind: 'area', areas: ['PUBLICERING', 'DRIFT'] });
    // Schemaförslag: a run and a discard write the candidate tables alone;
    // an apply replaces the draft as Generera does, which in DIRECT takes
    // the replaced lessons off the calendar, so it holds the class's two.
    expect(of('OptimizationController', 'startCandidates')).toEqual({ kind: 'area', areas: ['SCHEMALAGGNING'] });
    expect(of('OptimizationController', 'discardCandidates')).toEqual({ kind: 'area', areas: ['SCHEMALAGGNING'] });
    expect(of('OptimizationController', 'applyCandidate')).toEqual({ kind: 'area', areas: ['SCHEMALAGGNING', 'DRIFT'] });
  });

  it('keeps the public surface to the health probes, the public viewer and SS12000', () => {
    const publicPaths = [
      ...new Set(routes.filter((r) => r.isPublic).map((r) => r.path)),
    ].sort();

    expect(publicPaths).toEqual([...PUBLIC_PATHS].sort());
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
