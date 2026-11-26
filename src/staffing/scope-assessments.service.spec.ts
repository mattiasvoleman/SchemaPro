import { BadRequestException, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { createPrismaMock, createTxMock, testUser, type PrismaMock, type TxMock } from '../../test/utils/prisma-mock';
import { lockingRead, rawSql, type LockedTable } from '../../test/utils/locking-read';
import { recordedReads } from '../../test/utils/recorded-reads';
import type { PrismaService } from '../database/prisma.service';
import {
  SCOPE_DAY_NEEDS_INITIATIVE,
  SCOPE_EMPTY,
  SCOPE_INITIATIVE_NEEDS_DAY,
  SCOPE_NOT_IN_FORCE,
  SCOPE_NUMBERING_NOT_COVERED,
  ScopeAssessmentsService,
  hideScopeAssessment,
  scopeAboveEdge,
  scopeDayInFuture,
  scopeDayOutsideYear,
  toScopeAssessmentResponse,
} from './scope-assessments.service';

const SCHOOL_ID = '33333333-3333-4333-8333-333333333333';
const ME = '22222222-2222-4222-8222-222222222222';
const COLLEAGUE = '44444444-4444-4444-8444-444444444444';
const YEAR_ID = '99999999-9999-4999-8999-999999999999';
const KEY = { schoolId_userId_academicYearId: { schoolId: SCHOOL_ID, userId: COLLEAGUE, academicYearId: YEAR_ID } };

const USERS: LockedTable = {
  name: 'Users',
  columns: ['id', 'schoolId', 'authId', 'role', 'firstName', 'lastName', 'email', 'phone', 'isActive', 'invitedAt', 'createdAt', 'updatedAt', 'studentGroupId'],
  lock: 'FOR NO KEY UPDATE',
};

/** The läsår as the service reads it: FOR SHARE, so that a PATCH of its dates waits (review of #410, L-6). */
const YEARS: LockedTable = {
  name: 'AcademicYears',
  columns: ['id', 'startDate', 'endDate', 'gradeNumbering'],
  lock: 'FOR SHARE',
};
const yearRow = (over: Record<string, unknown> = {}) => ({
  id: YEAR_ID,
  startDate: new Date('2027-08-16T00:00:00.000Z'),
  endDate: new Date('2028-06-09T00:00:00.000Z'),
  gradeNumbering: 'NIOARIG',
  ...over,
});

const band = (over: Record<string, unknown>) => ({
  schoolForm: 'GRUNDSKOLA',
  gradeNumbering: 'NIOARIG',
  gradeFrom: 1,
  gradeTo: 6,
  teachingHoursLow: 550,
  teachingHoursHigh: 650,
  planningFloorPercent: 100,
  teachingSection: '3 § p. 1',
  planningSection: '4 §',
  note: null,
  ...over,
});
// The lydelse and its bands as the reader asks for them: the lydelse of the year's first day in one statement, its bands from their own
// table in a second (a year the ordinance does not reach sends the first only: review of #404, M-3).
const lydelse = () => ({
  id: 'version-1',
  code: 'SFS2026:1487',
  sfs: 'SFS 2026:1487',
  title: 'Förordning',
  validFrom: new Date('2027-07-01T00:00:00.000Z'),
  validTo: null,
  source: 'https://example.invalid/sfs',
});
const lydelseBands = () => [
  band({}),
  band({ gradeFrom: 7, gradeTo: 9, teachingHoursLow: 500, teachingHoursHigh: 600, planningFloorPercent: 110, teachingSection: '3 § p. 2' }),
];

const stored = (over: Record<string, unknown> = {}) => ({
  id: 'a-1',
  schoolId: SCHOOL_ID,
  userId: COLLEAGUE,
  academicYearId: YEAR_ID,
  teachingLevelHours: 600,
  exceptionKind: null,
  ownInitiativeOn: null,
  note: 'kort',
  decidedById: ME,
  decidedAt: new Date('2027-03-05T08:00:00.000Z'),
  createdAt: new Date('2027-03-05T08:00:00.000Z'),
  updatedAt: new Date('2027-03-05T08:00:00.000Z'),
  ...over,
});

describe('ScopeAssessmentsService', () => {
  let service: ScopeAssessmentsService;
  let tx: TxMock;
  let prisma: PrismaMock;
  let users: Record<string, unknown>[];
  let years: Record<string, unknown>[];

  beforeEach(() => {
    // A day after the year's last: every day the tests below call a day of the year is behind us (the day of an own initiative is not
    // registered before it has come), and the describe that is about that day sets its own.
    jest.useFakeTimers().setSystemTime(new Date('2028-06-10T10:00:00.000Z'));
    tx = createTxMock();
    prisma = createPrismaMock(tx);
    service = new ScopeAssessmentsService(prisma as unknown as PrismaService);
    users = [{ id: COLLEAGUE, role: 'TEACHER' }];
    // A year that begins after the ordinance does, in the nine-year numbering; the lydelse that holds on its first day.
    years = [yearRow()];
    Object.assign(tx, {
      $queryRaw: jest.fn((...call: unknown[]) =>
        Promise.resolve(rawSql(call).includes('"AcademicYears"') ? lockingRead(YEARS, years, call) : lockingRead(USERS, users, call)),
      ),
    });
    // The list asks that the year is the school's before it asks for its rows (a plain read: nothing is written).
    tx.academicYear.findUnique.mockResolvedValue({ id: YEAR_ID });
    tx.assignmentScopeVersion.findFirst.mockResolvedValue(lydelse());
    tx.assignmentScopeBand.findMany.mockResolvedValue(lydelseBands());
    tx.assignmentScopeAssessment.upsert.mockImplementation(({ create }: { create: Record<string, unknown> }) =>
      Promise.resolve(stored({ ...create, decidedAt: new Date('2027-03-05T08:00:00.000Z') })),
    );
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  describe('list', () => {
    it('is a 404 for a year that is not the school\'s, as the write is, and reads no rows (L-3)', async () => {
      tx.academicYear.findUnique.mockResolvedValue(null);
      await expect(service.list(YEAR_ID, testUser())).rejects.toBeInstanceOf(NotFoundException);
      expect(tx.assignmentScopeAssessment.findMany).not.toHaveBeenCalled();
      expect(tx.academicYear.findUnique).toHaveBeenCalledWith({ where: { id: YEAR_ID }, select: { id: true } });
    });

    it('is refused for a login with no school before anything is read (requireSchoolId)', async () => {
      await expect(service.list(YEAR_ID, testUser({ schoolId: undefined }))).rejects.toThrow();
      expect(prisma.withRls).not.toHaveBeenCalled();
    });

    it('hands the year\'s rows to an administrator who reads HR, whole, ordered by teacher', async () => {
      tx.assignmentScopeAssessment.findMany.mockResolvedValue([stored()]);
      const answer = await service.list(YEAR_ID, testUser());
      expect(tx.assignmentScopeAssessment.findMany).toHaveBeenCalledWith({ where: { academicYearId: YEAR_ID }, orderBy: { userId: 'asc' } });
      expect(answer).toEqual([
        {
          userId: COLLEAGUE,
          academicYearId: YEAR_ID,
          teachingLevelHours: 600,
          exceptionKind: null,
          ownInitiativeOn: null,
          note: 'kort',
          decidedById: ME,
          decidedAt: '2027-03-05T08:00:00.000Z',
          hrHidden: false,
        },
      ]);
    });

    it('leaves only the exception kind of another person\'s row to an administrator without HR-läs, and says it is hidden', async () => {
      tx.assignmentScopeAssessment.findMany.mockResolvedValue([
        stored({ exceptionKind: 'OWN_INITIATIVE', ownInitiativeOn: new Date('2027-05-02T00:00:00.000Z') }),
      ]);
      const [row] = await service.list(YEAR_ID, testUser({ adminProfile: 'EXPEDITION', hrRead: false }));
      expect(row).toEqual({
        userId: COLLEAGUE,
        academicYearId: YEAR_ID,
        teachingLevelHours: null,
        exceptionKind: 'OWN_INITIATIVE',
        ownInitiativeOn: null,
        note: null,
        decidedById: null,
        decidedAt: null,
        hrHidden: true,
      });
    });

    it('writes the read in the läslogg: EMPLOYMENT, about each teacher in the list, for every reader and in the read\'s own transaction', async () => {
      tx.assignmentScopeAssessment.findMany.mockResolvedValue([stored(), stored({ userId: ME })]);
      await service.list(YEAR_ID, testUser({ channel: 'WEB' }));
      expect(recordedReads(tx)).toEqual([{ kind: 'EMPLOYMENT', channel: 'WEB', ids: [COLLEAGUE, ME] }]);

      // A reader without HR-läs is handed the rows masked and still read them: it is logged all the same.
      tx.$executeRaw.mockClear();
      await service.list(YEAR_ID, testUser({ adminProfile: 'EXPEDITION', hrRead: false, channel: 'APP' }));
      expect(recordedReads(tx)).toEqual([{ kind: 'EMPLOYMENT', channel: 'APP', ids: [COLLEAGUE, ME] }]);

      // A list with nobody in it names nobody and sends nothing.
      tx.$executeRaw.mockClear();
      tx.assignmentScopeAssessment.findMany.mockResolvedValue([]);
      await service.list(YEAR_ID, testUser());
      expect(recordedReads(tx)).toEqual([]);
    });

    it('gives an administrator without HR-läs their OWN row whole: a person\'s own is theirs (mayReadHrOf)', async () => {
      tx.assignmentScopeAssessment.findMany.mockResolvedValue([stored({ userId: ME })]);
      const [row] = await service.list(YEAR_ID, testUser({ adminProfile: 'EXPEDITION', hrRead: false }));
      expect(row).toMatchObject({ userId: ME, teachingLevelHours: 600, hrHidden: false });
    });
  });

  describe('upsert', () => {
    const put = (dto: Record<string, unknown>, user = testUser()) => service.upsert(COLLEAGUE, YEAR_ID, dto as never, user);

    it('writes the whole row on the pair the URL names, with the day as a date, and answers it', async () => {
      const answer = await put({ teachingLevelHours: 580, exceptionKind: 'OWN_INITIATIVE', ownInitiativeOn: '2027-05-02', note: 'på begäran' });
      const data = { teachingLevelHours: 580, exceptionKind: 'OWN_INITIATIVE', ownInitiativeOn: new Date('2027-05-02T00:00:00.000Z'), note: 'på begäran' };
      expect(tx.assignmentScopeAssessment.upsert).toHaveBeenCalledWith({
        where: KEY,
        create: { schoolId: SCHOOL_ID, userId: COLLEAGUE, academicYearId: YEAR_ID, ...data },
        update: data,
      });
      expect(answer).toMatchObject({ userId: COLLEAGUE, teachingLevelHours: 580, exceptionKind: 'OWN_INITIATIVE', ownInitiativeOn: '2027-05-02', note: 'på begäran', hrHidden: false });
    });

    it('never sends who decided or when: the database sets both from the session', async () => {
      await put({ teachingLevelHours: 600 });
      const call = tx.assignmentScopeAssessment.upsert.mock.calls[0]![0] as { create: Record<string, unknown>; update: Record<string, unknown> };
      for (const side of [call.create, call.update]) {
        expect(side).not.toHaveProperty('decidedById');
        expect(side).not.toHaveProperty('decidedAt');
      }
    });

    it('replaces the row: what the body leaves out is null', async () => {
      await put({ exceptionKind: 'SMALL_GROUP' });
      expect(tx.assignmentScopeAssessment.upsert).toHaveBeenCalledWith(
        expect.objectContaining({ update: { teachingLevelHours: null, exceptionKind: 'SMALL_GROUP', ownInitiativeOn: null, note: null } }),
      );
    });

    it('is refused when it says nothing, and writes nothing', async () => {
      await expect(put({})).rejects.toThrow(new BadRequestException(SCOPE_EMPTY));
      await expect(put({ teachingLevelHours: null, exceptionKind: null, note: 'bara en anteckning' })).rejects.toThrow(new BadRequestException(SCOPE_EMPTY));
      expect(tx.assignmentScopeAssessment.upsert).not.toHaveBeenCalled();
      expect(prisma.withRls).not.toHaveBeenCalled();
    });

    it('wants the day for the exception on the teacher\'s own initiative, and refuses it for anything else', async () => {
      await expect(put({ exceptionKind: 'OWN_INITIATIVE' })).rejects.toThrow(new BadRequestException(SCOPE_INITIATIVE_NEEDS_DAY));
      await expect(put({ exceptionKind: 'SMALL_GROUP', ownInitiativeOn: '2027-05-02' })).rejects.toThrow(new BadRequestException(SCOPE_DAY_NEEDS_INITIATIVE));
      await expect(put({ teachingLevelHours: 600, ownInitiativeOn: '2027-05-02' })).rejects.toThrow(new BadRequestException(SCOPE_DAY_NEEDS_INITIATIVE));
      expect(tx.assignmentScopeAssessment.upsert).not.toHaveBeenCalled();
    });

    it('holds a level to the ordinance\'s highest edge of the year\'s lydelse, 650 here, and lets the edge itself through', async () => {
      await expect(put({ teachingLevelHours: 651 })).rejects.toThrow(new BadRequestException(scopeAboveEdge(650)));
      await expect(put({ teachingLevelHours: 650 })).resolves.toMatchObject({ teachingLevelHours: 650 });
      await expect(put({ teachingLevelHours: 1 })).resolves.toMatchObject({ teachingLevelHours: 1 });
    });

    it('moves the bound with the lydelse and not with a constant: another edge, another refusal', async () => {
      tx.assignmentScopeBand.findMany.mockResolvedValue([band({ teachingHoursHigh: 700 })]);
      await expect(put({ teachingLevelHours: 700 })).resolves.toMatchObject({ teachingLevelHours: 700 });
      await expect(put({ teachingLevelHours: 701 })).rejects.toThrow(new BadRequestException(scopeAboveEdge(700)));
    });

    it('lets an exception stand without a level, whatever the edge', async () => {
      await expect(put({ exceptionKind: 'SMALL_GROUP' })).resolves.toMatchObject({ teachingLevelHours: null, exceptionKind: 'SMALL_GROUP' });
    });

    it('refuses a year the ordinance does not reach (no lydelse holds on its first day), and a numbering it has no bands for', async () => {
      tx.assignmentScopeVersion.findFirst.mockResolvedValue(null);
      await expect(put({ teachingLevelHours: 600 })).rejects.toThrow(new BadRequestException(SCOPE_NOT_IN_FORCE));
      expect(tx.assignmentScopeBand.findMany).not.toHaveBeenCalled();
      tx.assignmentScopeVersion.findFirst.mockResolvedValue(lydelse());
      years = [yearRow({ startDate: new Date('2028-08-16T00:00:00.000Z'), endDate: new Date('2029-06-08T00:00:00.000Z'), gradeNumbering: 'TIOARIG' })];
      await expect(put({ teachingLevelHours: 600 })).rejects.toThrow(new BadRequestException(SCOPE_NUMBERING_NOT_COVERED));
      expect(tx.assignmentScopeAssessment.upsert).not.toHaveBeenCalled();
    });

    it('asks the database for the lydelse of the year\'s first day, once, and for its bands in a statement of their own', async () => {
      await put({ teachingLevelHours: 600 });
      expect(tx.assignmentScopeVersion.findFirst).toHaveBeenCalledTimes(1);
      expect(tx.assignmentScopeBand.findMany).toHaveBeenCalledTimes(1);
      expect(tx.assignmentScopeBand.findMany).toHaveBeenCalledWith({ where: { versionId: 'version-1' } });
      expect(tx.assignmentScopeVersion.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({ where: { validFrom: { lte: new Date('2027-08-16T00:00:00.000Z') }, OR: [{ validTo: null }, { validTo: { gte: new Date('2027-08-16T00:00:00.000Z') } }] } }),
      );
    });

    it('is a 404 for a year that is not the school\'s, and writes nothing', async () => {
      years = [];
      await expect(put({ teachingLevelHours: 600 })).rejects.toBeInstanceOf(NotFoundException);
      expect(tx.assignmentScopeAssessment.upsert).not.toHaveBeenCalled();
    });

    it('reads the year FOR SHARE, once, before it reads the lydelse, so that a PATCH of the year\'s dates cannot move it between the two (L-6)', async () => {
      await put({ teachingLevelHours: 600 });
      const raw = (tx['$queryRaw'] as unknown as jest.Mock).mock.calls.map((call) => rawSql(call).replace(/\s+/g, ' ').trim());
      expect(raw.filter((sql) => sql.includes('"AcademicYears"'))).toEqual([
        'SELECT "startDate", "endDate", "gradeNumbering" FROM "AcademicYears" WHERE "id" = ?::uuid FOR SHARE',
      ]);
      const year = (tx['$queryRaw'] as unknown as jest.Mock).mock.invocationCallOrder.at(-1)!;
      expect(tx.assignmentScopeVersion.findFirst.mock.invocationCallOrder[0]!).toBeGreaterThan(year - 1);
    });

    // The order is Users, then AcademicYears, as the write was written and reviewed. Either order was deadlock-free in a run against a real
    // database (the year PATCH, the activation and the carrying rollover, 40 rounds, no 40P01), so this does not say the other is wrong:
    // it says a change of the order is a decision and not a drift.
    it('takes the person\'s row before the läsår\'s', async () => {
      await put({ teachingLevelHours: 600 });
      const raw = (tx['$queryRaw'] as unknown as jest.Mock).mock.calls.map((call) => rawSql(call));
      const person = raw.findIndex((sql) => sql.includes('"Users"'));
      const year = raw.findIndex((sql) => sql.includes('"AcademicYears"'));
      expect(person).toBeGreaterThanOrEqual(0);
      expect(year).toBeGreaterThan(person);
    });

    describe('the day of an own initiative (11 § p. 1) lies in the läsår or at most a year before it (L-4)', () => {
      const initiative = (ownInitiativeOn: string) => put({ exceptionKind: 'OWN_INITIATIVE', ownInitiativeOn });

      it('takes the first day of the year before the läsår, the läsår\'s own days and its last day', async () => {
        for (const on of ['2026-08-16', '2027-01-20', '2027-08-16', '2028-06-09']) {
          await expect(initiative(on)).resolves.toMatchObject({ exceptionKind: 'OWN_INITIATIVE', ownInitiativeOn: on });
        }
      });

      it('refuses the day before that, a day after the läsår, and the typos the table would have kept (1900, 2999, 2072 for 2027)', async () => {
        for (const on of ['2026-08-15', '2028-06-10', '1900-01-01', '2999-01-01', '2072-09-01']) {
          await expect(initiative(on)).rejects.toThrow(new BadRequestException(scopeDayOutsideYear('2026-08-16', '2028-06-09')));
        }
        expect(tx.assignmentScopeAssessment.upsert).not.toHaveBeenCalled();
      });

      it('says the bounds in the order a reader reads them, in the sentence the caller gets (written out: the expected text above is built by the function itself)', async () => {
        await expect(initiative('2072-09-01')).rejects.toThrow(
          'Dagen då läraren tog initiativet ska ligga i läsåret eller högst ett år före det: från 2026-08-16 till och med 2028-06-09.',
        );
      });

      it('asks nothing of the day when there is none (a level alone, or an exception that is not the teacher\'s own initiative)', async () => {
        await expect(put({ teachingLevelHours: 600 })).resolves.toBeDefined();
        await expect(put({ exceptionKind: 'SMALL_GROUP' })).resolves.toBeDefined();
        // ...and reads nothing of the school either: the zone is asked for a day and for nothing else.
        expect(tx.school.findUnique).not.toHaveBeenCalled();
      });

      it('moves with the läsår it is written for and not with a constant', async () => {
        years = [yearRow({ startDate: new Date('2027-08-18T00:00:00.000Z'), endDate: new Date('2028-06-12T00:00:00.000Z') })];
        await expect(initiative('2026-08-18')).resolves.toBeDefined();
        await expect(initiative('2026-08-17')).rejects.toThrow(new BadRequestException(scopeDayOutsideYear('2026-08-18', '2028-06-12')));
        await expect(initiative('2028-06-13')).rejects.toBeInstanceOf(BadRequestException);
      });
    });

    describe('the day of an own initiative is not after the school\'s today (the review of #413, U-2)', () => {
      const initiative = (ownInitiativeOn: string) => put({ exceptionKind: 'OWN_INITIATIVE', ownInitiativeOn });

      it('takes today and every day before it, and refuses tomorrow, in the sentence that names today', async () => {
        jest.setSystemTime(new Date('2027-09-01T10:00:00.000Z'));
        await expect(initiative('2027-09-01')).resolves.toMatchObject({ ownInitiativeOn: '2027-09-01' });
        await expect(initiative('2027-08-31')).resolves.toBeDefined();
        await expect(initiative('2027-09-02')).rejects.toThrow(new BadRequestException(scopeDayInFuture('2027-09-01')));
        expect(tx.assignmentScopeAssessment.upsert).toHaveBeenCalledTimes(2);
      });

      it('says today in words the one who registers can read', async () => {
        jest.setSystemTime(new Date('2027-09-01T10:00:00.000Z'));
        await expect(initiative('2027-09-30')).rejects.toThrow(
          'Dagen då läraren tog initiativet kan inte ligga efter i dag (2027-09-01): undantaget registreras när initiativet har tagits.',
        );
      });

      it('is the school\'s day and not UTC\'s: at 00:30 on the 2nd in Stockholm, which is the 1st in UTC, the 2nd is today', async () => {
        jest.setSystemTime(new Date('2027-09-01T22:30:00.000Z'));
        tx.school.findUnique.mockResolvedValue({ timezone: 'Europe/Stockholm' });
        await expect(initiative('2027-09-02')).resolves.toBeDefined();
        await expect(initiative('2027-09-03')).rejects.toThrow(new BadRequestException(scopeDayInFuture('2027-09-02')));
      });

      it('goes by the zone the school has, not by Stockholm: the same instant is still the 1st in Honolulu', async () => {
        jest.setSystemTime(new Date('2027-09-01T22:30:00.000Z'));
        tx.school.findUnique.mockResolvedValue({ timezone: 'Pacific/Honolulu' });
        await expect(initiative('2027-09-01')).resolves.toBeDefined();
        await expect(initiative('2027-09-02')).rejects.toThrow(new BadRequestException(scopeDayInFuture('2027-09-01')));
      });

      it('reads the school of the session, once, by its own id', async () => {
        await initiative('2028-01-10');
        expect(tx.school.findUnique).toHaveBeenCalledTimes(1);
        expect(tx.school.findUnique).toHaveBeenCalledWith({ where: { id: SCHOOL_ID }, select: { timezone: true } });
      });

      it('asks the year first: a day outside it is the year\'s sentence, not today\'s, whatever the clock says', async () => {
        jest.setSystemTime(new Date('2027-09-01T10:00:00.000Z'));
        await expect(initiative('2999-01-01')).rejects.toThrow(new BadRequestException(scopeDayOutsideYear('2026-08-16', '2028-06-09')));
      });
    });

    it('is refused for a person who is not staff, under the lock every staffing write takes', async () => {
      users = [{ id: COLLEAGUE, role: 'STUDENT' }];
      await expect(put({ teachingLevelHours: 600 })).rejects.toThrow(/hör till en lärare/);
      expect(tx.assignmentScopeAssessment.upsert).not.toHaveBeenCalled();
    });

    it('is a 404 for a person who is not there', async () => {
      users = [];
      await expect(put({ teachingLevelHours: 600 })).rejects.toBeInstanceOf(NotFoundException);
    });

    it('answers a decider who cannot read this person\'s HR as the list would: masked', async () => {
      const answer = await put({ teachingLevelHours: 600 }, testUser({ adminProfile: 'EXPEDITION', hrRead: false }));
      expect(answer).toMatchObject({ teachingLevelHours: null, note: null, hrHidden: true });
    });
  });

  describe('remove', () => {
    it('deletes the row of the pair the URL names', async () => {
      await service.remove(COLLEAGUE, YEAR_ID, testUser());
      expect(tx.assignmentScopeAssessment.delete).toHaveBeenCalledWith({ where: KEY });
    });

    it('is a 404 for a row that is not there (P2025), as every delete by key is', async () => {
      tx.assignmentScopeAssessment.delete.mockRejectedValue(
        new Prisma.PrismaClientKnownRequestError('not found', { code: 'P2025', clientVersion: Prisma.prismaVersion.client }),
      );
      await expect(service.remove(COLLEAGUE, YEAR_ID, testUser())).rejects.toBeInstanceOf(NotFoundException);
    });
  });
});

describe('the response of an assessment', () => {
  it('prints the day as yyyy-mm-dd and the time as an instant, and is not hidden', () => {
    const answer = toScopeAssessmentResponse(stored({ exceptionKind: 'OWN_INITIATIVE', ownInitiativeOn: new Date('2027-05-02T00:00:00.000Z') }) as never);
    expect(answer).toMatchObject({ ownInitiativeOn: '2027-05-02', decidedAt: '2027-03-05T08:00:00.000Z', hrHidden: false });
  });

  it('hides what is about the person and keeps the exception kind, for a reader who may not read their HR', () => {
    const hidden = hideScopeAssessment(toScopeAssessmentResponse(stored({ exceptionKind: 'SMALL_GROUP' }) as never));
    expect(hidden).toEqual({
      userId: COLLEAGUE,
      academicYearId: YEAR_ID,
      teachingLevelHours: null,
      exceptionKind: 'SMALL_GROUP',
      ownInitiativeOn: null,
      note: null,
      decidedById: null,
      decidedAt: null,
      hrHidden: true,
    });
  });
});
