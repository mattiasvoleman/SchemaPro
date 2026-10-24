import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { ConfigService } from '@nestjs/config';
import { Logger } from '@nestjs/common';
import { AppModule } from './app.module';
import { configureBodyParsers } from './common/http-defaults';
import { CorsIoAdapter } from './realtime/cors-io.adapter';
import type { AppConfig } from './config/configuration';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    // Suppress the default NestJS logger for HTTP requests; structured logging
    // is handled by the exception filter and service-level Logger calls.
    logger: ['error', 'warn', 'log'],
  });

  // Body size limits — shared with the e2e harness so both run identically.
  configureBodyParsers(app);

  const configService = app.get(ConfigService);
  const appConfig = configService.getOrThrow<AppConfig>('app');

  // Trust the first proxy hop when running behind a load balancer or API
  // gateway, so that `req.ip` reflects the real client IP (used by throttler).
  app.set('trust proxy', 1);

  // CORS — only allow origins configured in the environment.
  if (appConfig.corsOrigins.length > 0) {
    app.enableCors({
      origin: appConfig.corsOrigins,
      methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
      // X-School-Id: the school a request is about, for a login with rows
      // at several schools (src/auth/school-choice.ts).
      allowedHeaders: ['Authorization', 'Content-Type', 'X-School-Id'],
      credentials: true,
    });
  }

  // Global prefix is handled per-route (api/v1/*) for explicit versioning.

  // Apply the HTTP CORS allowlist to the Socket.IO gateway as well.
  app.useWebSocketAdapter(new CorsIoAdapter(app));

  // SIGTERM (a redeploy) runs the modules' shutdown hooks before the process
  // goes. Without it Nest never calls them outside app.close(): a
  // schemaförslag run in flight was left RUNNING until its lease ran out
  // instead of being marked CANDIDATE_RUN_INTERRUPTED at once. In order: the
  // destroy hooks (that mark, and the jobs stopping their timers), then the
  // HTTP server closes and waits for the requests in flight, then
  // PrismaService disconnects (onApplicationShutdown). The platform must leave
  // a few seconds between SIGTERM and SIGKILL for this to land (docs/DEPLOYMENT.md).
  app.enableShutdownHooks();

  const port = appConfig.port;
  await app.listen(port);

  const logger = new Logger('Bootstrap');
  logger.log(`Rastra API running on port ${port} [${appConfig.nodeEnv}]`);
}

bootstrap().catch((error: unknown) => {
  const logger = new Logger('Bootstrap');
  logger.error('Fatal error during bootstrap', error instanceof Error ? error.stack : String(error));
  process.exit(1);
});
