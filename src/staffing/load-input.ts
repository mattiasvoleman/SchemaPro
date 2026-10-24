import type { PrismaClient, TeacherEmploymentForm } from '@prisma/client';
import { gradeSpanOf, loadRosters } from '../optimization/room-eligibility';
import { rostersOfYear, type RosterViewer } from '../year-rollover/projected-rosters';
import { loadWeightOf, type GradeSpan, type JudgedYear, type LoadInput, type LoadModel } from './teacher-load';
import type { LoadPeriod } from './employment-periods';
import type { YearBounds } from './teaching-weeks';
import { supervisionOfTeachers, withSupervision, type LoadShift, type TeacherSupervision } from '../supervision/supervision-load';

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
  /** The policy's load model; MINUTES without a policy row. */
  loadModel: LoadModel;
  /**
   * loadWeightOf(loadModel, the subject's loadFactor) for ANY subject of the
   * school — a PATCH moving a row to another subject, a lesson whose subject
   * has no requirement — so every charge is weighed by one function. 1 under
   * MINUTES, where no factor is read at all.
   */
  weightOf(subjectId: string): number;
  /**
   * What SCB asks of a post besides its figures (migration 20261111090000),
   * by teacher, from the statement that read the figures: the SCB file
   * (src/staffing/scb) states the anställningsform and the karriärtjänst of
   * the same row version its omfattning comes from. Undefined without a post.
   */
  scbPostOf(userId: string): ScbPostFields | undefined;
  /**
   * Each teacher's rastvakt in the year's rastvaktsschema (Rastvaktsschema,
   * supervision-load.ts), for the teachers with a pass the reader may read;
   * null when they may read none. The passes are already in input.duties.
   */
  supervision: TeacherSupervision[] | null;
}

export interface ScbPostFields {
  employmentForm: TeacherEmploymentForm | null;
  firstTeacherPercent: number | null;
  lecturerPercent: number | null;
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
 * `viewer` is whoever asks, for the year's roster basis (projected-rosters.ts):
 * staff only, as every route reaching this is.
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
  viewer: RosterViewer,
  academicYearId: string,
  schoolId: string,
  options: { alsoGroupIds?: string[]; studentIds?: string[] } = {},
): Promise<LoadRead | null> {
  const yearRow = await tx.academicYear.findUnique({
    where: { id: academicYearId },
    select: {
      startDate: true,
      endDate: true,
      isActive: true,
      predecessorId: true,
      gradeNumbering: true,
      // The rastvaktsschema's passes the reader may read, counted in this
      // statement: a year without one asks nothing more (below).
      _count: { select: { supervisionShifts: true } },
    },
  });
  if (!yearRow) return null;
  // The spans stay in the year's numbering (a lov is the year's own); a
  // behörighet reads them in NIOARIG through the year's numbering
  // (qualificationCovers), carried only when tioårig.
  const year: JudgedYear = {
    startDate: asDay(yearRow.startDate),
    endDate: asDay(yearRow.endDate),
    ...(yearRow.gradeNumbering === 'TIOARIG' ? { gradeNumbering: 'TIOARIG' as const } : {}),
  };

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
      lessonLengths: true,
      teacherLoadPercent: true,
      coTeacherLoadPercent: true,
      recurrence: true,
      startDate: true,
      endDate: true,
      subject: { select: { name: true } },
      studentGroup: { select: { name: true, gradeLevel: true } },
      // Delade lektioner (20261205090000): the lessons other teachers take.
      shares: {
        select: { teacherId: true, lessons: true, minutes: true },
        orderBy: [{ minutes: 'desc' }, { teacherId: 'asc' }],
      },
    },
  });
  const posts = await tx.teacherEmployment.findMany({ where: { academicYearId } });
  // The posts' periods (migration 20261022120000), under the same arms as the
  // posts: a TEACHER gets their own post's and nobody else's. Asked only of a
  // year that has posts, so a school without any sends what it always did.
  const periodRows =
    posts.length > 0
      ? await tx.teacherEmploymentPeriod.findMany({
          where: { academicYearId },
          orderBy: [{ employmentId: 'asc' }, { validFrom: 'asc' }],
        })
      : [];
  const scbPosts = new Map<string, ScbPostFields>(
    posts.map((post) => [
      post.userId,
      {
        employmentForm: post.employmentForm,
        firstTeacherPercent: post.firstTeacherPercent,
        lecturerPercent: post.lecturerPercent,
      },
    ]),
  );
  const employments = posts.map((post) => ({
    ...post,
    periods: (periodRows ?? []).filter((period) => period.employmentId === post.id),
  }));
  const policy = await tx.staffingPolicy.findUnique({ where: { schoolId } });
  // The Faktor model's weights, read only when the school counts by factor: a
  // MINUTES school (every school until it says otherwise) sends exactly the
  // statements it always did, and every weight is 1 without asking.
  const loadModel: LoadModel = policy?.loadModel ?? 'MINUTES';
  const factorBySubject =
    loadModel === 'FACTOR'
      ? new Map(
          (
            await tx.subject.findMany({ select: { id: true, loadFactor: true } })
          ).map((row) => [row.id, Number(row.loadFactor)]),
        )
      : null;
  const weightOf = (subjectId: string): number =>
    loadWeightOf(loadModel, factorBySubject?.get(subjectId));
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
    select: { userId: true, kind: true, minutesPerWeek: true, countsAsTeaching: true, validFrom: true, validTo: true },
  });
  // The year's rastvaktspass (20261202090000), with whether their area counts
  // as teaching: one statement, and only when the year has a pass the reader
  // may read — a TEACHER their own, as for the uppdrag.
  const shiftRows =
    (yearRow._count?.supervisionShifts ?? 0) > 0
      ? await tx.$queryRaw<{ userId: string; startTime: Date; endTime: Date; validFrom: Date | null; validTo: Date | null; countsAsTeaching: boolean }[]>`
          SELECT s."userId", s."startTime", s."endTime", s."validFrom", s."validTo", a."countsAsTeaching"
          FROM "SupervisionShifts" s
          JOIN "SupervisionAreas" a ON a."id" = s."areaId" AND a."schoolId" = s."schoolId"
          WHERE s."academicYearId" = ${academicYearId}::uuid
          ORDER BY s."id"
        `
      : [];
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
  // A rolled year not yet activated spans the grades its activation would
  // place (projected-rosters.ts); the flags come from the year row above, so
  // the active year's report costs nothing more.
  const rosters =
    asked.length > 0
      ? await loadRosters(
          tx,
          await rostersOfYear(tx, viewer, academicYearId, yearRow),
          asked,
          [...groups.values()],
          options.studentIds ?? [],
        )
      : null;
  const spanOf = (groupIds: string[], studentIds: string[] = []): GradeSpan | null =>
    rosters ? gradeSpanOf(rosters, groupIds, studentIds) : null;

  const kindedDuties = duties.map((row) => ({
    userId: row.userId,
    kind: row.kind,
    minutesPerWeek: row.minutesPerWeek,
    countsAsTeaching: row.countsAsTeaching,
    // Only when dated: an undated duty's input is the object it always was.
    ...(row.validFrom ? { validFrom: asDay(row.validFrom) } : {}),
    ...(row.validTo ? { validTo: asDay(row.validTo) } : {}),
  }));
  const shifts: LoadShift[] = shiftRows.map((row) => ({
    userId: row.userId,
    start: row.startTime.getUTCHours() * 60 + row.startTime.getUTCMinutes(),
    end: row.endTime.getUTCHours() * 60 + row.endTime.getUTCMinutes(),
    validFrom: asDayOrNull(row.validFrom),
    validTo: asDayOrNull(row.validTo),
    countsAsTeaching: row.countsAsTeaching,
  }));
  const closures = breaks.map((row) => ({
    startDate: asDay(row.startDate),
    endDate: asDay(row.endDate),
    minGradeLevel: row.minGradeLevel,
    maxGradeLevel: row.maxGradeLevel,
  }));

  const input: LoadInput = {
    year,
    policy: policy
      ? {
          fullTimeTeachingMinutesPerWeek: policy.fullTimeTeachingMinutesPerWeek,
          overAllocationTolerancePercent: policy.overAllocationTolerancePercent,
          fullTimeRegulatedHoursPerYear: policy.fullTimeRegulatedHoursPerYear,
          workDaysPerYear: policy.workDaysPerYear,
          qualificationMode: policy.qualificationMode,
          fullTimeAnnualHours: policy.fullTimeAnnualHours ?? undefined,
          semesterHoursPerWeek:
            policy.semesterHoursPerWeek == null ? undefined : Number(policy.semesterHoursPerWeek),
          loadModel: policy.loadModel ?? undefined,
        }
      : null,
    employments: employments.map((row) => ({
      userId: row.userId,
      employmentPercent: Number(row.employmentPercent),
      reductionPercent: Number(row.reductionPercent),
      contractKind: row.contractKind,
      teachingTargetMinutesPerWeek: row.teachingTargetMinutesPerWeek,
      signature: row.signature,
      // Only when there are any: a post that does not change is the object it always was.
      ...((row.periods ?? []).length > 0 ? { periods: (row.periods ?? []).map(toLoadPeriod) } : {}),
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
      lessonLengths: row.lessonLengths,
      teacherLoadPercent: row.teacherLoadPercent,
      coTeacherLoadPercent: row.coTeacherLoadPercent,
      // Only when there are any: a row nobody shares is the object it always was.
      ...((row.shares ?? []).length > 0 ? { shares: row.shares } : {}),
      recurrence: row.recurrence,
      startDate: asDayOrNull(row.startDate),
      endDate: asDayOrNull(row.endDate),
      gradeSpan: spanOf([row.studentGroupId]),
      // Only under FACTOR: a MINUTES row carries no weight, which weigh()
      // reads as 1 without multiplying.
      ...(factorBySubject ? { loadWeight: weightOf(row.subjectId) } : {}),
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
    closures,
    // The uppdrag with the rastvaktsschema in them (supervision-load.ts): each
    // pass an uppdrag, and a RASTVAKT uppdrag counted only on the dates its
    // teacher has no pass. Without a pass, the uppdrag as they always were.
    duties: withSupervision(kindedDuties, shifts, year),
    inactiveUserIds: (inactive ?? []).map((row) => row.id),
  };
  return {
    year,
    input,
    spanOf,
    groupName: (groupId) => groups.get(groupId)?.name,
    loadModel,
    weightOf,
    scbPostOf: (userId) => scbPosts.get(userId),
    supervision: shifts.length > 0 ? supervisionOfTeachers(kindedDuties, shifts, year, closures) : null,
  };
}

/** A stored period as the report and the checks read it. */
export function toLoadPeriod(row: {
  validFrom: Date;
  validTo: Date | null;
  employmentPercent: unknown;
  reductionPercent: unknown;
  teachingTargetMinutesPerWeek: number | null;
}): LoadPeriod {
  return {
    validFrom: asDay(row.validFrom),
    validTo: asDayOrNull(row.validTo),
    employmentPercent: Number(row.employmentPercent),
    reductionPercent: Number(row.reductionPercent),
    teachingTargetMinutesPerWeek: row.teachingTargetMinutesPerWeek,
  };
}

export { asDay, asDayOrNull };
