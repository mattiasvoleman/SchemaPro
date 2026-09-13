import { BadRequestException, ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { Prisma, RoomType } from '@prisma/client';
import {
  createPrismaMock,
  createTxMock,
  testUser,
  type PrismaMock,
  type TxMock,
} from '../../test/utils/prisma-mock';
import type { PrismaService } from '../database/prisma.service';
import { RoomsService } from './rooms.service';
import type { CreateRoomDto } from './dto/room.dto';

const SCHOOL_ID = '33333333-3333-4333-8333-333333333333';
const ROOM_ID = '55555555-5555-4555-8555-555555555555';
const ROOM_TYPE_ID = '88888888-8888-4888-8888-888888888888';
const OTHER_ROOM_ID = '56565656-5656-4565-8565-565656565656';

const prismaError = (code: string): Prisma.PrismaClientKnownRequestError =>
  new Prisma.PrismaClientKnownRequestError(`Simulated ${code}`, {
    code,
    clientVersion: Prisma.prismaVersion.client,
  });

type Selection = Record<string, unknown>;

/**
 * What Prisma hands back for a `select`: the fields asked for and nothing else,
 * a relation through its own nested `select` (or whole, when it is named
 * without one), and a refusal for a selection with no truthy field in it
 * ("needs at least one truthy value").
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

type FixtureRule = { kind: 'WISH' | 'LOCK'; subject: string; roomIds: string[] };

/** The room-rule filter remove() sends, read the way Prisma reads it. */
function ruleMatches(where: Record<string, unknown>, rule: FixtureRule): boolean {
  return Object.entries(where).every(([key, condition]) => {
    if (key === 'kind') return rule.kind === condition;
    if (key === 'rooms') {
      const { some, ...rest } = condition as { some?: { roomId?: string } };
      if (Object.keys(rest).length > 0) {
        throw new Error(`Unhandled rooms condition: ${Object.keys(rest).join(', ')}`);
      }
      // `rooms: {}` is no condition; `some: {}` is "names at least one room";
      // `some: { roomId }` is "names this one".
      if (some === undefined) return true;
      return rule.roomIds.some(
        (roomId) => some.roomId === undefined || roomId === some.roomId,
      );
    }
    throw new Error(`The lock query grew a condition tests do not know: ${key}`);
  });
}

describe('RoomsService', () => {
  let service: RoomsService;
  let tx: TxMock;
  let prisma: PrismaMock;

  beforeEach(() => {
    tx = createTxMock();
    prisma = createPrismaMock(tx);
    service = new RoomsService(prisma as unknown as PrismaService);
  });

  const dto = (overrides: Partial<CreateRoomDto> = {}): CreateRoomDto => ({
    name: 'Sal 101',
    ...overrides,
  });

  describe('create', () => {
    it('creates a minimal room: tenant from the principal, optionals null, enum defaults untouched', async () => {
      const row = { id: ROOM_ID };
      tx.room.create.mockResolvedValue(row);
      const user = testUser();

      await expect(service.create(dto(), user)).resolves.toBe(row);

      expect(prisma.withRls).toHaveBeenCalledWith(user, expect.any(Function));
      // Exact shape: no `type` / `requiresApproval` keys when the DTO omits
      // them, so the Prisma column defaults apply.
      expect(tx.room.create).toHaveBeenCalledWith({
        data: {
          schoolId: SCHOOL_ID,
          name: 'Sal 101',
          code: null,
          capacity: null,
          // No stage limit by default — every year may use the room.
          minGradeLevel: null,
          maxGradeLevel: null,
          // Nowhere in particular: the room optimisation still counts its
          // room changes, and charges no floor or building it was never told.
          building: null,
          floor: null,
        },
      });
    });

    it('persists the chosen room type and approval requirement', async () => {
      tx.room.create.mockResolvedValue({ id: ROOM_ID });

      await service.create(
        dto({
          code: 'LAB1',
          capacity: 24,
          roomTypeId: ROOM_TYPE_ID,
          requiresApproval: true,
        }),
        testUser(),
      );

      expect(tx.room.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            code: 'LAB1',
            capacity: 24,
            roomTypeId: ROOM_TYPE_ID,
            requiresApproval: true,
          }),
        }),
      );
    });

    it('rejects a principal with no school', async () => {
      await expect(
        service.create(dto(), testUser({ schoolId: undefined })),
      ).rejects.toThrow(ForbiddenException);
      expect(prisma.withRls).not.toHaveBeenCalled();
    });

    it('maps a duplicate room (P2002) to 409', async () => {
      tx.room.create.mockRejectedValue(prismaError('P2002'));

      await expect(service.create(dto(), testUser())).rejects.toThrow(
        ConflictException,
      );
    });
  });

  describe('update', () => {
    it('passes an explicit `requiresApproval: false` through (falsy but defined)', async () => {
      const row = { id: ROOM_ID, requiresApproval: false };
      tx.room.update.mockResolvedValue(row);
      const user = testUser();

      await expect(
        service.update(ROOM_ID, { requiresApproval: false }, user),
      ).resolves.toBe(row);

      expect(prisma.withRls).toHaveBeenCalledWith(user, expect.any(Function));
      expect(tx.room.update).toHaveBeenCalledWith({
        where: { id: ROOM_ID },
        data: { requiresApproval: false },
      });
    });

    it('sends only the provided fields, null clearing the code', async () => {
      tx.room.update.mockResolvedValue({ id: ROOM_ID });

      await service.update(
        ROOM_ID,
        { name: 'Fysiksal', code: null },
        testUser(),
      );

      expect(tx.room.update).toHaveBeenCalledWith({
        where: { id: ROOM_ID },
        data: { name: 'Fysiksal', code: null },
      });
    });

    it('writes a new room type when that is what the PATCH names', async () => {
      // The type is what a subject's required type is matched against. A PATCH
      // that drops it leaves kemi placed in a room that is no longer a lab.
      tx.room.update.mockResolvedValue({ id: ROOM_ID });

      await service.update(ROOM_ID, { roomTypeId: ROOM_TYPE_ID }, testUser());

      expect(tx.room.update).toHaveBeenCalledWith({
        where: { id: ROOM_ID },
        data: { roomTypeId: ROOM_TYPE_ID },
      });
    });

    it('maps P2025 (unknown or cross-tenant id) to 404', async () => {
      tx.room.update.mockRejectedValue(prismaError('P2025'));

      await expect(
        service.update(ROOM_ID, { name: 'X' }, testUser()),
      ).rejects.toThrow(NotFoundException);
    });
  });

  describe('remove', () => {
    /*
     * The school's room rules as a table the guard reads through its own
     * query: narrowed by kind and by the room they name, cut to the fields it
     * selects. The rules handed in include ones that must NOT come back — a
     * wish, a lock on another room — so a query that loses a condition refuses
     * a delete it should allow.
     */
    const givenRules = (rules: FixtureRule[]) => {
      tx.roomPreference.findMany.mockImplementation(
        ({
          where = {},
          select,
        }: { where?: Record<string, unknown>; select?: Selection } = {}) =>
          Promise.resolve(
            rules
              .filter((rule) => ruleMatches(where, rule))
              .map((rule, index) =>
                selected(
                  {
                    id: `rule-${index}`,
                    kind: rule.kind,
                    subject: { id: `subject-${index}`, name: rule.subject },
                    rooms: rule.roomIds.map((roomId) => ({ roomId })),
                  },
                  select,
                ),
              ),
          ),
      );
    };

    it('deletes by id under the caller’s RLS context', async () => {
      tx.room.delete.mockResolvedValue({ id: ROOM_ID });
      const user = testUser();

      await expect(service.remove(ROOM_ID, user)).resolves.toBeUndefined();

      expect(prisma.withRls).toHaveBeenCalledWith(user, expect.any(Function));
      expect(tx.room.delete).toHaveBeenCalledWith({ where: { id: ROOM_ID } });
    });

    it('refuses to delete the last room a lock names', async () => {
      /*
       * RoomPreferenceRooms cascades, so the rule would survive with an empty
       * room list — a lock that forbids every room and permits none. The school
       * would meet that as a week that stopped generating for no visible
       * reason, and there is nowhere to put a warning: this returns 204 and the
       * room list simply re-renders.
       */
      givenRules([{ kind: 'LOCK', subject: 'Matematik', roomIds: [ROOM_ID] }]);

      await expect(service.remove(ROOM_ID, testUser())).rejects.toThrow(
        new BadRequestException(
          'Salen är den enda som är låst för Matematik. Ta bort eller ändra låsningen först.',
        ),
      );
      expect(tx.room.delete).not.toHaveBeenCalled();
    });

    it('names every subject a lock would strand, once each', async () => {
      givenRules([
        { kind: 'LOCK', subject: 'Matematik', roomIds: [ROOM_ID] },
        { kind: 'LOCK', subject: 'Fysik', roomIds: [ROOM_ID] },
        // A second Matematik lock, for another stage: still one subject to fix.
        { kind: 'LOCK', subject: 'Matematik', roomIds: [ROOM_ID] },
      ]);

      await expect(service.remove(ROOM_ID, testUser())).rejects.toThrow(
        new BadRequestException(
          'Salen är den enda som är låst för Matematik, Fysik. Ta bort eller ändra låsningen först.',
        ),
      );
    });

    it('deletes a room no lock names, whatever else in the school is locked', async () => {
      givenRules([
        // A lock on another room, and a wish this delete would empty: neither
        // is a reason to refuse it.
        { kind: 'LOCK', subject: 'Kemi', roomIds: [OTHER_ROOM_ID] },
        { kind: 'WISH', subject: 'Bild', roomIds: [ROOM_ID] },
      ]);
      tx.room.delete.mockResolvedValue({ id: ROOM_ID });

      await expect(service.remove(ROOM_ID, testUser())).resolves.toBeUndefined();
      expect(tx.room.delete).toHaveBeenCalledWith({ where: { id: ROOM_ID } });
    });

    it('asks only about locks, never about wishes', async () => {
      /*
       * A wish left with no rooms simply stops being paid — harmless. A lock
       * left with none forbids every room and permits none. Guarding both would
       * refuse an ordinary delete for a rule that costs nothing.
       *
       * Asserted on the QUERY, which is weaker than a behavioural test and is
       * the strongest thing available: the prisma mock returns what it is told
       * regardless of `where`, so no fixture can make it filter. What this
       * catches is the filter being dropped.
       */
      tx.roomPreference.findMany.mockResolvedValue([]);
      tx.room.delete.mockResolvedValue({ id: ROOM_ID });

      await service.remove(ROOM_ID, testUser());

      expect(tx.roomPreference.findMany.mock.calls[0][0].where).toMatchObject({
        kind: 'LOCK',
      });
    });

    it('allows the delete when the lock still has another room', async () => {
      // Two rooms named, one going away: the rule keeps meaning something.
      givenRules([
        { kind: 'LOCK', subject: 'Matematik', roomIds: [ROOM_ID, OTHER_ROOM_ID] },
      ]);
      tx.room.delete.mockResolvedValue({ id: ROOM_ID });

      await expect(service.remove(ROOM_ID, testUser())).resolves.toBeUndefined();
      expect(tx.room.delete).toHaveBeenCalled();
    });

    it('maps P2025 (unknown or cross-tenant id) to 404', async () => {
      tx.room.delete.mockRejectedValue(prismaError('P2025'));

      await expect(service.remove(ROOM_ID, testUser())).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe('location', () => {
    /*
     * The room optimisation compares buildings by equality and charges a walk
     * between two of them. "Hus B" and "Hus B " would be two buildings nobody
     * can tell apart on screen, and a name of spaces is no name at all.
     */
    it('stores a building trimmed, and a floor', async () => {
      tx.room.create.mockResolvedValue({ id: ROOM_ID });

      await service.create(dto({ building: '  Hus B ', floor: 2 }), testUser());

      expect(tx.room.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ building: 'Hus B', floor: 2 }),
      });
    });

    it('stores a blank building as none', async () => {
      tx.room.create.mockResolvedValue({ id: ROOM_ID });

      await service.create(dto({ building: '   ' }), testUser());

      expect(tx.room.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ building: null }),
      });
    });

    it('keeps a ground floor, which is falsy but known', async () => {
      tx.room.create.mockResolvedValue({ id: ROOM_ID });

      await service.create(dto({ floor: 0 }), testUser());

      const { data } = tx.room.create.mock.calls[0][0] as { data: { floor: number } };
      expect(data.floor).toBe(0);
    });

    it('trims a building on update and clears it with a blank', async () => {
      tx.room.update.mockResolvedValue({ id: ROOM_ID });

      await service.update(ROOM_ID, { building: ' Annexet ', floor: -1 }, testUser());
      await service.update(ROOM_ID, { building: '', floor: null }, testUser());

      expect(tx.room.update).toHaveBeenNthCalledWith(1, {
        where: { id: ROOM_ID },
        data: { building: 'Annexet', floor: -1 },
      });
      expect(tx.room.update).toHaveBeenNthCalledWith(2, {
        where: { id: ROOM_ID },
        data: { building: null, floor: null },
      });
    });

    it('leaves an untouched location alone on a partial update', async () => {
      tx.room.update.mockResolvedValue({ id: ROOM_ID });

      await service.update(ROOM_ID, { capacity: 28 }, testUser());

      expect(tx.room.update).toHaveBeenCalledWith({
        where: { id: ROOM_ID },
        data: { capacity: 28 },
      });
    });
  });

  describe('year range', () => {
    it('stores a stage limit', async () => {
      tx.room.create.mockResolvedValue({ id: ROOM_ID });

      await service.create(
        { name: 'B12', minGradeLevel: 4, maxGradeLevel: 6 },
        testUser(),
      );

      expect(tx.room.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ minGradeLevel: 4, maxGradeLevel: 6 }),
      });
    });

    it('allows a one-year room', async () => {
      tx.room.create.mockResolvedValue({ id: ROOM_ID });

      await service.create(
        { name: 'Förskoleklassrum', minGradeLevel: 0, maxGradeLevel: 0 },
        testUser(),
      );

      const { data } = tx.room.create.mock.calls[0][0] as {
        data: { minGradeLevel: number; maxGradeLevel: number };
      };
      // Year 0 is förskoleklass, a real year — it must survive a falsy check.
      expect(data).toMatchObject({ minGradeLevel: 0, maxGradeLevel: 0 });
    });

    it('refuses an inverted range instead of storing an unusable room', async () => {
      await expect(
        service.create({ name: 'B12', minGradeLevel: 7, maxGradeLevel: 4 }, testUser()),
      ).rejects.toThrow(
        new BadRequestException('Lägsta årskurs kan inte vara högre än högsta årskurs.'),
      );
      expect(prisma.withRls).not.toHaveBeenCalled();
    });

    it('refuses an inverted range on update too', async () => {
      await expect(
        service.update(ROOM_ID, { minGradeLevel: 9, maxGradeLevel: 1 }, testUser()),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(prisma.withRls).not.toHaveBeenCalled();
    });

    it('lets a PATCH lift the upper limit while it sets the lower one', async () => {
      // "From åk 7 and up" is a number and a null. Only two numbers can be out
      // of order — and 7 > null is true in JavaScript, which is the comparison
      // this guard must not make.
      tx.room.update.mockResolvedValue({ id: ROOM_ID });

      await service.update(ROOM_ID, { minGradeLevel: 7, maxGradeLevel: null }, testUser());

      expect(tx.room.update).toHaveBeenCalledWith({
        where: { id: ROOM_ID },
        data: { minGradeLevel: 7, maxGradeLevel: null },
      });
    });

    it('clears a limit with an explicit null', async () => {
      tx.room.update.mockResolvedValue({ id: ROOM_ID });

      await service.update(ROOM_ID, { minGradeLevel: null, maxGradeLevel: null }, testUser());

      expect(tx.room.update).toHaveBeenCalledWith({
        where: { id: ROOM_ID },
        data: { minGradeLevel: null, maxGradeLevel: null },
      });
    });

    it('leaves an untouched limit alone on a partial update', async () => {
      tx.room.update.mockResolvedValue({ id: ROOM_ID });

      await service.update(ROOM_ID, { name: 'B13' }, testUser());

      expect(tx.room.update).toHaveBeenCalledWith({
        where: { id: ROOM_ID },
        data: { name: 'B13' },
      });
    });
  });

});
