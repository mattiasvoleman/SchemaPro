import { BadRequestException, ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { ConstraintResource, ConstraintType, Prisma } from '@prisma/client';
import {
  createPrismaMock,
  createTxMock,
  testUser,
  type PrismaMock,
  type TxMock,
} from '../../test/utils/prisma-mock';
import type { PrismaService } from '../database/prisma.service';
import { AvailabilityConstraintsService } from './availability-constraints.service';
import type {
  CreateAvailabilityConstraintDto,
  UpdateAvailabilityConstraintDto,
} from './dto/availability-constraint.dto';

const SCHOOL_ID = '33333333-3333-4333-8333-333333333333';
const TEACHER_ID = '44444444-4444-4444-8444-444444444444';
const ROOM_ID = '55555555-5555-4555-8555-555555555555';
const GROUP_ID = '66666666-6666-4666-8666-666666666666';
const CONSTRAINT_ID = '77777777-7777-4777-8777-777777777777';

/** A `@db.Time` value as Prisma hands it back: a Date anchored at 1970-01-01. */
const wallClock = (time: string): Date => new Date(`1970-01-01T${time}:00.000Z`);

/** Reconstructs the SQL text of a tagged-template $queryRaw call. */
const rawSql = (call: unknown[]): string =>
  (call[0] as readonly string[]).join('?');

const prismaError = (code: string): Prisma.PrismaClientKnownRequestError =>
  new Prisma.PrismaClientKnownRequestError(`Simulated ${code}`, {
    code,
    clientVersion: Prisma.prismaVersion.client,
  });

describe('AvailabilityConstraintsService', () => {
  let service: AvailabilityConstraintsService;
  let tx: TxMock;
  let prisma: PrismaMock;
  /** The locking read of the stored window in update(). */
  let queryRaw: jest.Mock;

  beforeEach(() => {
    tx = createTxMock();
    // The auto-vivifying mock would hand back a model proxy for `$queryRaw`,
    // and a proxy is not callable. Empty by default: a row nobody stored is a
    // row the lookup does not find.
    queryRaw = jest.fn().mockResolvedValue([]);
    Object.assign(tx, { $queryRaw: queryRaw });
    prisma = createPrismaMock(tx);
    service = new AvailabilityConstraintsService(
      prisma as unknown as PrismaService,
    );
  });

  /** A valid weekly teacher constraint: Tuesdays 08:00–09:30. */
  const weeklyDto = (
    overrides: Partial<CreateAvailabilityConstraintDto> = {},
  ): CreateAvailabilityConstraintDto => ({
    resourceType: ConstraintResource.TEACHER,
    userId: TEACHER_ID,
    dayOfWeek: 2,
    startTime: '08:00',
    endTime: '09:30',
    ...overrides,
  });

  /** The row already in the table, as update() reads it back: 08:00-09:30. */
  const storeWindow = (startTime = '08:00', endTime = '09:30'): void => {
    queryRaw.mockResolvedValue([
      { startTime: wallClock(startTime), endTime: wallClock(endTime) },
    ]);
  };

  describe('create', () => {
    it('creates a weekly teacher constraint under the caller’s RLS context', async () => {
      const row = { id: CONSTRAINT_ID };
      tx.availabilityConstraint.create.mockResolvedValue(row);
      const user = testUser();

      await expect(service.create(weeklyDto(), user)).resolves.toBe(row);

      expect(prisma.withRls).toHaveBeenCalledWith(user, expect.any(Function));
      // Exact data shape: tenant from the principal, unset references null,
      // times parsed to @db.Time dates — and no `type` key when not provided,
      // so the Prisma default applies.
      expect(tx.availabilityConstraint.create).toHaveBeenCalledWith({
        data: {
          schoolId: SCHOOL_ID,
          resourceType: ConstraintResource.TEACHER,
          userId: TEACHER_ID,
          roomId: null,
          studentGroupId: null,
          minGradeLevel: null,
          maxGradeLevel: null,
          dayOfWeek: 2,
          date: null,
          startTime: new Date('1970-01-01T08:00:00.000Z'),
          endTime: new Date('1970-01-01T09:30:00.000Z'),
          reason: null,
        },
      });
    });

    it('creates a year-range lock that names no resource at all', async () => {
      // The one target that is not a row in any table: there is no "årskurs 5"
      // to point at, so the rule carries its own bounds. A school reserving a
      // hour held free for åk 4-6 is written once instead of once per class.
      tx.availabilityConstraint.create.mockResolvedValue({ id: CONSTRAINT_ID });

      await service.create(
        weeklyDto({
          resourceType: ConstraintResource.GRADE_LEVEL,
          userId: undefined,
          minGradeLevel: 4,
          maxGradeLevel: 6,
          reason: 'Lunch',
        }),
        testUser(),
      );

      expect(tx.availabilityConstraint.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            resourceType: ConstraintResource.GRADE_LEVEL,
            userId: null,
            roomId: null,
            studentGroupId: null,
            minGradeLevel: 4,
            maxGradeLevel: 6,
          }),
        }),
      );
    });

    it('refuses a year-range lock with no bounds', async () => {
      await expect(
        service.create(
          weeklyDto({
            resourceType: ConstraintResource.GRADE_LEVEL,
            userId: undefined,
          }),
          testUser(),
        ),
      ).rejects.toThrow(
        new BadRequestException('A GRADE_LEVEL constraint must state at least one year bound.'),
      );

      expect(tx.availabilityConstraint.create).not.toHaveBeenCalled();
    });

    it('refuses an inverted year range', async () => {
      // Accepted by the wire schema, and it would match nothing — the same
      // silent no-op the resource-shape check exists to prevent.
      await expect(
        service.create(
          weeklyDto({
            resourceType: ConstraintResource.GRADE_LEVEL,
            userId: undefined,
            minGradeLevel: 9,
            maxGradeLevel: 3,
          }),
          testUser(),
        ),
      ).rejects.toThrow(
        new BadRequestException('minGradeLevel must not be greater than maxGradeLevel.'),
      );
    });

    it('refuses a year-range lock that also names a group', async () => {
      await expect(
        service.create(
          weeklyDto({
            resourceType: ConstraintResource.GRADE_LEVEL,
            userId: undefined,
            studentGroupId: GROUP_ID,
            minGradeLevel: 4,
          }),
          testUser(),
        ),
      ).rejects.toThrow(
        new BadRequestException(
          'A GRADE_LEVEL constraint must not reference a teacher, room or group.',
        ),
      );
    });

    it.each([
      ['a teacher', { userId: TEACHER_ID }],
      ['a room', { roomId: ROOM_ID }],
    ])('refuses a year-range lock that also names %s', async (_what, reference) => {
      // Two targets in one rule: the solver can honour only one, and nothing
      // on the rule says which.
      await expect(
        service.create(
          weeklyDto({
            resourceType: ConstraintResource.GRADE_LEVEL,
            userId: undefined,
            minGradeLevel: 4,
            ...reference,
          }),
          testUser(),
        ),
      ).rejects.toThrow(
        new BadRequestException(
          'A GRADE_LEVEL constraint must not reference a teacher, room or group.',
        ),
      );
      expect(prisma.withRls).not.toHaveBeenCalled();
    });

    it.each([
      ['upwards from åk 7', { minGradeLevel: 7, maxGradeLevel: null }],
      ['downwards to åk 3', { minGradeLevel: null, maxGradeLevel: 3 }],
    ])('accepts a year-range lock open %s', async (_label, bounds) => {
      // "At least one year bound" is the rule. A form that clears the other
      // field sends null for it, and a null bound is open, not zero.
      tx.availabilityConstraint.create.mockResolvedValue({ id: CONSTRAINT_ID });

      await service.create(
        weeklyDto({
          resourceType: ConstraintResource.GRADE_LEVEL,
          userId: undefined,
          ...(bounds as Partial<CreateAvailabilityConstraintDto>),
        }),
        testUser(),
      );

      expect(tx.availabilityConstraint.create).toHaveBeenCalledWith({
        data: expect.objectContaining(bounds),
      });
    });

    it('accepts a single year as a span of one', async () => {
      tx.availabilityConstraint.create.mockResolvedValue({ id: CONSTRAINT_ID });

      await expect(
        service.create(
          weeklyDto({
            resourceType: ConstraintResource.GRADE_LEVEL,
            userId: undefined,
            minGradeLevel: 5,
            maxGradeLevel: 5,
          }),
          testUser(),
        ),
      ).resolves.toEqual({ id: CONSTRAINT_ID });
    });

    it('stores a one-off room constraint for a specific date', async () => {
      tx.availabilityConstraint.create.mockResolvedValue({ id: CONSTRAINT_ID });

      await service.create(
        weeklyDto({
          resourceType: ConstraintResource.ROOM,
          userId: undefined,
          roomId: ROOM_ID,
          dayOfWeek: undefined,
          date: '2026-09-01',
          reason: 'Renovation',
        }),
        testUser(),
      );

      expect(tx.availabilityConstraint.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            resourceType: ConstraintResource.ROOM,
            roomId: ROOM_ID,
            userId: null,
            dayOfWeek: null,
            date: new Date('2026-09-01T00:00:00.000Z'),
            reason: 'Renovation',
          }),
        }),
      );
    });

    it('passes an explicit constraint type through', async () => {
      tx.availabilityConstraint.create.mockResolvedValue({ id: CONSTRAINT_ID });

      await service.create(
        weeklyDto({ type: ConstraintType.PREFERRED_FREE }),
        testUser(),
      );

      expect(tx.availabilityConstraint.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ type: ConstraintType.PREFERRED_FREE }),
        }),
      );
    });

    it.each([
      [
        ConstraintResource.TEACHER,
        // roomId present but the TEACHER shape needs userId
        weeklyDto({ userId: undefined, roomId: ROOM_ID }),
      ],
      [
        ConstraintResource.ROOM,
        weeklyDto({ resourceType: ConstraintResource.ROOM, userId: TEACHER_ID }),
      ],
      [
        ConstraintResource.STUDENT_GROUP,
        weeklyDto({
          resourceType: ConstraintResource.STUDENT_GROUP,
          userId: undefined,
          roomId: ROOM_ID,
        }),
      ],
    ])(
      'rejects a %s constraint missing its matching resource id',
      async (resourceType, dto) => {
        await expect(service.create(dto, testUser())).rejects.toThrow(
          `A ${resourceType} constraint must reference the matching resource id.`,
        );
        expect(prisma.withRls).not.toHaveBeenCalled();
      },
    );

    it('requires either dayOfWeek or date', async () => {
      await expect(
        service.create(weeklyDto({ dayOfWeek: undefined }), testUser()),
      ).rejects.toThrow('Provide either dayOfWeek or date.');
      expect(prisma.withRls).not.toHaveBeenCalled();
    });

    it('rejects an inverted time range', async () => {
      await expect(
        service.create(
          weeklyDto({ startTime: '10:00', endTime: '09:00' }),
          testUser(),
        ),
      ).rejects.toThrow('startTime must be before endTime.');
    });

    it('rejects a zero-length time range', async () => {
      await expect(
        service.create(
          weeklyDto({ startTime: '09:00', endTime: '09:00' }),
          testUser(),
        ),
      ).rejects.toThrow(BadRequestException);
    });

    // Was pinned as a suspected bug, and it was one: the check compared the raw
    // strings, so the DTO-legal mixed formats "09:00" and "09:00:00" slipped
    // past — "09:00" is the shorter string, hence the "smaller" one — even
    // though both parse to the same instant, and a zero-length block was
    // stored. Comparing minutes since midnight is what closes it.
    it('rejects a zero-length range written in mixed HH:MM / HH:MM:SS formats', async () => {
      await expect(
        service.create(
          weeklyDto({ startTime: '09:00', endTime: '09:00:00' }),
          testUser(),
        ),
      ).rejects.toThrow('startTime must be before endTime.');

      expect(prisma.withRls).not.toHaveBeenCalled();
    });

    it('rejects a window only seconds long', async () => {
      // "09:00:30" is lexically after "09:00", so a string compare calls this
      // window ordered. On the grid it is thirty seconds long, which is no
      // window at all.
      //
      // The seconds are now refused one check earlier, so the sentence names
      // the second rather than the ordering — a narrower answer to the same
      // request, and still the same 400. The ordering guard below still has
      // its own rows; this window simply never reaches it.
      await expect(
        service.create(
          weeklyDto({ startTime: '09:00', endTime: '09:00:30' }),
          testUser(),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('refuses a second the ordering check would have let through', async () => {
      /*
       * 09:00:30 to 10:00 spans real minutes, so the ordering guard is happy
       * with it — and this table has no CHECK on its window at all, not even
       * the `"endTime" > "startTime"` its siblings carry. Nothing anywhere
       * refused this: the block was stored thirty seconds off the solver's
       * grid, and `toWallClock` then answered "09:00" for it, so the admin
       * could not even see what had been saved.
       */
      await expect(
        service.create(
          weeklyDto({ startTime: '09:00:30', endTime: '10:00' }),
          testUser(),
        ),
      ).rejects.toThrow(/must be whole minutes/);

      expect(prisma.withRls).not.toHaveBeenCalled();
    });

    it('still takes the zero seconds PostgREST sends, so a row round-trips', async () => {
      // Why the DTO admits HH:MM:SS at all. Refusing the second must not refuse
      // the round-trip it exists for.
      tx.availabilityConstraint.create.mockResolvedValue({ id: CONSTRAINT_ID });

      await service.create(
        weeklyDto({ startTime: '09:00:00', endTime: '10:00:00' }),
        testUser(),
      );

      expect(tx.availabilityConstraint.create).toHaveBeenCalled();
    });

    it('rejects a principal with no school before touching the database', async () => {
      await expect(
        service.create(weeklyDto(), testUser({ schoolId: undefined })),
      ).rejects.toThrow(ForbiddenException);
      expect(prisma.withRls).not.toHaveBeenCalled();
    });

    it('maps a foreign-key failure (invisible referenced row under RLS) to 409', async () => {
      tx.availabilityConstraint.create.mockRejectedValue(prismaError('P2003'));

      await expect(service.create(weeklyDto(), testUser())).rejects.toThrow(
        ConflictException,
      );
    });
  });

  describe('update', () => {
    it('sends only the provided fields, under the caller’s RLS context', async () => {
      const row = { id: CONSTRAINT_ID, reason: 'Away' };
      tx.availabilityConstraint.update.mockResolvedValue(row);
      const user = testUser();
      const dto: UpdateAvailabilityConstraintDto = { reason: 'Away' };

      await expect(service.update(CONSTRAINT_ID, dto, user)).resolves.toBe(row);

      expect(prisma.withRls).toHaveBeenCalledWith(user, expect.any(Function));
      expect(tx.availabilityConstraint.update).toHaveBeenCalledWith({
        where: { id: CONSTRAINT_ID },
        data: { reason: 'Away' },
      });
    });

    it('refuses a PATCH that would leave the rule pointing at nothing', async () => {
      // create() has always checked the shape; update() never did, so a PATCH
      // could switch a teacher rule to STUDENT_GROUP without supplying a group
      // and leave a rule that validates, saves, lists — and constrains nothing.
      await expect(
        service.update(
          CONSTRAINT_ID,
          { resourceType: ConstraintResource.STUDENT_GROUP },
          testUser(),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);

      expect(tx.availabilityConstraint.update).not.toHaveBeenCalled();
    });

    it('lets a PATCH that supplies the matching id through', async () => {
      tx.availabilityConstraint.update.mockResolvedValue({ id: CONSTRAINT_ID });

      await service.update(
        CONSTRAINT_ID,
        { resourceType: ConstraintResource.STUDENT_GROUP, studentGroupId: GROUP_ID },
        testUser(),
      );

      expect(tx.availabilityConstraint.update).toHaveBeenCalled();
    });

    it('leaves a PATCH that does not touch the resource type alone', async () => {
      // The shape check must not demand fields the caller never mentioned —
      // changing only the reason is the most common edit there is.
      tx.availabilityConstraint.update.mockResolvedValue({ id: CONSTRAINT_ID });

      await service.update(CONSTRAINT_ID, { reason: 'Sjuk' }, testUser());

      expect(tx.availabilityConstraint.update).toHaveBeenCalled();
    });

    it.each<[string, UpdateAvailabilityConstraintDto]>([
      ['a resource type with its room', { resourceType: ConstraintResource.ROOM, roomId: ROOM_ID }],
      ['the teacher', { userId: TEACHER_ID }],
      ['the room', { roomId: ROOM_ID }],
      [
        'a group with its resource type',
        { resourceType: ConstraintResource.STUDENT_GROUP, studentGroupId: GROUP_ID },
      ],
      ['the lower year', { minGradeLevel: 4 }],
      ['the upper year', { maxGradeLevel: 6 }],
      ['the kind of rule', { type: ConstraintType.PREFERRED_FREE }],
    ])('writes %s when that is what the PATCH names', async (_field, patch) => {
      // A field dropped on the way to the write answers 200 and leaves the rule
      // blocking what it blocked before.
      tx.availabilityConstraint.update.mockResolvedValue({ id: CONSTRAINT_ID });

      await service.update(CONSTRAINT_ID, patch, testUser());

      expect(tx.availabilityConstraint.update).toHaveBeenCalledWith({
        where: { id: CONSTRAINT_ID },
        data: patch,
      });
    });

    it('parses a new startTime and clears the date with null', async () => {
      storeWindow();
      tx.availabilityConstraint.update.mockResolvedValue({ id: CONSTRAINT_ID });
      const dto: UpdateAvailabilityConstraintDto = {
        date: null,
        dayOfWeek: 3,
        startTime: '07:15',
      };

      await service.update(CONSTRAINT_ID, dto, testUser());

      expect(tx.availabilityConstraint.update).toHaveBeenCalledWith({
        where: { id: CONSTRAINT_ID },
        data: {
          date: null,
          dayOfWeek: 3,
          startTime: new Date('1970-01-01T07:15:00.000Z'),
        },
      });
    });

    it('rejects an inverted range when both times are provided', async () => {
      await expect(
        service.update(
          CONSTRAINT_ID,
          { startTime: '12:00', endTime: '11:00' },
          testUser(),
        ),
      ).rejects.toThrow('startTime must be before endTime.');
      expect(prisma.withRls).not.toHaveBeenCalled();
    });

    it('rejects a zero-length range in mixed formats when both times are provided', async () => {
      await expect(
        service.update(
          CONSTRAINT_ID,
          { startTime: '09:00', endTime: '09:00:00' },
          testUser(),
        ),
      ).rejects.toThrow('startTime must be before endTime.');
      expect(prisma.withRls).not.toHaveBeenCalled();
    });

    it('decides a PATCH carrying both ends from the payload, without reading the row', async () => {
      // 16:00-17:00 sits wholly after the stored 08:00-09:30, so either end
      // measured against the row on its own would fail while the pair is fine.
      // The payload replaces the whole window; the row has nothing to add.
      storeWindow();
      tx.availabilityConstraint.update.mockResolvedValue({ id: CONSTRAINT_ID });

      await service.update(
        CONSTRAINT_ID,
        { startTime: '16:00', endTime: '17:00' },
        testUser(),
      );

      expect(queryRaw).not.toHaveBeenCalled();
      expect(tx.availabilityConstraint.update).toHaveBeenCalledWith({
        where: { id: CONSTRAINT_ID },
        data: { startTime: wallClock('16:00'), endTime: wallClock('17:00') },
      });
    });

    /*
     * Was pinned as current behaviour, on the grounds that with one bound in the
     * DTO no range check is possible at this layer. It is possible against the
     * row, and nothing else catches the inversion: the table has no CHECK on
     * the window, and an inverted pair overlaps no lesson of the day, so the
     * rule saves, lists and blocks nothing.
     */
    it('refuses a start moved past the end it never mentions', async () => {
      storeWindow();

      await expect(
        service.update(CONSTRAINT_ID, { startTime: '23:00' }, testUser()),
      ).rejects.toThrow('startTime must be before endTime.');

      expect(tx.availabilityConstraint.update).not.toHaveBeenCalled();
    });

    it('refuses an end moved before the start it never mentions', async () => {
      storeWindow();

      await expect(
        service.update(CONSTRAINT_ID, { endTime: '07:00' }, testUser()),
      ).rejects.toThrow('startTime must be before endTime.');

      expect(tx.availabilityConstraint.update).not.toHaveBeenCalled();
    });

    it('compares the merge in minutes, not as strings', async () => {
      // The stored start reads back as "09:00" and the DTO's regex admits
      // "09:00:30", which is lexically AFTER it — so a string compare calls
      // this window ordered and stores a thirty-second block.
      //
      // Refused on the second now, before the merge is measured at all. The
      // stored side cannot carry seconds — `toWallClock` answers in HH:MM — so
      // only the DTO's own value can trip this, which is the point.
      storeWindow('09:00', '10:00');

      await expect(
        service.update(CONSTRAINT_ID, { endTime: '09:00:30' }, testUser()),
      ).rejects.toBeInstanceOf(BadRequestException);

      expect(tx.availabilityConstraint.update).not.toHaveBeenCalled();
    });

    it('reads the stored bound in UTC, so no server zone can shift it', async () => {
      // 23:00 stored is the hour a local read would roll into the next day; a
      // start of 22:00 is before it and must be accepted.
      storeWindow('00:30', '23:00');
      tx.availabilityConstraint.update.mockResolvedValue({ id: CONSTRAINT_ID });

      await service.update(CONSTRAINT_ID, { startTime: '22:00' }, testUser());

      expect(tx.availabilityConstraint.update).toHaveBeenCalled();
    });

    it('accepts a one-sided move that still leaves the window whole', async () => {
      storeWindow();
      tx.availabilityConstraint.update.mockResolvedValue({ id: CONSTRAINT_ID });

      await expect(
        service.update(CONSTRAINT_ID, { endTime: '11:00' }, testUser()),
      ).resolves.toEqual({ id: CONSTRAINT_ID });

      expect(tx.availabilityConstraint.update).toHaveBeenCalledWith({
        where: { id: CONSTRAINT_ID },
        data: { endTime: wallClock('11:00') },
      });
    });

    it('reads the row it checks under a lock, in the transaction that writes it', async () => {
      // A second transaction for the write would let a concurrent PATCH moving
      // the other end commit in between, and so would a plain read in the same
      // one: withRls runs at READ COMMITTED, where a read takes no lock. The
      // guard is only as good as the row it saw, so the row is held until the
      // write commits.
      storeWindow();
      tx.availabilityConstraint.update.mockResolvedValue({ id: CONSTRAINT_ID });

      await service.update(CONSTRAINT_ID, { endTime: '11:00' }, testUser());

      expect(prisma.withRls).toHaveBeenCalledTimes(1);
      expect(queryRaw).toHaveBeenCalledTimes(1);
      const [call] = queryRaw.mock.calls;
      expect(rawSql(call)).toMatch(
        /FROM "AvailabilityConstraints"\s+WHERE "id" = \?::uuid\s+FOR UPDATE/,
      );
      expect(call.slice(1)).toEqual([CONSTRAINT_ID]);
      expect(queryRaw.mock.invocationCallOrder[0]).toBeLessThan(
        tx.availabilityConstraint.update.mock.invocationCallOrder[0],
      );
    });

    // A constraint in another school is invisible under RLS, so the locking
    // read comes back empty for it exactly as for an id that never existed —
    // and "does not exist" is the right answer to both: confirming the row is
    // there would tell this school something about another one.
    it('404s a one-sided PATCH against an unknown or cross-tenant id, in the words the write would use', async () => {
      await expect(
        service.update(CONSTRAINT_ID, { endTime: '11:00' }, testUser()),
      ).rejects.toThrow(new NotFoundException('The requested record does not exist.'));

      expect(tx.availabilityConstraint.update).not.toHaveBeenCalled();
    });

    it('takes no lock when the payload leaves the window alone', async () => {
      // The ordinary edit is a new reason. It cannot invert anything, and a row
      // lock on it would only queue it behind an unrelated edit of the times.
      tx.availabilityConstraint.update.mockResolvedValue({ id: CONSTRAINT_ID });

      await service.update(CONSTRAINT_ID, { reason: 'Sjuk' }, testUser());

      expect(queryRaw).not.toHaveBeenCalled();
    });

    it('answers an explicit null bound with a 400, not a crash', async () => {
      // @IsOptional() lets null through the wire schema. The column is NOT NULL
      // and parseTimeString has always refused null with a 400; the window
      // check must not be what turns it into a TypeError and a 500.
      storeWindow();

      await expect(
        service.update(
          CONSTRAINT_ID,
          { startTime: '09:00', endTime: null as unknown as string },
          testUser(),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);

      expect(tx.availabilityConstraint.update).not.toHaveBeenCalled();
    });

    it('maps P2025 (unknown or cross-tenant id) to 404', async () => {
      tx.availabilityConstraint.update.mockRejectedValue(prismaError('P2025'));

      await expect(
        service.update(CONSTRAINT_ID, { reason: 'x' }, testUser()),
      ).rejects.toThrow(NotFoundException);
    });
  });

  describe('remove', () => {
    it('deletes by id under the caller’s RLS context', async () => {
      tx.availabilityConstraint.delete.mockResolvedValue({ id: CONSTRAINT_ID });
      const user = testUser();

      await expect(service.remove(CONSTRAINT_ID, user)).resolves.toBeUndefined();

      expect(prisma.withRls).toHaveBeenCalledWith(user, expect.any(Function));
      expect(tx.availabilityConstraint.delete).toHaveBeenCalledWith({
        where: { id: CONSTRAINT_ID },
      });
    });

    it('maps P2025 (unknown or cross-tenant id) to 404', async () => {
      tx.availabilityConstraint.delete.mockRejectedValue(prismaError('P2025'));

      await expect(service.remove(CONSTRAINT_ID, testUser())).rejects.toThrow(
        NotFoundException,
      );
    });
  });
});
