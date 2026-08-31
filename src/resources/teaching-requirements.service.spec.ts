import {
  BadRequestException,
  ConflictException,
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
import { TeachingRequirementsService } from './teaching-requirements.service';
import type { CreateTeachingRequirementDto } from './dto/teaching-requirement.dto';

const SCHOOL_ID = '33333333-3333-4333-8333-333333333333';
const YEAR_ID = '99999999-9999-4999-8999-999999999999';
const SUBJECT_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const GROUP_ID = '66666666-6666-4666-8666-666666666666';
const TEACHER_ID = '44444444-4444-4444-8444-444444444444';
const CO_TEACHER_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const REQUIREMENT_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

/** The läsår every period in these tests is measured against. */
const YEAR = {
  startDate: new Date('2026-08-17T00:00:00.000Z'),
  endDate: new Date('2027-06-11T00:00:00.000Z'),
};

const prismaError = (code: string): Prisma.PrismaClientKnownRequestError =>
  new Prisma.PrismaClientKnownRequestError(`Simulated ${code}`, {
    code,
    clientVersion: Prisma.prismaVersion.client,
  });

describe('TeachingRequirementsService', () => {
  let service: TeachingRequirementsService;
  let tx: TxMock;
  let prisma: PrismaMock;

  beforeEach(() => {
    tx = createTxMock();
    prisma = createPrismaMock(tx);
    service = new TeachingRequirementsService(prisma as unknown as PrismaService);
  });

  const dto = (
    overrides: Partial<CreateTeachingRequirementDto> = {},
  ): CreateTeachingRequirementDto => ({
    academicYearId: YEAR_ID,
    subjectId: SUBJECT_ID,
    studentGroupId: GROUP_ID,
    ...overrides,
  });

  describe('create', () => {
    it('creates an unassigned requirement with the documented defaults', async () => {
      const row = { id: REQUIREMENT_ID, startDate: null, endDate: null };
      tx.teachingRequirement.create.mockResolvedValue(row);
      const user = testUser();

      // The row itself rather than a copy of it would be the simpler
      // assertion, but the dates leave as strings now — see toResponse.
      await expect(service.create(dto(), user)).resolves.toEqual(row);

      expect(prisma.withRls).toHaveBeenCalledWith(user, expect.any(Function));
      expect(tx.teachingRequirement.create).toHaveBeenCalledWith({
        data: {
          schoolId: SCHOOL_ID,
          academicYearId: YEAR_ID,
          subjectId: SUBJECT_ID,
          studentGroupId: GROUP_ID,
          teacherId: null,
          coTeacherId: null,
          lessonsPerWeek: 1,
          minutesPerLesson: 60,
          recurrence: 'ALL_WEEKS',
          startDate: null,
          endDate: null,
        },
      });
      // A requirement without a period runs the whole year by definition, so
      // there is nothing to measure and the year is never fetched.
      expect(tx.academicYear.findUnique).not.toHaveBeenCalled();
    });

    it('persists explicit teachers and load figures', async () => {
      tx.teachingRequirement.create.mockResolvedValue({ id: REQUIREMENT_ID });

      await service.create(
        dto({
          teacherId: TEACHER_ID,
          coTeacherId: CO_TEACHER_ID,
          lessonsPerWeek: 3,
          minutesPerLesson: 45,
        }),
        testUser(),
      );

      expect(tx.teachingRequirement.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            teacherId: TEACHER_ID,
            coTeacherId: CO_TEACHER_ID,
            lessonsPerWeek: 3,
            minutesPerLesson: 45,
          }),
        }),
      );
    });

    it('persists a spring-only period and its recurrence', async () => {
      tx.academicYear.findUnique.mockResolvedValue(YEAR);
      tx.teachingRequirement.create.mockResolvedValue({ id: REQUIREMENT_ID });

      await service.create(
        dto({
          recurrence: 'ODD_WEEKS',
          startDate: '2027-01-11',
          endDate: '2027-06-11',
        }),
        testUser(),
      );

      expect(tx.academicYear.findUnique).toHaveBeenCalledWith({
        where: { id: YEAR_ID },
        select: { startDate: true, endDate: true },
      });
      expect(tx.teachingRequirement.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            recurrence: 'ODD_WEEKS',
            startDate: new Date('2027-01-11T00:00:00.000Z'),
            // The last day of the year is inside it — the bounds are inclusive.
            endDate: new Date('2027-06-11T00:00:00.000Z'),
          }),
        }),
      );
    });

    it('answers with the period as dates, not as invented midnight instants', async () => {
      tx.academicYear.findUnique.mockResolvedValue(YEAR);
      tx.teachingRequirement.create.mockResolvedValue({
        id: REQUIREMENT_ID,
        startDate: new Date('2027-01-11T00:00:00.000Z'),
        endDate: new Date('2027-06-11T00:00:00.000Z'),
      });

      // The shape the web app's own type has always claimed for this field, and
      // the shape Supabase gives when the same row is read back. Before this,
      // saving and reloading produced two different strings for one field.
      await expect(
        service.create(
          dto({ startDate: '2027-01-11', endDate: '2027-06-11' }),
          testUser(),
        ),
      ).resolves.toEqual({
        id: REQUIREMENT_ID,
        startDate: '2027-01-11',
        endDate: '2027-06-11',
      });
    });

    it('keeps a period-less requirement’s nulls as nulls', async () => {
      tx.teachingRequirement.create.mockResolvedValue({
        id: REQUIREMENT_ID,
        startDate: null,
        endDate: null,
      });

      // Null is "the year's own boundary" and has to survive the trip out; an
      // empty string here would read as a stated bound the admin never gave.
      await expect(service.create(dto(), testUser())).resolves.toEqual({
        id: REQUIREMENT_ID,
        startDate: null,
        endDate: null,
      });
    });

    it('refuses a period that reaches past the end of the läsår', async () => {
      tx.academicYear.findUnique.mockResolvedValue(YEAR);

      await expect(
        service.create(dto({ endDate: '2027-08-01' }), testUser()),
      ).rejects.toThrow(BadRequestException);
      expect(tx.teachingRequirement.create).not.toHaveBeenCalled();
    });

    it('refuses an end before its start instead of letting the CHECK 500', async () => {
      tx.academicYear.findUnique.mockResolvedValue(YEAR);

      await expect(
        service.create(
          dto({ startDate: '2027-01-11', endDate: '2026-12-01' }),
          testUser(),
        ),
      ).rejects.toThrow(BadRequestException);
      expect(tx.teachingRequirement.create).not.toHaveBeenCalled();
    });

    it('says nothing about a year RLS hides, and lets the FK refuse it', async () => {
      tx.academicYear.findUnique.mockResolvedValue(null);
      tx.teachingRequirement.create.mockRejectedValue(prismaError('P2003'));

      // Not 400 "outside its year": that answer would confirm the year exists.
      await expect(
        service.create(dto({ startDate: '2027-01-11' }), testUser()),
      ).rejects.toThrow(ConflictException);
      expect(tx.teachingRequirement.create).toHaveBeenCalled();
    });

    it('rejects a principal with no school', async () => {
      await expect(
        service.create(dto(), testUser({ schoolId: undefined })),
      ).rejects.toThrow(ForbiddenException);
      expect(prisma.withRls).not.toHaveBeenCalled();
    });

    it('maps a bad reference (P2003, invisible under RLS) to 409', async () => {
      tx.teachingRequirement.create.mockRejectedValue(prismaError('P2003'));

      await expect(service.create(dto(), testUser())).rejects.toThrow(
        ConflictException,
      );
    });
  });

  describe('lektionslängden mot solverns rutnät', () => {
    /*
     * The gap that produced a 500 in production. `@Min(15) @Max(240)` says the
     * number is plausible; it does not say the engine can lay it on its grid.
     * A 40-minute lesson — an ordinary Swedish length — was accepted, stored,
     * and blew up as an unhandled ValueError the first time somebody pressed
     * "generera", one service away from the field that caused it.
     *
     * The grid is five minutes now, so 40 is fine. What is left is what lands
     * between slots.
     */
    it.each([37, 41, 52, 1])('refuses %s minutes', async (minutesPerLesson) => {
      await expect(
        service.create(dto({ minutesPerLesson }), testUser()),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(tx.teachingRequirement.create).not.toHaveBeenCalled();
    });

    it.each([40, 45, 50, 60, 90])('accepts %s minutes', async (minutesPerLesson) => {
      // 40 and 50 are the reason the grid moved; they were impossible before.
      tx.academicYear.findUnique.mockResolvedValue(YEAR);
      tx.teachingRequirement.create.mockResolvedValue({ id: 'req-1' });

      await expect(
        service.create(dto({ minutesPerLesson }), testUser()),
      ).resolves.toBeDefined();
    });

    it('names the two lengths nearest the one that was refused', async () => {
      // "invalid" would send an administrator back to a grid they cannot see.
      await expect(
        service.create(dto({ minutesPerLesson: 37 }), testUser()),
      ).rejects.toThrow(/35.*40|40.*35/);
    });

    it('checks an update that changes only the length', async () => {
      // The guard first sat inside the period's condition, so the ordinary
      // edit — change the length, touch nothing else — skipped it entirely.
      await expect(
        service.update('req-1', { minutesPerLesson: 41 }, testUser()),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(tx.teachingRequirement.update).not.toHaveBeenCalled();
    });
  });

  describe('update', () => {
    it('unassigns the teacher with an explicit null and nothing else', async () => {
      const row = {
        id: REQUIREMENT_ID,
        teacherId: null,
        startDate: null,
        endDate: null,
      };
      tx.teachingRequirement.update.mockResolvedValue(row);
      const user = testUser();

      await expect(
        service.update(REQUIREMENT_ID, { teacherId: null }, user),
      ).resolves.toEqual(row);

      expect(prisma.withRls).toHaveBeenCalledWith(user, expect.any(Function));
      expect(tx.teachingRequirement.update).toHaveBeenCalledWith({
        where: { id: REQUIREMENT_ID },
        data: { teacherId: null },
      });
    });

    it('sends only the provided load figures', async () => {
      tx.teachingRequirement.update.mockResolvedValue({ id: REQUIREMENT_ID });

      await service.update(
        REQUIREMENT_ID,
        { lessonsPerWeek: 2, minutesPerLesson: 90 },
        testUser(),
      );

      expect(tx.teachingRequirement.update).toHaveBeenCalledWith({
        where: { id: REQUIREMENT_ID },
        data: { lessonsPerWeek: 2, minutesPerLesson: 90 },
      });
      // Neither date was sent, so the row is not read to merge a period.
      expect(tx.teachingRequirement.findUnique).not.toHaveBeenCalled();
    });

    it('clears a period with explicit nulls and nothing else', async () => {
      tx.teachingRequirement.findUnique.mockResolvedValue({
        startDate: new Date('2027-01-11T00:00:00.000Z'),
        endDate: new Date('2027-06-11T00:00:00.000Z'),
        academicYear: YEAR,
      });
      tx.teachingRequirement.update.mockResolvedValue({ id: REQUIREMENT_ID });

      await service.update(
        REQUIREMENT_ID,
        { startDate: null, endDate: null },
        testUser(),
      );

      expect(tx.teachingRequirement.update).toHaveBeenCalledWith({
        where: { id: REQUIREMENT_ID },
        data: { startDate: null, endDate: null },
      });
    });

    it('measures a one-sided move against the date already on the row', async () => {
      tx.teachingRequirement.findUnique.mockResolvedValue({
        startDate: new Date('2027-01-11T00:00:00.000Z'),
        endDate: null,
        academicYear: YEAR,
      });

      // Nothing in this PATCH is wrong on its own; it is wrong against the
      // start it inherits, which is the whole reason the row is read first.
      await expect(
        service.update(REQUIREMENT_ID, { endDate: '2026-12-01' }, testUser()),
      ).rejects.toThrow(BadRequestException);
      expect(tx.teachingRequirement.update).not.toHaveBeenCalled();
    });

    it('refuses a period moved outside the row’s own läsår', async () => {
      tx.teachingRequirement.findUnique.mockResolvedValue({
        startDate: null,
        endDate: null,
        academicYear: YEAR,
      });

      await expect(
        service.update(REQUIREMENT_ID, { startDate: '2026-06-01' }, testUser()),
      ).rejects.toThrow(BadRequestException);
      expect(tx.teachingRequirement.update).not.toHaveBeenCalled();
    });

    it('leaves an unreadable row to update()’s own 404', async () => {
      tx.teachingRequirement.findUnique.mockResolvedValue(null);
      tx.teachingRequirement.update.mockRejectedValue(prismaError('P2025'));

      await expect(
        service.update(REQUIREMENT_ID, { startDate: '2026-06-01' }, testUser()),
      ).rejects.toThrow(NotFoundException);
    });

    it('maps P2025 (unknown or cross-tenant id) to 404', async () => {
      tx.teachingRequirement.update.mockRejectedValue(prismaError('P2025'));

      await expect(
        service.update(REQUIREMENT_ID, { lessonsPerWeek: 2 }, testUser()),
      ).rejects.toThrow(NotFoundException);
    });
  });

  describe('remove', () => {
    it('deletes by id under the caller’s RLS context', async () => {
      tx.teachingRequirement.delete.mockResolvedValue({ id: REQUIREMENT_ID });
      const user = testUser();

      await expect(
        service.remove(REQUIREMENT_ID, user),
      ).resolves.toBeUndefined();

      expect(prisma.withRls).toHaveBeenCalledWith(user, expect.any(Function));
      expect(tx.teachingRequirement.delete).toHaveBeenCalledWith({
        where: { id: REQUIREMENT_ID },
      });
    });

    it('maps P2025 (unknown or cross-tenant id) to 404', async () => {
      tx.teachingRequirement.delete.mockRejectedValue(prismaError('P2025'));

      await expect(
        service.remove(REQUIREMENT_ID, testUser()),
      ).rejects.toThrow(NotFoundException);
    });
  });
});
