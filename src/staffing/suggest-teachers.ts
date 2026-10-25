import { changesDuringYear } from './employment-periods';
import {
  DEFAULT_LOAD_POLICY,
  QUALIFICATION_RANK,
  chargedMinutes,
  countedMinutesByTeacher,
  loadStatus,
  stretchLoads,
  strongestCoveringQualification,
  targetMinutesPerWeek,
  yearTargetMinutesPerWeek,
  type GradeSpan,
  type LoadEmployment,
  type LoadInput,
  type LoadQualification,
  type LoadRequirement,
  type LoadStatus,
} from './teacher-load';

/** One person who could take a timplanspost, and what taking it would do. */
export interface TeacherCandidate {
  userId: string;
  /**
   * The strongest behörighet covering the subject over the group's derived
   * span, valid at some point of the year — or null. Always null when the
   * school has recorded none (`qualificationsRecorded: false`).
   */
  qualificationKind: LoadQualification['kind'] | null;
  /** Leads or co-teaches another row in the subject this year. */
  teachesSubjectAlready: boolean;
  /** Leads or co-teaches another row for the same group this year. */
  teachesGroupAlready: boolean;
  /**
   * Led or co-taught the subject for the group's predecessor in the
   * predecessor year (any of its rows: split, odd/even, term courses). Always
   * false when the group has no predecessor.
   */
  taughtLastYear: boolean;
  /** Already the row's lead teacher. */
  currentlyAssigned: boolean;
  /** target − counted after taking the row; null without a target. */
  remainingMinutesPerWeek: number | null;
  /** Taking the row would put them past target × (1 + tolerance). */
  wouldExceed: boolean;
  /** Their status after taking the row. */
  status: LoadStatus;
}

export interface TeacherSuggestions {
  requirementId: string;
  subjectId: string;
  studentGroupId: string;
  gradeSpan: GradeSpan | null;
  /**
   * What the row charges its lead: lessons × minutes × weight ×
   * teacherLoadPercent — or, when `share` is set, what that share does.
   */
  teacherMinutesPerWeek: number;
  /**
   * Delade lektioner: the share nobody teaches the candidates are ranked for
   * (its length), instead of the row's lead. Absent for the lead.
   */
  share?: { minutes: number };
  qualificationsRecorded: boolean;
  /**
   * The group's predecessor and its year, when the predecessor had a row in
   * the subject; null otherwise — a school that never rolls, a new group, or a
   * subject the class did not read last year.
   */
  lastYear: { groupName: string; yearName: string } | null;
  candidates: TeacherCandidate[];
}

/**
 * Who taught the subject for the group's predecessor, as the caller read it:
 * the union of lead and co-teacher over every predecessor row of the subject.
 */
export interface LastYearTeachers {
  groupName: string;
  yearName: string;
  teacherIds: readonly string[];
}

/**
 * Who should take this timplanspost: every active member of staff, ranked.
 *
 * FOUR KEYS, IN ORDER. (1) Behörighet for the subject over the group's
 * derived grade span — LEGITIMATION, BEHORIG, TILLATEN, none — the same
 * coverage rule as the report's unqualified list and the substitute picker,
 * so the badge here and the warning there never disagree. (2) The same
 * teacher as last year: led or co-taught this subject for the group's
 * predecessor. (3) Already teaching the group: a class with three teachers
 * rather than six. (4) Room left, after taking the row, most first; a teacher
 * with no target sorts last within their tier, because "unknown" is not
 * "plenty". Then by id, so two loads of the panel agree.
 *
 * The timplanspost dialog's pickers on /admin/requirements order by key (1)
 * alone, from the same badge (web/lib/staffing-candidates.ts, strongestFirst):
 * a change to the tiers here is a change to that list too.
 *
 * WHY CONTINUITY SITS BETWEEN (1) AND (3). Below behörighet, because that is
 * the legal question (who may set the grade), REFUSE refuses the write anyway,
 * and the badge, the report and the substitute picker keep one order —
 * continuity never lifts an unqualified candidate over a qualified one. Above
 * "teaches the group", because last year's teacher knows the same pupils in
 * the same SUBJECT, carries the progression through åk 7–9 and sets the grade
 * at the end of it; "teaches the group" knows the pupils only from another
 * subject. It names one or two people per row, so it reorders little.
 *
 * A SCHOOL WITH NO BEHÖRIGHET ROWS falls back, for key (1), to "has a
 * requirement in the subject, this year or for the group last year" — the
 * floor the substitute picker has always had, widened by continuity — rather
 * than ranking everybody as unqualified alike. Without the widening a freshly
 * rolled year would rank last year's teacher of this very subject below
 * whoever happened to be staffed first in it.
 *
 * "AFTER TAKING THE ROW" means with this row's lead charge moved to them: the
 * current lead's own figure excludes the row first, so they are compared on
 * the same footing as everybody else, and a co-teacher of the row is left
 * out — one person cannot be both of a row's teachers (the writers refuse it).
 * wouldExceed and status come from loadStatus over countedMinutesByTeacher,
 * which is exactly the question STAFF_TEACHER_OVER_TARGET asks of the write —
 * wouldExceed only for a row that adds minutes, as the write asks only then.
 * For a teacher whose post changes during the year the same question is asked
 * stretch by stretch, as STAFF_TEACHER_OVER_TARGET_IN_PERIOD asks it: the
 * room left is the tightest stretch's, the status the worst stretch's.
 *
 * `showsPeriods` is whether the reader may see when and how a post changes
 * (Roller i skolan, readsHr). Without it a changing post's room and status
 * are the year's, as the matrix shows them, and the ranking reads that room:
 * the tightest stretch's room would give back the post's level in it.
 * wouldExceed is still asked stretch by stretch, because that is what the
 * write will answer.
 *
 * PURE: the caller reads the rows; nothing here knows a name.
 */
export function suggestTeachers(
  input: LoadInput,
  requirementId: string,
  staffIds: readonly string[],
  lastYear: LastYearTeachers | null = null,
  showsPeriods = true,
  share: { minutes: number } | null = null,
): TeacherSuggestions {
  const requirement = input.requirements.find((row) => row.id === requirementId);
  if (!requirement) {
    throw new Error(`suggestTeachers: requirement ${requirementId} is not in the input`);
  }
  const policy = input.policy ?? DEFAULT_LOAD_POLICY;
  const employmentByUser = new Map(input.employments.map((row) => [row.userId, row]));
  const qualificationsRecorded = input.qualifications.length > 0;

  /*
   * What a candidate takes: the row's lead, or — delade lektioner — a share
   * of it nobody teaches (`share`, by its length), given its own teacher.
   * The ranking is the same either way; only the place they are put in, and
   * so the minutes they are charged, differ.
   */
  const shareIndex =
    share === null
      ? -1
      : (requirement.shares ?? []).findIndex((row) => row.teacherId === null && row.minutes === share.minutes);
  if (share !== null && shareIndex < 0) {
    throw new Error(`suggestTeachers: requirement ${requirementId} has no teacherless share of ${share.minutes} minutes`);
  }
  const placed = (row: LoadRequirement, userId: string | null): LoadRequirement =>
    row.id !== requirementId
      ? row
      : shareIndex < 0
        ? { ...row, teacherId: userId }
        : { ...row, shares: row.shares!.map((stored, index) => (index === shareIndex ? { ...stored, teacherId: userId } : stored)) };
  const withoutLead = input.requirements.map((row) => placed(row, null));
  const takenBy = (userId: string) => input.requirements.map((row) => placed(row, userId));

  // Everybody's minutes with the place taken off: the lead's, or nothing
  // for a share nobody teaches.
  const base = countedMinutesByTeacher({ ...input, requirements: withoutLead });
  const charge =
    shareIndex < 0
      ? chargedMinutes(requirement, input.year, input.closures).teacher
      : (chargedMinutes(placed(requirement, SHARE_PLACE), input.year, input.closures).parts.find(
          (part) => part.teacherId === SHARE_PLACE,
        )?.charged ?? 0);

  const others = input.requirements.filter((row) => row.id !== requirementId);
  // Delade lektioner: a share's teacher teaches the row's group and subject too.
  const teaches = (userId: string, row: (typeof others)[number]) =>
    row.teacherId === userId ||
    row.coTeacherId === userId ||
    (row.shares ?? []).some((share) => share.teacherId === userId);
  // Who already teaches some of this row's lessons is not offered its lead
  // (the trigger's rule (d)), as its medlärare is not; for a share, nor is
  // its lead.
  const sharing = new Set((requirement.shares ?? []).map((stored) => stored.teacherId));
  if (shareIndex >= 0 && requirement.teacherId !== null) sharing.add(requirement.teacherId);
  const lastYearTeachers = new Set(lastYear?.teacherIds ?? []);
  const familiar = subjectFamiliarTeachers(input, requirementId, lastYear);

  const candidates: TeacherCandidate[] = [];
  for (const userId of new Set(staffIds)) {
    if (userId === requirement.coTeacherId || sharing.has(userId)) continue;
    const employment = employmentByUser.get(userId) ?? null;
    const changing = employment !== null && changesDuringYear(employment, input.year) ? employment : null;
    let remainingMinutesPerWeek: number | null;
    let wouldExceed: boolean;
    let status: LoadStatus;
    if (changing && !showsPeriods) {
      const target = yearTargetMinutesPerWeek(input, changing);
      const after = (base.get(userId) ?? 0) + charge;
      status = loadStatus(after, target, policy.overAllocationTolerancePercent);
      remainingMinutesPerWeek = target === null ? null : target - Math.round(after);
      wouldExceed = exceedsAStretch(input, withoutLead, takenBy(userId), changing);
    } else if (changing) {
      // A post that changes during the year: stretch by stretch, as the write
      // is judged (staffing-checks.ts overTargetFindingByStretch). The
      // tightest stretch is the room left; the worst is the status; and it
      // would exceed exactly when some stretch the row adds to goes over.
      const tolerance = policy.overAllocationTolerancePercent;
      const without = stretchLoads({ ...input, requirements: withoutLead }, changing);
      const taking = stretchLoads({ ...input, requirements: takenBy(userId) }, changing);
      const judged = taking.filter((stretch) => stretch.weeks > 0);
      const rooms = judged
        .filter((stretch) => stretch.target !== null)
        .map((stretch) => stretch.target! - Math.round(stretch.counted));
      remainingMinutesPerWeek = rooms.length === 0 ? null : Math.min(...rooms);
      wouldExceed = taking.some(
        (stretch, index) =>
          stretch.weeks > 0 &&
          stretch.counted > (without[index]?.counted ?? 0) + 1e-9 &&
          loadStatus(stretch.counted, stretch.target, tolerance) === 'OVER',
      );
      status = judged.reduce<LoadStatus>(
        (worst, stretch) => {
          const next = loadStatus(stretch.counted, stretch.target, tolerance);
          return STATUS_RANK[next] < STATUS_RANK[worst] ? next : worst;
        },
        'NO_TARGET',
      );
    } else {
      const target = targetMinutesPerWeek(employment, policy);
      const after = (base.get(userId) ?? 0) + charge;
      status = loadStatus(after, target, policy.overAllocationTolerancePercent);
      remainingMinutesPerWeek = target === null ? null : target - Math.round(after);
      // Only a row that adds minutes can take anybody past the limit: the
      // over-target check asks of no other write (overTargetFinding), and a
      // 0 % row must not warn the admin off a teacher the write lets through.
      wouldExceed = charge > 1e-9 && status === 'OVER';
    }
    candidates.push({
      userId,
      qualificationKind: qualificationsRecorded
        ? strongestCoveringQualification(input.qualifications, userId, requirement, input.year)
        : null,
      teachesSubjectAlready: others.some(
        (row) => row.subjectId === requirement.subjectId && teaches(userId, row),
      ),
      teachesGroupAlready: others.some(
        (row) => row.studentGroupId === requirement.studentGroupId && teaches(userId, row),
      ),
      taughtLastYear: lastYearTeachers.has(userId),
      currentlyAssigned: shareIndex < 0 && requirement.teacherId === userId,
      remainingMinutesPerWeek,
      wouldExceed,
      status,
    });
  }

  const tier = (candidate: TeacherCandidate): number =>
    qualificationsRecorded
      ? candidate.qualificationKind
        ? QUALIFICATION_RANK[candidate.qualificationKind]
        : 0
      : Number(familiar.has(candidate.userId));
  candidates.sort(
    (a, b) =>
      tier(b) - tier(a) ||
      Number(b.taughtLastYear) - Number(a.taughtLastYear) ||
      Number(b.teachesGroupAlready) - Number(a.teachesGroupAlready) ||
      Number(a.remainingMinutesPerWeek === null) - Number(b.remainingMinutesPerWeek === null) ||
      (b.remainingMinutesPerWeek ?? 0) - (a.remainingMinutesPerWeek ?? 0) ||
      a.userId.localeCompare(b.userId),
  );

  return {
    requirementId,
    subjectId: requirement.subjectId,
    studentGroupId: requirement.studentGroupId,
    gradeSpan: requirement.gradeSpan,
    teacherMinutesPerWeek: Math.round(charge),
    ...(shareIndex < 0 ? {} : { share: { minutes: share!.minutes } }),
    qualificationsRecorded,
    lastYear: lastYear ? { groupName: lastYear.groupName, yearName: lastYear.yearName } : null,
    candidates,
  };
}

/** Whether taking the row puts a changing post past the limit of a stretch it adds to. */
function exceedsAStretch(
  input: LoadInput,
  withoutLead: LoadInput['requirements'],
  takenBy: LoadInput['requirements'],
  employment: LoadEmployment,
): boolean {
  const tolerance = (input.policy ?? DEFAULT_LOAD_POLICY).overAllocationTolerancePercent;
  const without = stretchLoads({ ...input, requirements: withoutLead }, employment);
  const taking = stretchLoads({ ...input, requirements: takenBy }, employment);
  return taking.some(
    (stretch, index) =>
      stretch.weeks > 0 &&
      stretch.counted > (without[index]?.counted ?? 0) + 1e-9 &&
      loadStatus(stretch.counted, stretch.target, tolerance) === 'OVER',
  );
}

/**
 * A teacher id no member of staff has, for reading what a share would charge
 * whoever is given it: chargedMinutes keys its parts by teacher.
 */
const SHARE_PLACE = '\u0000share';

/** OVER first, as the matrix sorts: the worst of a changing post's stretches is its status. */
const STATUS_RANK: Record<LoadStatus, number> = { OVER: 0, UNDER: 1, OK: 2, NO_TARGET: 3 };

/**
 * Who "already teaches the subject" for one timplanspost: everybody who leads
 * or co-teaches ANOTHER row of the subject this year, and whoever taught it for
 * the group's predecessor last year (`lastYear`, as the caller read it).
 *
 * The floor a school with NO behörighet rows is ranked by — suggestTeachers'
 * key (1) without records, which is exactly teachesSubjectAlready ||
 * taughtLastYear — and the eligibility the staffing proposal sends for such a
 * school, as a preference rather than a rule (StaffingProposalService). One
 * predicate, so the picker's first tier and the proposal's "undervisar redan i
 * ämnet" badge name the same people.
 *
 * Every id the rows name, staff or not: the caller intersects with whom it can
 * actually give the row to.
 */
export function subjectFamiliarTeachers(
  input: Pick<LoadInput, 'requirements'>,
  requirementId: string,
  lastYear: LastYearTeachers | null,
): Set<string> {
  const requirement = input.requirements.find((row) => row.id === requirementId);
  if (!requirement) {
    throw new Error(`subjectFamiliarTeachers: requirement ${requirementId} is not in the input`);
  }
  const familiar = new Set<string>(lastYear?.teacherIds ?? []);
  for (const row of input.requirements) {
    if (row.id === requirementId || row.subjectId !== requirement.subjectId) continue;
    if (row.teacherId !== null) familiar.add(row.teacherId);
    if (row.coTeacherId !== null) familiar.add(row.coTeacherId);
    for (const share of row.shares ?? []) {
      if (share.teacherId !== null) familiar.add(share.teacherId);
    }
  }
  return familiar;
}
