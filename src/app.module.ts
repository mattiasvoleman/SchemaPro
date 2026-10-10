import { Module } from '@nestjs/common';
import { APP_FILTER, APP_GUARD, APP_PIPE } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import {
  ThrottlerGuard,
  ThrottlerModule,
  ThrottlerModuleOptions,
} from '@nestjs/throttler';
import {
  ClassSerializerInterceptor,
  ValidationPipe,
} from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';

import { AppConfigModule } from './config/config.module';
import { DatabaseModule } from './database/database.module';
import { AuthModule } from './auth/auth.module';
import { HealthModule } from './health/health.module';
import { FamilyModule } from './family/family.module';
import { NotificationsModule } from './notifications/notifications.module';
import { ImportModule } from './import/import.module';
import { IntegrationModule } from './integration/integration.module';
import { JwtAuthGuard } from './auth/jwt-auth.guard';
import { RolesGuard } from './auth/roles.guard';
import { HttpExceptionFilter } from './common/filters/http-exception.filter';
import { WindowedThrottlerStorage } from './common/windowed-throttler-storage';
import { OptimizationModule } from './optimization/optimization.module';
import { AttendanceModule } from './attendance/attendance.module';
import { ResourcesModule } from './resources/resources.module';
import { UsersModule } from './users/users.module';
import { CalendarModule } from './calendar/calendar.module';
import { RoomBookingsModule } from './room-bookings/room-bookings.module';
import { RealtimeModule } from './realtime/realtime.module';
import { StaffingModule } from './staffing/staffing.module';
import { TimplanModule } from './timplan/timplan.module';
import { PublicationModule } from './publication/publication.module';
import { YearRolloverModule } from './year-rollover/year-rollover.module';
import { CoverModule } from './cover/cover.module';
import type { ThrottleConfig } from './config/configuration';

/**
 * Root application module.
 *
 * ## Wiring summary
 *
 * | Concern                  | Provider                                     | Scope  |
 * |--------------------------|----------------------------------------------|--------|
 * | Config & env validation  | `AppConfigModule` (global, via ConfigModule)  | Global |
 * | Database + RLS           | `DatabaseModule` (global PrismaService)       | Global |
 * | JWT authentication       | `AuthModule` (JwtStrategy + PassportModule)   | Global |
 * | Authentication guard     | `JwtAuthGuard` via APP_GUARD                  | Global |
 * | RBAC guard               | `RolesGuard` via APP_GUARD                    | Global |
 * | Rate limiting            | `ThrottlerModule` + `ThrottlerGuard`          | Global |
 * | Input validation         | `ValidationPipe` via APP_PIPE                 | Global |
 * | Error responses          | `HttpExceptionFilter` via APP_FILTER          | Global |
 * | Response serialization   | `ClassSerializerInterceptor` via APP_INTERCEPTOR | Global |
 *
 * ## Rate limiter — Redis upgrade path
 *
 * By default `ThrottlerModule` uses an in-memory store, which is correct for
 * a single-instance deployment. For horizontal scaling set `REDIS_URL` in the
 * environment. To activate the Redis store, install `@nestjs/throttler-storage-redis`
 * and swap the `storage` option below — no other code changes are required.
 *
 * ```ts
 * import { ThrottlerStorageRedisService } from '@nestjs/throttler-storage-redis';
 *
 * // inside useFactory:
 * storage: new ThrottlerStorageRedisService(config.redisUrl),
 * ```
 */
@Module({
  imports: [
    AppConfigModule,
    DatabaseModule,
    AuthModule,
    HealthModule,
    FamilyModule,
    NotificationsModule,
    ImportModule,
    IntegrationModule,

    ThrottlerModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (configService: ConfigService): ThrottlerModuleOptions => {
        const throttle =
          configService.getOrThrow<ThrottleConfig>('throttle');

        // ---------------------------------------------------------------------------
        // Redis upgrade path (uncomment when REDIS_URL is configured):
        //
        // import { ThrottlerStorageRedisService } from '@nestjs/throttler-storage-redis';
        //
        // if (throttle.redisUrl) {
        //   return {
        //     throttlers: [{ ttl: throttle.ttlSeconds * 1000, limit: throttle.limit }],
        //     storage: new ThrottlerStorageRedisService(throttle.redisUrl),
        //   };
        // }
        // ---------------------------------------------------------------------------

        return {
          throttlers: [
            { ttl: throttle.ttlSeconds * 1000, limit: throttle.limit },
          ],
          // Not the library's in-memory store, which schedules a timer per
          // request and turns every burst's expiry into seconds of event-loop
          // work — see WindowedThrottlerStorage.
          storage: new WindowedThrottlerStorage(),
        };
      },
    }),

    OptimizationModule,
    AttendanceModule,
    ResourcesModule,
    UsersModule,
    CalendarModule,
    RoomBookingsModule,
    RealtimeModule,
    StaffingModule,
    TimplanModule,
    YearRolloverModule,
    PublicationModule,
    CoverModule,
  ],

  providers: [
    // Global guards are applied in order: authentication → roles → throttle.
    {
      provide: APP_GUARD,
      useClass: JwtAuthGuard,
    },
    {
      provide: APP_GUARD,
      useClass: RolesGuard,
    },
    {
      provide: APP_GUARD,
      useClass: ThrottlerGuard,
    },
    // Strict validation for all incoming payloads.
    {
      provide: APP_PIPE,
      useValue: new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
        transformOptions: { enableImplicitConversion: false },
      }),
    },
    // RFC-7807 error shape for all exceptions.
    {
      provide: APP_FILTER,
      useClass: HttpExceptionFilter,
    },
    // Strips properties decorated with @Exclude() from responses.
    {
      provide: APP_INTERCEPTOR,
      useClass: ClassSerializerInterceptor,
    },
  ],
})
export class AppModule {}
