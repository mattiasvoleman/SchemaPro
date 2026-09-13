import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  createPrismaMock,
  createTxMock,
  testUser,
  type PrismaMock,
  type TxMock,
} from '../../test/utils/prisma-mock';
import type { PrismaService } from '../database/prisma.service';
import { RoomPreferencesService } from './room-preferences.service';

const PREF_ID = '77777777-7777-4777-8777-777777777777';
const SUBJECT_ID = '99999999-9999-4999-8999-999999999999';
const TYPE_ID = '66666666-6666-4666-8666-666666666666';
const ROOM_A = '11111111-1111-4111-8111-111111111111';
const ROOM_B = '22222222-2222-4222-8222-222222222222';

const schoolless = () => ({ ...testUser(), schoolId: undefined });

const prismaError = (code: string): Prisma.PrismaClientKnownRequestError =>
  new Prisma.PrismaClientKnownRequestError(`Simulated ${code}`, {
    code,
    clientVersion: Prisma.prismaVersion.client,
  });

type Selection = Record<string, unknown>;

type FixtureRoom = {
  id: string;
  name: string;
  minGradeLevel: number | null;
  maxGradeLevel: number | null;
};

/**
 * What Prisma hands back for a `select`: the fields asked for and nothing else,
 * a relation through its own nested `select` (or whole, when it is named
 * without one), and a refusal for a selection with no truthy field in it
 * ("needs at least one truthy value"). A stub that returns the whole row
 * whatever the query asked for lets a read that forgets a field feed
 * `undefined` to the check behind it, and the check then passes.
 */
function selected(
  row: Record<string, unknown>,
  select?: Selection,
): Record<string, unknown> {
  if (select === undefined) return row;
  const fields = Object.entries(select).filter(([, value]) => value);
  if (fields.length === 0) {
    throw new Error('Prisma: a `select` needs at least one truthy value.');
  }
  return Object.fromEntries(
    fields.map(([field, value]) => {
      const nested = (value as { select?: Selection }).select;
      const related = row[field];
      if (!nested) return [field, related];
      return [
        field,
        Array.isArray(related)
          ? related.map((entry: Record<string, unknown>) => selected(entry, nested))
          : selected(related as Record<string, unknown>, nested),
      ];
    }),
  );
}

describe('RoomPreferencesService', () => {
  let service: RoomPreferencesService;
  let tx: TxMock;
  let prisma: PrismaMock;

  beforeEach(() => {
    tx = createTxMock();
    prisma = createPrismaMock(tx);
    service = new RoomPreferencesService(prisma as unknown as PrismaService);
    tx.roomPreference.create.mockResolvedValue({ id: PREF_ID });
    tx.roomPreference.update.mockResolvedValue({ id: PREF_ID });
    // update() reads the stored row before it validates the merge; without it
    // every PATCH would be a 404.
    givenRule({ kind: 'WISH', minGradeLevel: null, maxGradeLevel: null, roomIds: [ROOM_A] });
  });

  /**
   * The stored rule, read back the way Prisma answers the query that was sent:
   * found only by its own id, its columns always, its rooms only when the
   * include names them and through the include's own select. A stub that hands
   * back the room list whatever was asked would let a merge that lost it arm a
   * lock against rooms nobody checked.
   */
  const givenRule = (rule: {
    kind: 'WISH' | 'LOCK';
    minGradeLevel: number | null;
    maxGradeLevel: number | null;
    roomIds: string[];
  }) => {
    const { roomIds, ...columns } = rule;
    const schoolId = testUser().schoolId;
    const scalars = {
      id: PREF_ID,
      schoolId,
      subjectId: SUBJECT_ID,
      roomTypeId: null,
      weight: 100,
      ...columns,
    };
    const rooms = roomIds.map((roomId) => ({ roomPreferenceId: PREF_ID, schoolId, roomId }));
    tx.roomPreference.findUnique.mockImplementation(
      ({
        where,
        include,
      }: {
        where?: { id?: string };
        include?: { rooms?: boolean | { select?: Selection } };
      }) => {
        if (where?.id === undefined) {
          throw new Error('Prisma: findUnique needs a unique field in `where`.');
        }
        if (where.id !== PREF_ID) return Promise.resolve(null);
        const relation = include?.rooms;
        if (!relation) return Promise.resolve(scalars);
        const select = typeof relation === 'object' ? relation.select : undefined;
        return Promise.resolve({
          ...scalars,
          rooms: rooms.map((entry) => selected(entry, select)),
        });
      },
    );
  };

  /**
   * The school's rooms as a table the lock check reads through its own query:
   * narrowed to the ids it names, cut to the fields it selects. Rooms the rule
   * does not name are in here too, so a query that loses its filter measures
   * the lock against rooms it never named.
   */
  const givenRooms = (rooms: FixtureRoom[]) => {
    tx.room.findMany.mockImplementation(
      ({
        where,
        select,
      }: { where?: { id?: { in?: string[] } }; select?: Selection } = {}) => {
        const ids = where?.id?.in;
        return Promise.resolve(
          rooms
            .filter((room) => ids === undefined || ids.includes(room.id))
            .map((room) => selected(room, select)),
        );
      },
    );
  };

  describe('create', () => {
    it('stores a wish for named rooms, stamping the tenant from the principal', async () => {
      await service.create(
        { subjectId: SUBJECT_ID, roomIds: [ROOM_A, ROOM_B], weight: 200 },
        testUser(),
      );

      expect(tx.roomPreference.create).toHaveBeenCalledWith({
        data: {
          schoolId: testUser().schoolId,
          subjectId: SUBJECT_ID,
          minGradeLevel: null,
          maxGradeLevel: null,
          roomTypeId: null,
          weight: 200,
          rooms: {
            create: [
              { schoolId: testUser().schoolId, roomId: ROOM_A },
              { schoolId: testUser().schoolId, roomId: ROOM_B },
            ],
          },
        },
        include: { rooms: { select: { roomId: true } } },
      });
    });

    it('stores a wish for a room type with no rooms attached', async () => {
      await service.create(
        { subjectId: SUBJECT_ID, roomTypeId: TYPE_ID },
        testUser(),
      );

      const { data } = tx.roomPreference.create.mock.calls[0][0] as {
        data: { roomTypeId: string; rooms: { create: unknown[] } };
      };
      expect(data.roomTypeId).toBe(TYPE_ID);
      expect(data.rooms.create).toEqual([]);
    });

    it('drops a room named twice rather than failing on the unique index', async () => {
      await service.create(
        { subjectId: SUBJECT_ID, roomIds: [ROOM_A, ROOM_A] },
        testUser(),
      );

      const { data } = tx.roomPreference.create.mock.calls[0][0] as {
        data: { rooms: { create: unknown[] } };
      };
      expect(data.rooms.create).toHaveLength(1);
    });

    it('refuses a wish that points at both a type and rooms', async () => {
      // The school could not say which it meant, and the engine cannot guess.
      await expect(
        service.create(
          { subjectId: SUBJECT_ID, roomTypeId: TYPE_ID, roomIds: [ROOM_A] },
          testUser(),
        ),
      ).rejects.toThrow(
        new BadRequestException(
          'Ange antingen en salstyp eller en eller flera salar — inte båda och inte ingetdera.',
        ),
      );
      expect(prisma.withRls).not.toHaveBeenCalled();
    });

    it('refuses a wish that points at nothing', async () => {
      // It could be neither satisfied nor violated — a row that does nothing
      // but look like a rule.
      await expect(
        service.create({ subjectId: SUBJECT_ID }, testUser()),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('treats an empty room list as pointing at nothing', async () => {
      await expect(
        service.create({ subjectId: SUBJECT_ID, roomIds: [] }, testUser()),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('rejects a school-less principal before touching the database', async () => {
      await expect(
        service.create({ subjectId: SUBJECT_ID, roomIds: [ROOM_A] }, schoolless()),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });
  });

  describe('update', () => {
    it('changes the weight without demanding the target be restated', async () => {
      await service.update(PREF_ID, { weight: 500 }, testUser());

      expect(tx.roomPreference.update).toHaveBeenCalledWith({
        where: { id: PREF_ID },
        data: { weight: 500 },
        include: { rooms: { select: { roomId: true } } },
      });
    });

    it('replaces the room list wholesale when it is given', async () => {
      await service.update(PREF_ID, { roomIds: [ROOM_B] }, testUser());

      const { data } = tx.roomPreference.update.mock.calls[0][0] as {
        data: { roomTypeId: string | null; rooms: { deleteMany: unknown; create: unknown[] } };
      };
      expect(data.roomTypeId).toBeNull();
      expect(data.rooms.deleteMany).toEqual({});
      expect(data.rooms.create).toEqual([
        { schoolId: testUser().schoolId, roomId: ROOM_B },
      ]);
    });

    it('switching to a type clears the rooms it replaces', async () => {
      await service.update(PREF_ID, { roomTypeId: TYPE_ID }, testUser());

      const { data } = tx.roomPreference.update.mock.calls[0][0] as {
        data: { roomTypeId: string; rooms: { create: unknown[] } };
      };
      expect(data.roomTypeId).toBe(TYPE_ID);
      expect(data.rooms.create).toEqual([]);
    });

    it('still refuses both targets at once', async () => {
      await expect(
        service.update(PREF_ID, { roomTypeId: TYPE_ID, roomIds: [ROOM_A] }, testUser()),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  describe('list', () => {
    it('runs under the caller and returns the rooms each wish names', async () => {
      tx.roomPreference.findMany.mockResolvedValue([]);

      await service.list(testUser());

      expect(prisma.withRls).toHaveBeenCalledWith(
        expect.objectContaining({ userId: testUser().userId }),
        expect.any(Function),
      );
      expect(tx.roomPreference.findMany).toHaveBeenCalledWith({
        orderBy: { createdAt: 'asc' },
        include: { rooms: { select: { roomId: true } } },
      });
    });
  });

  // -------------------------------------------------------------------------
  // Stadiet och låset
  // -------------------------------------------------------------------------

  describe('the stage and the lock', () => {
    it('defaults to a wish, which is what every existing row means', async () => {
      // A caller that forgets `kind` gets the half that cannot make a week
      // impossible.
      await service.create({ subjectId: SUBJECT_ID, roomIds: [ROOM_A] }, testUser());

      expect('kind' in tx.roomPreference.create.mock.calls[0][0].data).toBe(false);
    });

    it('stores a lock with its years', async () => {
      await service.create(
        {
          subjectId: SUBJECT_ID,
          roomIds: [ROOM_A],
          kind: 'LOCK',
          minGradeLevel: 4,
          maxGradeLevel: 4,
        },
        testUser(),
      );

      const data = tx.roomPreference.create.mock.calls[0][0].data;
      expect(data.kind).toBe('LOCK');
      expect([data.minGradeLevel, data.maxGradeLevel]).toEqual([4, 4]);
    });

    it('refuses half a span, which cannot be interpreted', async () => {
      await expect(
        service.create(
          { subjectId: SUBJECT_ID, roomIds: [ROOM_A], minGradeLevel: 4 },
          testUser(),
        ),
      ).rejects.toThrow(
        new BadRequestException(
          'Ange båda årskurserna eller ingen av dem — ett halvt spann går inte att tolka.',
        ),
      );
      expect(tx.roomPreference.create).not.toHaveBeenCalled();
    });

    it('refuses a backwards span', async () => {
      await expect(
        service.create(
          {
            subjectId: SUBJECT_ID,
            roomIds: [ROOM_A],
            minGradeLevel: 9,
            maxGradeLevel: 4,
          },
          testUser(),
        ),
      ).rejects.toThrow(
        new BadRequestException('Den lägsta årskursen får inte vara högre än den högsta.'),
      );
    });

    it('refuses a lock whose every room is fenced away from its years', async () => {
      /*
       * "Åk 4:s matte endast i Optimisten 4" when Optimisten 4 is reserved for
       * years 7-9 is a contradiction, and only this layer can phrase it: it is
       * the last place that still knows the room's NAME. The engine meets the
       * same fact as an empty eligible set and can say no more than "no room
       * satisfies capacity/type/years".
       */
      givenRooms([
        { id: ROOM_A, name: 'Optimisten 4', minGradeLevel: 7, maxGradeLevel: 9 },
      ]);

      await expect(
        service.create(
          {
            subjectId: SUBJECT_ID,
            roomIds: [ROOM_A],
            kind: 'LOCK',
            minGradeLevel: 4,
            maxGradeLevel: 4,
          },
          testUser(),
        ),
      ).rejects.toThrow('Optimisten 4');
      expect(tx.roomPreference.create).not.toHaveBeenCalled();
    });

    it('refuses a lock whose span only HALF fits the room', async () => {
      /*
       * The case that separates containment from overlap, and the reason it is
       * containment. A lock for åk 4-8 naming a room fenced to years 7-9
       * OVERLAPS it — years 7 and 8 are in both — so an overlap test would
       * accept the rule and then send the year-4 and year-5 children into a
       * högstadie room. Containment asks whether the whole span fits, and it
       * does not.
       *
       * A disjoint span (åk 4 vs a 7-9 room) cannot tell the two apart: both
       * refuse it.
       */
      givenRooms([{ id: ROOM_A, name: 'Hytt 1', minGradeLevel: 7, maxGradeLevel: 9 }]);

      await expect(
        service.create(
          {
            subjectId: SUBJECT_ID,
            roomIds: [ROOM_A],
            kind: 'LOCK',
            minGradeLevel: 4,
            maxGradeLevel: 8,
          },
          testUser(),
        ),
      ).rejects.toThrow('Hytt 1');
    });

    it('accepts a lock when one of its rooms fits, even if another does not', async () => {
      // The rooms are alternatives, not a set that must all work.
      givenRooms([
        { id: ROOM_A, name: 'Optimisten 4', minGradeLevel: 7, maxGradeLevel: 9 },
        { id: ROOM_B, name: 'Bryggan 3', minGradeLevel: null, maxGradeLevel: null },
      ]);

      await expect(
        service.create(
          {
            subjectId: SUBJECT_ID,
            roomIds: [ROOM_A, ROOM_B],
            kind: 'LOCK',
            minGradeLevel: 4,
            maxGradeLevel: 4,
          },
          testUser(),
        ),
      ).resolves.toBeDefined();
    });

    it('leaves an unreachable WISH alone', async () => {
      /*
       * A wish that cannot be met costs a constant the solver ignores. Refusing
       * one would stop a school writing an aspiration before the room it needs
       * has been re-fenced — and only a lock can make a week impossible.
       */
      givenRooms([
        { id: ROOM_A, name: 'Optimisten 4', minGradeLevel: 7, maxGradeLevel: 9 },
      ]);

      await expect(
        service.create(
          {
            subjectId: SUBJECT_ID,
            roomIds: [ROOM_A],
            minGradeLevel: 4,
            maxGradeLevel: 4,
          },
          testUser(),
        ),
      ).resolves.toBeDefined();
    });

    it('checks the merge when a PATCH flips a wish into a lock', async () => {
      /*
       * The payload says nothing about the rooms it is about to start
       * enforcing. Reading them off the DTO alone would arm a lock against a
       * room list nobody re-checked.
       */
      givenRule({ kind: 'WISH', minGradeLevel: 4, maxGradeLevel: 4, roomIds: [ROOM_A] });
      givenRooms([
        { id: ROOM_A, name: 'Optimisten 4', minGradeLevel: 7, maxGradeLevel: 9 },
      ]);

      await expect(
        service.update(PREF_ID, { kind: 'LOCK' }, testUser()),
      ).rejects.toThrow('Optimisten 4');
      expect(tx.roomPreference.update).not.toHaveBeenCalled();
    });

    it('checks the merge when a PATCH moves one year bound', async () => {
      // The other bound is never sent, so validating the DTO alone passes and
      // the database answers with a constraint name instead.
      givenRule({ kind: 'WISH', minGradeLevel: 4, maxGradeLevel: 6, roomIds: [ROOM_A] });

      await expect(
        service.update(PREF_ID, { minGradeLevel: 9 }, testUser()),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(tx.roomPreference.update).not.toHaveBeenCalled();
    });

    it('can clear a span back to every year', async () => {
      givenRule({ kind: 'WISH', minGradeLevel: 4, maxGradeLevel: 6, roomIds: [ROOM_A] });

      await service.update(
        PREF_ID,
        { minGradeLevel: null, maxGradeLevel: null },
        testUser(),
      );

      const data = tx.roomPreference.update.mock.calls[0][0].data;
      expect([data.minGradeLevel, data.maxGradeLevel]).toEqual([null, null]);
    });

    it('reports an unknown rule as missing rather than as a write failure', async () => {
      tx.roomPreference.findUnique.mockResolvedValue(null);

      await expect(service.update(PREF_ID, { kind: 'LOCK' }, testUser())).rejects.toThrow(
        /not found/,
      );
    });

    const lock = (roomIds: string[], minGradeLevel: number, maxGradeLevel: number) =>
      service.create(
        { subjectId: SUBJECT_ID, roomIds, kind: 'LOCK', minGradeLevel, maxGradeLevel },
        testUser(),
      );

    it('measures a lock against the rooms it names, not every room in the school', async () => {
      // Bryggan 3 would hold åk 4, but the lock does not name it: the rule is
      // still a contradiction, and saying so is the check's whole job.
      givenRooms([
        { id: ROOM_A, name: 'Optimisten 4', minGradeLevel: 7, maxGradeLevel: 9 },
        { id: ROOM_B, name: 'Bryggan 3', minGradeLevel: null, maxGradeLevel: null },
      ]);

      await expect(lock([ROOM_A], 4, 4)).rejects.toThrow('Optimisten 4');
      expect(tx.roomPreference.create).not.toHaveBeenCalled();
    });

    it('accepts a lock whose span sits inside the room’s fence', async () => {
      givenRooms([
        { id: ROOM_A, name: 'Mellanstadiesalen', minGradeLevel: 3, maxGradeLevel: 6 },
      ]);

      await expect(lock([ROOM_A], 4, 5)).resolves.toBeDefined();
    });

    it('counts both edges of the fence as inside it', async () => {
      // Åk 4-6 in a room fenced to 4-6 is the ordinary case, not a borderline one.
      givenRooms([
        { id: ROOM_A, name: 'Mellanstadiesalen', minGradeLevel: 4, maxGradeLevel: 6 },
      ]);

      await expect(lock([ROOM_A], 4, 6)).resolves.toBeDefined();
    });

    it('refuses a lock that reaches above the room’s fence', async () => {
      // The upper half of containment: åk 4-8 in a room for 0-5 fits at the
      // bottom and would send åk 6-8 into a lågstadie room at the top.
      givenRooms([
        { id: ROOM_A, name: 'Lågstadiesalen', minGradeLevel: 0, maxGradeLevel: 5 },
      ]);

      await expect(lock([ROOM_A], 4, 8)).rejects.toThrow('Lågstadiesalen');
    });

    it('never refuses a lock with no span, which reaches every year', async () => {
      givenRooms([
        { id: ROOM_A, name: 'Optimisten 4', minGradeLevel: 7, maxGradeLevel: 9 },
      ]);

      await expect(
        service.create(
          { subjectId: SUBJECT_ID, roomIds: [ROOM_A], kind: 'LOCK' },
          testUser(),
        ),
      ).resolves.toBeDefined();
    });

    it('names every refused room in one sentence the admin can act on', async () => {
      givenRooms([
        { id: ROOM_A, name: 'Optimisten 4', minGradeLevel: 7, maxGradeLevel: 9 },
        { id: ROOM_B, name: 'Hytt 1', minGradeLevel: 7, maxGradeLevel: 9 },
      ]);

      await expect(lock([ROOM_A, ROOM_B], 4, 4)).rejects.toThrow(
        new BadRequestException(
          'Låset går inte att hålla: Optimisten 4, Hytt 1 är reserverade för andra ' +
            'årskurser än 4–4. Ändra salens årskurser eller välj en annan sal.',
        ),
      );
    });

    it('arms a lock with a PATCH that only flips the kind, when the stored rooms allow it', async () => {
      givenRule({ kind: 'WISH', minGradeLevel: 4, maxGradeLevel: 4, roomIds: [ROOM_A] });
      givenRooms([
        { id: ROOM_A, name: 'Bryggan 3', minGradeLevel: null, maxGradeLevel: null },
      ]);

      await service.update(PREF_ID, { kind: 'LOCK' }, testUser());

      expect(tx.roomPreference.update).toHaveBeenCalledWith({
        where: { id: PREF_ID },
        data: { kind: 'LOCK' },
        include: { rooms: { select: { roomId: true } } },
      });
    });
  });

  describe('remove', () => {
    it('deletes by id under the caller and answers with the id', async () => {
      tx.roomPreference.delete.mockResolvedValue({ id: PREF_ID });
      const user = testUser();

      await expect(service.remove(PREF_ID, user)).resolves.toEqual({ id: PREF_ID });

      expect(prisma.withRls).toHaveBeenCalledWith(user, expect.any(Function));
      expect(tx.roomPreference.delete).toHaveBeenCalledWith({ where: { id: PREF_ID } });
    });

    it('maps P2025 (unknown or cross-tenant id) to 404', async () => {
      tx.roomPreference.delete.mockRejectedValue(prismaError('P2025'));

      await expect(service.remove(PREF_ID, testUser())).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });
  });
});
