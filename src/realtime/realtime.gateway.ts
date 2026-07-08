import { Logger } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import {
  OnGatewayConnection,
  OnGatewayDisconnect,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import type { Server, Socket } from 'socket.io';
import { PrismaService } from '../database/prisma.service';
import type { JwtPayload } from '../auth/interfaces/jwt-payload.interface';
import {
  LESSON_UPDATED_EVENT,
  type CalendarLessonUpdatedPayload,
} from './realtime.types';

/**
 * Socket.IO gateway for live schedule updates.
 *
 * ## Auth
 * Clients send their Supabase access token in the handshake `auth.token`
 * field (never in the URL). The gateway verifies the signature/expiry and
 * resolves the profile from the `Users` table — same trust chain as the HTTP
 * JWT strategy. Unauthenticated sockets are disconnected immediately.
 *
 * ## Rooms
 * Each socket joins `school:<schoolId>` and `user:<userId>`. Lesson updates
 * are emitted to the affected teachers' user rooms plus the school room, so
 * admins' dashboards can also react.
 *
 * CORS reuses the HTTP allowlist semantics: socket.io performs its own
 * origin check against the configured origins at runtime (see AppModule
 * bootstrap in main.ts for the HTTP equivalent).
 */
@WebSocketGateway({
  transports: ['websocket'],
  cors: { origin: true, credentials: true },
})
export class RealtimeGateway implements OnGatewayConnection, OnGatewayDisconnect {
  private readonly logger = new Logger(RealtimeGateway.name);

  @WebSocketServer()
  private server!: Server;

  constructor(
    private readonly jwtService: JwtService,
    private readonly prisma: PrismaService,
  ) {}

  async handleConnection(client: Socket): Promise<void> {
    const token = this.extractToken(client);
    if (!token) {
      client.disconnect(true);
      return;
    }

    let payload: JwtPayload;
    try {
      payload = await this.jwtService.verifyAsync<JwtPayload>(token);
    } catch {
      client.disconnect(true);
      return;
    }
    if (!payload.sub) {
      client.disconnect(true);
      return;
    }

    // Identity lookup by the verified subject claim (outside RLS by design,
    // mirroring JwtStrategy.validate).
    const profile = await this.prisma.withSystemTransaction((tx) =>
      tx.user.findUnique({
        where: { authId: payload.sub },
        select: { id: true, schoolId: true, isActive: true },
      }),
    );
    if (!profile || !profile.isActive) {
      client.disconnect(true);
      return;
    }

    await client.join([`school:${profile.schoolId}`, `user:${profile.id}`]);
    // Only opaque ids in logs — never emails or names.
    this.logger.log(`Socket connected [user=${profile.id}]`);
  }

  handleDisconnect(): void {
    // Rooms are cleaned up automatically by socket.io.
  }

  /** Emits a lesson update to its school room and each affected teacher. */
  emitLessonUpdated(
    schoolId: string,
    teacherIds: readonly string[],
    payload: CalendarLessonUpdatedPayload,
  ): void {
    const rooms = [
      `school:${schoolId}`,
      ...teacherIds.map((teacherId) => `user:${teacherId}`),
    ];
    this.server.to(rooms).emit(LESSON_UPDATED_EVENT, payload);
  }

  private extractToken(client: Socket): string | null {
    const auth = client.handshake.auth as Record<string, unknown>;
    return typeof auth['token'] === 'string' && auth['token'].length > 0
      ? auth['token']
      : null;
  }
}
