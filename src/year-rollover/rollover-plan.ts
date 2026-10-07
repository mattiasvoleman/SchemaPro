import { createHash } from 'node:crypto';
import type { BreakKind, ConstraintType, LessonRecurrence, StudentGroupKind } from '@prisma/client';
import {
  crossesIsoWeek53,
  dateShiftDays,
  defaultGraduatingGrade,
  frameChanges,
  mapPeriod,
  nameCollisions,
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
import { qualificationFinding } from '../staffing/staffing-checks';
import type { GradeSpan } from '../staffing/teacher-load';
import { skippedModels } from './rollover-registry';
import type { RolloverSource, SourceGroup } from './rollover-source';

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
  | 'ISO_WEEK_53_CROSSED';

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
    minutesBefore: number;
    minutesAfter: number;
    teacherLoadPercent: number;
    coTeacherLoadPercent: number;
    recurrence: LessonRecurrence;
    startDate: string | null;
    endDate: string | null;
  }[];
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
  skipped: { model: string; reason: string; count: number | null }[];
  problems: RolloverProblem[];
  blocking: boolean;
  planHash: string;
  /** Not part of the response: what the execute writes. */
  writes: RolloverWrites;
}

const clock = (value: Date): string => value.toISOString().slice(11, 16);

export function planRollover(source: RolloverSource, request: RolloverRequest): RolloverPlan {
  const options = {
    carryTeachingGroups: request.carryTeachingGroups ?? true,
    carryTeachingGroupMembers: request.carryTeachingGroupMembers ?? true,
    keepTeachers: request.keepTeachers ?? true,
    carryClassRules: request.carryClassRules ?? true,
  };
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
    breaks: [],
    classRules: [],
  };
  for (const row of resolved) {
    const group = groupById.get(row.sourceGroupId)!;
    if (row.successor) {
      writes.groups.push({
        key: group.id,
        name: row.successor.name,
        kind: group.kind,
        gradeLevel: row.successor.gradeLevel,
        predecessorId: group.id,
      });
    }
    if (row.intake) {
      writes.groups.push({
        key: intakeKey(group.id),
        name: row.intake.name,
        kind: group.kind,
        gradeLevel: row.intake.gradeLevel,
        predecessorId: null,
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
      if (!options.carryTeachingGroupMembers) continue;
      if (homeLeaves) {
        if (homeRow!.outcome === 'GRADUATE') stats.graduating++;
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
      minutesBefore: requirement.minutesBefore,
      minutesAfter: requirement.minutesAfter,
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
      writes.requirements.push({ ...base, groupKey: group.id, teacherId, coTeacherId });
      requirementStats.carried++;
      carriedPerGroup.set(group.id, (carriedPerGroup.get(group.id) ?? 0) + 1);
    }
    if (row.intake) {
      // The intake class reads what its grade read this year, taught by
      // whoever is staffed later: unpromoted, no teachers.
      writes.requirements.push({ ...base, groupKey: intakeKey(group.id), teacherId: null, coTeacherId: null });
      requirementStats.carried++;
    }
  }
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
    const proposal = proposeBreak(lov, sourceBounds, target, shift);
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

  // ---- volume against the newest decided plan for the target grade
  const planFor = (grade: number) =>
    [...source.decidedPlans]
      .filter((plan) => plan.entries.some((entry) => entry.gradeLevel === grade))
      .sort((a, b) => (a.decidedAt < b.decidedAt ? 1 : -1))[0] ?? null;
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

  // ---- left behind
  if (source.skipped.duties > 0) {
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
  };
  const skipped = skippedModels().map((entry) => ({
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
    breaks: [...writes.breaks].sort((a, b) => (a.sourceBreakId < b.sourceBreakId ? -1 : 1)),
    classRules: [...writes.classRules]
      .sort((a, b) => (a.sourceConstraintId < b.sourceConstraintId ? -1 : 1))
      .map((rule) => ({ ...rule, startTime: clock(rule.startTime), endTime: clock(rule.endTime) })),
  };
  return createHash('sha256').update(JSON.stringify(ordered)).digest('hex');
}

/** The plan as the API answers it: everything but the rows to write. */
export function previewOf(plan: RolloverPlan): Omit<RolloverPlan, 'writes'> {
  const { writes: _writes, ...preview } = plan;
  return preview;
}
