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
import { JwtAuthGuard } from './auth/jwt-auth.guard';
import { RolesGuard } from './auth/roles.guard';
import { HttpExceptionFilter } from './common/filters/http-exception.filter';
import { OptimizationModule } from './optimization/optimization.module';
import { AttendanceModule } from './attendance/attendance.module';
import { ResourcesModule } from './resources/resources.module';
import { UsersModule } from './users/users.module';
import { CalendarModule } from './calendar/calendar.module';
import { RealtimeModule } from './realtime/realtime.module';
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
        };
      },
    }),

    OptimizationModule,
    AttendanceModule,
    ResourcesModule,
    UsersModule,
    CalendarModule,
    RealtimeModule,
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
