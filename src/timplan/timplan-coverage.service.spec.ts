import { BadRequestException, NotFoundException } from '@nestjs/common';
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
import type { ScheduledVerdict, ScheduledVerdictCode } from '../common/timplan-scheduled';
import { describeScheduledVerdict } from './timplan-scheduled-messages';

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

  describe('a past year with class history (timplan P4)', () => {
    const day = (value: string) => new Date(`${value}T00:00:00.000Z`);
    const past = () => {
      givenTheYear();
      tx.academicYear.findUnique.mockResolvedValue({
        startDate: new Date('2026-08-17T00:00:00.000Z'),
        endDate: new Date('2027-06-11T00:00:00.000Z'),
        isActive: false,
        predecessorId: null,
      });
      tx.academicYear.findFirst.mockResolvedValue({ startDate: new Date('2027-08-16T00:00:00.000Z') });
    };

    it('reads that year’s rosters from the history: the last segment is the home, a pupil deactivated since still counts', async () => {
      past();
      // Bo moved 8A → nowhere (a class since deleted); Cleo, deactivated
      // since, sat in 8A all year. Anna is in 8A.
      tx.studentEnrollment.findMany.mockResolvedValue([
        { studentId: ANNA, studentGroupId: CLASS_ID, validFrom: day('2026-08-17'), validTo: day('2027-06-12') },
        { studentId: BO, studentGroupId: CLASS_ID, validFrom: day('2026-08-17'), validTo: day('2026-11-02') },
        { studentId: BO, studentGroupId: null, validFrom: day('2026-11-02'), validTo: day('2027-06-12') },
        { studentId: VISITOR, studentGroupId: CLASS_ID, validFrom: day('2026-08-17'), validTo: day('2027-06-12') },
      ]);

      const answer = await service.planned({ academicYearId: YEAR_ID }, testUser());

      expect(tx.studentEnrollment.findMany).toHaveBeenCalledWith({
        where: { academicYearId: YEAR_ID },
        select: { studentId: true, studentGroupId: true, validFrom: true, validTo: true },
        orderBy: [{ studentId: 'asc' }, { validFrom: 'asc' }],
      });
      // Not today's rows: no home read by class, and memberships of exactly these pupils, active or not.
      expect(tx.user.findMany).not.toHaveBeenCalled();
      expect(tx.studentGroupMember.findMany).toHaveBeenCalledWith({
        where: { studentGroupId: { in: [GROUP_ID] }, studentId: { in: [ANNA, BO, VISITOR] } },
        select: { studentId: true, studentGroupId: true },
      });
      expect(answer).toMatchObject({ pupilCount: 2, pupilsOutsideClasses: 1 });
    });

    it('counts no straggler: a segment from the ended year’s end + 1 holds no day of it, and its pupil sat there never', async () => {
      past();
      // Placed in the ended year's 8A in the summer, before the activation
      // moved them on: the trigger opened the segment at endDate + 1
      // (2027-06-12) and the activation closed it. The stage view clips it
      // away (clipToYear); the planned and delivered layers must agree.
      tx.studentEnrollment.findMany.mockResolvedValue([
        { studentId: ANNA, studentGroupId: CLASS_ID, validFrom: day('2026-08-17'), validTo: day('2027-06-12') },
        { studentId: BO, studentGroupId: CLASS_ID, validFrom: day('2026-08-17'), validTo: day('2027-06-12') },
        { studentId: VISITOR, studentGroupId: CLASS_ID, validFrom: day('2027-06-12'), validTo: day('2027-08-16') },
      ]);
      const answer = await service.planned({ academicYearId: YEAR_ID }, testUser());
      expect(tx.studentGroupMember.findMany).toHaveBeenCalledWith({
        where: { studentGroupId: { in: [GROUP_ID] }, studentId: { in: [ANNA, BO] } },
        select: { studentId: true, studentGroupId: true },
      });
      expect(answer).toMatchObject({ pupilCount: 2 });
    });

    it('keeps today’s rosters for a past year the history says nothing about, and for the active year asks nothing more', async () => {
      past();
      await service.planned({ academicYearId: YEAR_ID }, testUser());
      expect(tx.user.findMany).toHaveBeenCalled();

      tx = createTxMock();
      prisma = createPrismaMock(tx);
      service = new TimplanCoverageService(prisma as unknown as PrismaService);
      givenTheYear();
      tx.academicYear.findUnique.mockResolvedValue({
        startDate: new Date('2026-08-17T00:00:00.000Z'),
        endDate: new Date('2027-06-11T00:00:00.000Z'),
        isActive: true,
        predecessorId: null,
      });
      await service.planned({ academicYearId: YEAR_ID }, testUser());
      expect(tx.academicYear.findFirst).not.toHaveBeenCalled();
      expect(tx.studentEnrollment.findMany).not.toHaveBeenCalled();
    });

    it('reads a later year (a rolled one) never from the history', async () => {
      past();
      tx.academicYear.findFirst.mockResolvedValue({ startDate: new Date('2025-08-18T00:00:00.000Z') });
      await service.planned({ academicYearId: YEAR_ID }, testUser());
      expect(tx.studentEnrollment.findMany).not.toHaveBeenCalled();
    });
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

describe('TimplanCoverageService, layer 2 (schemalagt mot planerat)', () => {
  let service: TimplanCoverageService;
  let tx: TxMock;

  const t = (hhmm: string) => new Date(`1970-01-01T${hhmm}:00.000Z`);
  const lessonRow = (id: string, startTime: string, endTime: string, extra: Record<string, unknown> = {}) => ({
    id,
    studentGroupId: CLASS_ID,
    subjectId: MA,
    startTime: t(startTime),
    endTime: t(endTime),
    recurrence: 'ALL_WEEKS',
    startDate: null,
    endDate: null,
    isParked: false,
    extraGroups: [],
    participants: [],
    ...extra,
  });

  beforeEach(() => {
    tx = createTxMock();
    service = new TimplanCoverageService(createPrismaMock(tx) as unknown as PrismaService);
    tx.academicYear.findUnique.mockResolvedValue({
      startDate: new Date('2026-08-17T00:00:00.000Z'),
      endDate: new Date('2027-06-11T00:00:00.000Z'),
    });
    tx.subject.findMany.mockResolvedValue([{ id: MA, name: 'Matematik', nationalCode: 'MA', countsTowardTimplan: true }]);
    tx.studentGroup.findMany.mockResolvedValue([{ id: CLASS_ID, name: '8A', kind: 'CLASS', gradeLevel: 8 }]);
    tx.teachingRequirement.findMany.mockResolvedValue([
      {
        id: 'f1f1f1f1-f1f1-4f1f-8f1f-f1f1f1f1f1f1',
        studentGroupId: CLASS_ID,
        subjectId: MA,
        lessonsPerWeek: 3,
        minutesPerLesson: 60,
        lessonLengths: [],
        recurrence: 'ALL_WEEKS',
        startDate: null,
        endDate: null,
      },
    ]);
    tx.user.findMany.mockResolvedValue([{ id: ANNA, studentGroupId: CLASS_ID }]);
    tx.masterLesson.findMany.mockResolvedValue([
      lessonRow('a0a0a0a0-a0a0-4a0a-8a0a-a0a0a0a0a0a1', '08:00', '09:00'),
      lessonRow('a0a0a0a0-a0a0-4a0a-8a0a-a0a0a0a0a0a2', '10:00', '10:55'),
      lessonRow('a0a0a0a0-a0a0-4a0a-8a0a-a0a0a0a0a0a3', '13:00', '14:00', { isParked: true }),
    ]);
  });

  it('reads the year’s master lessons, parked ones too, and judges each at its own duration', async () => {
    const answer = await service.scheduled({ academicYearId: YEAR_ID, layer: 'scheduled' }, testUser());
    expect(tx.masterLesson.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { academicYearId: YEAR_ID },
        select: expect.objectContaining({
          isParked: true,
          extraGroups: { select: { studentGroupId: true } },
          participants: { select: { studentId: true } },
        }),
      }),
    );
    expect(answer).toMatchObject({ academicYearId: YEAR_ID, layer: 'scheduled', pupilLevel: true, lessonCount: 2 });
    expect(answer.groups[0]!.lines[0]).toMatchObject({
      plannedMinutesPerWeek: 180,
      scheduledMinutesPerWeek: 115,
      parkedMinutesPerWeek: 60,
      status: 'SHORT',
      pupils: { min: -65, median: -65, max: -65, below: 1 },
    });
    // 115 + 60 parked ≥ 180 is false: a real shortfall, with its sentence.
    expect(answer.verdicts).toEqual([
      expect.objectContaining({
        code: 'TIMPLAN_SCHEDULE_SHORT',
        message: '8A: Matematik har 115 min/vecka i grundschemat, 65 under planerade 180 min/vecka.',
      }),
    ]);
  });

  it('gives a teacher the group level, drill-down or not, with no pupil id anywhere', async () => {
    const answer = await service.scheduled(
      { academicYearId: YEAR_ID, layer: 'scheduled', studentGroupId: CLASS_ID },
      testUser({ role: Role.TEACHER }),
    );
    expect(answer).toMatchObject({ pupilLevel: false, pupils: null, pupilsBelowPlanned: null });
    expect(JSON.stringify(answer)).not.toContain(ANNA);
  });

  it('gives an admin every pupil of the drilled group', async () => {
    const answer = await service.scheduled(
      { academicYearId: YEAR_ID, layer: 'scheduled', studentGroupId: CLASS_ID },
      testUser(),
    );
    expect(answer.pupils).toEqual([
      expect.objectContaining({ pupilId: ANNA, lines: [expect.objectContaining({ scheduledMinutesPerWeek: 115 })] }),
    ]);
  });

  it('refuses a drill-down on layer 1, whose answer keeps its one shape', async () => {
    await expect(
      service.planned({ academicYearId: YEAR_ID, studentGroupId: CLASS_ID }, testUser()),
    ).rejects.toThrow(BadRequestException);
  });

  it('404s a year RLS hides, and reads no lesson', async () => {
    tx.academicYear.findUnique.mockResolvedValue(null);
    await expect(service.scheduled({ academicYearId: YEAR_ID, layer: 'scheduled' }, testUser())).rejects.toThrow(
      NotFoundException,
    );
    expect(tx.masterLesson.findMany).not.toHaveBeenCalled();
  });
});

describe('describeScheduledVerdict', () => {
  const codes: ScheduledVerdictCode[] = [
    'TIMPLAN_SCHEDULE_NONE',
    'TIMPLAN_SCHEDULE_UNSCHEDULED',
    'TIMPLAN_SCHEDULE_SHORT',
    'TIMPLAN_SCHEDULE_PARKED',
    'TIMPLAN_SCHEDULE_EXTRA',
    'TIMPLAN_SCHEDULE_UNPLANNED',
    'TIMPLAN_PUPIL_SCHEDULE_SHORT',
  ];
  const params = {
    groupName: '7A',
    subjectName: 'Matematik',
    plannedMinutesPerWeek: 180,
    scheduledMinutesPerWeek: 120,
    deltaMinutesPerWeek: -60,
    parkedMinutesPerWeek: 60,
    deficitMinutesPerWeek: 60,
    groupDeficitMinutesPerWeek: 0,
  };
  it.each(codes)('%s is a whole sentence, never says "fel" and names no pupil', (code) => {
    const sentence = describeScheduledVerdict({ code, severity: 'warning', params } as ScheduledVerdict);
    expect(sentence.length).toBeGreaterThan(20);
    expect(sentence).not.toMatch(/\bfel\b/i);
    expect(sentence).not.toContain('undefined');
    expect(sentence).not.toContain('NaN');
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
