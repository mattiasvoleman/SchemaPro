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
import { AcademicYearsService } from './academic-years.service';
import type {
  CreateAcademicYearDto,
  UpdateAcademicYearDto,
} from './dto/academic-year.dto';

const SCHOOL_ID = '33333333-3333-4333-8333-333333333333';
const YEAR_ID = '99999999-9999-4999-8999-999999999999';
const OTHER_YEAR_ID = '98989898-9898-4898-8898-989898989898';

/** The row as it stands before an update moves it. */
const YEAR = {
  startDate: new Date('2026-08-17T00:00:00.000Z'),
  endDate: new Date('2027-06-11T00:00:00.000Z'),
};

const date = (value: string): Date => new Date(`${value}T00:00:00.000Z`);

const prismaError = (code: string): Prisma.PrismaClientKnownRequestError =>
  new Prisma.PrismaClientKnownRequestError(`Simulated ${code}`, {
    code,
    clientVersion: Prisma.prismaVersion.client,
  });

/**
 * What Prisma hands back for a `select`: the fields asked for and nothing else,
 * and a refusal for a selection with no truthy field in it ("needs at least one
 * truthy value"). A stub that returns the whole row whatever the query asked
 * for lets a read that forgets a field feed `undefined` to the guard behind it,
 * and the guard then passes.
 */
function selected(
  row: Record<string, unknown>,
  select?: Record<string, unknown>,
): Record<string, unknown> {
  if (select === undefined) return row;
  const fields = Object.keys(select).filter((field) => select[field]);
  if (fields.length === 0) {
    throw new Error('Prisma: a `select` needs at least one truthy value.');
  }
  return Object.fromEntries(fields.map((field) => [field, row[field]]));
}

// ---------------------------------------------------------------------------
// The year's lov as a table the stranded-break count actually runs against.
//
// Asserting the `where` literally would prove the service builds the filter
// someone typed, so the breaks are counted BY the filter it produced and the
// tests name which of them must be counted. The interpreter knows exactly the
// keys this service emits and throws on anything else, the same way
// school-breaks.service.spec.ts reads its delete filter.
// ---------------------------------------------------------------------------

interface FixtureBreak {
  name: string;
  academicYearId: string;
  startDate: string;
  endDate: string;
}

function breakMatches(where: Record<string, unknown>, row: FixtureBreak): boolean {
  return Object.entries(where).every(([key, condition]) => {
    switch (key) {
      case 'academicYearId':
        return row.academicYearId === condition;
      case 'OR':
        // Prisma reads an empty OR as "no alternative holds": it matches nothing.
        return (condition as Record<string, unknown>[]).some((branch) =>
          breakMatches(branch, row),
        );
      case 'startDate':
      case 'endDate': {
        const value = date(row[key]);
        return Object.entries(condition as Record<string, Date>).every(
          ([operator, bound]) => {
            if (operator === 'lt') return value < bound;
            if (operator === 'gt') return value > bound;
            throw new Error(`The count grew an operator tests do not know: ${operator}`);
          },
        );
      }
      default:
        throw new Error(`The count grew a condition tests do not know: ${key}`);
    }
  });
}

describe('AcademicYearsService', () => {
  let service: AcademicYearsService;
  let tx: TxMock;
  let prisma: PrismaMock;

  beforeEach(() => {
    tx = createTxMock();
    prisma = createPrismaMock(tx);
    service = new AcademicYearsService(prisma as unknown as PrismaService);
  });

  const dto = (
    overrides: Partial<CreateAcademicYearDto> = {},
  ): CreateAcademicYearDto => ({
    name: '2026/2027',
    startDate: '2026-08-17',
    endDate: '2027-06-12',
    ...overrides,
  });

  describe('create', () => {
    it('creates an inactive year by default, tenant taken from the principal', async () => {
      const row = { id: YEAR_ID };
      tx.academicYear.create.mockResolvedValue(row);
      const user = testUser();

      await expect(service.create(dto(), user)).resolves.toBe(row);

      expect(prisma.withRls).toHaveBeenCalledWith(user, expect.any(Function));
      expect(tx.academicYear.create).toHaveBeenCalledWith({
        data: {
          schoolId: SCHOOL_ID,
          name: '2026/2027',
          startDate: new Date('2026-08-17T00:00:00.000Z'),
          endDate: new Date('2027-06-12T00:00:00.000Z'),
          isActive: false,
        },
      });
      // No other year loses its active flag for an inactive create.
      expect(tx.academicYear.updateMany).not.toHaveBeenCalled();
    });

    it('deactivates the school’s current active year before creating an active one', async () => {
      tx.academicYear.updateMany.mockResolvedValue({ count: 1 });
      tx.academicYear.create.mockResolvedValue({ id: YEAR_ID });

      await service.create(dto({ isActive: true }), testUser());

      expect(tx.academicYear.updateMany).toHaveBeenCalledWith({
        where: { schoolId: SCHOOL_ID, isActive: true },
        data: { isActive: false },
      });
      expect(tx.academicYear.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ isActive: true }),
        }),
      );
      // The hand-over happens inside one transaction, deactivate first.
      const deactivatedAt =
        tx.academicYear.updateMany.mock.invocationCallOrder[0];
      const createdAt = tx.academicYear.create.mock.invocationCallOrder[0];
      expect(deactivatedAt).toBeLessThan(createdAt);
    });

    it('rejects startDate after endDate', async () => {
      await expect(
        service.create(
          dto({ startDate: '2027-06-12', endDate: '2026-08-17' }),
          testUser(),
        ),
      ).rejects.toThrow('startDate must be before endDate.');
      expect(prisma.withRls).not.toHaveBeenCalled();
    });

    it('rejects a zero-length year', async () => {
      await expect(
        service.create(
          dto({ startDate: '2026-08-17', endDate: '2026-08-17' }),
          testUser(),
        ),
      ).rejects.toThrow(BadRequestException);
    });

    it('rejects a principal with no school', async () => {
      await expect(
        service.create(dto(), testUser({ schoolId: undefined })),
      ).rejects.toThrow(ForbiddenException);
      expect(prisma.withRls).not.toHaveBeenCalled();
    });

    it('maps a duplicate year (P2002) to 409', async () => {
      tx.academicYear.create.mockRejectedValue(prismaError('P2002'));

      await expect(service.create(dto(), testUser())).rejects.toThrow(
        ConflictException,
      );
    });
  });

  describe('update', () => {
    /** The year row, read back the way Prisma answers the query sent for it. */
    const givenYear = (year: { startDate: Date; endDate: Date } = YEAR) => {
      tx.academicYear.findUnique.mockImplementation(
        ({
          where,
          select,
        }: {
          where?: { id?: string };
          select?: Record<string, unknown>;
        }) => {
          if (where?.id === undefined) {
            throw new Error('Prisma: findUnique needs a unique field in `where`.');
          }
          const row = {
            id: YEAR_ID,
            schoolId: SCHOOL_ID,
            name: '2026/2027',
            isActive: true,
            ...year,
          };
          return Promise.resolve(where.id === YEAR_ID ? selected(row, select) : null);
        },
      );
    };

    const givenBreaks = (breaks: FixtureBreak[]) => {
      tx.schoolBreak.count.mockImplementation(
        (args: { where?: Record<string, unknown> } = {}) =>
          Promise.resolve(
            breaks.filter((row) => breakMatches(args.where ?? {}, row)).length,
          ),
      );
    };

    /** The whole refusal, so a sentence that grows or loses a part fails too. */
    const stranding = (what: string, from: string, to: string) =>
      new BadRequestException(
        `${what} would fall outside the new academic year (${from} to ${to}). ` +
          'Move or clear them first.',
      );

    it('excludes the year itself when stealing the active flag', async () => {
      tx.academicYear.updateMany.mockResolvedValue({ count: 1 });
      tx.academicYear.update.mockResolvedValue({ id: YEAR_ID });
      const payload: UpdateAcademicYearDto = { isActive: true };

      await service.update(YEAR_ID, payload, testUser());

      expect(tx.academicYear.updateMany).toHaveBeenCalledWith({
        where: { schoolId: SCHOOL_ID, isActive: true, id: { not: YEAR_ID } },
        data: { isActive: false },
      });
      expect(tx.academicYear.update).toHaveBeenCalledWith({
        where: { id: YEAR_ID },
        data: { isActive: true },
      });
    });

    it('deactivating a year does not touch its siblings', async () => {
      tx.academicYear.update.mockResolvedValue({ id: YEAR_ID });

      await service.update(YEAR_ID, { isActive: false }, testUser());

      expect(tx.academicYear.updateMany).not.toHaveBeenCalled();
      expect(tx.academicYear.update).toHaveBeenCalledWith({
        where: { id: YEAR_ID },
        data: { isActive: false },
      });
    });

    it('sends only the provided fields, dates parsed', async () => {
      givenYear();
      tx.teachingRequirement.count.mockResolvedValue(0);
      tx.schoolBreak.count.mockResolvedValue(0);
      tx.academicYear.update.mockResolvedValue({ id: YEAR_ID });

      await service.update(
        YEAR_ID,
        { name: 'Läsår 26/27', startDate: '2026-08-18' },
        testUser(),
      );

      expect(tx.academicYear.update).toHaveBeenCalledWith({
        where: { id: YEAR_ID },
        data: {
          name: 'Läsår 26/27',
          startDate: new Date('2026-08-18T00:00:00.000Z'),
        },
      });
    });

    it('never reads the requirements when no date moves', async () => {
      tx.academicYear.update.mockResolvedValue({ id: YEAR_ID });

      await service.update(YEAR_ID, { name: 'Läsår 26/27' }, testUser());

      // A rename cannot strand a period, and the containment check costs two
      // queries inside a serializable transaction — not a toll to charge every
      // edit of the year's name or its active flag.
      expect(tx.academicYear.findUnique).not.toHaveBeenCalled();
      expect(tx.teachingRequirement.count).not.toHaveBeenCalled();
    });

    it('refuses to move the year out from under existing periods, and says how many', async () => {
      givenYear();
      tx.teachingRequirement.count.mockResolvedValue(3);
      tx.schoolBreak.count.mockResolvedValue(0);

      // Autumn term start pushed a month later; every course that already
      // starts in August is now outside its own year.
      await expect(
        service.update(YEAR_ID, { startDate: '2026-09-14' }, testUser()),
      ).rejects.toThrow(
        stranding('3 teaching requirements', '2026-09-14', '2027-06-11'),
      );
      expect(tx.academicYear.update).not.toHaveBeenCalled();
    });

    it('says "requirement" for a single one', async () => {
      givenYear();
      tx.teachingRequirement.count.mockResolvedValue(1);
      tx.schoolBreak.count.mockResolvedValue(0);

      await expect(
        service.update(YEAR_ID, { startDate: '2026-09-14' }, testUser()),
      ).rejects.toThrow(
        stranding('1 teaching requirement', '2026-09-14', '2027-06-11'),
      );
    });

    it('refuses just as firmly when only a lov would be stranded', async () => {
      /*
       * The half that was missing, and the worse one. A stranded requirement
       * period simply generates nothing; a stranded lov stops suppressing
       * publish — lessons reappear across a week the school is shut — and it
       * can never be edited back, because every write path measures the range
       * against the year it no longer fits inside.
       */
      givenYear();
      tx.teachingRequirement.count.mockResolvedValue(0);
      tx.schoolBreak.count.mockResolvedValue(1);

      // Only the lov is named: "0 teaching requirements and 1 break" would send
      // the admin to a page with nothing on it to fix.
      await expect(
        service.update(YEAR_ID, { startDate: '2026-09-14' }, testUser()),
      ).rejects.toThrow(stranding('1 break', '2026-09-14', '2027-06-11'));
      expect(tx.academicYear.update).not.toHaveBeenCalled();
    });

    it('counts the lov the new bounds leave outside, and only this year’s', async () => {
      givenYear();
      tx.teachingRequirement.count.mockResolvedValue(0);
      givenBreaks([
        // Stranded: the start moves past both of its days.
        {
          name: 'Uppstartsdagar',
          academicYearId: YEAR_ID,
          startDate: '2026-08-17',
          endDate: '2026-08-18',
        },
        // Still inside the narrowed year, and not the admin's problem.
        {
          name: 'Höstlov',
          academicYearId: YEAR_ID,
          startDate: '2026-10-26',
          endDate: '2026-10-30',
        },
        // Another year's lov is outside these bounds too, and belongs to it.
        {
          name: 'Sportlov',
          academicYearId: OTHER_YEAR_ID,
          startDate: '2026-02-22',
          endDate: '2026-02-26',
        },
      ]);

      await expect(
        service.update(YEAR_ID, { startDate: '2026-09-14' }, testUser()),
      ).rejects.toThrow(stranding('1 break', '2026-09-14', '2027-06-11'));
      expect(tx.academicYear.update).not.toHaveBeenCalled();
    });

    it('names both when a year move would strand periods and lov together', async () => {
      // Two counts rather than one total: "4 rader" tells nobody where to look,
      // and the two live on different pages.
      givenYear();
      tx.teachingRequirement.count.mockResolvedValue(3);
      tx.schoolBreak.count.mockResolvedValue(2);

      await expect(
        service.update(YEAR_ID, { startDate: '2026-09-14' }, testUser()),
      ).rejects.toThrow(
        stranding('3 teaching requirements and 2 breaks', '2026-09-14', '2027-06-11'),
      );
    });

    it('measures the periods against the bounds as they will end up', async () => {
      givenYear();
      tx.teachingRequirement.count.mockResolvedValue(0);
      tx.schoolBreak.count.mockResolvedValue(0);
      tx.academicYear.update.mockResolvedValue({ id: YEAR_ID });

      // Only endDate moves, so startDate has to come from the row — measuring
      // against a half-stated year would count every August period as stranded.
      await service.update(YEAR_ID, { endDate: '2027-06-18' }, testUser());

      expect(tx.teachingRequirement.count).toHaveBeenCalledWith({
        where: {
          academicYearId: YEAR_ID,
          OR: [
            { startDate: { lt: YEAR.startDate } },
            { startDate: { gt: new Date('2027-06-18T00:00:00.000Z') } },
            { endDate: { lt: YEAR.startDate } },
            { endDate: { gt: new Date('2027-06-18T00:00:00.000Z') } },
          ],
        },
      });
      expect(tx.academicYear.update).toHaveBeenCalledWith({
        where: { id: YEAR_ID },
        data: { endDate: new Date('2027-06-18T00:00:00.000Z') },
      });
    });

    it('lets a widened year through — nothing that fit can fall outside a superset', async () => {
      givenYear();
      tx.teachingRequirement.count.mockResolvedValue(0);
      tx.schoolBreak.count.mockResolvedValue(0);
      tx.academicYear.update.mockResolvedValue({ id: YEAR_ID });

      await expect(
        service.update(
          YEAR_ID,
          { startDate: '2026-08-10', endDate: '2027-06-18' },
          testUser(),
        ),
      ).resolves.toEqual({ id: YEAR_ID });
    });

    it('says a one-sided move inverted the year rather than blaming the periods', async () => {
      givenYear();

      await expect(
        service.update(YEAR_ID, { startDate: '2027-08-01' }, testUser()),
      ).rejects.toThrow('startDate must be before endDate.');
      // The count would have answered "every period is outside", which is true
      // and says nothing about the mistake that was actually made.
      expect(tx.teachingRequirement.count).not.toHaveBeenCalled();
      expect(tx.academicYear.update).not.toHaveBeenCalled();
    });

    it('refuses a one-sided move that leaves the year no days at all', async () => {
      // create() refuses startDate === endDate; a move one field at a time must
      // not be the way round it.
      givenYear();

      await expect(
        service.update(YEAR_ID, { startDate: '2027-06-11' }, testUser()),
      ).rejects.toThrow(new BadRequestException('startDate must be before endDate.'));
      expect(tx.teachingRequirement.count).not.toHaveBeenCalled();
      expect(tx.academicYear.update).not.toHaveBeenCalled();
    });

    it('leaves a year RLS hides to update()’s own 404', async () => {
      tx.academicYear.findUnique.mockResolvedValue(null);
      tx.academicYear.update.mockRejectedValue(prismaError('P2025'));

      // Counting somebody else's requirements at them would confirm the year
      // exists; the 404 the update already gives is the whole answer.
      await expect(
        service.update(YEAR_ID, { startDate: '2026-09-14' }, testUser()),
      ).rejects.toThrow(NotFoundException);
      expect(tx.teachingRequirement.count).not.toHaveBeenCalled();
    });

    it('requires a school even for a name-only change', async () => {
      await expect(
        service.update(YEAR_ID, { name: 'X' }, testUser({ schoolId: undefined })),
      ).rejects.toThrow(ForbiddenException);
      expect(prisma.withRls).not.toHaveBeenCalled();
    });

    it('maps P2025 (unknown or cross-tenant id) to 404', async () => {
      tx.academicYear.update.mockRejectedValue(prismaError('P2025'));

      await expect(
        service.update(YEAR_ID, { name: 'X' }, testUser()),
      ).rejects.toThrow(NotFoundException);
    });
  });

  describe('remove', () => {
    it('deletes by id under the caller’s RLS context', async () => {
      tx.academicYear.delete.mockResolvedValue({ id: YEAR_ID });
      const user = testUser();

      await expect(service.remove(YEAR_ID, user)).resolves.toBeUndefined();

      expect(prisma.withRls).toHaveBeenCalledWith(user, expect.any(Function));
      expect(tx.academicYear.delete).toHaveBeenCalledWith({
        where: { id: YEAR_ID },
      });
    });

    it('maps P2025 (unknown or cross-tenant id) to 404', async () => {
      tx.academicYear.delete.mockRejectedValue(prismaError('P2025'));

      await expect(service.remove(YEAR_ID, testUser())).rejects.toThrow(
        NotFoundException,
      );
    });
  });
});
