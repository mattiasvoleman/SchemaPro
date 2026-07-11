import type { INestApplicationContext } from '@nestjs/common';
import { IoAdapter } from '@nestjs/platform-socket.io';
import { ConfigService } from '@nestjs/config';
import type { Server, ServerOptions } from 'socket.io';
import type { AppConfig } from '../config/configuration';

/**
 * Socket.IO adapter that applies the SAME CORS allowlist as the HTTP server
 * (`CORS_ORIGINS`) instead of reflecting every origin.
 *
 * The `@WebSocketGateway()` decorator is evaluated at class-definition time,
 * before the DI container exists, so it cannot read `ConfigService`. Injecting
 * the allowlist here — at server-construction time — is the correct place to
 * configure gateway CORS from validated configuration.
 *
 * Native clients (the Expo mobile app) send no `Origin` header, so restricting
 * browser origins does not affect them.
 */
export class CorsIoAdapter extends IoAdapter {
  private readonly corsOrigins: string[];

  constructor(app: INestApplicationContext) {
    super(app);
    this.corsOrigins = app.get(ConfigService).getOrThrow<AppConfig>('app').corsOrigins;
  }

  createIOServer(port: number, options?: ServerOptions): Server {
    const cors =
      this.corsOrigins.length > 0
        ? { origin: this.corsOrigins, credentials: true }
        : { origin: false as const };

    return super.createIOServer(port, {
      ...options,
      cors,
    }) as Server;
  }
}
