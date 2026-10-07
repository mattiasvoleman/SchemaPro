import type { PrismaClient } from '@prisma/client';
import { gradeSpanOf, loadRosters } from '../optimization/room-eligibility';
import type { GradeSpan, LoadInput } from './teacher-load';
import type { YearBounds } from './teaching-weeks';

const asDay = (value: Date): string => value.toISOString().slice(0, 10);
const asDayOrNull = (value: Date | null): string | null => (value === null ? null : asDay(value));

/** The year's load input, and what a write needs to judge a row not yet in it. */
export interface LoadRead {
  year: YearBounds;
  input: LoadInput;
  /**
   * The years a set of groups (and named pupils) holds, derived as the
   * optimisation proxy derives it. Answers for the groups this read was asked
   * about: every group with a requirement, plus `alsoGroupIds`.
   */
  spanOf(groupIds: string[], studentIds?: string[]): GradeSpan | null;
  /** The school's name for a group of the year, or undefined. */
  groupName(groupId: string): string | undefined;
}

/**
 * Reads the rows the belastningsrapport is computed from — and the two staffing
 * checks ask their questions of — in the caller's transaction.
 *
 * ONE READER for the report (StaffingLoadService), suggest-teachers and every
 * write the checks guard (staffing-enforcement.ts), so "how much does Anna
 * carry" has one answer whether the matrix asks, the picker asks, or a PATCH
 * that would put her over asks. Null when RLS hides the year — the report turns
 * that into its 404, a write lets its own statement answer.
 *
 * GRADE SPANS OVER EVERY GROUP OF THE YEAR. The years a teaching group holds are
 * its members' home classes' years, and room-eligibility reads a home class's
 * year from the groups it is HANDED. The report used to hand it only the groups
 * that had a requirement, so a pupil whose home class had none counted for no
 * year at all and a 7–8 group read as 7–7. The proxy hands it every group of the
 * year; so does this, which is what "the same derivation the proxy uses" means.
 */
export async function readLoadInput(
  tx: PrismaClient,
  academicYearId: string,
  schoolId: string,
  options: { alsoGroupIds?: string[]; studentIds?: string[] } = {},
): Promise<LoadRead | null> {
  const yearRow = await tx.academicYear.findUnique({
    where: { id: academicYearId },
    select: { startDate: true, endDate: true },
  });
  if (!yearRow) return null;
  const year: YearBounds = { startDate: asDay(yearRow.startDate), endDate: asDay(yearRow.endDate) };

  // One statement after another, not Promise.all: a transaction is one
  // connection, pg queues concurrent queries on it anyway (and deprecates
  // doing so), so the "parallel" form bought nothing and made the order of
  // statements in the transaction an accident.
  const requirements = await tx.teachingRequirement.findMany({
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
  });
  const employments = await tx.teacherEmployment.findMany({ where: { academicYearId } });
  const policy = await tx.staffingPolicy.findUnique({ where: { schoolId } });
  const breaks = await tx.schoolBreak.findMany({
    where: { academicYearId },
    select: { startDate: true, endDate: true, minGradeLevel: true, maxGradeLevel: true },
  });
  const qualifications = await tx.teacherSubjectQualification.findMany({
    select: {
      userId: true,
      subjectId: true,
      minGradeLevel: true,
      maxGradeLevel: true,
      kind: true,
      validFrom: true,
      validTo: true,
    },
  });
  // Holders who are deactivated: kept out of bottleneck capacity, as the
  // picker keeps them out of its candidates. A read that RLS narrows only
  // narrows what is excluded, never what is counted.
  const holderIds = [...new Set(qualifications.map((row) => row.userId))];
  const inactive =
    holderIds.length > 0
      ? await tx.user.findMany({
          where: { id: { in: holderIds }, isActive: false },
          select: { id: true },
        })
      : [];
  // The year's uppdrag. RLS hands a TEACHER only their own, which is all
  // their row needs.
  const duties = await tx.teacherDuty.findMany({
    where: { academicYearId },
    select: { userId: true, minutesPerWeek: true, countsAsTeaching: true },
  });
  const yearGroups = await tx.studentGroup.findMany({
    where: { academicYearId },
    select: { id: true, gradeLevel: true, name: true },
  });

  // Every group the year has, plus a requirement's group the year list did not
  // carry (a row pointing across years is the database's business, not this
  // read's to drop).
  const groups = new Map<string, { id: string; gradeLevel: number | null; name: string }>();
  for (const group of yearGroups ?? []) groups.set(group.id, group);
  for (const requirement of requirements) {
    if (!groups.has(requirement.studentGroupId)) {
      groups.set(requirement.studentGroupId, {
        id: requirement.studentGroupId,
        gradeLevel: requirement.studentGroup.gradeLevel,
        name: requirement.studentGroup.name,
      });
    }
  }
  const asked = [
    ...new Set([
      ...requirements.map((requirement) => requirement.studentGroupId),
      ...(options.alsoGroupIds ?? []),
    ]),
  ];
  const rosters =
    asked.length > 0
      ? await loadRosters(tx, asked, [...groups.values()], options.studentIds ?? [])
      : null;
  const spanOf = (groupIds: string[], studentIds: string[] = []): GradeSpan | null =>
    rosters ? gradeSpanOf(rosters, groupIds, studentIds) : null;

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
      gradeSpan: spanOf([row.studentGroupId]),
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
    inactiveUserIds: (inactive ?? []).map((row) => row.id),
  };
  return {
    year,
    input,
    spanOf,
    groupName: (groupId) => groups.get(groupId)?.name,
  };
}

export { asDay, asDayOrNull };
