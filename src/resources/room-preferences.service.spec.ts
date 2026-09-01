import { BadRequestException, ForbiddenException } from '@nestjs/common';
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
    tx.roomPreference.findUnique.mockResolvedValue({
      id: PREF_ID,
      kind: 'WISH',
      minGradeLevel: null,
      maxGradeLevel: null,
      rooms: [{ roomId: ROOM_A }],
    });
  });

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
      ).rejects.toBeInstanceOf(BadRequestException);
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
      ).rejects.toBeInstanceOf(BadRequestException);
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
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('refuses a lock whose every room is fenced away from its years', async () => {
      /*
       * "Åk 4:s matte endast i Optimisten 4" when Optimisten 4 is reserved for
       * years 7-9 is a contradiction, and only this layer can phrase it: it is
       * the last place that still knows the room's NAME. The engine meets the
       * same fact as an empty eligible set and can say no more than "no room
       * satisfies capacity/type/years".
       */
      tx.room.findMany.mockResolvedValue([
        { name: 'Optimisten 4', minGradeLevel: 7, maxGradeLevel: 9 },
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
      tx.room.findMany.mockResolvedValue([
        { name: 'Hytt 1', minGradeLevel: 7, maxGradeLevel: 9 },
      ]);

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
      tx.room.findMany.mockResolvedValue([
        { name: 'Optimisten 4', minGradeLevel: 7, maxGradeLevel: 9 },
        { name: 'Bryggan 3', minGradeLevel: null, maxGradeLevel: null },
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
      tx.room.findMany.mockResolvedValue([
        { name: 'Optimisten 4', minGradeLevel: 7, maxGradeLevel: 9 },
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
      tx.roomPreference.findUnique.mockResolvedValue({
        id: PREF_ID,
        kind: 'WISH',
        minGradeLevel: 4,
        maxGradeLevel: 4,
        rooms: [{ roomId: ROOM_A }],
      });
      tx.room.findMany.mockResolvedValue([
        { name: 'Optimisten 4', minGradeLevel: 7, maxGradeLevel: 9 },
      ]);

      await expect(
        service.update(PREF_ID, { kind: 'LOCK' }, testUser()),
      ).rejects.toThrow('Optimisten 4');
      expect(tx.roomPreference.update).not.toHaveBeenCalled();
    });

    it('checks the merge when a PATCH moves one year bound', async () => {
      // The other bound is never sent, so validating the DTO alone passes and
      // the database answers with a constraint name instead.
      tx.roomPreference.findUnique.mockResolvedValue({
        id: PREF_ID,
        kind: 'WISH',
        minGradeLevel: 4,
        maxGradeLevel: 6,
        rooms: [{ roomId: ROOM_A }],
      });

      await expect(
        service.update(PREF_ID, { minGradeLevel: 9 }, testUser()),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(tx.roomPreference.update).not.toHaveBeenCalled();
    });

    it('can clear a span back to every year', async () => {
      tx.roomPreference.findUnique.mockResolvedValue({
        id: PREF_ID,
        kind: 'WISH',
        minGradeLevel: 4,
        maxGradeLevel: 6,
        rooms: [{ roomId: ROOM_A }],
      });

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
  });
});
