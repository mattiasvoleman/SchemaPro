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
import { lockingRead, rawSql, transactionsOf, type LockedTable } from '../../test/utils/locking-read';
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

      // No decided timplan in the school (the mock's findFirst finds
      // nothing): the year carries no attachments, exactly as before P2.
      await expect(service.create(dto(), user)).resolves.toEqual({ ...row, timplans: [] });

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

    it('attaches every årskurs the newest decided plan speaks for, in the transaction that creates the year', async () => {
      tx.academicYear.create.mockResolvedValue({ id: YEAR_ID });
      tx.localTimplan.findFirst.mockResolvedValue({
        id: 'a1a1a1a1-a1a1-4a1a-8a1a-a1a1a1a1a1a1',
        name: 'Grundskolan 2024',
        status: 'DECIDED',
        nationalVersion: { schoolForm: 'GRUNDSKOLA', appliesFromCohortTerm: 'HT2024' },
        entries: [],
      });

      const created = await service.create(dto(), testUser());

      // Newest by decision, and only decided plans: a draft is never a default.
      expect(tx.localTimplan.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { status: 'DECIDED' },
          orderBy: [{ decidedAt: 'desc' }, { createdAt: 'desc' }, { id: 'asc' }],
        }),
      );
      const rows = (tx.academicYearTimplan.createMany.mock.calls[0]?.[0] as {
        data: { gradeLevel: number; academicYearId: string; schoolId: string }[];
      }).data;
      expect(rows.map((row) => row.gradeLevel)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
      expect(rows.every((row) => row.academicYearId === YEAR_ID && row.schoolId === SCHOOL_ID)).toBe(true);
      expect(created.timplans).toHaveLength(9);
      expect(created.timplans[0]).toEqual({
        gradeLevel: 1,
        localTimplanId: 'a1a1a1a1-a1a1-4a1a-8a1a-a1a1a1a1a1a1',
        planName: 'Grundskolan 2024',
        planStatus: 'DECIDED',
      });
    });

    it('attaches förskoleklassen only when the plan itself plans it, and follows the version’s stages', async () => {
      tx.academicYear.create.mockResolvedValue({ id: YEAR_ID });
      tx.localTimplan.findFirst.mockResolvedValue({
        id: 'a1a1a1a1-a1a1-4a1a-8a1a-a1a1a1a1a1a1',
        name: 'Sameskolan',
        status: 'DECIDED',
        nationalVersion: { schoolForm: 'SAMESKOLA', appliesFromCohortTerm: 'HT2024' },
        entries: [{ gradeLevel: 0 }],
      });

      await service.create(dto(), testUser());

      const rows = (tx.academicYearTimplan.createMany.mock.calls[0]?.[0] as {
        data: { gradeLevel: number }[];
      }).data;
      // Sameskolan has no högstadium: 0 (the plan's own F-klass rows) and 1–6.
      expect(rows.map((row) => row.gradeLevel)).toEqual([0, 1, 2, 3, 4, 5, 6]);
    });

    it('a failed default rolls the year back with it — one transaction, one error', async () => {
      tx.academicYear.create.mockResolvedValue({ id: YEAR_ID });
      tx.localTimplan.findFirst.mockResolvedValue({
        id: 'a1a1a1a1-a1a1-4a1a-8a1a-a1a1a1a1a1a1',
        name: 'Grundskolan 2024',
        status: 'DECIDED',
        nationalVersion: { schoolForm: 'GRUNDSKOLA', appliesFromCohortTerm: 'HT2024' },
        entries: [],
      });
      tx.academicYearTimplan.createMany.mockRejectedValue(prismaError('P2003'));

      await expect(service.create(dto(), testUser())).rejects.toThrow(ConflictException);
      expect(prisma.withRls).toHaveBeenCalledTimes(1);
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

    // Two activations at once. The hand-over of the second finds nothing to
    // deactivate (the first's year was not active in its snapshot), and the
    // one-active-year index refuses its write with P2002. That has to leave the
    // transaction body as a rejection, which is what makes withRls roll the
    // transaction back, and reach the caller as 409.
    it('lets a racing activation’s P2002 abort its transaction, and answers 409', async () => {
      const lost = prismaError('P2002');
      tx.academicYear.updateMany.mockResolvedValue({ count: 0 });
      tx.academicYear.create.mockRejectedValue(lost);

      await expect(
        service.create(dto({ isActive: true }), testUser()),
      ).rejects.toThrow(ConflictException);

      await expect(prisma.withRls.mock.results[0].value).rejects.toBe(lost);
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
    const YEARS: LockedTable = {
      name: 'AcademicYears',
      columns: [
        'id', 'schoolId', 'name', 'startDate', 'endDate', 'isActive', 'createdAt',
        'updatedAt',
      ],
      lock: 'FOR NO KEY UPDATE',
    };
    /** The years update()'s locking read can find: none until a test stores one. */
    let years: Record<string, unknown>[];
    /** The locking read of the stored bounds. */
    let queryRaw: jest.Mock;

    beforeEach(() => {
      years = [];
      // The auto-vivifying mock would hand back a model proxy for `$queryRaw`,
      // and a proxy is not callable. It answers as the table would, from the
      // year a test stored: a year nobody stored is one the lock does not find.
      queryRaw = jest.fn((...call: unknown[]) =>
        Promise.resolve(lockingRead(YEARS, years, call)),
      );
      Object.assign(tx, { $queryRaw: queryRaw });
    });

    /** The year row as stored, found by its own id and by nothing else. */
    const givenYear = (year: { startDate: Date; endDate: Date } = YEAR) => {
      years = [
        {
          id: YEAR_ID,
          schoolId: SCHOOL_ID,
          name: '2026/2027',
          isActive: true,
          ...year,
        },
      ];
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

    // The one-active-year index checks a row as it is written, not at commit:
    // an UPDATE setting a second year active fails on that statement, even in
    // a transaction that would deactivate the first one next. Written the other
    // way round, every activation while another year is active would be a 409.
    it('hands the active flag over before it writes the year active', async () => {
      tx.academicYear.updateMany.mockResolvedValue({ count: 1 });
      tx.academicYear.update.mockResolvedValue({ id: YEAR_ID });

      await service.update(YEAR_ID, { isActive: true }, testUser());

      expect(
        tx.academicYear.updateMany.mock.invocationCallOrder[0],
      ).toBeLessThan(tx.academicYear.update.mock.invocationCallOrder[0]);
    });

    // As in create: a racing activation's write is refused by the index, and
    // the refusal has to abort the transaction rather than be handled in it.
    it('lets a racing activation’s P2002 abort its transaction, and answers 409', async () => {
      const lost = prismaError('P2002');
      tx.academicYear.updateMany.mockResolvedValue({ count: 0 });
      tx.academicYear.update.mockRejectedValue(lost);

      await expect(
        service.update(YEAR_ID, { isActive: true }, testUser()),
      ).rejects.toThrow(ConflictException);

      await expect(prisma.withRls.mock.results[0].value).rejects.toBe(lost);
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

      // A rename cannot strand a period, and the containment check costs a row
      // lock and two more queries inside the update's transaction — not a toll
      // to charge every edit of the year's name or its active flag.
      expect(queryRaw).not.toHaveBeenCalled();
      expect(tx.teachingRequirement.count).not.toHaveBeenCalled();
    });

    // Against a year with no dated period yet, a PATCH moving the start to June
    // and one moving the end to September would each pass on a row read without
    // a lock, and together store a year that ends before it starts, which
    // nothing on AcademicYears refuses. withRls runs READ COMMITTED, so only a
    // lock makes the second PATCH wait for the first and be measured against
    // what it wrote.
    it('reads the bounds it merges against under a lock, in the transaction that writes them', async () => {
      givenYear();
      tx.teachingRequirement.count.mockResolvedValue(0);
      tx.schoolBreak.count.mockResolvedValue(0);
      tx.academicYear.update.mockResolvedValue({ id: YEAR_ID });
      const ranIn = transactionsOf(prisma);
      const readIn = ranIn(queryRaw);
      const writtenIn = ranIn(tx.academicYear.update);

      await service.update(YEAR_ID, { endDate: '2027-06-18' }, testUser());

      // A lock lasts as long as the transaction that took it, so the read and
      // the write have to share one, and it has to be withRls's, the one
      // interactive transaction under the caller's claims.
      expect(readIn).toEqual([expect.stringMatching(/^withRls#\d+$/)]);
      expect(writtenIn).toEqual(readIn);
      const [call] = queryRaw.mock.calls;
      expect(rawSql(call)).toMatch(
        /SELECT "startDate", "endDate"\s+FROM "AcademicYears"\s+WHERE "id" = \?::uuid\s+FOR NO KEY UPDATE/,
      );
      expect(call.slice(1)).toEqual([YEAR_ID]);
      expect(queryRaw.mock.invocationCallOrder[0]).toBeLessThan(
        tx.teachingRequirement.count.mock.invocationCallOrder[0],
      );
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
      // No year is stored, which is all the locking read finds of a year RLS
      // hides.
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

  describe('rollover guards', () => {
    const PREVIOUS_ID = '97979797-9797-4797-8797-979797979797';
    const day = (value: string) => new Date(`${value}T00:00:00.000Z`);
    /** 2026/27 (active, 7A with one pupil) rolled into YEAR_ID (8A, linked). */
    const givenChain = (pupilIn: 'previous' | 'next') => {
      tx.academicYear.findMany.mockResolvedValue([
        { id: PREVIOUS_ID, name: '2026/27', startDate: day('2026-08-17'), endDate: day('2027-06-11'), isActive: true, predecessorId: null, graduatingGradeLevel: null },
        { id: YEAR_ID, name: '2027/28', startDate: day('2027-08-16'), endDate: day('2028-06-09'), isActive: false, predecessorId: PREVIOUS_ID, graduatingGradeLevel: 9 },
      ]);
      tx.studentGroup.findMany.mockResolvedValue([
        { id: 'g7', name: '7A', academicYearId: PREVIOUS_ID, kind: 'CLASS', gradeLevel: 7, predecessorId: null },
        { id: 'g8', name: '8A', academicYearId: YEAR_ID, kind: 'CLASS', gradeLevel: 8, predecessorId: 'g7' },
      ]);
      tx.user.findMany.mockResolvedValue([
        { id: 'p1', isActive: true, studentGroupId: pupilIn === 'previous' ? 'g7' : 'g8' },
      ]);
    };

    it('refuses PATCH {isActive: true} on a year whose pupils have not moved in, pointing at the activation', async () => {
      givenChain('previous');
      const refusal = await service.update(YEAR_ID, { isActive: true }, testUser()).catch((e) => e);
      expect(refusal).toBeInstanceOf(ConflictException);
      expect(refusal.getResponse()).toMatchObject({ code: 'YEAR_ACTIVATION_HAS_MOVES', params: { pupils: 1 } });
      expect(tx.academicYear.updateMany).not.toHaveBeenCalled();
      expect(tx.academicYear.update).not.toHaveBeenCalled();
    });

    it('refuses PATCH {isActive: true} on a year its successor has superseded', async () => {
      givenChain('next');
      const refusal = await service.update(PREVIOUS_ID, { isActive: true }, testUser()).catch((e) => e);
      expect(refusal.getResponse()).toMatchObject({ code: 'YEAR_IS_SUPERSEDED' });
      expect(tx.academicYear.update).not.toHaveBeenCalled();
    });

    it('lets the flag move once the pupils are in, and never asks when the flag goes off', async () => {
      givenChain('next');
      tx.academicYear.update.mockResolvedValue({ id: YEAR_ID });
      await service.update(YEAR_ID, { isActive: true }, testUser());
      expect(tx.academicYear.update).toHaveBeenCalled();
      tx.academicYear.findMany.mockClear();
      await service.update(YEAR_ID, { isActive: false }, testUser());
      expect(tx.academicYear.findMany).not.toHaveBeenCalled();
    });

    it('refuses to delete a year whose classes are pupils’ home classes, inactive ones included, naming how many', async () => {
      // 26 active pupils and one on leave, whom the activation left in last
      // year's 7A: the count is run BY the filter the service builds.
      const pupils = [
        ...Array.from({ length: 26 }, () => ({ role: 'STUDENT', isActive: true, academicYearId: YEAR_ID })),
        { role: 'STUDENT', isActive: false, academicYearId: YEAR_ID },
        { role: 'STUDENT', isActive: true, academicYearId: OTHER_YEAR_ID },
      ];
      tx.user.count.mockImplementation(((args: { where: Record<string, unknown> }) => {
        const { role, isActive, studentGroup, ...rest } = args.where as {
          role: string;
          isActive?: boolean;
          studentGroup: { academicYearId: string };
        };
        expect(rest).toEqual({});
        return Promise.resolve(
          pupils.filter(
            (pupil) =>
              pupil.role === role &&
              (isActive === undefined || pupil.isActive === isActive) &&
              pupil.academicYearId === studentGroup.academicYearId,
          ).length,
        );
      }) as never);
      const refusal = await service.remove(YEAR_ID, testUser()).catch((e) => e);
      expect(refusal).toBeInstanceOf(ConflictException);
      expect(refusal.getResponse()).toMatchObject({
        code: 'YEAR_HAS_HOME_PUPILS',
        params: { pupils: 27, inactive: 1 },
        message:
          'Läsåret har klasser som är hemklass för 27 elever, varav 1 inaktiva. ' +
          'Flytta eleverna, eller aktivera ett annat läsår som tar över dem, innan läsåret tas bort.',
      });
      expect(tx.academicYear.delete).not.toHaveBeenCalled();

      // Only the pupil on leave left: still refused.
      pupils.splice(0, 26);
      const leave = await service.remove(YEAR_ID, testUser()).catch((e) => e);
      expect(leave.getResponse()).toMatchObject({ code: 'YEAR_HAS_HOME_PUPILS', params: { pupils: 1, inactive: 1 } });
      expect(tx.academicYear.delete).not.toHaveBeenCalled();
    });

    it('keeps a linked year after its predecessor and before its successor', async () => {
      const queryRaw = jest.fn((...call: unknown[]) =>
        Promise.resolve(
          lockingRead(
            { name: 'AcademicYears', columns: ['id', 'startDate', 'endDate'], lock: 'FOR NO KEY UPDATE' },
            [{ id: YEAR_ID, startDate: day('2027-08-16'), endDate: day('2028-06-09') }],
            call,
          ),
        ),
      );
      Object.assign(tx, { $queryRaw: queryRaw });
      tx.academicYear.findUnique.mockResolvedValue({
        predecessor: { name: '2026/27', endDate: day('2027-06-11') },
        successor: { name: '2028/29', startDate: day('2028-08-14') },
      });
      tx.teachingRequirement.count.mockResolvedValue(0);
      tx.schoolBreak.count.mockResolvedValue(0);

      await expect(service.update(YEAR_ID, { startDate: '2027-06-11' }, testUser())).rejects.toThrow(
        new BadRequestException('startDate: läsåret fortsätter 2026/27 och måste börja efter att det slutar (2027-06-11).'),
      );
      await expect(service.update(YEAR_ID, { endDate: '2028-08-20' }, testUser())).rejects.toThrow(
        new BadRequestException('endDate: läsåret fortsätter i 2028/29 och måste sluta innan det börjar (2028-08-14).'),
      );
      tx.academicYear.update.mockResolvedValue({ id: YEAR_ID });
      await expect(service.update(YEAR_ID, { startDate: '2027-08-23' }, testUser())).resolves.toBeDefined();
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
