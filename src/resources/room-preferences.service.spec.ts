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
});
