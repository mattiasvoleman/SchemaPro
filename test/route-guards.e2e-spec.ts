import { DiscoveryService, MetadataScanner, Reflector } from '@nestjs/core';
import { PATH_METADATA } from '@nestjs/common/constants';
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
const PUBLIC_PATHS = ['health', 'public/v1/timetables', 'ss12000/v1'];

interface RouteInfo {
  controller: string;
  method: string;
  path: string;
  roles: unknown;
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
            path: basePath,
            roles: reflector.getAllAndOverride(ROLES_KEY, [handler, cls]),
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
