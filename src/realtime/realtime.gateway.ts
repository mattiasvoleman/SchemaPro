import { Logger } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import {
  MessageBody,
  ConnectedSocket,
  OnGatewayConnection,
  OnGatewayDisconnect,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import type { Server, Socket } from 'socket.io';
import { PrismaService } from '../database/prisma.service';
import type { JwtPayload } from '../auth/interfaces/jwt-payload.interface';
import {
  LESSON_UPDATED_EVENT,
  MASTER_TIMETABLE_UPDATED_EVENT,
  TIMETABLE_PRESENCE_EVENT,
  type CalendarLessonUpdatedPayload,
  type TimetablePeer,
} from './realtime.types';

interface SocketProfile {
  userId: string;
  schoolId: string;
  /** Display label for presence chips — "First L." (no email, no full PII). */
  label: string;
  /** Master-lesson id this user is currently editing, if any. */
  editingLessonId: string | null;
}

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
 * CORS reuses the HTTP `CORS_ORIGINS` allowlist, applied by `CorsIoAdapter`
 * (registered in main.ts) at socket.io server-construction time. The decorator
 * intentionally does NOT set `origin` here — the adapter is the single source
 * of truth so browser origins cannot be reflected indiscriminately.
 */
@WebSocketGateway({
  transports: ['websocket'],
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
        select: {
          id: true,
          schoolId: true,
          isActive: true,
          firstName: true,
          lastName: true,
        },
      }),
    );
    if (!profile || !profile.isActive) {
      client.disconnect(true);
      return;
    }

    const socketProfile: SocketProfile = {
      userId: profile.id,
      schoolId: profile.schoolId,
      label: `${profile.firstName} ${profile.lastName.charAt(0)}.`,
      editingLessonId: null,
    };
    client.data['profile'] = socketProfile;

    await client.join([`school:${profile.schoolId}`, `user:${profile.id}`]);
    // Only opaque ids in logs — never emails or names.
    this.logger.log(`Socket connected [user=${profile.id}]`);
  }

  handleDisconnect(client: Socket): void {
    // Rooms are cleaned up automatically by socket.io; peers just need a
    // fresh roster without the departed editor.
    const profile = client.data['profile'] as SocketProfile | undefined;
    if (profile) {
      // Fire after socket.io finishes removing the socket from its rooms.
      setImmediate(() => void this.broadcastPresence(profile.schoolId));
    }
  }

  /**
   * Presence heartbeat from the timetable editor. `editingLessonId` is the
   * master lesson the admin currently has open (soft edit-lock), or null.
   * Every change re-broadcasts the school's full roster.
   */
  @SubscribeMessage('timetable:presence')
  async onPresence(
    @ConnectedSocket() client: Socket,
    @MessageBody() body: { editingLessonId?: string | null } | undefined,
  ): Promise<void> {
    const profile = client.data['profile'] as SocketProfile | undefined;
    if (!profile) return;
    profile.editingLessonId =
      typeof body?.editingLessonId === 'string' ? body.editingLessonId : null;
    await this.broadcastPresence(profile.schoolId);
  }

  /** Roster of connected users per school + what each one is editing. */
  private async broadcastPresence(schoolId: string): Promise<void> {
    const sockets = await this.server.in(`school:${schoolId}`).fetchSockets();
    const peers: TimetablePeer[] = [];
    const seen = new Set<string>();
    for (const socket of sockets) {
      const profile = socket.data['profile'] as SocketProfile | undefined;
      if (!profile || seen.has(profile.userId)) continue;
      seen.add(profile.userId);
      peers.push({
        userId: profile.userId,
        label: profile.label,
        editingLessonId: profile.editingLessonId,
      });
    }
    this.server.to(`school:${schoolId}`).emit(TIMETABLE_PRESENCE_EVENT, { peers });
  }

  /** Notifies a school that the master timetable changed (clients refetch). */
  emitMasterTimetableUpdated(schoolId: string): void {
    this.server
      .to(`school:${schoolId}`)
      .emit(MASTER_TIMETABLE_UPDATED_EVENT, { changedAt: new Date().toISOString() });
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
