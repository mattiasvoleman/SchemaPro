import { BadRequestException, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  createPrismaMock,
  createTxMock,
  testUser,
  type PrismaMock,
  type TxMock,
} from '../../test/utils/prisma-mock';
import type { PrismaService } from '../database/prisma.service';
import { Role } from '../auth/enums/role.enum';
import { StaffingLoadService } from './staffing-load.service';

const SCHOOL_ID = '33333333-3333-4333-8333-333333333333';
const ME = '22222222-2222-4222-8222-222222222222';
const COLLEAGUE = '44444444-4444-4444-8444-444444444444';
const YEAR_ID = '99999999-9999-4999-8999-999999999999';
const GROUP_7A = '66666666-6666-4666-8666-666666666666';
const MA = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

describe('StaffingLoadService', () => {
  let service: StaffingLoadService;
  let tx: TxMock;
  let prisma: PrismaMock;

  const requirementRow = (overrides: Record<string, unknown> = {}) => ({
    id: 'req-1',
    subjectId: MA,
    studentGroupId: GROUP_7A,
    teacherId: ME,
    coTeacherId: null,
    lessonsPerWeek: 10,
    minutesPerLesson: 60,
    teacherLoadPercent: 100,
    coTeacherLoadPercent: 100,
    recurrence: 'ALL_WEEKS',
    startDate: null,
    endDate: null,
    subject: { name: 'Matematik' },
    studentGroup: { name: '7A', gradeLevel: 7 },
    ...overrides,
  });

  beforeEach(() => {
    tx = createTxMock();
    prisma = createPrismaMock(tx);
    service = new StaffingLoadService(prisma as unknown as PrismaService);
    tx.academicYear.findUnique.mockResolvedValue({
      startDate: new Date('2026-08-17T00:00:00.000Z'),
      endDate: new Date('2027-06-11T00:00:00.000Z'),
    });
    tx.staffingPolicy.findUnique.mockResolvedValue({
      fullTimeTeachingMinutesPerWeek: 1080,
      overAllocationTolerancePercent: 10,
      fullTimeRegulatedHoursPerYear: 1360,
      workDaysPerYear: 194,
      qualificationMode: 'WARN',
    });
    tx.teacherEmployment.findMany.mockResolvedValue([
      {
        userId: ME,
        employmentPercent: new Prisma.Decimal('80.000'),
        reductionPercent: new Prisma.Decimal('0.000'),
        contractKind: 'FERIE',
        teachingTargetMinutesPerWeek: null,
        signature: 'ME',
      },
    ]);
    tx.teachingRequirement.findMany.mockResolvedValue([
      requirementRow(),
      requirementRow({ id: 'req-2', teacherId: null, lessonsPerWeek: 2 }),
    ]);
  });

  it('reads every table in one RLS transaction and computes the report on it', async () => {
    const user = testUser();

    const report = await service.load(YEAR_ID, 'planned', user);

    expect(prisma.withRls).toHaveBeenCalledTimes(1);
    expect(prisma.withRls).toHaveBeenCalledWith(user, expect.any(Function));
    expect(tx.academicYear.findUnique).toHaveBeenCalledWith({
      where: { id: YEAR_ID },
      select: { startDate: true, endDate: true },
    });
    expect(tx.staffingPolicy.findUnique).toHaveBeenCalledWith({ where: { schoolId: SCHOOL_ID } });
    expect(tx.teacherEmployment.findMany).toHaveBeenCalledWith({ where: { academicYearId: YEAR_ID } });
    expect(report).toMatchObject({
      academicYearId: YEAR_ID,
      horizon: 'planned',
      year: { startDate: '2026-08-17', endDate: '2027-06-11' },
      qualificationsRecorded: false,
    });
    expect(report.teachers).toEqual([
      expect.objectContaining({
        userId: ME,
        employment: expect.objectContaining({ employmentPercent: 80, reductionPercent: 0 }),
        targetMinutesPerWeek: 865,
        assignedMinutesPerWeek: 600,
        status: 'UNDER',
      }),
    ]);
    expect(report.unstaffedRequirements).toEqual([
      expect.objectContaining({ requirementId: 'req-2', groupName: '7A', minutesPerWeek: 120 }),
    ]);
  });

  it('derives the group’s grade span the way the proxy does: members’ home classes, else the group’s own grade', async () => {
    tx.teacherSubjectQualification.findMany.mockResolvedValue([
      {
        userId: ME,
        subjectId: MA,
        minGradeLevel: 7,
        maxGradeLevel: 7,
        kind: 'LEGITIMATION',
        validFrom: null,
        validTo: null,
      },
    ]);
    // No members at all: the group's own gradeLevel (7) stands in, and the
    // 7-7 qualification covers it.
    const withoutMembers = await service.load(YEAR_ID, undefined, testUser());
    expect(withoutMembers.unqualifiedAssignments).toEqual([]);
    expect(withoutMembers.unstaffedRequirements[0]!.gradeSpan).toEqual({ min: 7, max: 7 });

    // A member whose home class is åk 8 widens the span to 7-8, which the
    // qualification no longer covers.
    const GROUP_8B = '77777777-7777-4777-8777-777777777777';
    tx.studentGroupMember.findMany.mockResolvedValue([
      { studentId: 'pupil-1', studentGroupId: GROUP_7A },
    ]);
    tx.user.findMany.mockImplementation((query: { where: Record<string, unknown> }) =>
      Promise.resolve(
        'studentGroupId' in query.where
          ? [{ id: 'pupil-2', studentGroupId: GROUP_7A }]
          : [
              { id: 'pupil-1', studentGroupId: GROUP_8B },
              { id: 'pupil-2', studentGroupId: GROUP_7A },
            ],
      ),
    );
    tx.studentGroup.findMany.mockResolvedValue([]);
    // The proxy's roster helper reads the groups' grades from the list it is
    // handed; 8B is not among the requirement groups, so its grade is unknown
    // and only 7A's pupils count — still 7-7. Give 8B's grade through a
    // requirement of its own instead.
    tx.teachingRequirement.findMany.mockResolvedValue([
      requirementRow(),
      requirementRow({
        id: 'req-3',
        studentGroupId: GROUP_8B,
        teacherId: null,
        studentGroup: { name: '8B', gradeLevel: 8 },
      }),
    ]);
    const withMembers = await service.load(YEAR_ID, undefined, testUser());
    expect(withMembers.unqualifiedAssignments).toEqual([
      expect.objectContaining({ requirementId: 'req-1', userId: ME, gradeSpan: { min: 7, max: 8 } }),
    ]);
  });

  it('cuts a teacher’s answer down to their own row and hides the admin’s lists', async () => {
    tx.teachingRequirement.findMany.mockResolvedValue([
      requirementRow(),
      requirementRow({ id: 'req-2', teacherId: COLLEAGUE }),
      requirementRow({ id: 'req-3', teacherId: null }),
    ]);
    tx.teacherSubjectQualification.findMany.mockResolvedValue([
      {
        userId: 'somebody',
        subjectId: MA,
        minGradeLevel: 1,
        maxGradeLevel: 9,
        kind: 'BEHORIG',
        validFrom: null,
        validTo: null,
      },
    ]);

    const report = await service.load(YEAR_ID, 'planned', testUser({ role: Role.TEACHER }));

    expect(report.teachers.map((row) => row.userId)).toEqual([ME]);
    expect(report.unstaffedRequirements).toEqual([]);
    expect(report.unqualifiedAssignments).toEqual([
      expect.objectContaining({ userId: ME, requirementId: 'req-1' }),
    ]);
    expect(report.totals).toEqual({
      teacherMinutesPerWeek: 0,
      lessonMinutesPerWeek: 0,
      dutyMinutesPerWeek: 0,
    });
    // Capacity is a sum over colleagues' posts, which RLS never handed them.
    expect(report.subjectBottlenecks).toEqual([]);
    expect(report.bottlenecksComputed).toBe(false);
  });

  it('reads the year’s uppdrag and the rows’ percentages into the report', async () => {
    tx.teachingRequirement.findMany.mockResolvedValue([
      requirementRow({ coTeacherId: COLLEAGUE, coTeacherLoadPercent: 50 }),
    ]);
    tx.teacherDuty.findMany.mockResolvedValue([
      { userId: ME, minutesPerWeek: 120, countsAsTeaching: true },
      { userId: ME, minutesPerWeek: 60, countsAsTeaching: false },
    ]);

    const report = await service.load(YEAR_ID, 'planned', testUser());

    expect(tx.teacherDuty.findMany).toHaveBeenCalledWith({
      where: { academicYearId: YEAR_ID },
      select: { userId: true, minutesPerWeek: true, countsAsTeaching: true },
    });
    expect(report.teachers.find((row) => row.userId === ME)).toMatchObject({
      assignedMinutesPerWeek: 600,
      dutyMinutesPerWeek: 180,
      countedMinutesPerWeek: 720,
    });
    expect(report.teachers.find((row) => row.userId === COLLEAGUE)).toMatchObject({
      assignedMinutesPerWeek: 300,
    });
    expect(report.totals).toEqual({
      teacherMinutesPerWeek: 900,
      lessonMinutesPerWeek: 600,
      dutyMinutesPerWeek: 180,
    });
  });

  it('refuses a horizon that does not exist yet, before reading anything', async () => {
    await expect(service.load(YEAR_ID, 'scheduled', testUser())).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(prisma.withRls).not.toHaveBeenCalled();
  });

  it('404s a year RLS hides', async () => {
    tx.academicYear.findUnique.mockResolvedValue(null);
    await expect(service.load(YEAR_ID, 'planned', testUser())).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('reads a school with no policy row as the defaults', async () => {
    tx.staffingPolicy.findUnique.mockResolvedValue(null);
    const report = await service.load(YEAR_ID, 'planned', testUser());
    expect(report.teachers[0]).toMatchObject({ status: 'NO_TARGET', targetMinutesPerWeek: null });
  });

  it('answers the unstaffed list on its own', async () => {
    const rows = await service.unstaffed(YEAR_ID, testUser());
    expect(rows).toEqual([expect.objectContaining({ requirementId: 'req-2', subjectName: 'Matematik' })]);
  });
});
