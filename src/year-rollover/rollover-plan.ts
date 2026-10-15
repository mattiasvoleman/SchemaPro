import { createHash } from 'node:crypto';
import type { BreakKind, ConstraintType, LessonRecurrence, StudentGroupKind } from '@prisma/client';
import {
  crossesIsoWeek53,
  dateShiftDays,
  defaultGraduatingGrade,
  frameChanges,
  mapPeriod,
  nameCollisions,
  promoteName,
  proposeBreak,
  resolveGroups,
  volumeFindings,
  type BreakAnchor,
  type DayBounds,
  type GroupChoice,
  type GroupChoiceError,
  type NameStatus,
  type RequestedOutcome,
  type ResolvedGroup,
  type RolloverOutcome,
  type VolumeFinding,
} from '../common/year-rollover';
import { isMixed } from '../common/lesson-lengths';
import { isLanguageBlockName } from '../timplan/generate-requirements';
import { qualificationFinding } from '../staffing/staffing-checks';
import type { GradeSpan } from '../staffing/teacher-load';
import { skippedModels } from './rollover-registry';
import type { RolloverSource, SourceGroup } from './rollover-source';
import {
  planStaffingCarry,
  stableStaffing,
  type StaffingCarryPreview,
  type StaffingProblemCode,
  type StaffingWrites,
} from './rollover-staffing';
import { planCohortTimplans, type PlannedTimplan } from './rollover-timplans';

/**
 * The rollover as a plan: every row it would write, every row it leaves
 * behind and why, and everything the admin should look at first. Pure over
 * the source rows and the request, so the preview and the execute compute
 * the same plan, and `planHash` — over the rows to be written only — says
 * whether anything changed between the two.
 */

export interface RolloverRequest {
  name: string;
  startDate: string;
  endDate: string;
  graduatingGradeLevel?: number;
  groups?: { sourceGroupId: string; outcome?: RequestedOutcome; name?: string }[];
  carryTeachingGroups?: boolean;
  carryTeachingGroupMembers?: boolean;
  keepTeachers?: boolean;
  carryClassRules?: boolean;
  breaks?: { sourceBreakId: string; startDate?: string; endDate?: string }[];
  /**
   * Carry tjänster and uppdrag (staffing Fas 5). Absent means false, unlike
   * the four options above: a request from before the option existed plans,
   * writes and hashes exactly as it did. The wizard sends true by default.
   */
  carryStaffing?: boolean;
}

export type RolloverProblemCode =
  | 'GRADUATING_GRADE_REQUIRED'
  | 'ROLLOVER_NAME_COLLISION'
  | 'ROLLOVER_NAME_CASE_COLLISION'
  | 'ROLLOVER_GROUP_CHOICE_INVALID'
  | 'ROLLOVER_UNKNOWN_GROUP'
  | 'ROLLOVER_UNKNOWN_BREAK'
  | 'ROLLOVER_TARGET_DATES'
  | 'YEAR_NAME_TAKEN'
  | 'YEAR_DATES_OVERLAP'
  | 'BREAK_NEEDS_DATES'
  | 'BREAK_OUTSIDE_YEAR'
  | 'DUTY_SLOTS_NOT_CARRIED'
  | 'VOLUME_DIFFERS_FROM_TIMPLAN'
  | 'ISO_WEEK_53_CROSSED'
  | 'ROLLOVER_2028_RENUMBERING'
  | StaffingProblemCode;

export interface RolloverProblem {
  code: RolloverProblemCode;
  blocking: boolean;
  params: Record<string, string | number | string[]>;
}

/** Where a row of the new year goes: a source group's successor, or its intake twin. */
export type GroupKey = string;
const intakeKey = (sourceGroupId: string): GroupKey => `intake:${sourceGroupId}`;

export interface RolloverWrites {
  year: {
    name: string;
    startDate: string;
    endDate: string;
    graduatingGradeLevel: number;
    predecessorId: string;
  };
  groups: {
    key: GroupKey;
    name: string;
    kind: StudentGroupKind;
    gradeLevel: number | null;
    predecessorId: string | null;
    /**
     * A half's class (Halvklasser): the key its class is written under —
     * the class's successor, or its intake twin. Absent on every other group,
     * so a school without halves writes what it always wrote.
     */
    halfOfKey?: GroupKey;
  }[];
  members: { groupKey: GroupKey; studentId: string }[];
  requirements: {
    sourceRequirementId: string;
    groupKey: GroupKey;
    subjectId: string;
    teacherId: string | null;
    coTeacherId: string | null;
    lessonsPerWeek: number;
    minutesPerLesson: number;
    /**
     * Only on a split row: its lektionslängder, carried as they are. Absent
     * on a uniform one, so its write — and the planHash over the writes — is
     * byte for byte what it was before the column existed.
     */
    lessonLengths?: number[];
    minutesBefore: number;
    minutesAfter: number;
    /**
     * Only on a row with its own ämnesfördelning, carried as it is — an own
     * rule of "no limit" is the flag alone, its numbers left to the columns'
     * null. Absent on a row that follows its subject, so its write and the
     * planHash are what they were before the columns existed.
     */
    ownDistribution?: true;
    maxLessonsPerDay?: number;
    minDaysBetween?: number;
    teacherLoadPercent: number;
    coTeacherLoadPercent: number;
    recurrence: LessonRecurrence;
    startDate: string | null;
    endDate: string | null;
    /**
     * Parallella block: the key of the block copy the row is carried into
     * (`blocks` below). Only on a row in a block, so a school that has none
     * writes, and hashes, what it always did.
     */
    blockKey?: string;
  }[];
  /**
   * The parallel blocks carried, one copy per block and side: the rows
   * carried to the successor groups, keyed by the source block's id, and
   * those carried to intake twins, keyed `intake:<id>`. A copy holding no
   * carried row is not written. See planBlocks.
   */
  blocks: { key: string; sourceBlockId: string; name: string }[];
  breaks: {
    sourceBreakId: string;
    name: string;
    kind: BreakKind;
    startDate: string;
    endDate: string;
    minGradeLevel: number | null;
    maxGradeLevel: number | null;
  }[];
  classRules: {
    sourceConstraintId: string;
    groupKey: GroupKey;
    dayOfWeek: number;
    startTime: Date;
    endTime: Date;
    type: ConstraintType;
    reason: string | null;
    minGradeLevel: number | null;
    maxGradeLevel: number | null;
  }[];
  /** Timplan per årskurs of the new year: the cohorts' plans, and each other grade's default or own plan. */
  timplans: { gradeLevel: number; localTimplanId: string }[];
  /** Tjänster and uppdrag (staffing Fas 5); null without carryStaffing, and then outside the hash. */
  staffing: StaffingWrites | null;
}

export interface PlannedGroup {
  sourceGroupId: string;
  sourceName: string;
  kind: StudentGroupKind;
  sourceGradeLevel: number | null;
  outcome: RolloverOutcome;
  targetName: string | null;
  targetGradeLevel: number | null;
  intakeName: string | null;
  nameStatus: NameStatus | null;
  noGrade: boolean;
  error: GroupChoiceError | null;
  collision: boolean;
  caseCollision: boolean;
  homePupils: number;
  membersCopied: number;
  membersExcluded: { graduating: number; noSuccessor: number };
  membersStranded: number;
  requirementsCarried: number;
  volumeFindings: (VolumeFinding & { subjectName: string })[];
  volumePlanName: string | null;
}

export type TeacherClearReason = 'INACTIVE' | 'SAME_TEACHER_TWICE' | 'NOT_QUALIFIED';

export interface RolloverPlan {
  source: { id: string; name: string; startDate: string; endDate: string };
  target: { name: string; startDate: string; endDate: string; dateShiftDays: number; crossesIsoWeek53: boolean };
  graduatingGradeLevel: number | null;
  graduatingGradeSource: 'REQUEST' | 'TIMPLAN' | 'CLASSES' | 'NONE';
  graduatingGradeConflict: { timplan: number[]; classes: number | null } | null;
  groups: PlannedGroup[];
  requirements: {
    carried: number;
    notCarried: number;
    periodShifted: number;
    periodBoundAnchored: number;
    periodDropped: { sourceRequirementId: string; subjectName: string; groupName: string; startDate: string | null; endDate: string | null }[];
    teachersCleared: { sourceRequirementId: string; subjectName: string; groupName: string; role: 'TEACHER' | 'CO_TEACHER'; teacherId: string; reason: TeacherClearReason }[];
    qualificationWarnings: { sourceRequirementId: string; subjectName: string; groupName: string; role: 'TEACHER' | 'CO_TEACHER'; teacherId: string; grades: string }[];
    oddEvenRows: number;
  };
  breaks: {
    sourceBreakId: string;
    name: string;
    startDate: string;
    endDate: string;
    proposedStart: string | null;
    proposedEnd: string | null;
    anchor: BreakAnchor;
    fits: boolean;
    selected: boolean;
    startDateToWrite: string | null;
    endDateToWrite: string | null;
  }[];
  classRules: { sourceConstraintId: string; sourceGroupName: string; targetGroupName: string; dayOfWeek: number; startTime: string; endTime: string; stageChange: boolean }[];
  /**
   * Per årskurs of the new year, the plan it will follow and why: carried
   * from the grade a class moves up from, a grade with no cohort below it
   * defaulting to the newest decided plan that speaks for it, or keeping its
   * own when none does. See rollover-timplans.ts.
   */
  timplans: PlannedTimplan[];
  /** What carrying tjänster and uppdrag would do; null without carryStaffing. */
  staffing: StaffingCarryPreview | null;
  skipped: { model: string; reason: string; count: number | null }[];
  problems: RolloverProblem[];
  blocking: boolean;
  planHash: string;
  /** Not part of the response: what the execute writes. */
  writes: RolloverWrites;
}

const clock = (value: Date): string => value.toISOString().slice(11, 16);

/** SFS 2025:729 applies to education after 30 June 2028 (övergångsbestämmelse 2). */
const REFORM_2028_FROM = '2028-07-01';

export function planRollover(source: RolloverSource, request: RolloverRequest): RolloverPlan {
  const options = {
    carryTeachingGroups: request.carryTeachingGroups ?? true,
    carryTeachingGroupMembers: request.carryTeachingGroupMembers ?? true,
    keepTeachers: request.keepTeachers ?? true,
    carryClassRules: request.carryClassRules ?? true,
    carryStaffing: request.carryStaffing === true,
  };
  if (options.carryStaffing && source.staffing === null) {
    throw new Error('planRollover: carryStaffing needs the source read with its staffing.');
  }
  const problems: RolloverProblem[] = [];
  const sourceBounds: DayBounds = { startDate: source.year.startDate, endDate: source.year.endDate };
  const target: DayBounds = { startDate: request.startDate, endDate: request.endDate };
  const shift = dateShiftDays(sourceBounds.startDate, target.startDate);
  const name = request.name.trim();

  if (!(target.startDate > sourceBounds.endDate && target.startDate < target.endDate)) {
    problems.push({
      code: 'ROLLOVER_TARGET_DATES',
      blocking: true,
      params: { sourceEndDate: sourceBounds.endDate, startDate: target.startDate, endDate: target.endDate },
    });
  }
  const sameName = source.otherYears.find((other) => other.name === name);
  if (sameName || source.year.name === name) {
    problems.push({ code: 'YEAR_NAME_TAKEN', blocking: true, params: { name } });
  }
  const overlapping = source.otherYears
    .filter((other) => other.startDate <= target.endDate && target.startDate <= other.endDate)
    .map((other) => other.name)
    .sort();
  if (overlapping.length > 0) {
    problems.push({ code: 'YEAR_DATES_OVERLAP', blocking: false, params: { years: overlapping } });
  }
  // The tioårig grundskola (SFS 2025:729, i kraft 2026-07-01, tillämpas från
  // 2028-07-01). Its övergångsbestämmelse 4 moves every pupil already in
  // school one årskurs further than a normal year: förskoleklassen 2027/28
  // begins directly in åk 2, and everyone who would have begun åk 2 or
  // higher in HT 2028 begins the årskurs above it. This rollover promotes
  // one årskurs (PROMOTE_GRADE); the double step is a follow-up due before
  // the spring 2028 rollover. Until then the preview SAYS so, as a warning
  // that blocks nothing — every class's gradeLevel in a year from HT 2028
  // would otherwise be one too low without anybody being told. Not a write,
  // so the planHash over the writes is unchanged. Only for the rollover that
  // CROSSES into the reform (source before 1 July 2028, target from it): the
  // double step is once, and a rollover from 2028/29 into 2029/30 promotes
  // one årskurs like any other.
  if (sourceBounds.startDate < REFORM_2028_FROM && target.startDate >= REFORM_2028_FROM) {
    problems.push({
      code: 'ROLLOVER_2028_RENUMBERING',
      blocking: false,
      params: { startYear: Number(target.startDate.slice(0, 4)), source: 'SFS 2025:729, övergångsbestämmelse 4' },
    });
  }

  // ---- G
  const fallback = defaultGraduatingGrade(
    source.decidedPlans.map((plan) => ({
      schoolForm: plan.schoolForm,
      decidedAt: plan.decidedAt,
      maxGradeLevel: plan.entries.length > 0 ? Math.max(...plan.entries.map((entry) => entry.gradeLevel)) : null,
    })),
    source.groups.filter((group) => group.kind === 'CLASS').map((group) => group.gradeLevel),
  );
  const fromRequest = request.graduatingGradeLevel;
  const graduating = fromRequest ?? (fallback.conflict ? null : fallback.value);
  if (graduating === null) {
    problems.push({
      code: 'GRADUATING_GRADE_REQUIRED',
      blocking: true,
      params: {
        timplan: (fallback.conflict?.timplan ?? []).map(String),
        classes: fallback.conflict?.classes ?? fallback.value ?? '',
      },
    });
  }
  // Without a G nothing graduates: every graded group is shown as promoted,
  // and the plan stays blocked until one is chosen.
  const g = graduating ?? 99;

  // ---- groups
  const groupById = new Map(source.groups.map((group) => [group.id, group]));
  const choices = new Map<string, GroupChoice>();
  for (const choice of request.groups ?? []) {
    if (!groupById.has(choice.sourceGroupId)) {
      problems.push({ code: 'ROLLOVER_UNKNOWN_GROUP', blocking: true, params: { sourceGroupId: choice.sourceGroupId } });
      continue;
    }
    choices.set(choice.sourceGroupId, { outcome: choice.outcome, name: choice.name });
  }
  const resolved = resolveGroups(source.groups, g, options, choices);
  const resolvedById = new Map(resolved.map((row) => [row.sourceGroupId, row]));
  for (const row of resolved) {
    if (row.error) {
      problems.push({
        code: 'ROLLOVER_GROUP_CHOICE_INVALID',
        blocking: true,
        params: { group: groupById.get(row.sourceGroupId)!.name, error: row.error },
      });
    }
  }
  const collisions = nameCollisions(resolved);
  const blockedNames = collisions.filter((collision) => !collision.caseOnly);
  if (blockedNames.length > 0) {
    problems.push({
      code: 'ROLLOVER_NAME_COLLISION',
      blocking: true,
      params: { names: blockedNames.map((collision) => collision.name) },
    });
  }
  const caseNames = collisions.filter((collision) => collision.caseOnly);
  if (caseNames.length > 0) {
    problems.push({
      code: 'ROLLOVER_NAME_CASE_COLLISION',
      blocking: false,
      params: { names: caseNames.map((collision) => collision.name) },
    });
  }
  const colliding = new Set(blockedNames.flatMap((collision) => collision.sourceGroupIds));
  const caseColliding = new Set(caseNames.flatMap((collision) => collision.sourceGroupIds));

  const writes: RolloverWrites = {
    year: {
      name,
      startDate: target.startDate,
      endDate: target.endDate,
      graduatingGradeLevel: g,
      predecessorId: source.year.id,
    },
    groups: [],
    members: [],
    requirements: [],
    blocks: [],
    breaks: [],
    classRules: [],
    timplans: [],
    staffing: null,
  };
  for (const row of resolved) {
    const group = groupById.get(row.sourceGroupId)!;
    // A half rides with its class: written under the class's successor, or
    // under its intake twin (resolveGroups only gives a half what its class has).
    const halfOf = group.halfOfId ?? null;
    if (row.successor) {
      writes.groups.push({
        key: group.id,
        name: row.successor.name,
        kind: group.kind,
        gradeLevel: row.successor.gradeLevel,
        predecessorId: group.id,
        ...(halfOf ? { halfOfKey: halfOf } : {}),
      });
    }
    if (row.intake) {
      writes.groups.push({
        key: intakeKey(group.id),
        name: row.intake.name,
        kind: group.kind,
        gradeLevel: row.intake.gradeLevel,
        predecessorId: null,
        ...(halfOf ? { halfOfKey: intakeKey(halfOf) } : {}),
      });
    }
  }

  // ---- members, and the projected grade of each pupil next year
  const projectedGrade = (studentId: string): number | null => {
    const home = source.homeClassOf.get(studentId);
    const successor = home ? resolvedById.get(home)?.successor : undefined;
    return successor?.gradeLevel ?? null;
  };
  const memberStats = new Map<string, { copied: number; graduating: number; noSuccessor: number; stranded: number }>();
  const membersOf = new Map<string, string[]>();
  for (const member of source.members) {
    const ids = membersOf.get(member.studentGroupId) ?? [];
    ids.push(member.studentId);
    membersOf.set(member.studentGroupId, ids);
  }
  for (const group of source.groups) {
    const stats = { copied: 0, graduating: 0, noSuccessor: 0, stranded: 0 };
    memberStats.set(group.id, stats);
    if (group.kind !== 'TEACHING_GROUP') continue;
    const row = resolvedById.get(group.id)!;
    for (const studentId of [...(membersOf.get(group.id) ?? [])].sort()) {
      const home = source.homeClassOf.get(studentId) ?? null;
      const homeRow = home ? resolvedById.get(home) : undefined;
      const homeLeaves = homeRow !== undefined && homeRow.successor === null;
      if (!row.successor) {
        if (!homeLeaves) stats.stranded++;
        continue;
      }
      // A half's pupils move up with it, whatever the option says: the half
      // is part of the class, and its successor is next year's half of the
      // class those pupils move into. Only its class's pupils, though: a
      // member whose home is elsewhere could not be placed in the successor
      // (the member trigger's rule), and one such row would refuse the whole
      // rollover; they are stranded, as a pupil whose class does not follow.
      if (group.halfOfId && home !== group.halfOfId) {
        if (!homeLeaves) stats.stranded++;
        continue;
      }
      if (!options.carryTeachingGroupMembers && !group.halfOfId) continue;
      if (homeLeaves) {
        // Labelled as the activation will label the pupil: a graduate when
        // the home class is at or above G, whatever its outcome is called
        // (INTAKE on the lowest class of a one-grade school also leaves it
        // without a successor), unplaced otherwise.
        const homeGrade = groupById.get(home!)?.gradeLevel ?? null;
        if (homeGrade !== null && homeGrade >= g) stats.graduating++;
        else stats.noSuccessor++;
        continue;
      }
      stats.copied++;
      writes.members.push({ groupKey: group.id, studentId });
    }
  }

  // ---- requirements
  const spanOf = (group: SourceGroup, row: ResolvedGroup): GradeSpan | null => {
    const own = row.successor?.gradeLevel ?? null;
    if (group.kind === 'TEACHING_GROUP') {
      const grades = (membersOf.get(group.id) ?? [])
        .map(projectedGrade)
        .filter((grade): grade is number => grade !== null);
      if (grades.length > 0) return { min: Math.min(...grades), max: Math.max(...grades) };
    }
    return own === null ? null : { min: own, max: own };
  };
  const requirementStats: RolloverPlan['requirements'] = {
    carried: 0,
    notCarried: 0,
    periodShifted: 0,
    periodBoundAnchored: 0,
    periodDropped: [],
    teachersCleared: [],
    qualificationWarnings: [],
    oddEvenRows: 0,
  };
  const carriedPerGroup = new Map<string, number>();
  const policy = {
    qualificationMode: source.qualificationMode,
    overAllocationMode: 'OFF' as const,
    overAllocationTolerancePercent: 0,
    fullTimeTeachingMinutesPerWeek: null,
  };
  for (const requirement of source.requirements) {
    const group = groupById.get(requirement.studentGroupId);
    const row = group ? resolvedById.get(group.id) : undefined;
    if (!group || !row || (!row.successor && !row.intake)) {
      requirementStats.notCarried++;
      continue;
    }
    const period = mapPeriod(requirement.startDate, requirement.endDate, sourceBounds, target, shift);
    const targetGroupName = row.successor?.name ?? row.intake?.name ?? group.name;
    if (period.status === 'DROPPED') {
      requirementStats.periodDropped.push({
        sourceRequirementId: requirement.id,
        subjectName: requirement.subjectName,
        groupName: group.name,
        startDate: requirement.startDate,
        endDate: requirement.endDate,
      });
      continue;
    }
    if (period.status === 'SHIFTED') requirementStats.periodShifted++;
    if (period.status === 'BOUND_ANCHORED') requirementStats.periodBoundAnchored++;
    if (requirement.recurrence !== 'ALL_WEEKS') requirementStats.oddEvenRows++;

    const base = {
      sourceRequirementId: requirement.id,
      subjectId: requirement.subjectId,
      lessonsPerWeek: requirement.lessonsPerWeek,
      minutesPerLesson: requirement.minutesPerLesson,
      ...(isMixed(requirement) ? { lessonLengths: [...requirement.lessonLengths] } : {}),
      minutesBefore: requirement.minutesBefore,
      minutesAfter: requirement.minutesAfter,
      // Each column only where it is not its default (COPY_UNLESS_DEFAULT).
      ...(requirement.ownDistribution ? { ownDistribution: true as const } : {}),
      ...(requirement.ownDistribution && requirement.maxLessonsPerDay !== null
        ? { maxLessonsPerDay: requirement.maxLessonsPerDay }
        : {}),
      ...(requirement.ownDistribution && requirement.minDaysBetween !== null
        ? { minDaysBetween: requirement.minDaysBetween }
        : {}),
      teacherLoadPercent: requirement.teacherLoadPercent,
      coTeacherLoadPercent: requirement.coTeacherLoadPercent,
      recurrence: requirement.recurrence,
      startDate: period.startDate,
      endDate: period.endDate,
    };

    if (row.successor) {
      let teacherId: string | null = null;
      let coTeacherId: string | null = null;
      if (options.keepTeachers) {
        const span = spanOf(group, row);
        const keep = (role: 'TEACHER' | 'CO_TEACHER', userId: string | null): string | null => {
          if (userId === null) return null;
          const clear = (reason: TeacherClearReason) => {
            requirementStats.teachersCleared.push({
              sourceRequirementId: requirement.id,
              subjectName: requirement.subjectName,
              groupName: targetGroupName,
              role,
              teacherId: userId,
              reason,
            });
            return null;
          };
          if (!source.activeTeacherIds.has(userId)) return clear('INACTIVE');
          // Against the row's own lead, kept or not: one person as both is
          // refused by every writer (SAME_TEACHER_TWICE in staffing-enforcement).
          if (role === 'CO_TEACHER' && userId === requirement.teacherId) return clear('SAME_TEACHER_TWICE');
          const finding = qualificationFinding({
            policy,
            qualifications: source.qualifications,
            userId,
            role,
            subject: { id: requirement.subjectId, name: requirement.subjectName },
            span,
            window: target,
          });
          if (finding?.mode === 'REFUSE') return clear('NOT_QUALIFIED');
          if (finding) {
            requirementStats.qualificationWarnings.push({
              sourceRequirementId: requirement.id,
              subjectName: requirement.subjectName,
              groupName: targetGroupName,
              role,
              teacherId: userId,
              grades: String(finding.params.grades),
            });
          }
          return userId;
        };
        teacherId = keep('TEACHER', requirement.teacherId);
        coTeacherId = keep('CO_TEACHER', requirement.coTeacherId);
      }
      writes.requirements.push({
        ...base,
        groupKey: group.id,
        teacherId,
        coTeacherId,
        ...(requirement.blockId ? { blockKey: requirement.blockId } : {}),
      });
      requirementStats.carried++;
      carriedPerGroup.set(group.id, (carriedPerGroup.get(group.id) ?? 0) + 1);
    }
    if (row.intake) {
      // The intake class reads what its grade read this year, taught by
      // whoever is staffed later: unpromoted, no teachers.
      writes.requirements.push({
        ...base,
        groupKey: intakeKey(group.id),
        teacherId: null,
        coTeacherId: null,
        ...(requirement.blockId ? { blockKey: intakeKey(requirement.blockId) } : {}),
      });
      requirementStats.carried++;
    }
  }
  // A carried group's årskurs this year and next, for its block's name: the
  // group's own when it has one, as its own name is promoted; else that of the
  // pupils carried with it, read from their classes as spanOf reads a teaching
  // group's span. Null where they differ, or where nobody is carried.
  const carriedPupils = new Map<string, string[]>();
  for (const member of writes.members) {
    carriedPupils.set(member.groupKey, [...(carriedPupils.get(member.groupKey) ?? []), member.studentId]);
  }
  const single = (grades: (number | null)[]): number | null => {
    const distinct = new Set(grades);
    return distinct.size === 1 ? [...distinct][0]! : null;
  };
  const cohortMove = (groupId: string): CohortMove => {
    const own = groupById.get(groupId)?.gradeLevel ?? null;
    if (own !== null) return { from: own, to: resolvedById.get(groupId)?.successor?.gradeLevel ?? null };
    const pupils = carriedPupils.get(groupId) ?? [];
    const homeGrade = (studentId: string): number | null => {
      const home = source.homeClassOf.get(studentId);
      return home ? (groupById.get(home)?.gradeLevel ?? null) : null;
    };
    return { from: single(pupils.map(homeGrade)), to: single(pupils.map(projectedGrade)) };
  };
  writes.blocks = planBlocks(source, writes.requirements, cohortMove);
  if (requirementStats.oddEvenRows > 0 && crossesIsoWeek53(sourceBounds.startDate, target.startDate)) {
    problems.push({ code: 'ISO_WEEK_53_CROSSED', blocking: false, params: { rows: requirementStats.oddEvenRows } });
  }

  // ---- lov
  const selected = new Map((request.breaks ?? []).map((choice) => [choice.sourceBreakId, choice]));
  const knownBreaks = new Set(source.breaks.map((lov) => lov.id));
  for (const id of selected.keys()) {
    if (!knownBreaks.has(id)) {
      problems.push({ code: 'ROLLOVER_UNKNOWN_BREAK', blocking: true, params: { sourceBreakId: id } });
    }
  }
  const breaks: RolloverPlan['breaks'] = source.breaks.map((lov) => {
    const proposal = proposeBreak(lov, sourceBounds, target);
    const choice = selected.get(lov.id);
    const startDateToWrite = choice ? (choice.startDate ?? proposal.proposedStart) : null;
    const endDateToWrite = choice ? (choice.endDate ?? proposal.proposedEnd) : null;
    if (choice) {
      if (startDateToWrite === null || endDateToWrite === null) {
        problems.push({ code: 'BREAK_NEEDS_DATES', blocking: true, params: { name: lov.name, startDate: lov.startDate } });
      } else if (
        startDateToWrite > endDateToWrite ||
        startDateToWrite < target.startDate ||
        endDateToWrite > target.endDate
      ) {
        problems.push({
          code: 'BREAK_OUTSIDE_YEAR',
          blocking: true,
          params: { name: lov.name, startDate: startDateToWrite, endDate: endDateToWrite },
        });
      } else {
        writes.breaks.push({
          sourceBreakId: lov.id,
          name: lov.name,
          kind: lov.kind,
          startDate: startDateToWrite,
          endDate: endDateToWrite,
          minGradeLevel: lov.minGradeLevel,
          maxGradeLevel: lov.maxGradeLevel,
        });
      }
    }
    return {
      sourceBreakId: lov.id,
      name: lov.name,
      startDate: lov.startDate,
      endDate: lov.endDate,
      ...proposal,
      selected: choice !== undefined,
      startDateToWrite,
      endDateToWrite,
    };
  });

  // ---- weekly class rules
  const classRules: RolloverPlan['classRules'] = [];
  if (options.carryClassRules) {
    for (const rule of source.classRules) {
      const group = groupById.get(rule.studentGroupId);
      const row = group ? resolvedById.get(group.id) : undefined;
      if (!group || !row?.successor) continue;
      const stageChange =
        row.outcome !== 'CARRY' && group.gradeLevel !== null && frameChanges(source.frames, group.gradeLevel);
      classRules.push({
        sourceConstraintId: rule.id,
        sourceGroupName: group.name,
        targetGroupName: row.successor.name,
        dayOfWeek: rule.dayOfWeek,
        startTime: clock(rule.startTime),
        endTime: clock(rule.endTime),
        stageChange,
      });
      writes.classRules.push({
        sourceConstraintId: rule.id,
        groupKey: group.id,
        dayOfWeek: rule.dayOfWeek,
        startTime: rule.startTime,
        endTime: rule.endTime,
        type: rule.type,
        reason: rule.reason,
        minGradeLevel: rule.minGradeLevel,
        maxGradeLevel: rule.maxGradeLevel,
      });
    }
  }

  // ---- timplan per årskurs, by cohort
  // A cohort is a class that moves up a grade, not an attachment row.
  const movingCohorts = new Set<number>();
  for (const row of resolved) {
    const group = groupById.get(row.sourceGroupId)!;
    if (group.kind === 'CLASS' && group.gradeLevel !== null && row.successor?.gradeLevel === group.gradeLevel + 1) {
      movingCohorts.add(group.gradeLevel);
    }
  }
  const timplans = planCohortTimplans({
    source: source.timplans,
    graduatingGradeLevel: g,
    movingCohorts,
    decided: source.decidedTimplans,
    targetStartYear: Number(target.startDate.slice(0, 4)),
  });
  for (const row of timplans) {
    writes.timplans.push({ gradeLevel: row.gradeLevel, localTimplanId: row.localTimplanId });
  }

  // ---- volume against the plan the target grade will follow
  // That is the new year's timplan row for the grade (carried or default),
  // a draft included — the plan the coverage report will measure the class
  // against — and only when the plan gives the grade any minutes at all.
  const followed = new Map(timplans.map((row) => [row.gradeLevel, row]));
  const planFor = (grade: number) => {
    const row = followed.get(grade);
    if (!row) return null;
    const entries = (source.planEntries.get(row.localTimplanId) ?? []).filter((entry) => entry.gradeLevel === grade);
    return entries.length > 0 ? { name: row.planName, entries } : null;
  };
  const volumeOf = new Map<string, { findings: PlannedGroup['volumeFindings']; planName: string | null }>();
  for (const row of resolved) {
    const group = groupById.get(row.sourceGroupId)!;
    if (group.kind !== 'CLASS' || !row.successor || row.successor.gradeLevel === null || row.outcome === 'CARRY') {
      continue;
    }
    const plan = planFor(row.successor.gradeLevel);
    if (!plan) continue;
    const planned = new Map(
      plan.entries
        .filter((entry) => entry.gradeLevel === row.successor!.gradeLevel)
        .map((entry) => [entry.subjectId, entry.minutesPerWeek] as const),
    );
    const rows = writes.requirements.filter((written) => written.groupKey === group.id);
    const findings = volumeFindings(rows, planned, target).map((finding) => ({
      ...finding,
      subjectName: source.subjectNames.get(finding.subjectId) ?? '',
    }));
    volumeOf.set(group.id, { findings, planName: plan.name });
  }
  const differing = [...volumeOf.entries()].filter(([, volume]) => volume.findings.length > 0);
  if (differing.length > 0) {
    problems.push({
      code: 'VOLUME_DIFFERS_FROM_TIMPLAN',
      blocking: false,
      params: { groups: differing.map(([id]) => resolvedById.get(id)!.successor!.name).sort() },
    });
  }

  // ---- tjänster and uppdrag, when asked for
  let staffing: StaffingCarryPreview | null = null;
  if (options.carryStaffing) {
    const carry = planStaffingCarry({
      staffing: source.staffing!,
      sourceYearEndDate: source.year.endDate,
      // The successor the groups step writes, keyed by the source group as
      // every other step maps a group; an INTAKE twin continues nothing.
      successorOf: (sourceGroupId) => {
        const successor = resolvedById.get(sourceGroupId)?.successor;
        return successor ? { key: sourceGroupId, name: successor.name } : null;
      },
      groupName: (sourceGroupId) => groupById.get(sourceGroupId)?.name ?? null,
      existing: null,
    });
    writes.staffing = carry.writes;
    staffing = carry.preview;
    problems.push(...carry.problems);
  }

  // ---- left behind
  if (!options.carryStaffing && source.skipped.duties > 0) {
    problems.push({
      code: 'DUTY_SLOTS_NOT_CARRIED',
      blocking: false,
      params: {
        duties: source.skipped.duties,
        blockedSlots: source.skipped.dutyBlockedSlots,
        mentorskap: source.skipped.mentorskap,
      },
    });
  }
  const counts: Record<string, number> = {
    MasterLesson: source.skipped.masterLessons,
    LunchSitting: source.skipped.lunchSittings,
    TeacherEmployment: source.skipped.employments,
    TeacherDuty: source.skipped.duties,
    TeacherDutySlot: source.skipped.dutyBlockedSlots,
  };
  const skipped = skippedModels({ carryStaffing: options.carryStaffing }).map((entry) => ({
    model: entry.model,
    reason: entry.reason,
    count: entry.counted ? (counts[entry.model] ?? 0) : null,
  }));

  const groups: PlannedGroup[] = resolved.map((row) => {
    const group = groupById.get(row.sourceGroupId)!;
    const stats = memberStats.get(group.id)!;
    return {
      sourceGroupId: group.id,
      sourceName: group.name,
      kind: group.kind,
      sourceGradeLevel: group.gradeLevel,
      outcome: row.outcome,
      targetName: row.successor?.name ?? null,
      targetGradeLevel: row.successor?.gradeLevel ?? null,
      intakeName: row.intake?.name ?? null,
      nameStatus: row.nameStatus,
      noGrade: row.noGrade,
      error: row.error,
      collision: colliding.has(group.id),
      caseCollision: caseColliding.has(group.id),
      homePupils: source.homePupils.get(group.id)?.length ?? 0,
      membersCopied: stats.copied,
      membersExcluded: { graduating: stats.graduating, noSuccessor: stats.noSuccessor },
      membersStranded: stats.stranded,
      requirementsCarried: carriedPerGroup.get(group.id) ?? 0,
      volumeFindings: volumeOf.get(group.id)?.findings ?? [],
      volumePlanName: volumeOf.get(group.id)?.planName ?? null,
    };
  });

  return {
    source: { id: source.year.id, name: source.year.name, ...sourceBounds },
    target: {
      name,
      ...target,
      dateShiftDays: shift,
      crossesIsoWeek53: crossesIsoWeek53(sourceBounds.startDate, target.startDate),
    },
    graduatingGradeLevel: graduating,
    graduatingGradeSource: fromRequest !== undefined ? 'REQUEST' : fallback.source,
    graduatingGradeConflict: fallback.conflict,
    groups,
    requirements: requirementStats,
    breaks,
    classRules,
    timplans,
    staffing,
    skipped,
    problems,
    blocking: problems.some((problem) => problem.blocking),
    planHash: hashWrites(writes),
    writes,
  };
}

/**
 * The hash of what the execute would write, in a fixed order. Covers the
 * rows, never the warnings: a WARN-mode finding that appears between preview
 * and execute does not change a row, so it does not make the preview stale.
 */
export function hashWrites(writes: RolloverWrites): string {
  const ordered = {
    year: writes.year,
    groups: [...writes.groups].sort((a, b) => (a.key < b.key ? -1 : 1)),
    members: [...writes.members].sort((a, b) =>
      `${a.groupKey}|${a.studentId}` < `${b.groupKey}|${b.studentId}` ? -1 : 1,
    ),
    requirements: [...writes.requirements].sort((a, b) =>
      `${a.groupKey}|${a.sourceRequirementId}` < `${b.groupKey}|${b.sourceRequirementId}` ? -1 : 1,
    ),
    // Appended only when blocks are carried, so a school without blocks
    // hashes what it always did.
    ...(writes.blocks.length > 0
      ? { blocks: [...writes.blocks].sort((a, b) => (a.key < b.key ? -1 : 1)) }
      : {}),
    breaks: [...writes.breaks].sort((a, b) => (a.sourceBreakId < b.sourceBreakId ? -1 : 1)),
    classRules: [...writes.classRules]
      .sort((a, b) => (a.sourceConstraintId < b.sourceConstraintId ? -1 : 1))
      .map((rule) => ({ ...rule, startTime: clock(rule.startTime), endTime: clock(rule.endTime) })),
    timplans: [...writes.timplans].sort((a, b) => a.gradeLevel - b.gradeLevel),
    // Appended only when tjänster are carried: without the option the JSON,
    // and so the hash, is fa4a3d6's to the byte (pinned in the service spec).
    ...(writes.staffing !== null ? { staffing: stableStaffing(writes.staffing) } : {}),
  };
  return createHash('sha256').update(JSON.stringify(ordered)).digest('hex');
}

/**
 * Parallella block: one copy per source block and side, holding the rows
 * carried with it.
 *
 * A block follows its rows, as the rows follow their groups. The rows carried
 * to the successor groups make one copy, named as the groups are promoted:
 * promoteName() at the årskurs the carried rows' cohorts are in, when every
 * one of them moves one årskurs up, so "Språkval åk 7" over Ty7, Fr7 and Sp7
 * becomes "Språkval åk 8". A cohort's årskurs is its group's, or, for a
 * språkval group without one, that of the pupils carried with it (cohortMove
 * in planRollover). Only the rows carried count, and next year's årskurs is
 * the one resolved for the new year, not this year's plus one.
 *
 * A NAME THAT WOULD SAY THE WRONG YEAR IS NOT KEPT AS IT IS. Members in
 * different årskurser, or one carried at its årskurs (CARRY), keep the name:
 * their groups say which årskurs they are. But a copy whose cohort's årskurs
 * is unknown — groups without one and no pupils carried, or pupils from
 * several — would keep "Språkval åk 7" over last year's cohort, and next
 * year's "Skapa timplansposter" for åk 7 upserts its block by that name and
 * would put the new språkval in it, with nothing left to say the groups are
 * another årskurs'. So such a name takes the source year's name: "Språkval
 * åk 7 (2026/27)". Only a name "Skapa timplansposter" could upsert by
 * (isLanguageBlockName) is at risk, so only that one takes it: "Elevens val
 * åk 7–9" over pupils of several årskurser keeps its name, and a name that
 * already took a year's is not given another at the next rollover.
 *
 * The rows carried to the intake twins make a second copy under the source's
 * own name, as the twins keep theirs. A copy holding no carried row is not
 * written.
 *
 * The rows' lessons and weeks are carried as they are and their periods by
 * one rule, so a block whose rows agreed agrees in the new year as well, and
 * the trigger of 20261024090000 holds the insert to it.
 *
 * NAMES ARE UNIQUE IN THE NEW YEAR: successor copies first, then intake ones,
 * each by name and then by source id, and a name another copy already took
 * gets " (2)", " (3)" …, cut to the 80 characters a block name may have.
 */
function planBlocks(
  source: RolloverSource,
  rows: RolloverWrites['requirements'],
  cohortMove: (sourceGroupId: string) => CohortMove,
): RolloverWrites['blocks'] {
  if (source.blocks.length === 0) return [];
  const used = new Set(rows.flatMap((row) => (row.blockKey ? [row.blockKey] : [])));
  const copies = source.blocks.flatMap((block) => {
    const sides: { key: string; sourceBlockId: string; name: string; intake: boolean }[] = [];
    if (used.has(block.id)) {
      // A successor row's groupKey is its source group's id.
      const moves = rows.filter((row) => row.blockKey === block.id).map((row) => cohortMove(row.groupKey));
      const from = moves[0]?.from ?? null;
      const promoted = from !== null && moves.every((move) => move.from === from && move.to === from + 1);
      const unknown = moves.some((move) => move.from === null || move.to === null);
      const name = promoted
        ? promoteName(block.name, from).name
        : unknown && isLanguageBlockName(block.name)
          ? withSuffix(block.name, ` (${source.year.name})`)
          : block.name;
      sides.push({ key: block.id, sourceBlockId: block.id, name, intake: false });
    }
    if (used.has(intakeKey(block.id))) {
      sides.push({ key: intakeKey(block.id), sourceBlockId: block.id, name: block.name, intake: true });
    }
    return sides;
  });
  copies.sort(
    (a, b) =>
      Number(a.intake) - Number(b.intake) ||
      a.name.localeCompare(b.name, 'sv') ||
      (a.sourceBlockId < b.sourceBlockId ? -1 : a.sourceBlockId > b.sourceBlockId ? 1 : 0),
  );
  const taken = new Set<string>();
  return copies.map(({ key, sourceBlockId, name }) => {
    let unique = name;
    for (let n = 2; taken.has(unique); n++) unique = withSuffix(name, ` (${n})`);
    taken.add(unique);
    return { key, sourceBlockId, name: unique };
  });
}

/** TeachingBlocks_name_is_sane's bound. */
const BLOCK_NAME_MAX = 80;

/** A carried row's cohort: its årskurs this year and next, null where unknown. */
interface CohortMove {
  from: number | null;
  to: number | null;
}

/** `name` and `suffix`, the name cut to keep within BLOCK_NAME_MAX. */
const withSuffix = (name: string, suffix: string): string =>
  `${name.slice(0, BLOCK_NAME_MAX - suffix.length).trimEnd()}${suffix}`;

/** The plan as the API answers it: everything but the rows to write. */
export function previewOf(plan: RolloverPlan): Omit<RolloverPlan, 'writes'> {
  const { writes: _writes, ...preview } = plan;
  return preview;
}
