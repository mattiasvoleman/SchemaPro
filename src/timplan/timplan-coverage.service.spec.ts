import { NotFoundException } from '@nestjs/common';
import { Role } from '../auth/enums/role.enum';
import {
  createPrismaMock,
  createTxMock,
  testUser,
  type PrismaMock,
  type TxMock,
} from '../../test/utils/prisma-mock';
import type { PlannedVerdict, PlannedVerdictCode } from '../common/timplan-planned';
import type { PrismaService } from '../database/prisma.service';
import { TimplanCoverageService } from './timplan-coverage.service';
import { describePlannedVerdict } from './timplan-planned-messages';

const YEAR_ID = '44444444-4444-4444-8444-444444444444';
const PLAN_ID = 'a1a1a1a1-a1a1-4a1a-8a1a-a1a1a1a1a1a1';
const CLASS_ID = 'c1c1c1c1-c1c1-4c1c-8c1c-c1c1c1c1c1c1';
const GROUP_ID = 'c2c2c2c2-c2c2-4c2c-8c2c-c2c2c2c2c2c2';
const SPA = 'd1d1d1d1-d1d1-4d1d-8d1d-d1d1d1d1d1d1';
const MA = 'd2d2d2d2-d2d2-4d2d-8d2d-d2d2d2d2d2d2';
const ANNA = 'e1e1e1e1-e1e1-4e1e-8e1e-e1e1e1e1e1e1';
const BO = 'e2e2e2e2-e2e2-4e2e-8e2e-e2e2e2e2e2e2';
const VISITOR = 'e3e3e3e3-e3e3-4e3e-8e3e-e3e3e3e3e3e3';

describe('TimplanCoverageService', () => {
  let service: TimplanCoverageService;
  let tx: TxMock;
  let prisma: PrismaMock;

  beforeEach(() => {
    tx = createTxMock();
    prisma = createPrismaMock(tx);
    service = new TimplanCoverageService(prisma as unknown as PrismaService);
  });

  /** 8A, its språkval group and two pupils, one of them without språkval. */
  const givenTheYear = () => {
    tx.academicYear.findUnique.mockResolvedValue({
      startDate: new Date('2026-08-17T00:00:00.000Z'),
      endDate: new Date('2027-06-11T00:00:00.000Z'),
    });
    tx.academicYearTimplan.findMany.mockResolvedValue([{ gradeLevel: 8, localTimplanId: PLAN_ID }]);
    tx.localTimplan.findMany.mockResolvedValue([
      {
        id: PLAN_ID,
        name: 'Grundskolan 2024',
        status: 'DECIDED',
        entries: [
          { subjectId: SPA, gradeLevel: 8, minutesPerWeek: 90 },
          { subjectId: MA, gradeLevel: 8, minutesPerWeek: 180 },
        ],
      },
    ]);
    tx.subject.findMany.mockResolvedValue([
      { id: SPA, name: 'Spanska', nationalCode: 'M2', countsTowardTimplan: true },
      { id: MA, name: 'Matematik', nationalCode: 'MA', countsTowardTimplan: true },
    ]);
    tx.studentGroup.findMany.mockResolvedValue([
      { id: CLASS_ID, name: '8A', kind: 'CLASS', gradeLevel: 8 },
      { id: GROUP_ID, name: 'Spanska 8', kind: 'TEACHING_GROUP', gradeLevel: null },
    ]);
    tx.teachingRequirement.findMany.mockResolvedValue([
      {
        id: 'f1f1f1f1-f1f1-4f1f-8f1f-f1f1f1f1f1f1',
        studentGroupId: CLASS_ID,
        subjectId: MA,
        lessonsPerWeek: 3,
        minutesPerLesson: 60,
        recurrence: 'ALL_WEEKS',
        startDate: null,
        endDate: null,
      },
      {
        id: 'f2f2f2f2-f2f2-4f2f-8f2f-f2f2f2f2f2f2',
        studentGroupId: GROUP_ID,
        subjectId: SPA,
        lessonsPerWeek: 3,
        minutesPerLesson: 30,
        recurrence: 'ALL_WEEKS',
        startDate: new Date('2026-08-17T00:00:00.000Z'),
        endDate: null,
      },
    ]);
    tx.user.findMany.mockResolvedValue([
      { id: ANNA, studentGroupId: CLASS_ID },
      { id: BO, studentGroupId: CLASS_ID },
    ]);
    tx.studentGroupMember.findMany.mockResolvedValue([
      { studentId: ANNA, studentGroupId: GROUP_ID },
      { studentId: VISITOR, studentGroupId: GROUP_ID },
    ]);
  };

  it('answers the admin with the pupil level, each verdict with its Swedish sentence', async () => {
    givenTheYear();

    const answer = await service.planned({ academicYearId: YEAR_ID }, testUser());

    expect(prisma.withRls).toHaveBeenCalledTimes(1);
    expect(answer).toMatchObject({ academicYearId: YEAR_ID, layer: 'planned', pupilLevel: true, pupilCount: 2 });
    // The visitor (a member whose home class is not this year's) is counted, not judged.
    expect(answer.pupilsOutsideClasses).toBe(1);
    expect(answer.verdicts).toEqual([
      expect.objectContaining({
        code: 'TIMPLAN_PUPIL_UNDERPLANNED',
        pupilId: BO,
        message: 'En elev i 8A får 0 min/vecka Spanska, 90 under målet 90 min/vecka för åk 8.',
      }),
    ]);
    expect(answer.groups[0]).toMatchObject({ linesWithTarget: 2, linesCovered: 1, pupilCount: 2 });
  });

  it('reads only active pupils, homes by class and memberships by teaching group', async () => {
    givenTheYear();
    await service.planned({ academicYearId: YEAR_ID }, testUser());

    expect(tx.user.findMany).toHaveBeenCalledWith({
      where: { studentGroupId: { in: [CLASS_ID] }, role: 'STUDENT', isActive: true },
      select: { id: true, studentGroupId: true },
    });
    expect(tx.studentGroupMember.findMany).toHaveBeenCalledWith({
      where: { studentGroupId: { in: [GROUP_ID] }, student: { isActive: true } },
      select: { studentId: true, studentGroupId: true },
    });
    expect(tx.teachingRequirement.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { academicYearId: YEAR_ID } }),
    );
  });

  it('answers a teacher with the group level only: no pupil id anywhere in the document', async () => {
    givenTheYear();

    const answer = await service.planned({ academicYearId: YEAR_ID }, testUser({ role: Role.TEACHER }));

    expect(answer.pupilLevel).toBe(false);
    expect(answer.pupils).toBeNull();
    expect(answer.verdicts).toEqual([]);
    const text = JSON.stringify(answer);
    for (const pupilId of [ANNA, BO, VISITOR]) expect(text).not.toContain(pupilId);
    // The class coverage is the same computation: språkval is short for one pupil.
    expect(answer.groups[0]).toMatchObject({ linesWithTarget: 2, linesCovered: 1 });
  });

  it('404s a year RLS hides, and reads nothing else', async () => {
    tx.academicYear.findUnique.mockResolvedValue(null);
    await expect(service.planned({ academicYearId: YEAR_ID }, testUser())).rejects.toThrow(NotFoundException);
    expect(tx.teachingRequirement.findMany).not.toHaveBeenCalled();
  });

  it('skips the plans read for a year with no attachments', async () => {
    tx.academicYear.findUnique.mockResolvedValue({
      startDate: new Date('2026-08-17T00:00:00.000Z'),
      endDate: new Date('2027-06-11T00:00:00.000Z'),
    });
    const answer = await service.planned({ academicYearId: YEAR_ID }, testUser());
    expect(tx.localTimplan.findMany).not.toHaveBeenCalled();
    expect(answer.groups).toEqual([]);
  });
});

describe('describePlannedVerdict', () => {
  const codes: PlannedVerdictCode[] = [
    'TIMPLAN_YEAR_GRADE_UNATTACHED',
    'TIMPLAN_ATTACHED_DRAFT',
    'TIMPLAN_GROUP_UNPLANNED',
    'TIMPLAN_GROUP_UNDERPLANNED',
    'TIMPLAN_GROUP_OVERPLANNED',
    'TIMPLAN_PUPIL_UNDERPLANNED',
    'TIMPLAN_PUPIL_DOUBLE_PLANNED',
  ];
  const params = {
    gradeLevel: 7,
    gradeLevels: '7, 8',
    groupNames: '7A, 7B',
    groupCount: 2,
    planName: 'Grundskolan 2027',
    groupName: '7A',
    subjectName: 'Matematik',
    targetMinutesPerWeek: 180,
    plannedMinutesPerWeek: 120,
    deficitMinutesPerWeek: 60,
    surplusMinutesPerWeek: 60,
  };

  it.each(codes)('%s is a whole sentence, and never says "fel"', (code) => {
    const sentence = describePlannedVerdict({ code, severity: 'warning', params } as PlannedVerdict);
    expect(sentence.length).toBeGreaterThan(20);
    expect(sentence).not.toMatch(/\bfel\b/i);
    expect(sentence).not.toContain('undefined');
  });

  it('names förskoleklassen, the draft and the grade in plain words', () => {
    expect(
      describePlannedVerdict({
        code: 'TIMPLAN_YEAR_GRADE_UNATTACHED',
        severity: 'notice',
        params: { gradeLevel: 0, groupNames: 'F-A', groupCount: 1 },
      }),
    ).toContain('i förskoleklass (F-A)');
    expect(
      describePlannedVerdict({
        code: 'TIMPLAN_ATTACHED_DRAFT',
        severity: 'notice',
        params: { planName: 'Grundskolan 2027', gradeLevels: '9' },
      }),
    ).toBe('Årskurs 9 följer "Grundskolan 2027", som är ett utkast — inte beslutad. Jämförelsen gäller utkastet.');
  });
});
