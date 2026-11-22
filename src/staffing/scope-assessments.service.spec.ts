import { BadRequestException, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { createPrismaMock, createTxMock, testUser, type PrismaMock, type TxMock } from '../../test/utils/prisma-mock';
import { lockingRead, type LockedTable } from '../../test/utils/locking-read';
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

  beforeEach(() => {
    tx = createTxMock();
    prisma = createPrismaMock(tx);
    service = new ScopeAssessmentsService(prisma as unknown as PrismaService);
    users = [{ id: COLLEAGUE, role: 'TEACHER' }];
    Object.assign(tx, { $queryRaw: jest.fn((...call: unknown[]) => Promise.resolve(lockingRead(USERS, users, call))) });
    // A year that begins after the ordinance does, in the nine-year numbering; the lydelse that holds on its first day.
    tx.academicYear.findUnique.mockResolvedValue({ startDate: new Date('2027-08-16T00:00:00.000Z'), gradeNumbering: 'NIOARIG' });
    tx.assignmentScopeVersion.findFirst.mockResolvedValue(lydelse());
    tx.assignmentScopeBand.findMany.mockResolvedValue(lydelseBands());
    tx.assignmentScopeAssessment.upsert.mockImplementation(({ create }: { create: Record<string, unknown> }) =>
      Promise.resolve(stored({ ...create, decidedAt: new Date('2027-03-05T08:00:00.000Z') })),
    );
  });

  describe('list', () => {
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
      tx.academicYear.findUnique.mockResolvedValue({ startDate: new Date('2028-08-16T00:00:00.000Z'), gradeNumbering: 'TIOARIG' });
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
      tx.academicYear.findUnique.mockResolvedValue(null);
      await expect(put({ teachingLevelHours: 600 })).rejects.toBeInstanceOf(NotFoundException);
      expect(tx.assignmentScopeAssessment.upsert).not.toHaveBeenCalled();
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
