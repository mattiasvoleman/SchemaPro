import 'reflect-metadata';
import {
  CanActivate,
  ExecutionContext,
  Global,
  Injectable,
  Module,
  UnauthorizedException,
  ValidationPipe,
  type INestApplication,
} from '@nestjs/common';
import { APP_FILTER, APP_GUARD, APP_PIPE } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import type { Request } from 'express';
import { AppConfigModule } from '../../src/config/config.module';
import { DatabaseModule } from '../../src/database/database.module';
import { HttpExceptionFilter } from '../../src/common/filters/http-exception.filter';
import { RolesGuard } from '../../src/auth/roles.guard';
import { NotificationsModule } from '../../src/notifications/notifications.module';
import { AttendanceModule } from '../../src/attendance/attendance.module';
import { ResourcesModule } from '../../src/resources/resources.module';
import { CalendarModule } from '../../src/calendar/calendar.module';
import { UsersModule } from '../../src/users/users.module';
import { JwtAuthGuard } from '../../src/auth/jwt-auth.guard';
import { PrismaService } from '../../src/database/prisma.service';
import { RealtimeService } from '../../src/realtime/realtime.service';
import type { AuthenticatedUser } from '../../src/auth/interfaces/authenticated-user.interface';
import { createPrismaMock, createTxMock, type TxMock } from './prisma-mock';

export type { TxMock };

/**
 * E2E harness: boots the production feature modules with the real validation
 * pipe, RFC-7807 exception filter and RBAC guard. Two substitutions keep the
 * suite hermetic:
 *
 *  - `PrismaService` is replaced by an in-memory mock so no database is
 *    required. `withRls` still funnels every data access through a single
 *    entry point, mirroring production call shapes.
 *  - JWT verification is replaced by a header-driven fake: tests pass the
 *    principal as JSON in the `x-test-user` header. RolesGuard runs for real.
 */

@Injectable()
class HeaderAuthGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
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
      useValue: { notifyLessonChanged: jest.fn() },
    },
  ],
  exports: [RealtimeService],
})
class TestRealtimeModule {}

@Module({
  imports: [
    AppConfigModule,
    DatabaseModule,
    TestRealtimeModule,
    // @Global in production; feature services inject it directly, so the test
    // graph needs it imported explicitly or their constructors cannot resolve.
    NotificationsModule,
    AttendanceModule,
    ResourcesModule,
    CalendarModule,
    UsersModule,
  ],
  providers: [
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
  ],
})
class TestAppModule {}

export interface TestHarness {
  app: INestApplication;
  tx: TxMock;
  close: () => Promise<void>;
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

export async function createTestApp(): Promise<TestHarness> {
  // Environment defaults live in test/setup-env.ts (jest setupFiles) because
  // ConfigModule validates the environment at import time.
  const txProxy = createTxMock();
  const prismaMock = createPrismaMock(txProxy);

  const moduleRef = await Test.createTestingModule({
    imports: [TestAppModule],
  })
    .overrideProvider(PrismaService)
    .useValue(prismaMock)
    // Controllers also reference JwtAuthGuard directly via @UseGuards.
    .overrideGuard(JwtAuthGuard)
    .useClass(HeaderAuthGuard)
    .compile();

  const app = moduleRef.createNestApplication();
  await app.init();

  return {
    app,
    tx: txProxy,
    close: async () => {
      await app.close();
    },
  };
}
