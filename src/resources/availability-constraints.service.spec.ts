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

const prismaError = (code: string): Prisma.PrismaClientKnownRequestError =>
  new Prisma.PrismaClientKnownRequestError(`Simulated ${code}`, {
    code,
    clientVersion: Prisma.prismaVersion.client,
  });

describe('AvailabilityConstraintsService', () => {
  let service: AvailabilityConstraintsService;
  let tx: TxMock;
  let prisma: PrismaMock;

  beforeEach(() => {
    tx = createTxMock();
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
      // lunch sitting for åk 4-6 writes this once instead of once per class.
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
      ).rejects.toBeInstanceOf(BadRequestException);

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
      ).rejects.toBeInstanceOf(BadRequestException);
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
      ).rejects.toBeInstanceOf(BadRequestException);
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

    // SUSPECTED BUG (pinned): the range check compares the raw strings, so the
    // DTO-legal mixed formats "09:00" vs "09:00:00" slip past ("09:00" is a
    // shorter string, hence "smaller") even though both parse to the same
    // instant — a zero-length constraint is stored.
    it('currently accepts a zero-length range written in mixed HH:MM / HH:MM:SS formats', async () => {
      tx.availabilityConstraint.create.mockResolvedValue({ id: CONSTRAINT_ID });

      await service.create(
        weeklyDto({ startTime: '09:00', endTime: '09:00:00' }),
        testUser(),
      );

      expect(tx.availabilityConstraint.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            startTime: new Date('1970-01-01T09:00:00.000Z'),
            endTime: new Date('1970-01-01T09:00:00.000Z'),
          }),
        }),
      );
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

    it('parses a new startTime and clears the date with null', async () => {
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

    // Pins current behaviour: with only one bound in the DTO no range check is
    // possible at this layer, so the write goes through even if it inverts the
    // stored range.
    it('does not range-check a lone startTime', async () => {
      tx.availabilityConstraint.update.mockResolvedValue({ id: CONSTRAINT_ID });

      await expect(
        service.update(CONSTRAINT_ID, { startTime: '23:00' }, testUser()),
      ).resolves.toEqual({ id: CONSTRAINT_ID });
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
