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
    // The year's flags ride on the same read, for the roster basis.
    expect(tx.academicYear.findUnique).toHaveBeenCalledWith({
      where: { id: YEAR_ID },
      select: { startDate: true, endDate: true, isActive: true, predecessorId: true },
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
    // handed. With no group list for the year (an empty mock), 8B is known
    // only through a requirement of its own — given here; the next test
    // gives it through the year's groups instead.
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

  it('reads a pupil’s home class from every group of the year, not only the ones with a requirement', async () => {
    // 7A's only pupil is a member whose home class is 8B, which has no
    // requirement of its own. The proxy hands loadRosters every group of the
    // year, so 8B's year counts and the span is 8; reading only the
    // requirement groups used to know no year for the pupil and fall back to
    // 7A's own 7 — and pass a 7-only behörighet for a class of åk 8 pupils.
    const GROUP_8B = '77777777-7777-4777-8777-777777777777';
    tx.teacherSubjectQualification.findMany.mockResolvedValue([
      { userId: ME, subjectId: MA, minGradeLevel: 7, maxGradeLevel: 7, kind: 'LEGITIMATION', validFrom: null, validTo: null },
    ]);
    tx.studentGroupMember.findMany.mockResolvedValue([{ studentId: 'pupil-1', studentGroupId: GROUP_7A }]);
    tx.user.findMany.mockImplementation((query: { where: Record<string, unknown> }) =>
      Promise.resolve('studentGroupId' in query.where ? [] : [{ id: 'pupil-1', studentGroupId: GROUP_8B }]),
    );
    tx.studentGroup.findMany.mockResolvedValue([
      { id: GROUP_7A, name: '7A', gradeLevel: 7 },
      { id: GROUP_8B, name: '8B', gradeLevel: 8 },
    ]);
    tx.teachingRequirement.findMany.mockResolvedValue([requirementRow()]);

    const report = await service.load(YEAR_ID, undefined, testUser());

    expect(tx.studentGroup.findMany).toHaveBeenCalledWith({
      where: { academicYearId: YEAR_ID },
      select: { id: true, gradeLevel: true, name: true },
    });
    expect(report.unqualifiedAssignments).toEqual([
      expect.objectContaining({ requirementId: 'req-1', gradeSpan: { min: 8, max: 8 } }),
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

  it('under MINUTES reads no factor at all and charges the minutes', async () => {
    const report = await service.load(YEAR_ID, 'planned', testUser());

    expect(tx.subject.findMany).not.toHaveBeenCalled();
    expect(report.loadModel).toBe('MINUTES');
    expect(report.teachers[0]!.assignedMinutesPerWeek).toBe(600);
  });

  it('under FACTOR reads every subject’s factor in one statement and charges minutes × factor, never the lesson minutes', async () => {
    tx.staffingPolicy.findUnique.mockResolvedValue({
      fullTimeTeachingMinutesPerWeek: 1080,
      overAllocationTolerancePercent: 10,
      fullTimeRegulatedHoursPerYear: 1360,
      fullTimeAnnualHours: 1767,
      workDaysPerYear: 194,
      semesterHoursPerWeek: new Prisma.Decimal('40.0'),
      qualificationMode: 'WARN',
      loadModel: 'FACTOR',
    });
    tx.subject.findMany.mockResolvedValue([{ id: MA, loadFactor: new Prisma.Decimal('0.700') }]);

    const report = await service.load(YEAR_ID, 'planned', testUser());

    expect(tx.subject.findMany).toHaveBeenCalledTimes(1);
    expect(tx.subject.findMany).toHaveBeenCalledWith({ select: { id: true, loadFactor: true } });
    expect(report.loadModel).toBe('FACTOR');
    // 10 × 60 × 0.7: the teacher; the unstaffed row's demand 2 × 60 × 0.7;
    // the pupils' lesson minutes stay 120.
    expect(report.teachers[0]!.assignedMinutesPerWeek).toBe(420);
    expect(report.teachers[0]!.assignments[0]).toMatchObject({ lessonMinutesPerWeek: 600, timeMinutesPerWeek: 600, minutesPerWeek: 420 });
    expect(report.unstaffedRequirements[0]).toMatchObject({ minutesPerWeek: 120, teacherMinutesPerWeek: 84 });
    expect(report.totals.lessonMinutesPerWeek).toBe(720);
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

  describe('suggestTeachers', () => {
    it('reads the row’s year in the same transaction and ranks the school’s active staff', async () => {
      tx.teachingRequirement.findUnique.mockResolvedValue({
        academicYearId: YEAR_ID,
        subjectId: MA,
        studentGroup: { predecessorId: null },
      });
      tx.user.findMany.mockResolvedValue([{ id: COLLEAGUE }, { id: ME }]);

      const answer = await service.suggestTeachers('req-2', testUser());

      expect(prisma.withRls).toHaveBeenCalledTimes(1);
      expect(tx.teachingRequirement.findUnique).toHaveBeenCalledWith({
        where: { id: 'req-2' },
        select: {
          academicYearId: true,
          subjectId: true,
          studentGroup: { select: { predecessorId: true } },
        },
      });
      // No predecessor: the year's one requirement read and nothing more, so
      // a school that never rolls makes today's statements.
      expect(tx.teachingRequirement.findMany).toHaveBeenCalledTimes(1);
      expect(answer.lastYear).toBeNull();
      expect(tx.user.findMany).toHaveBeenCalledWith({
        where: { role: { in: ['TEACHER', 'SCHOOL_ADMIN'] }, isActive: true },
        select: { id: true },
        orderBy: { id: 'asc' },
      });
      expect(answer).toMatchObject({ requirementId: 'req-2', teacherMinutesPerWeek: 120, qualificationsRecorded: false });
      // ME teaches Ma already (req-1), so the fallback tier puts them first;
      // 865 − 600 − 120 = 145 left. The colleague has no post: NO_TARGET.
      expect(answer.candidates).toEqual([
        expect.objectContaining({ userId: ME, teachesSubjectAlready: true, remainingMinutesPerWeek: 145, status: 'UNDER' }),
        expect.objectContaining({ userId: COLLEAGUE, remainingMinutesPerWeek: null, status: 'NO_TARGET' }),
      ]);
    });

    it('with a predecessor group, reads its rows of the subject once, after the year, and ranks on them', async () => {
      const PRED = '77777777-7777-4777-8777-777777777777';
      tx.teachingRequirement.findUnique.mockResolvedValue({
        academicYearId: YEAR_ID,
        subjectId: MA,
        studentGroup: { predecessorId: PRED },
      });
      tx.user.findMany.mockResolvedValue([{ id: COLLEAGUE }, { id: ME }]);
      const lastYearRows = [
        { teacherId: COLLEAGUE, coTeacherId: null, studentGroup: { name: '6A', academicYear: { name: '2025/26' } } },
        { teacherId: null, coTeacherId: COLLEAGUE, studentGroup: { name: '6A', academicYear: { name: '2025/26' } } },
      ];
      tx.teachingRequirement.findMany.mockImplementation(((args: { where: Record<string, unknown> }) =>
        Promise.resolve(
          args.where.studentGroupId === PRED
            ? lastYearRows
            : [requirementRow(), requirementRow({ id: 'req-2', teacherId: null, lessonsPerWeek: 2 })],
        )) as never);

      const answer = await service.suggestTeachers('req-2', testUser());

      expect(tx.teachingRequirement.findMany).toHaveBeenCalledTimes(2);
      expect(tx.teachingRequirement.findMany).toHaveBeenLastCalledWith({
        where: { studentGroupId: PRED, subjectId: MA },
        select: {
          teacherId: true,
          coTeacherId: true,
          studentGroup: { select: { name: true, academicYear: { select: { name: true } } } },
        },
        orderBy: { id: 'asc' },
      });
      expect(answer.lastYear).toEqual({ groupName: '6A', yearName: '2025/26' });
      // Both teach Ma in the fallback tier (ME this year, the colleague last
      // year); continuity is the next key.
      expect(answer.candidates.map((c) => [c.userId, c.taughtLastYear])).toEqual([
        [COLLEAGUE, true],
        [ME, false],
      ]);
    });

    it('404s a row RLS hides, before reading the year', async () => {
      tx.teachingRequirement.findUnique.mockResolvedValue(null);
      await expect(service.suggestTeachers('req-x', testUser())).rejects.toBeInstanceOf(NotFoundException);
      expect(tx.academicYear.findUnique).not.toHaveBeenCalled();
    });
  });
});
