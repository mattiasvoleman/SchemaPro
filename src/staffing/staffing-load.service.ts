import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import type { PrismaClient } from '@prisma/client';
import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';
import { Role } from '../auth/enums/role.enum';
import { PrismaService } from '../database/prisma.service';
import { requireSchoolId, requireUserId } from '../common/utils/request-context';
import { gradeSpanOf, loadRosters } from '../optimization/room-eligibility';
import {
  buildTeacherLoadReport,
  type LoadInput,
  type TeacherLoadReport,
  type UnstaffedRequirement,
} from './teacher-load';
import type { YearBounds } from './teaching-weeks';
import { suggestTeachers, type TeacherSuggestions } from './suggest-teachers';

/** The horizons the report can be asked for. Only the first exists in Fas 1. */
export const LOAD_HORIZONS = ['planned'] as const;
export type LoadHorizon = (typeof LOAD_HORIZONS)[number];

export interface TeacherLoadReportResponse extends TeacherLoadReport {
  academicYearId: string;
  horizon: LoadHorizon;
  year: YearBounds;
}

const asDay = (value: Date): string => value.toISOString().slice(0, 10);
const asDayOrNull = (value: Date | null): string | null => (value === null ? null : asDay(value));

/**
 * Reads the rows the report is computed from, in ONE RLS transaction, and hands
 * them to the arithmetic in teacher-load.ts.
 *
 * One transaction so the figures agree with each other: a requirement read
 * before an admin's PATCH and an employment read after it would make a row
 * whose minutes and target come from two different moments. The reads are
 * plain — nothing is written, so no lock is needed.
 *
 * A TEACHER gets their own row. RLS already hands them only their own
 * employment, and the requirements and qualifications they may read are the
 * school's, so the arithmetic runs on the whole school and the response is cut
 * down afterwards: a teacher's share of Ma is a fact about their own rows, but
 * the list of unstaffed requirements is the admin's to act on, and the
 * unqualified list is filtered to the one person it is about.
 */
@Injectable()
export class StaffingLoadService {
  constructor(private readonly prisma: PrismaService) {}

  async load(
    academicYearId: string,
    horizon: string | undefined,
    user: AuthenticatedUser,
  ): Promise<TeacherLoadReportResponse> {
    requireSchoolId(user);
    const chosen = horizon ?? 'planned';
    if (!(LOAD_HORIZONS as readonly string[]).includes(chosen)) {
      throw new BadRequestException(
        `Horisonten "${chosen}" finns inte ännu — just nu beräknas bara "planned" (tjänstefördelningen). Schemalagd och genomförd tid kommer i en senare fas.`,
      );
    }

    const { year, input } = await this.prisma.withRls(user, (tx) =>
      this.readInput(tx, academicYearId, user),
    );
    const report = buildTeacherLoadReport(input);

    const response: TeacherLoadReportResponse = {
      academicYearId,
      horizon: chosen as LoadHorizon,
      year,
      ...report,
    };
    if (user.role === Role.SCHOOL_ADMIN) return response;

    const own = requireUserId(user);
    return {
      ...response,
      teachers: report.teachers.filter((row) => row.userId === own),
      unstaffedRequirements: [],
      unqualifiedAssignments: report.unqualifiedAssignments.filter(
        (row) => row.userId === own,
      ),
      // Capacity per subject is a sum over colleagues' targets — and RLS has
      // handed this caller no colleague's post, so the figure would be wrong
      // as well as not theirs.
      subjectBottlenecks: [],
      bottlenecksComputed: false,
      totals: { teacherMinutesPerWeek: 0, lessonMinutesPerWeek: 0, dutyMinutesPerWeek: 0 },
    };
  }

  /** The year's requirements with no lead teacher, with their minutes and span. */
  async unstaffed(
    academicYearId: string,
    user: AuthenticatedUser,
  ): Promise<UnstaffedRequirement[]> {
    requireSchoolId(user);
    const { input } = await this.prisma.withRls(user, (tx) =>
      this.readInput(tx, academicYearId, user),
    );
    return buildTeacherLoadReport(input).unstaffedRequirements;
  }

  /**
   * Who should take one timplanspost, ranked (suggest-teachers.ts), from the
   * same rows the report reads and in the same single transaction — so the
   * "kvar N min/v" on a candidate is the figure the matrix shows for them,
   * minus this row.
   *
   * Candidates are the school's ACTIVE staff, TEACHER and SCHOOL_ADMIN alike:
   * a teaching rektor is assigned rows here, as the requirement's teacherId
   * already allows. The requirement is read first and answers 404 when RLS
   * hides it, as every other route names a foreign id.
   */
  async suggestTeachers(requirementId: string, user: AuthenticatedUser): Promise<TeacherSuggestions> {
    requireSchoolId(user);
    const { input, staffIds } = await this.prisma.withRls(user, async (tx) => {
      const requirement = await tx.teachingRequirement.findUnique({
        where: { id: requirementId },
        select: { academicYearId: true },
      });
      if (!requirement) {
        throw new NotFoundException('The requested record does not exist.');
      }
      const [{ input: yearInput }, staff] = await Promise.all([
        this.readInput(tx, requirement.academicYearId, user),
        tx.user.findMany({
          where: { role: { in: ['TEACHER', 'SCHOOL_ADMIN'] }, isActive: true },
          select: { id: true },
          orderBy: { id: 'asc' },
        }),
      ]);
      return { input: yearInput, staffIds: staff.map((row) => row.id) };
    });
    return suggestTeachers(input, requirementId, staffIds);
  }

  private async readInput(
    tx: PrismaClient,
    academicYearId: string,
    user: AuthenticatedUser,
  ): Promise<{ year: YearBounds; input: LoadInput }> {
    const schoolId = requireSchoolId(user);
    const yearRow = await tx.academicYear.findUnique({
      where: { id: academicYearId },
      select: { startDate: true, endDate: true },
    });
    if (!yearRow) {
      throw new NotFoundException('Academic year not found.');
    }
    const year: YearBounds = { startDate: asDay(yearRow.startDate), endDate: asDay(yearRow.endDate) };

    const [requirements, employments, policy, breaks, qualifications, duties] = await Promise.all([
      tx.teachingRequirement.findMany({
        where: { academicYearId },
        select: {
          id: true,
          subjectId: true,
          studentGroupId: true,
          teacherId: true,
          coTeacherId: true,
          lessonsPerWeek: true,
          minutesPerLesson: true,
          teacherLoadPercent: true,
          coTeacherLoadPercent: true,
          recurrence: true,
          startDate: true,
          endDate: true,
          subject: { select: { name: true } },
          studentGroup: { select: { name: true, gradeLevel: true } },
        },
      }),
      tx.teacherEmployment.findMany({ where: { academicYearId } }),
      tx.staffingPolicy.findUnique({ where: { schoolId } }),
      tx.schoolBreak.findMany({
        where: { academicYearId },
        select: { startDate: true, endDate: true, minGradeLevel: true, maxGradeLevel: true },
      }),
      tx.teacherSubjectQualification.findMany({
        select: {
          userId: true,
          subjectId: true,
          minGradeLevel: true,
          maxGradeLevel: true,
          kind: true,
          validFrom: true,
          validTo: true,
        },
      }),
      // The year's uppdrag. RLS hands a TEACHER only their own, which is all
      // their row needs.
      tx.teacherDuty.findMany({
        where: { academicYearId },
        select: { userId: true, minutesPerWeek: true, countsAsTeaching: true },
      }),
    ]);

    // The group's years as the optimisation proxy derives them: members' home
    // classes first, the group's own gradeLevel when no member carries one.
    const groups = new Map<string, { id: string; gradeLevel: number | null }>();
    for (const requirement of requirements) {
      groups.set(requirement.studentGroupId, {
        id: requirement.studentGroupId,
        gradeLevel: requirement.studentGroup.gradeLevel,
      });
    }
    const groupIds = [...groups.keys()];
    const rosters =
      groupIds.length > 0 ? await loadRosters(tx, groupIds, [...groups.values()]) : null;

    const input: LoadInput = {
      year,
      policy: policy
        ? {
            fullTimeTeachingMinutesPerWeek: policy.fullTimeTeachingMinutesPerWeek,
            overAllocationTolerancePercent: policy.overAllocationTolerancePercent,
            fullTimeRegulatedHoursPerYear: policy.fullTimeRegulatedHoursPerYear,
            workDaysPerYear: policy.workDaysPerYear,
            qualificationMode: policy.qualificationMode,
          }
        : null,
      employments: employments.map((row) => ({
        userId: row.userId,
        employmentPercent: Number(row.employmentPercent),
        reductionPercent: Number(row.reductionPercent),
        contractKind: row.contractKind,
        teachingTargetMinutesPerWeek: row.teachingTargetMinutesPerWeek,
        signature: row.signature,
      })),
      requirements: requirements.map((row) => ({
        id: row.id,
        subjectId: row.subjectId,
        subjectName: row.subject.name,
        studentGroupId: row.studentGroupId,
        groupName: row.studentGroup.name,
        teacherId: row.teacherId,
        coTeacherId: row.coTeacherId,
        lessonsPerWeek: row.lessonsPerWeek,
        minutesPerLesson: row.minutesPerLesson,
        teacherLoadPercent: row.teacherLoadPercent,
        coTeacherLoadPercent: row.coTeacherLoadPercent,
        recurrence: row.recurrence,
        startDate: asDayOrNull(row.startDate),
        endDate: asDayOrNull(row.endDate),
        gradeSpan: rosters ? gradeSpanOf(rosters, [row.studentGroupId]) : null,
      })),
      qualifications: qualifications.map((row) => ({
        userId: row.userId,
        subjectId: row.subjectId,
        minGradeLevel: row.minGradeLevel,
        maxGradeLevel: row.maxGradeLevel,
        kind: row.kind,
        validFrom: asDayOrNull(row.validFrom),
        validTo: asDayOrNull(row.validTo),
      })),
      closures: breaks.map((row) => ({
        startDate: asDay(row.startDate),
        endDate: asDay(row.endDate),
        minGradeLevel: row.minGradeLevel,
        maxGradeLevel: row.maxGradeLevel,
      })),
      duties: duties.map((row) => ({
        userId: row.userId,
        minutesPerWeek: row.minutesPerWeek,
        countsAsTeaching: row.countsAsTeaching,
      })),
    };
    return { year, input };
  }
}
