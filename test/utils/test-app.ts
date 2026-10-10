import 'reflect-metadata';
import {
  CanActivate,
  ClassSerializerInterceptor,
  ExecutionContext,
  Global,
  Injectable,
  Module,
  UnauthorizedException,
  ValidationPipe,
  type INestApplication,
} from '@nestjs/common';
import {
  APP_FILTER,
  APP_GUARD,
  APP_INTERCEPTOR,
  APP_PIPE,
  Reflector,
} from '@nestjs/core';
import { DiscoveryModule } from '@nestjs/core';
import { HttpService } from '@nestjs/axios';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { configureBodyParsers } from '../../src/common/http-defaults';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { Test, type TestingModuleBuilder } from '@nestjs/testing';
import { of } from 'rxjs';
import type { Request } from 'express';
import { AppConfigModule } from '../../src/config/config.module';
import { DatabaseModule } from '../../src/database/database.module';
import { HttpExceptionFilter } from '../../src/common/filters/http-exception.filter';
import { WindowedThrottlerStorage } from '../../src/common/windowed-throttler-storage';
import { RolesGuard } from '../../src/auth/roles.guard';
import { IS_PUBLIC_KEY } from '../../src/auth/decorators/public.decorator';
import { NotificationsModule } from '../../src/notifications/notifications.module';
import { AttendanceModule } from '../../src/attendance/attendance.module';
import { ResourcesModule } from '../../src/resources/resources.module';
import { CalendarModule } from '../../src/calendar/calendar.module';
import { UsersModule } from '../../src/users/users.module';
import { ImportModule } from '../../src/import/import.module';
import { OptimizationModule } from '../../src/optimization/optimization.module';
import { IntegrationModule } from '../../src/integration/integration.module';
import { FamilyModule } from '../../src/family/family.module';
import { RoomBookingsModule } from '../../src/room-bookings/room-bookings.module';
import { HealthModule } from '../../src/health/health.module';
import { StaffingModule } from '../../src/staffing/staffing.module';
import { TimplanModule } from '../../src/timplan/timplan.module';
import { YearRolloverModule } from '../../src/year-rollover/year-rollover.module';
import { PublicationModule } from '../../src/publication/publication.module';
import { CoverModule } from '../../src/cover/cover.module';
import { JwtAuthGuard } from '../../src/auth/jwt-auth.guard';
import { PrismaService } from '../../src/database/prisma.service';
import { RealtimeService } from '../../src/realtime/realtime.service';
import { SupabaseAdminService } from '../../src/users/supabase-admin.service';
import type { AuthenticatedUser } from '../../src/auth/interfaces/authenticated-user.interface';
import { createPrismaMock, createTxMock, type TxMock } from './prisma-mock';

export type { TxMock };

/**
 * E2E harness: boots every production feature module with the real routing
 * table, validation pipe, RFC-7807 exception filter, RBAC guard and response
 * serializer. What a unit spec cannot see — a route that does not resolve, a
 * DTO that rejects the payload the browser actually sends, a missing @Roles —
 * fails here.
 *
 * Substitutions keep the suite hermetic; each replaces an out-of-process
 * dependency, never the code under test:
 *
 *  - `PrismaService` → in-memory mock, so no database is required. `withRls`
 *    still funnels every data access through a single entry point, mirroring
 *    production call shapes.
 *  - JWT verification → a header-driven fake: tests pass the principal as JSON
 *    in the `x-test-user` header. RolesGuard runs for real.
 *  - `HttpService` → the solver call the optimization proxy would make.
 *  - `SupabaseAdminService` → the identity invites a people import fans out.
 *
 * The throttler is OFF by default: its counters are process-wide, so a shared
 * limiter would make unrelated specs fail each other depending on order. Boot
 * with `{ throttle: true }` in a spec that asserts a limit, and give that spec
 * its own app.
 */

@Injectable()
class HeaderAuthGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    // Mirrors JwtAuthGuard: @Public() routes (health probes, the SS12000
    // endpoints behind their own key guard) carry no principal at all, and a
    // harness that demanded one would make them untestable here.
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const request = context.switchToHttp().getRequest<Request>();
    const header = request.headers['x-test-user'];
    if (typeof header !== 'string' || header.length === 0) {
      throw new UnauthorizedException('Missing test principal.');
    }
    request.user = JSON.parse(header) as AuthenticatedUser;
    return true;
  }
}

/**
 * Stands in for the production (global) RealtimeModule so no Socket.IO
 * server is created in tests. Broadcasts become no-op jest mocks.
 */
@Global()
@Module({
  providers: [
    {
      provide: RealtimeService,
      // Derived from the class rather than hand-listed: a broadcast method
      // added later is stubbed the moment it exists, instead of surfacing as
      // "notifyX is not a function" in whichever spec happens to hit it.
      useValue: Object.fromEntries(
        Object.getOwnPropertyNames(RealtimeService.prototype)
          .filter((name) => name !== 'constructor')
          .map((name) => [name, jest.fn()]),
      ),
    },
  ],
  exports: [RealtimeService],
})
class TestRealtimeModule {}

/** The feature modules, in the order AppModule declares them. */
const FEATURE_MODULES = [
  // Test-only, and behaviour-free: it exposes the routing table so
  // route-guards.e2e-spec.ts can assert over every route rather than the
  // handful somebody remembered to write a spec for.
  DiscoveryModule,
  AppConfigModule,
  DatabaseModule,
  TestRealtimeModule,
  // @Global in production; feature services inject it directly, so the test
  // graph needs it imported explicitly or their constructors cannot resolve.
  NotificationsModule,
  HealthModule,
  FamilyModule,
  ImportModule,
  IntegrationModule,
  OptimizationModule,
  AttendanceModule,
  ResourcesModule,
  UsersModule,
  CalendarModule,
  RoomBookingsModule,
  StaffingModule,
  TimplanModule,
  YearRolloverModule,
  PublicationModule,
  CoverModule,
];

/** Everything global AppModule applies, minus the throttler (see below). */
const GLOBAL_PROVIDERS = [
  { provide: APP_GUARD, useClass: HeaderAuthGuard },
  { provide: APP_GUARD, useClass: RolesGuard },
  {
    provide: APP_PIPE,
    useValue: new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      transformOptions: { enableImplicitConversion: false },
    }),
  },
  { provide: APP_FILTER, useClass: HttpExceptionFilter },
  { provide: APP_INTERCEPTOR, useClass: ClassSerializerInterceptor },
];

@Module({ imports: FEATURE_MODULES, providers: GLOBAL_PROVIDERS })
class TestAppModule {}

/**
 * Same graph plus the real ThrottlerGuard, configured from the environment
 * exactly as AppModule does. Only a spec that asserts a rate limit boots this.
 */
@Module({
  imports: [
    ...FEATURE_MODULES,
    ThrottlerModule.forRoot({
      throttlers: [
        {
          ttl: Number(process.env['THROTTLE_TTL_SECONDS'] ?? 60) * 1000,
          limit: Number(process.env['THROTTLE_LIMIT'] ?? 1000),
        },
      ],
      // The store AppModule uses, so a 429 asserted here is production's.
      storage: new WindowedThrottlerStorage(),
    }),
  ],
  providers: [
    ...GLOBAL_PROVIDERS,
    { provide: APP_GUARD, useClass: ThrottlerGuard },
  ],
})
class ThrottledTestAppModule {}

/** Stand-in for the identity provider a people import invites through. */
export interface SupabaseAdminMock {
  /**
   * True by default, so the harness takes the production path. Left false,
   * UsersService quietly falls back to a placeholder authId — a development
   * convenience that would make every invite assertion pass vacuously.
   */
  isConfigured: boolean;
  inviteUser: jest.Mock;
  deleteUser: jest.Mock;
}

/** Stand-in for the outbound call to the CP-SAT service. */
export interface HttpServiceMock {
  post: jest.Mock;
  get: jest.Mock;
}

export interface TestHarness {
  app: INestApplication;
  tx: TxMock;
  http: HttpServiceMock;
  supabase: SupabaseAdminMock;
  close: () => Promise<void>;
}

export interface TestAppOptions {
  /**
   * Boot with the production rate limiter. Off by default — the limiter keeps
   * process-wide counters, so sharing one across specs makes them fail each
   * other by execution order rather than by behaviour.
   */
  throttle?: boolean;
}

export function asUser(user: Partial<AuthenticatedUser>): string {
  return JSON.stringify({
    authId: '11111111-1111-4111-8111-111111111111',
    role: 'SCHOOL_ADMIN',
    userId: '22222222-2222-4222-8222-222222222222',
    schoolId: '33333333-3333-4333-8333-333333333333',
    ...user,
  });
}

export async function createTestApp(
  options: TestAppOptions = {},
): Promise<TestHarness> {
  // Environment defaults live in test/setup-env.ts (jest setupFiles) because
  // ConfigModule validates the environment at import time.
  const txProxy = createTxMock();
  const prismaMock = createPrismaMock(txProxy);

  // Default to a shape the optimization proxy can consume, so a spec that only
  // cares about routing and RBAC needs no stubbing of its own.
  const http: HttpServiceMock = {
    post: jest.fn(() => of({ data: { status: 'OPTIMAL', lessons: [] } })),
    get: jest.fn(() => of({ data: {} })),
  };
  const supabase: SupabaseAdminMock = {
    isConfigured: true,
    inviteUser: jest.fn(async () => ({
      authId: '11111111-1111-4111-8111-111111111111',
      emailSent: true,
    })),
    deleteUser: jest.fn(async () => undefined),
  };

  const builder: TestingModuleBuilder = Test.createTestingModule({
    imports: [options.throttle ? ThrottledTestAppModule : TestAppModule],
  })
    .overrideProvider(PrismaService)
    .useValue(prismaMock)
    .overrideProvider(HttpService)
    .useValue(http)
    .overrideProvider(SupabaseAdminService)
    .useValue(supabase)
    // Controllers also reference JwtAuthGuard directly via @UseGuards.
    .overrideGuard(JwtAuthGuard)
    .useClass(HeaderAuthGuard);

  const moduleRef = await builder.compile();

  const app = moduleRef.createNestApplication<NestExpressApplication>();
  // Production's body limits, applied the same way main.ts applies them: a
  // harness with different limits cannot see a payload the real API rejects.
  configureBodyParsers(app);
  await app.init();

  return {
    app,
    tx: txProxy,
    http,
    supabase,
    close: async () => {
      await app.close();
    },
  };
}
