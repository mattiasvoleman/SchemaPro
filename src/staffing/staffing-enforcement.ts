import type { LessonRecurrence, PrismaClient, UnstaffedGenerationMode } from '@prisma/client';
import { gradeSpanOf, loadRosters } from '../optimization/room-eligibility';
import { asDay, readLoadInput } from './load-input';
import { rostersOfYear, type BasisOrYear, type RosterViewer } from '../year-rollover/projected-rosters';
import {
  DEFAULT_CHECK_POLICY,
  checksAnything,
  judgeRequirementWrite,
  qualificationFinding,
  settleFindings,
  type CheckPolicy,
  type StaffingFinding,
  type StaffingRole,
  type StaffingWarning,
} from './staffing-checks';
import type { LoadInput, LoadQualification, LoadRequirement } from './teacher-load';
import type { YearBounds } from './teaching-weeks';

/**
 * One person as both of a row's teachers. Nothing in the schema refuses it,
 * and every reader assumes it cannot happen: the load report charges the
 * person the lead's share AND the co-teacher's (200 % of a row at 100/100),
 * judgeRequirementWrite asks the over-target question once per role and so
 * answers twice for one person, and suggest-teachers drops the co-teacher
 * from the candidates — the lead with them. So every writer that names
 * teachers refuses it: the timplanspost's POST and PATCH (as the row will end
 * up, the stored half included) and the requirements import, per row.
 * Not a CHECK yet: rows written before this may hold it, and a CHECK on a
 * table nobody has audited would stop the deploy rather than the mistake.
 */
export const SAME_TEACHER_TWICE =
  'coTeacherId: medläraren kan inte vara samma person som läraren — en lärare står en gång per timplanspost.';
export const SAME_TEACHER_TWICE_IN_FILE =
  'Läraren och medläraren är samma person. En lärare står en gång per timplanspost — lämna medlärare tom eller ange en annan.';

export const sameTeacherTwice = (
  teacherId: string | null | undefined,
  coTeacherId: string | null | undefined,
): boolean => Boolean(teacherId) && teacherId === coTeacherId;

/*
 * Where the two staffing questions (staffing-checks.ts) meet the database.
 *
 * CHECK, THEN WRITE, IN THE WRITE'S OWN TRANSACTION. Every caller runs these
 * inside the RLS transaction its write runs in, BEFORE the write: the year is
 * read once, the row is judged as it would end up, and a REFUSE throws before
 * anything is written, so a refused write leaves the table as it was without
 * leaning on a rollback.
 *
 * THE LOAD QUESTION TAKES A LOCK, AND THE LOCK COMES FIRST. "Would Anna be over
 * after this?" is a read of every row Anna carries followed by a write that adds
 * one; at READ COMMITTED two admins assigning Anna two different rows would each
 * read her at 1 000 minutes, each pass, and together leave her at 1 300. So the
 * TeacherEmployment row of every teacher the write ends up with is locked FOR NO
 * KEY UPDATE before the year is read: the second admin waits for the first to
 * commit, and — READ COMMITTED taking a fresh snapshot per statement — then
 * reads the row the first one wrote, and is judged against it. In id order, so
 * two writes locking the same two teachers queue rather than deadlock (and a
 * deadlock that happens anyway is P2034/40P01, which rethrowPrismaError answers
 * as 409 WRITE_CONFLICT).
 *
 * FOR NO KEY UPDATE rather than FOR UPDATE: nothing references TeacherEmployments
 * today, but the Users lock (staff-lock.ts) argues the same choice and the two
 * should not differ for no reason. The employment row rather than the Users
 * row: a target belongs to the post, and a PUT changing the post (a lower
 * tjänstgöringsgrad) updates exactly this row, so it queues behind an
 * assignment judged against the old figure instead of interleaving with it.
 *
 * ONLY TEACHERS WITH A POST ARE LOCKED, as decided: without a TeacherEmployment
 * row there is no target, the question is inert, and there is nothing to lock.
 * The rows are found with a plain read and then locked by id; a post created in
 * the moment between the two is not locked, and its teacher is judged by the
 * year read after — the window is one admin creating a post while another
 * staffs that very teacher, and its worst case is a WARN-able over-allocation.
 *
 * Under RLS a locking read needs the table's UPDATE policy, which on
 * TeacherEmployments only teacher_employments_admin_all grants. Every write that
 * reaches here sits behind a SCHOOL_ADMIN route.
 */

/** The policy as the checks and the generate pre-flight read it. */
export interface EnforcedPolicy extends CheckPolicy {
  unstaffedGeneration: UnstaffedGenerationMode;
}

export async function readCheckPolicy(
  tx: PrismaClient,
  schoolId: string,
): Promise<EnforcedPolicy> {
  const row = await tx.staffingPolicy.findUnique({
    where: { schoolId },
    select: {
      qualificationMode: true,
      overAllocationMode: true,
      overAllocationTolerancePercent: true,
      fullTimeTeachingMinutesPerWeek: true,
      unstaffedGeneration: true,
    },
  });
  return row ?? { ...DEFAULT_CHECK_POLICY, unstaffedGeneration: 'ALLOW' };
}

/**
 * Locks the year's TeacherEmployment rows of these teachers FOR NO KEY UPDATE,
 * in id order, and says how many it locked. See the header.
 */
export async function lockEmploymentsOf(
  tx: PrismaClient,
  academicYearId: string,
  userIds: readonly string[],
): Promise<number> {
  const wanted = [...new Set(userIds)];
  if (wanted.length === 0) return 0;
  const posts = await tx.teacherEmployment.findMany({
    where: { academicYearId, userId: { in: wanted } },
    select: { id: true },
  });
  const ids = posts.map((post) => post.id).sort();
  if (ids.length === 0) return 0;
  const locked = await tx.$queryRaw<{ id: string }[]>`
    SELECT "id"
    FROM "TeacherEmployments"
    WHERE "id" = ANY(${ids}::uuid[])
    ORDER BY "id"
    FOR NO KEY UPDATE
  `;
  return locked.length;
}

/** What a timplanspost write sets; an absent field keeps the stored value. */
export interface RequirementPatch {
  teacherId?: string | null;
  coTeacherId?: string | null;
  lessonsPerWeek?: number;
  minutesPerLesson?: number;
  /**
   * The row's lektionslängder, [] when uniform. Writers that touch the shape
   * hand in the RESOLVED shape (src/resources/lesson-shape-merge.ts) — all
   * three fields together — so this overlay never has to merge a split.
   */
  lessonLengths?: readonly number[];
  teacherLoadPercent?: number;
  coTeacherLoadPercent?: number;
  recurrence?: LessonRecurrence;
  /** YYYY-MM-DD, or null for "the year's own bound". */
  startDate?: string | null;
  endDate?: string | null;
}

/** The fields whose change can change who teaches a row or what it charges them. */
export const STAFFING_FIELDS: readonly (keyof RequirementPatch)[] = [
  'teacherId',
  'coTeacherId',
  'lessonsPerWeek',
  'minutesPerLesson',
  'lessonLengths',
  'teacherLoadPercent',
  'coTeacherLoadPercent',
  'recurrence',
  'startDate',
  'endDate',
];

export function touchesStaffing(patch: object): boolean {
  return STAFFING_FIELDS.some(
    (field) => (patch as Record<string, unknown>)[field] !== undefined,
  );
}

/** A row as the write leaves it: `patch` over `before`, or over a create's defaults. */
export function mergeRequirement(
  before: LoadRequirement | null,
  base: Pick<LoadRequirement, 'id' | 'subjectId' | 'subjectName' | 'studentGroupId' | 'groupName' | 'gradeSpan'>,
  patch: RequirementPatch,
): LoadRequirement {
  const field = <K extends keyof RequirementPatch & keyof LoadRequirement>(
    name: K,
    fallback: LoadRequirement[K],
  ): LoadRequirement[K] =>
    patch[name] !== undefined
      ? (patch[name] as LoadRequirement[K])
      : before
        ? before[name]
        : fallback;
  return {
    ...base,
    teacherId: field('teacherId', null),
    coTeacherId: field('coTeacherId', null),
    lessonsPerWeek: field('lessonsPerWeek', 1),
    minutesPerLesson: field('minutesPerLesson', 60),
    lessonLengths: field('lessonLengths', []),
    teacherLoadPercent: field('teacherLoadPercent', 100),
    coTeacherLoadPercent: field('coTeacherLoadPercent', 100),
    recurrence: field('recurrence', 'ALL_WEEKS'),
    startDate: field('startDate', null),
    endDate: field('endDate', null),
  };
}

/**
 * Both questions for one timplanspost create or PATCH. Returns the WARNs;
 * throws the first REFUSE as a 409. `before` is the stored row's teachers (null
 * for a create) — the cheap read that decides whether anything needs asking
 * before the year is read at all.
 */
export async function enforceRequirementWrite(
  tx: PrismaClient,
  args: {
    /** Whoever writes: the year's roster basis is computed for them (projected-rosters.ts). */
    viewer: RosterViewer;
    schoolId: string;
    academicYearId: string;
    /** Null for a create. */
    requirementId: string | null;
    subjectId: string;
    studentGroupId: string;
    before: { teacherId: string | null; coTeacherId: string | null } | null;
    patch: RequirementPatch;
  },
): Promise<StaffingWarning[]> {
  const { patch, before } = args;
  if (!touchesStaffing(patch)) return [];
  // A row nobody teaches after the write asks nothing — not even the policy.
  const teacherAfter = patch.teacherId !== undefined ? patch.teacherId : (before?.teacherId ?? null);
  const coTeacherAfter =
    patch.coTeacherId !== undefined ? patch.coTeacherId : (before?.coTeacherId ?? null);
  const assignees = [teacherAfter, coTeacherAfter].filter((id): id is string => id !== null);
  if (assignees.length === 0) return [];
  const policy = await readCheckPolicy(tx, args.schoolId);
  if (!checksAnything(policy)) return [];

  const newlyAssigned =
    (teacherAfter !== null && teacherAfter !== (before?.teacherId ?? null)) ||
    (coTeacherAfter !== null && coTeacherAfter !== (before?.coTeacherId ?? null));
  const asksQualification = policy.qualificationMode !== 'OFF' && newlyAssigned;
  const asksLoad =
    policy.overAllocationMode !== 'OFF' &&
    (await lockEmploymentsOf(tx, args.academicYearId, assignees)) > 0;
  if (!asksQualification && !asksLoad) return [];

  const read = await readLoadInput(tx, args.viewer, args.academicYearId, args.schoolId, {
    alsoGroupIds: [args.studentGroupId],
  });
  if (!read) return [];
  const stored = args.requirementId
    ? (read.input.requirements.find((row) => row.id === args.requirementId) ?? null)
    : null;
  // An update RLS hides from the year read is one its own statement answers 404.
  if (args.requirementId && !stored) return [];
  const subjectName =
    stored?.subjectName ??
    (
      await tx.subject.findUnique({ where: { id: args.subjectId }, select: { name: true } })
    )?.name;
  // A subject the caller cannot see is a create the foreign key refuses.
  if (subjectName === undefined) return [];

  const after = mergeRequirement(
    stored,
    {
      id: args.requirementId ?? 'new-requirement',
      subjectId: args.subjectId,
      subjectName,
      studentGroupId: args.studentGroupId,
      groupName: stored?.groupName ?? read.groupName(args.studentGroupId) ?? '',
      gradeSpan: stored?.gradeSpan ?? read.spanOf([args.studentGroupId]),
    },
    patch,
  );
  const findings = judgeRequirementWrite({
    input: read.input,
    policy: asksLoad ? policy : { ...policy, overAllocationMode: 'OFF' },
    before: stored,
    after,
    subjectName,
  });
  return settleFindings(findings);
}

/**
 * The same two questions over a requirements file, one row at a time, with the
 * year's load carried forward between rows: a file assigning Anna three rows is
 * judged on the third with the first two counted. Opened once per upload, after
 * the teachers' posts are locked; null when nothing would be asked.
 */
export class RequirementImportChecks {
  private constructor(
    private readonly policy: CheckPolicy,
    private readonly input: LoadInput,
    private readonly spanOf: (groupIds: string[]) => ReturnType<typeof gradeSpanOf>,
  ) {}

  static async open(
    tx: PrismaClient,
    args: {
      viewer: RosterViewer;
      schoolId: string;
      academicYearId: string;
      /** Every teacher a row of the file can end up with. */
      teacherIds: readonly string[];
      /** Every group the file names. */
      groupIds: readonly string[];
    },
  ): Promise<RequirementImportChecks | null> {
    if (args.teacherIds.length === 0) return null;
    const policy = await readCheckPolicy(tx, args.schoolId);
    if (!checksAnything(policy)) return null;
    const asksLoad =
      policy.overAllocationMode !== 'OFF' &&
      (await lockEmploymentsOf(tx, args.academicYearId, args.teacherIds)) > 0;
    if (policy.qualificationMode === 'OFF' && !asksLoad) return null;
    const read = await readLoadInput(tx, args.viewer, args.academicYearId, args.schoolId, {
      alsoGroupIds: [...args.groupIds],
    });
    if (!read) return null;
    return new RequirementImportChecks(
      asksLoad ? policy : { ...policy, overAllocationMode: 'OFF' },
      { ...read.input, requirements: [...read.input.requirements] },
      (groupIds) => read.spanOf(groupIds),
    );
  }

  /** The row as stored before this upload (or an earlier row of it), by id. */
  stored(requirementId: string): LoadRequirement | null {
    return this.input.requirements.find((row) => row.id === requirementId) ?? null;
  }

  /**
   * Findings for one row of the file, judged against the year as the rows
   * before it left it. `requirementId` is the stored row's id, or null for a
   * row the upload creates.
   */
  judge(args: {
    requirementId: string | null;
    rowNumber: number;
    subjectId: string;
    subjectName: string;
    studentGroupId: string;
    groupName: string;
    patch: RequirementPatch;
  }): { findings: StaffingFinding[]; after: LoadRequirement } {
    const before = args.requirementId ? this.stored(args.requirementId) : null;
    const after = mergeRequirement(
      before,
      {
        id: args.requirementId ?? `import-row-${args.rowNumber}`,
        subjectId: args.subjectId,
        subjectName: args.subjectName,
        studentGroupId: args.studentGroupId,
        groupName: args.groupName,
        gradeSpan: before?.gradeSpan ?? this.spanOf([args.studentGroupId]),
      },
      args.patch,
    );
    const findings = judgeRequirementWrite({
      input: this.input,
      policy: this.policy,
      before,
      after,
      subjectName: args.subjectName,
    });
    return { findings, after };
  }

  /** Counts a written row for the rows after it. */
  apply(after: LoadRequirement): void {
    const index = this.input.requirements.findIndex((row) => row.id === after.id);
    if (index === -1) this.input.requirements.push(after);
    else this.input.requirements[index] = after;
  }
}

/**
 * A lesson's grade span from its whole attendance — its groups and its named
 * pupils — derived over every group of the year, as the proxy derives a
 * lesson's (roomNeedsOf): a pupil's home class need not be on the lesson to
 * give them their grade. The one derivation the vikarie warning, the vikarie
 * picker's badge and the master-lesson PATCH share, so they cannot disagree
 * about one teacher on one lesson.
 */
export async function attendanceSpan(
  tx: PrismaClient,
  args: {
    academicYearId: string;
    groupIds: string[];
    studentIds?: string[];
    /**
     * The year's roster basis, or the viewer and the year's flags to compute
     * it from (projected-rosters.ts). Required: a span read without one would
     * read a rolled year's empty classes and judge every teacher against the
     * groups' own grades.
     */
    rosters: BasisOrYear;
  },
): Promise<{ min: number; max: number } | null> {
  const basis =
    'kind' in args.rosters
      ? args.rosters
      : await rostersOfYear(tx, args.rosters.viewer, args.academicYearId, args.rosters.known);
  const groups = await tx.studentGroup.findMany({
    where: { academicYearId: args.academicYearId },
    select: { id: true, gradeLevel: true },
  });
  const rosters = await loadRosters(tx, basis, args.groupIds, groups ?? [], args.studentIds ?? []);
  return gradeSpanOf(rosters, args.groupIds, args.studentIds ?? []);
}

/**
 * The qualification question alone, for a write that puts teachers on LESSONS
 * rather than on the timplan: a master lesson re-teachered, a vikarie. The load
 * report is computed from the timplan, so a lesson has no load to be over.
 *
 * The span is the lesson's attendance — its groups and named pupils — derived
 * over every group of the year, as the proxy derives a lesson's (roomNeedsOf).
 * `window` defaults to the läsår; a vikarie passes the lesson's date.
 */
export async function lessonQualificationFindings(
  tx: PrismaClient,
  args: {
    schoolId: string;
    academicYearId: string;
    subjectId: string;
    groupIds: string[];
    studentIds?: string[];
    assignees: { userId: string; role: StaffingRole }[];
    window?: YearBounds;
    /** For the span: see attendanceSpan. Resolved only when the span is asked. */
    rosters: BasisOrYear;
  },
): Promise<StaffingFinding[]> {
  if (args.assignees.length === 0) return [];
  const policy = await readCheckPolicy(tx, args.schoolId);
  if (policy.qualificationMode === 'OFF') return [];
  const rows = await tx.teacherSubjectQualification.findMany({
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
  // Nothing recorded, nothing asked — see staffing-checks.ts.
  if (rows.length === 0) return [];
  const qualifications: LoadQualification[] = rows.map((row) => ({
    ...row,
    validFrom: row.validFrom ? asDay(row.validFrom) : null,
    validTo: row.validTo ? asDay(row.validTo) : null,
  }));

  // In sequence: one transaction is one connection (see load-input.ts).
  const subject = await tx.subject.findUnique({
    where: { id: args.subjectId },
    select: { name: true },
  });
  const year = args.window
    ? null
    : await tx.academicYear.findUnique({
        where: { id: args.academicYearId },
        select: { startDate: true, endDate: true },
      });
  if (!subject) return [];
  const window = args.window ?? (year ? { startDate: asDay(year.startDate), endDate: asDay(year.endDate) } : null);
  if (!window) return [];

  const span = await attendanceSpan(tx, args);
  return args.assignees
    .map(({ userId, role }) =>
      qualificationFinding({
        policy,
        qualifications,
        userId,
        role,
        subject: { id: args.subjectId, name: subject.name },
        span,
        window,
      }),
    )
    .filter((finding): finding is StaffingFinding => finding !== null);
}
