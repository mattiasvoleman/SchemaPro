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
import type { UserRole } from '@prisma/client';
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
  role: UserRole;
  /** Display label for presence chips — "First L." (no email, no full PII). */
  label: string;
  /** Master-lesson id this user is currently editing, if any. */
  editingLessonId: string | null;
}

/**
 * Who belongs in the staff room. A socket is not a lighter-weight way in than
 * the database: a pupil's session is the same session RLS refuses the whole
 * school to, so it must not be handed the school's traffic over a channel that
 * asks no policy anything.
 */
const STAFF_ROLES: readonly UserRole[] = ['TEACHER', 'SCHOOL_ADMIN'];

const isStaff = (profile: SocketProfile): boolean =>
  STAFF_ROLES.includes(profile.role);

/**
 * Presence rebroadcast coalescing window, in milliseconds.
 *
 * Every presence heartbeat walks every socket in the school room and emits the
 * whole roster back to all of them, so a client that heartbeats in a loop
 * multiplies its own traffic by the number of connected staff. Coalescing per
 * school turns any burst into one broadcast; it is a throttle, not a debounce,
 * because the roster is a snapshot and only the last one matters.
 */
const PRESENCE_COALESCE_MS = 100;

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
 * Every socket joins `user:<userId>`. Staff — teachers and school admins —
 * additionally join `staff:<schoolId>`.
 *
 * There used to be one `school:<schoolId>` room that every authenticated
 * principal joined, and every lesson update went to it. A pupil therefore
 * received the subject, room, status and roster of lessons the database
 * refuses to show them, and the presence roster of the admins editing the
 * timetable along with it. The socket is not a side door: it now carries a
 * lesson only to the teachers who teach it, and the timetable-editor traffic
 * only to staff. Both of those are exactly who the clients subscribe from —
 * the wire events are unchanged and no client needed a line altered.
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
  /** One pending roster broadcast per school; see PRESENCE_COALESCE_MS. */
  private readonly pendingPresence = new Map<string, NodeJS.Timeout>();

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

    // Identity lookup by the verified subject claim, mirroring
    // JwtStrategy.validate. See withVerifiedSubject: this is scoped to the
    // subject rather than attempting (and failing) to bypass RLS.
    const profile = await this.prisma.withVerifiedSubject(payload.sub, (db) =>
      db.user.findUnique({
        where: { authId: payload.sub },
        select: {
          id: true,
          schoolId: true,
          role: true,
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
      role: profile.role,
      label: `${profile.firstName} ${profile.lastName.charAt(0)}.`,
      editingLessonId: null,
    };
    client.data['profile'] = socketProfile;

    const rooms = [`user:${profile.id}`];
    if (isStaff(socketProfile)) rooms.push(`staff:${profile.schoolId}`);
    // The admins alone: a DRAFT school's grundschema edits are a draft that
    // teachers do not see (Publicering, 20261011100000), so they are announced
    // here and not in the staff room.
    if (socketProfile.role === 'SCHOOL_ADMIN') rooms.push(`admin:${profile.schoolId}`);
    await client.join(rooms);
    // Only opaque ids in logs — never emails or names.
    this.logger.log(`Socket connected [user=${profile.id}]`);
  }

  handleDisconnect(client: Socket): void {
    // Rooms are cleaned up automatically by socket.io; peers just need a
    // fresh roster without the departed editor.
    const profile = client.data['profile'] as SocketProfile | undefined;
    if (profile && isStaff(profile)) {
      // Fire after socket.io finishes removing the socket from its rooms.
      setImmediate(() => this.schedulePresence(profile.schoolId));
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
    // Silently ignored rather than answered with an error: a pupil's client
    // never sends this, so anything that does is either a stale build or
    // somebody probing, and neither deserves a reply that confirms the room.
    if (!profile || !isStaff(profile)) return;
    profile.editingLessonId =
      typeof body?.editingLessonId === 'string' ? body.editingLessonId : null;
    this.schedulePresence(profile.schoolId);
  }

  /** Coalesces a burst of heartbeats into one roster broadcast per school. */
  private schedulePresence(schoolId: string): void {
    if (this.pendingPresence.has(schoolId)) return;
    const timer = setTimeout(() => {
      this.pendingPresence.delete(schoolId);
      // Nothing awaits a timer, so a rejection here would be unhandled, and
      // Node ends the process on one by default. Today nothing rejects:
      // broadcastPresence awaits only fetchSockets() and a synchronous emit,
      // and CorsIoAdapter extends the in-memory IoAdapter, whose fetchSockets
      // does not fail. An adapter that can — a Redis adapter — would turn one
      // hiccup into that exit, and a roster that failed to refresh is not
      // worth it: the next heartbeat or disconnect sends a fresh one, and the
      // entry is already cleared so it can.
      this.broadcastPresence(schoolId).catch(() => {
        this.logger.warn(`Presence broadcast failed [school=${schoolId}]`);
      });
    }, PRESENCE_COALESCE_MS);
    // Nothing should be held open by a roster refresh at shutdown.
    timer.unref?.();
    this.pendingPresence.set(schoolId, timer);
  }

  /** Roster of connected users per school + what each one is editing. */
  private async broadcastPresence(schoolId: string): Promise<void> {
    const sockets = await this.server.in(`staff:${schoolId}`).fetchSockets();
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
    this.server.to(`staff:${schoolId}`).emit(TIMETABLE_PRESENCE_EVENT, { peers });
  }

  /**
   * Notifies a school that the master timetable changed (clients refetch).
   * `admin`: a draft edit, announced to the school's admins only.
   */
  emitMasterTimetableUpdated(schoolId: string, audience: 'staff' | 'admin' = 'staff'): void {
    this.server
      .to(`${audience}:${schoolId}`)
      .emit(MASTER_TIMETABLE_UPDATED_EVENT, { changedAt: new Date().toISOString() });
  }

  /**
   * Emits a lesson update to the teachers who teach it, and nobody else.
   *
   * The school room is deliberately gone from this list. The payload carries
   * the lesson's subject, room, status and its whole roster — a teacher's
   * offline attendance cache is built from exactly that — and the only client
   * that subscribes is the teacher app. Broadcasting it school-wide handed
   * every pupil and guardian the timetable the database keeps from them, for
   * the benefit of nobody at all.
   *
   * `schoolId` stays in the signature: it is what the log line is keyed on,
   * and a future audience (a substitute, a duty admin) is a school-scoped
   * question.
   */
  emitLessonUpdated(
    schoolId: string,
    teacherIds: readonly string[],
    payload: CalendarLessonUpdatedPayload,
  ): void {
    if (teacherIds.length === 0) {
      this.logger.debug(
        `Lesson update has no assigned teacher to notify [school=${schoolId}]`,
      );
      return;
    }
    this.server
      .to(teacherIds.map((teacherId) => `user:${teacherId}`))
      .emit(LESSON_UPDATED_EVENT, payload);
  }

  private extractToken(client: Socket): string | null {
    const auth = client.handshake.auth as Record<string, unknown>;
    return typeof auth['token'] === 'string' && auth['token'].length > 0
      ? auth['token']
      : null;
  }
}
