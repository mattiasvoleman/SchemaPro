import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { Role } from '../auth/enums/role.enum';
import { createPrismaMock, createTxMock, testUser, type PrismaMock, type TxMock } from '../../test/utils/prisma-mock';
import fixture from '../common/__fixtures__/timplan-stage-cases.json';
import { computePupilStages, type StageInput } from '../common/timplan-stage';
import type { PrismaService } from '../database/prisma.service';
import { describeStageVerdict } from './timplan-stage-messages';
import { TimplanStageService, statementRows } from './timplan-stage.service';

const YEAR_ID = '44444444-4444-4444-8444-444444444444';
const PUPIL = 'e1e1e1e1-e1e1-4e1e-8e1e-e1e1e1e1e1e1';
const OTHER = 'e2e2e2e2-e2e2-4e2e-8e2e-e2e2e2e2e2e2';
const PUBLICATION = 'f1f1f1f1-f1f1-4f1f-8f1f-f1f1f1f1f1f1';

describe('TimplanStageService', () => {
  let service: TimplanStageService;
  let tx: TxMock;
  let prisma: PrismaMock;

  beforeEach(() => {
    tx = createTxMock();
    (tx as unknown as { $queryRaw: jest.Mock }).$queryRaw = jest.fn().mockResolvedValue([]);
    prisma = createPrismaMock(tx);
    service = new TimplanStageService(prisma as unknown as PrismaService);
  });

  const year = (isActive: boolean) =>
    tx.academicYear.findUnique.mockResolvedValue({
      id: YEAR_ID,
      startDate: new Date('2026-08-17T00:00:00.000Z'),
      endDate: new Date('2027-06-11T00:00:00.000Z'),
      isActive,
      school: { timezone: 'Europe/Stockholm' },
    });

  describe('the Stadium view', () => {
    it('answers a year that is not the active one with isActiveYear false and reads no pupil', async () => {
      year(false);
      const answer = await service.overview({ academicYearId: YEAR_ID }, testUser());
      expect(answer).toMatchObject({ isActiveYear: false, classes: [], pupils: null, cohorts: [] });
      expect(tx.studentEnrollment.findMany).not.toHaveBeenCalled();
    });

    it('404s a year RLS hides', async () => {
      tx.academicYear.findUnique.mockResolvedValue(null);
      await expect(service.overview({ academicYearId: YEAR_ID }, testUser())).rejects.toThrow(NotFoundException);
    });

    it('a school with no class history and no plan answers an empty view, not an error', async () => {
      year(true);
      const answer = await service.overview({ academicYearId: YEAR_ID }, testUser());
      expect(answer).toMatchObject({ isActiveYear: true, classes: [], verdictCounts: [], publication: null });
      // The cohort notice still names the first reformed cohort.
      expect(answer.cohorts.map((row) => row.regime)).toEqual(['REFORMED_2028']);
    });
  });

  describe('publishing the statement', () => {
    it('refuses a year that is not active with 409 TIMPLAN_STAGE_NOT_ACTIVE_YEAR, writing nothing', async () => {
      year(false);
      const error = await service.publish({ academicYearId: YEAR_ID }, testUser()).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ConflictException);
      expect((error as ConflictException).getResponse()).toMatchObject({ code: 'TIMPLAN_STAGE_NOT_ACTIVE_YEAR' });
      expect(tx.timplanStatementPublication.create).not.toHaveBeenCalled();
    });

    it('locks the publication, replaces it, and stamps the admin', async () => {
      year(true);
      tx.timplanStatementPublication.create.mockResolvedValue({ id: PUBLICATION, publishedAt: new Date('2026-10-10T08:00:00.000Z') });
      const user = testUser();
      const answer = await service.publish({ academicYearId: YEAR_ID }, user);
      expect(answer).toMatchObject({ academicYearId: YEAR_ID, pupils: 0, rows: 0, publishedByUserId: user.userId });
      expect(tx.timplanStatementPublication.deleteMany).toHaveBeenCalled();
      expect(tx.timplanStatementPublication.create).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ academicYearId: YEAR_ID, publishedByUserId: user.userId }) }),
      );
      // The row lock comes first.
      expect((tx as unknown as { $queryRaw: jest.Mock }).$queryRaw.mock.invocationCallOrder[0]).toBeLessThan(
        tx.timplanStatementPublication.deleteMany.mock.invocationCallOrder[0]!,
      );
    });

    it('answers a racing publish that meets the unique key with 409 TIMPLAN_STAGE_PUBLISH_IN_PROGRESS', async () => {
      year(true);
      tx.timplanStatementPublication.create.mockRejectedValue(
        new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
          code: 'P2002',
          clientVersion: Prisma.prismaVersion.client,
          meta: { modelName: 'TimplanStatementPublication', target: 'TimplanStatementPublications_schoolId_key' },
        }),
      );
      const error = await service.publish({ academicYearId: YEAR_ID }, testUser()).catch((e: unknown) => e);
      expect((error as ConflictException).getResponse()).toMatchObject({ code: 'TIMPLAN_STAGE_PUBLISH_IN_PROGRESS' });
    });

    it('holds only the CURRENT stage of each pupil (data minimisation), with no teacher, group or name', () => {
      const cases = (fixture as unknown as { cases: { name: string; input: StageInput }[] }).cases;
      const one = cases.find((entry) => entry.name.startsWith('1.'))!;
      const rows = statementRows(computePupilStages(one.input));
      expect([...new Set(rows.map((row) => row.stage))].sort()).toEqual(['LAG_MELLAN', 'MELLAN']);
      const seven = cases.find((entry) => entry.name.startsWith('7.'))!;
      expect(statementRows(computePupilStages(seven.input))).toEqual([]); // finished stages: nothing
      expect(Object.keys(rows[0]!).sort()).toEqual([
        'backfilled', 'complete', 'distributionPublished', 'gradesFrom', 'gradesTo', 'nationalHours', 'outcomeHours',
        'plannedGrades', 'plannedHours', 'projectedHours', 'projectedStatus', 'recordedFrom', 'stage', 'status',
        'studentId', 'subjectCode', 'unrecordedGrades', 'versionCode',
      ]);
    });
  });

  describe('the card', () => {
    const row = (stage: string, subjectCode: string) => ({
      academicYearId: YEAR_ID,
      asOfDate: new Date('2026-10-01T00:00:00.000Z'),
      stage,
      subjectCode,
      versionCode: 'SFS2023:945/B1',
      distributionPublished: true,
      gradesFrom: 4,
      gradesTo: 6,
      nationalHours: new Prisma.Decimal(410),
      plannedHours: new Prisma.Decimal(413),
      outcomeHours: new Prisma.Decimal(263),
      projectedHours: new Prisma.Decimal(413),
      status: 'MET',
      projectedStatus: 'MET',
      complete: false,
      recordedFrom: new Date('2026-10-01T00:00:00.000Z'),
      plannedGrades: [6],
      unrecordedGrades: [4],
      backfilled: true,
    });

    it('reads a pupil’s OWN statement whatever studentId was sent, and never the publication row', async () => {
      tx.academicYear.findUnique.mockResolvedValue({ isActive: true });
      tx.timplanStatement.findMany.mockResolvedValue([row('MELLAN', 'MA')]);
      tx.nationalSubject.findMany.mockResolvedValue([{ code: 'MA', name: 'Matematik' }]);
      const pupil = testUser({ role: Role.STUDENT, userId: PUPIL });
      const answer = await service.card({ studentId: OTHER }, pupil);
      expect(tx.timplanStatement.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { studentId: PUPIL } }),
      );
      // The publication row names the publishing admin and counts the pupils; RLS gives a family none.
      expect(tx.timplanStatementPublication.findFirst).not.toHaveBeenCalled();
      expect(tx.academicYear.findUnique).toHaveBeenCalledWith({ where: { id: YEAR_ID }, select: { isActive: true } });
      expect(answer.statement).toMatchObject({
        studentId: PUPIL,
        asOfDate: '2026-10-01',
        stages: [
          {
            stage: 'MELLAN',
            recordedFrom: '2026-10-01',
            complete: false,
            lines: [{ subjectCode: 'MA', subjectName: 'Matematik', nationalHours: 410, outcomeHours: 263, plannedHours: 413 }],
          },
        ],
      });
    });

    it('shows nothing without a publication (or for a pupil whose rows RLS hides), and nothing for last year’s', async () => {
      const guardian = testUser({ role: Role.GUARDIAN });
      tx.timplanStatement.findMany.mockResolvedValue([]);
      await expect(service.card({ studentId: PUPIL }, guardian)).resolves.toEqual({ statement: null });
      expect(tx.academicYear.findUnique).not.toHaveBeenCalled();
      tx.timplanStatement.findMany.mockResolvedValue([row('MELLAN', 'MA')]);
      tx.academicYear.findUnique.mockResolvedValue({ isActive: false });
      await expect(service.card({ studentId: PUPIL }, guardian)).resolves.toEqual({ statement: null });
    });

    it('asks a guardian which child', async () => {
      await expect(service.card({}, testUser({ role: Role.GUARDIAN }))).rejects.toThrow(BadRequestException);
    });
  });
});

describe('the stage verdicts in Swedish', () => {
  it('has a sentence for every verdict the fixture reaches, naming no pupil', () => {
    const cases = (fixture as unknown as { cases: { input: StageInput }[] }).cases;
    const names = new Map([['MA', 'Matematik'], ['NO', 'Naturorienterande ämnen'], ['BI', 'Biologi'], ['BL', 'Bild']]);
    for (const entry of cases) {
      for (const pupil of computePupilStages(entry.input).pupils) {
        for (const verdict of pupil.verdicts) {
          const sentence = describeStageVerdict(verdict, names);
          expect(sentence.length).toBeGreaterThan(20);
          expect(sentence).not.toContain(pupil.pupilId);
          expect(sentence).not.toMatch(/undefined|NaN|\bfel\b/);
        }
      }
    }
  });

  it('says a shortfall within the cap may be skolans val, and names the reference data', () => {
    const sentence = describeStageVerdict(
      {
        code: 'TIMPLAN_PUPIL_STAGE_BELOW_NATIONAL',
        severity: 'notice',
        pupilId: PUPIL,
        stage: 'HOG',
        subjectCode: 'BL',
        params: { versionCode: 'SFS2023:945/B1', nationalHours: 100, hours: 90, shortfallHours: 10, withinCap: 1, capPercent: 20 },
      },
      new Map([['BL', 'Bild']]),
    );
    expect(sentence).toBe(
      'En elev har planerat 90 h Bild i högstadiet, 10 h under timplanens 100 h (enligt referensdata, SFS2023:945/B1). Det ryms inom 20 % och kan vara skolans val.',
    );
  });
});
