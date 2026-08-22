import { Logger } from '@nestjs/common';
import type { JwtService } from '@nestjs/jwt';
import type { Server, Socket } from 'socket.io';
import {
  createPrismaMock,
  createTxMock,
  type PrismaMock,
  type TxMock,
} from '../../test/utils/prisma-mock';
import type { PrismaService } from '../database/prisma.service';
import { RealtimeGateway } from './realtime.gateway';
import {
  LESSON_UPDATED_EVENT,
  MASTER_TIMETABLE_UPDATED_EVENT,
  TIMETABLE_PRESENCE_EVENT,
  type CalendarLessonUpdatedPayload,
} from './realtime.types';

const AUTH_ID = '11111111-1111-4111-8111-111111111111';
const USER_ID = '22222222-2222-4222-8222-222222222222';
const SCHOOL_ID = '33333333-3333-4333-8333-333333333333';
const TOKEN = 'handshake-jwt';

/** Mirrors the gateway's private SocketProfile shape. */
interface Profile {
  userId: string;
  schoolId: string;
  role: 'TEACHER' | 'SCHOOL_ADMIN' | 'STUDENT' | 'GUARDIAN' | 'SYSTEM_ADMIN';
  label: string;
  editingLessonId: string | null;
}

interface FakeSocket {
  handshake: { auth: Record<string, unknown> };
  data: Record<string, unknown>;
  disconnect: jest.Mock;
  join: jest.Mock;
}

const makeSocket = (auth: Record<string, unknown> = {}): FakeSocket => ({
  handshake: { auth },
  data: {},
  disconnect: jest.fn(),
  join: jest.fn().mockResolvedValue(undefined),
});

/** A socket as `server.in(room).fetchSockets()` reports it. */
const remoteSocket = (profile?: Profile) => ({
  data: profile ? { profile } : {},
});

const profileOf = (overrides: Partial<Profile> = {}): Profile => ({
  userId: USER_ID,
  schoolId: SCHOOL_ID,
  role: 'SCHOOL_ADMIN',
  label: 'Anna B.',
  editingLessonId: null,
  ...overrides,
});

/** Lets the queued `setImmediate` (and its microtasks) run. */
const flushImmediates = () =>
  new Promise<void>((resolve) => setImmediate(resolve));

/**
 * Presence broadcasts are coalesced behind a short timer, so a burst of
 * heartbeats costs one roster emit instead of one per beat. Tests have to let
 * that window close.
 */
const flushPresence = async () => {
  jest.advanceTimersByTime(200);
  await flushImmediates();
};

describe('RealtimeGateway', () => {
  let gateway: RealtimeGateway;
  let tx: TxMock;
  let prisma: PrismaMock;
  let jwt: { verifyAsync: jest.Mock };
  let emit: jest.Mock;
  let fetchSockets: jest.Mock;
  let server: { to: jest.Mock; in: jest.Mock };

  beforeEach(() => {
    // setImmediate stays real: the gateway defers the post-disconnect roster
    // refresh onto it, and a faked one would never run.
    jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick'] });
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'debug').mockImplementation(() => undefined);
    tx = createTxMock();
    prisma = createPrismaMock(tx);
    jwt = { verifyAsync: jest.fn() };
    emit = jest.fn();
    fetchSockets = jest.fn().mockResolvedValue([]);
    server = {
      to: jest.fn().mockReturnValue({ emit }),
      in: jest.fn().mockReturnValue({ fetchSockets }),
    };
    gateway = new RealtimeGateway(
      jwt as unknown as JwtService,
      prisma as unknown as PrismaService,
    );
    (gateway as unknown as { server: unknown }).server =
      server as unknown as Server;
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  const connect = (client: FakeSocket) =>
    gateway.handleConnection(client as unknown as Socket);

  const activeProfileRow = (overrides: Record<string, unknown> = {}) => ({
    id: USER_ID,
    schoolId: SCHOOL_ID,
    role: 'SCHOOL_ADMIN',
    isActive: true,
    firstName: 'Anna',
    lastName: 'Bergström',
    ...overrides,
  });

  describe('handleConnection (auth path)', () => {
    it('disconnects a socket with no token before verifying anything', async () => {
      const client = makeSocket({});

      await connect(client);

      expect(client.disconnect).toHaveBeenCalledWith(true);
      expect(jwt.verifyAsync).not.toHaveBeenCalled();
      expect(prisma.withVerifiedSubject).not.toHaveBeenCalled();
    });

    it('treats an empty-string or non-string token as absent', async () => {
      for (const token of ['', 42]) {
        const client = makeSocket({ token });
        await connect(client);
        expect(client.disconnect).toHaveBeenCalledWith(true);
      }
      expect(jwt.verifyAsync).not.toHaveBeenCalled();
    });

    it('disconnects on a bad signature without touching the database', async () => {
      jwt.verifyAsync.mockRejectedValue(new Error('invalid signature'));
      const client = makeSocket({ token: TOKEN });

      await connect(client);

      expect(jwt.verifyAsync).toHaveBeenCalledWith(TOKEN);
      expect(client.disconnect).toHaveBeenCalledWith(true);
      expect(prisma.withVerifiedSubject).not.toHaveBeenCalled();
      expect(client.join).not.toHaveBeenCalled();
    });

    it('disconnects a verified token that carries no subject', async () => {
      jwt.verifyAsync.mockResolvedValue({ role: 'authenticated' });
      const client = makeSocket({ token: TOKEN });

      await connect(client);

      expect(client.disconnect).toHaveBeenCalledWith(true);
      expect(prisma.withVerifiedSubject).not.toHaveBeenCalled();
    });

    it('resolves the profile via withVerifiedSubject scoped to the verified sub', async () => {
      jwt.verifyAsync.mockResolvedValue({ sub: AUTH_ID });
      tx.user.findUnique.mockResolvedValue(activeProfileRow());
      const client = makeSocket({ token: TOKEN });

      await connect(client);

      // Tenancy: identity bootstrap must use the verified-subject wrapper —
      // withSystemTransaction sets no claims and matches zero rows; withRls
      // would need a principal that does not exist yet.
      expect(prisma.withVerifiedSubject).toHaveBeenCalledWith(
        AUTH_ID,
        expect.any(Function),
      );
      expect(prisma.withRls).not.toHaveBeenCalled();
      expect(prisma.withSystemTransaction).not.toHaveBeenCalled();
      expect(tx.user.findUnique).toHaveBeenCalledWith(
        expect.objectContaining({ where: { authId: AUTH_ID } }),
      );
    });

    it('disconnects a subject with no profile row', async () => {
      jwt.verifyAsync.mockResolvedValue({ sub: AUTH_ID });
      tx.user.findUnique.mockResolvedValue(null);
      const client = makeSocket({ token: TOKEN });

      await connect(client);

      expect(client.disconnect).toHaveBeenCalledWith(true);
      expect(client.join).not.toHaveBeenCalled();
    });

    it('disconnects a deactivated profile even though the row exists', async () => {
      jwt.verifyAsync.mockResolvedValue({ sub: AUTH_ID });
      tx.user.findUnique.mockResolvedValue(
        activeProfileRow({ isActive: false }),
      );
      const client = makeSocket({ token: TOKEN });

      await connect(client);

      expect(client.disconnect).toHaveBeenCalledWith(true);
      expect(client.join).not.toHaveBeenCalled();
    });

    it('puts staff in the school room with a PII-reduced label', async () => {
      jwt.verifyAsync.mockResolvedValue({ sub: AUTH_ID });
      tx.user.findUnique.mockResolvedValue(activeProfileRow());
      const client = makeSocket({ token: TOKEN });

      await connect(client);

      expect(client.disconnect).not.toHaveBeenCalled();
      expect(client.join).toHaveBeenCalledWith([
        `user:${USER_ID}`,
        `staff:${SCHOOL_ID}`,
      ]);
      // Presence label is "First L." — never the full surname or an email.
      expect(client.data['profile']).toEqual({
        userId: USER_ID,
        schoolId: SCHOOL_ID,
        role: 'SCHOOL_ADMIN',
        label: 'Anna B.',
        editingLessonId: null,
      });
    });

    it.each(['STUDENT', 'GUARDIAN'])(
      'leaves a %s out of the staff room entirely',
      async (role) => {
        // There used to be one room every authenticated principal joined, and
        // every lesson update went to it — so a pupil received the subject,
        // room, status and roster of lessons the database refuses to show them.
        // A socket is not a lighter-weight way in than a query.
        jwt.verifyAsync.mockResolvedValue({ sub: AUTH_ID });
        tx.user.findUnique.mockResolvedValue(activeProfileRow({ role }));
        const client = makeSocket({ token: TOKEN });

        await connect(client);

        expect(client.disconnect).not.toHaveBeenCalled();
        expect(client.join).toHaveBeenCalledWith([`user:${USER_ID}`]);
      },
    );
  });

  describe('onPresence', () => {
    const presence = (client: FakeSocket, body?: { editingLessonId?: unknown }) =>
      gateway.onPresence(
        client as unknown as Socket,
        body as { editingLessonId?: string | null } | undefined,
      );

    it('ignores heartbeats from a socket that never authenticated', async () => {
      const client = makeSocket();

      await presence(client, { editingLessonId: 'lesson-1' });

      expect(fetchSockets).not.toHaveBeenCalled();
      expect(emit).not.toHaveBeenCalled();
    });

    it('records the edited lesson and broadcasts a deduplicated roster', async () => {
      const client = makeSocket();
      const mine = profileOf();
      client.data['profile'] = mine;
      const peer = profileOf({
        userId: 'peer-1',
        label: 'Berit C.',
        editingLessonId: 'lesson-2',
      });
      fetchSockets.mockResolvedValue([
        remoteSocket(mine),
        remoteSocket(peer),
        remoteSocket(), // pre-auth straggler — must be skipped
        remoteSocket(peer), // second tab of the same user — deduped
      ]);

      await presence(client, { editingLessonId: 'lesson-9' });
      await flushPresence();

      expect(server.in).toHaveBeenCalledWith(`staff:${SCHOOL_ID}`);
      expect(server.to).toHaveBeenCalledWith(`staff:${SCHOOL_ID}`);
      expect(emit).toHaveBeenCalledWith(TIMETABLE_PRESENCE_EVENT, {
        peers: [
          {
            userId: USER_ID,
            label: 'Anna B.',
            editingLessonId: 'lesson-9',
          },
          {
            userId: 'peer-1',
            label: 'Berit C.',
            editingLessonId: 'lesson-2',
          },
        ],
      });
    });

    it('clears the soft edit-lock when the body has no lesson id', async () => {
      const client = makeSocket();
      const mine = profileOf({ editingLessonId: 'lesson-9' });
      client.data['profile'] = mine;
      fetchSockets.mockResolvedValue([remoteSocket(mine)]);

      await presence(client, undefined);
      await flushPresence();
      expect(mine.editingLessonId).toBeNull();

      // A non-string id (bad client) is treated as "not editing" too.
      mine.editingLessonId = 'lesson-9';
      await presence(client, { editingLessonId: 42 });
      await flushPresence();
      expect(mine.editingLessonId).toBeNull();
      expect(emit).toHaveBeenCalledTimes(2);
    });

    it.each(['STUDENT', 'GUARDIAN'])('ignores a heartbeat from a %s', async (role) => {
      // The presence roster names the staff who are connected and the lesson
      // each has open. A pupil's client never sends this, so anything that does
      // is a stale build or somebody probing — and neither gets an answer that
      // confirms the room exists.
      const client = makeSocket();
      client.data['profile'] = profileOf({ role: role as 'STUDENT' });

      await presence(client, { editingLessonId: 'lesson-1' });
      await flushPresence();

      expect(server.in).not.toHaveBeenCalled();
      expect(emit).not.toHaveBeenCalled();
    });

    it('costs one broadcast however fast the heartbeats arrive', async () => {
      // Each broadcast walks every socket in the room and emits the roster back
      // to all of them, so an unthrottled heartbeat multiplies its own traffic
      // by the number of connected staff.
      const client = makeSocket();
      const mine = profileOf();
      client.data['profile'] = mine;
      fetchSockets.mockResolvedValue([remoteSocket(mine)]);

      for (let beat = 0; beat < 20; beat++) {
        await presence(client, { editingLessonId: `lesson-${beat}` });
      }
      await flushPresence();

      expect(emit).toHaveBeenCalledTimes(1);
      // The last state wins: a roster is a snapshot, not a stream.
      expect(emit).toHaveBeenCalledWith(TIMETABLE_PRESENCE_EVENT, {
        peers: [
          { userId: USER_ID, label: 'Anna B.', editingLessonId: 'lesson-19' },
        ],
      });
    });
  });

  describe('handleDisconnect', () => {
    it('rebroadcasts the school roster after an editor leaves', async () => {
      const client = makeSocket();
      client.data['profile'] = profileOf();
      fetchSockets.mockResolvedValue([]);

      gateway.handleDisconnect(client as unknown as Socket);
      await flushImmediates();
      await flushPresence();

      expect(server.in).toHaveBeenCalledWith(`staff:${SCHOOL_ID}`);
      expect(emit).toHaveBeenCalledWith(TIMETABLE_PRESENCE_EVENT, {
        peers: [],
      });
    });

    it('does not refresh the roster when a pupil disconnects', async () => {
      // A pupil was never in it, so their leaving changes nothing — and a
      // roster walk per pupil disconnect is work the school pays for nothing.
      const client = makeSocket();
      client.data['profile'] = profileOf({ role: 'STUDENT' });

      gateway.handleDisconnect(client as unknown as Socket);
      await flushImmediates();
      await flushPresence();

      expect(server.in).not.toHaveBeenCalled();
      expect(emit).not.toHaveBeenCalled();
    });

    it('does nothing for a socket that never authenticated', async () => {
      gateway.handleDisconnect(makeSocket() as unknown as Socket);
      await flushImmediates();

      expect(server.in).not.toHaveBeenCalled();
      expect(emit).not.toHaveBeenCalled();
    });
  });

  describe('emitMasterTimetableUpdated', () => {
    it('notifies the staff room with the change instant', () => {
      const NOW = new Date('2026-08-07T09:30:00.000Z');
      jest.useFakeTimers().setSystemTime(NOW);
      try {
        gateway.emitMasterTimetableUpdated(SCHOOL_ID);
      } finally {
        jest.useRealTimers();
      }

      expect(server.to).toHaveBeenCalledWith(`staff:${SCHOOL_ID}`);
      expect(emit).toHaveBeenCalledWith(MASTER_TIMETABLE_UPDATED_EVENT, {
        changedAt: '2026-08-07T09:30:00.000Z',
      });
    });
  });

  describe('emitLessonUpdated', () => {
    it('reaches the teachers who teach it, and nobody else', () => {
      // The payload carries the lesson's subject, room, status and its whole
      // roster; the teacher app builds its offline attendance cache from it.
      // It used to go to a room every pupil and guardian was in as well.
      const payload = {
        lessonId: 'lesson-1',
        updatedLesson: { id: 'lesson-1' },
      } as unknown as CalendarLessonUpdatedPayload;

      gateway.emitLessonUpdated(SCHOOL_ID, ['t-1', 't-2'], payload);

      expect(server.to).toHaveBeenCalledWith(['user:t-1', 'user:t-2']);
      expect(emit).toHaveBeenCalledWith(LESSON_UPDATED_EVENT, payload);
    });

    it('emits nothing at all when the lesson has no assigned teacher', () => {
      // socket.io treats an empty room list as "everyone", so the guard is not
      // a tidiness measure — without it an unassigned lesson would broadcast
      // its roster to every socket on the server, across schools.
      gateway.emitLessonUpdated(SCHOOL_ID, [], {
        lessonId: 'lesson-1',
        updatedLesson: { id: 'lesson-1' },
      } as unknown as CalendarLessonUpdatedPayload);

      expect(server.to).not.toHaveBeenCalled();
      expect(emit).not.toHaveBeenCalled();
    });
  });
});
