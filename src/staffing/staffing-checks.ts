import { ConflictException } from '@nestjs/common';
import type { StaffingCheckMode } from '@prisma/client';
import { changesDuringYear } from './employment-periods';
import { scopeOfTeacher, type ScopeVersion, type TeacherScope } from './assignment-scope';
import {
  countedMinutesByTeacher,
  loadStatus,
  stretchLoads,
  strongestCoveringQualification,
  targetMinutesPerWeek,
  type GradeSpan,
  type JudgedYear,
  type LoadEmployment,
  type LoadInput,
  type LoadQualification,
  type LoadRequirement,
  type StretchLoad,
} from './teacher-load';

/*
 * Tjänstefördelningens två frågor vid varje skrivning, ställda på ETT ställe.
 *
 * Every write that puts a teacher on teaching — a timplanspost created or
 * PATCHed, a row of the requirements import, a master lesson re-teachered, a
 * vikarie assigned — asks one or both of the same two questions, and this module
 * is the only place they are asked:
 *
 *   STAFF_TEACHER_NOT_QUALIFIED — does the teacher hold a behörighet in the
 *     subject whose span contains the group's derived grade span, valid in the
 *     window the write is about? The rule is qualificationCovers in
 *     teacher-load.ts, the one the report's unqualified list and the
 *     suggest-teachers badge already read, so a badge, a warning and a refusal
 *     cannot disagree about the same teacher.
 *
 *   STAFF_TEACHER_OVER_TARGET — would the write put the teacher past target ×
 *     (1 + tolerance / 100)? loadStatus over countedMinutesByTeacher, the
 *     figures the matrix's status and the picker's wouldExceed read — loadStatus
 *     judging their whole minutes, as all three print them — so the threshold
 *     here is the threshold there, and `minutes` is never at or under `limit`.
 *
 *   STAFF_TEACHER_OVER_SCOPE — would the write take the teacher's teaching hours over the läsår past the upper
 *     edge of the ordinance's span for their stage (SFS 2026:1487 3 §, assignment-scope.ts)? The same arithmetic as the
 *     report's `scope` block, in clock hours, unweighted: NOT the riktmärke of the question above, which is the school's
 *     own measure, so the two answer for themselves and a teacher can be inside one and over the other. Only the upper edge
 *     is asked: inside the span is the rektor's judgement (8 §), never a refusal. Asked only when the caller hands the
 *     lydelser in (`scopeVersions`), and only of a teacher who ends up over AND with more hours than before.
 *
 * Each is governed by its own policy mode. OFF asks nothing; WARN lets the write
 * through and hands back `warnings: [{ code, params }]`; REFUSE answers 409 with
 * the same code and params. The params are the catalogue's (optimization-engine
 * app/messages.py, rendered by the web from web/messages/*.json under
 * engineMessages), so the Swedish a 409 carries in `detail` and the sentence
 * the web renders from the code are the same sentence.
 *
 * THE QUALIFICATION QUESTION IS ASKED ONLY WHEN THE SCHOOL HAS SAID SOMETHING.
 * Zero behörighet rows is not the statement that nobody is qualified, and the
 * report (qualificationsRecorded) and the substitute picker already read it so.
 * A school that switches qualificationMode to REFUSE before recording a single
 * behörighet would otherwise be refused every assignment it makes.
 *
 * A WRITE THAT DOES NOT ADD TO A TEACHER'S LOAD IS NEVER OVER TARGET. A teacher
 * already at 130 % whose row loses a lesson is still over after the write — and
 * refusing that PATCH would refuse the very fix. So the question is "does this
 * write take them past the limit", asked as: over after, AND more after than
 * before. The same holds for a PATCH that changes nothing a load is made of.
 *
 * A POST THAT CHANGES DURING THE YEAR IS JUDGED IN THE STRETCH THE ROW RUNS IN
 * (migration 20261022120000). A teacher whose post has periods is asked the
 * load question stretch by stretch (teacher-load.ts stretchLoads, the
 * report's own arithmetic): before and after the write, in date order, and
 * the first stretch with teaching weeks the write takes past its own limit
 * answers — STAFF_TEACHER_OVER_TARGET_IN_PERIOD, naming the stretch's dates.
 * A row that runs only in the autumn adds nothing to the spring, so it can
 * only be refused for the autumn's figures. A teacher without periods is
 * asked exactly as before. A reader who may not see how a post changes
 * (Roller i skolan, without HR-läs) gets the same verdict as
 * STAFF_TEACHER_OVER_TARGET_HIDDEN, without the stretch's figures.
 *
 * PARAMS NAME A SUBJECT AND A SPAN, NEVER A PERSON. The admin who made the write
 * knows whom they assigned; the role ('TEACHER', 'CO_TEACHER', 'SUBSTITUTE')
 * says which of the row's teachers the sentence is about.
 *
 * PURE. The rows come in; nothing here reads a database or a clock.
 */

export const STAFF_TEACHER_NOT_QUALIFIED = 'STAFF_TEACHER_NOT_QUALIFIED' as const;
export const STAFF_TEACHER_OVER_TARGET = 'STAFF_TEACHER_OVER_TARGET' as const;
/** The same question in one stretch of a post that changes during the year. */
export const STAFF_TEACHER_OVER_TARGET_IN_PERIOD = 'STAFF_TEACHER_OVER_TARGET_IN_PERIOD' as const;
/**
 * The same verdict, for a reader who may not see how the post changes
 * (CheckPolicy.showsPeriods): no minutes, target, limit or dates.
 */
export const STAFF_TEACHER_OVER_TARGET_HIDDEN = 'STAFF_TEACHER_OVER_TARGET_HIDDEN' as const;
/** The ordinance's highest level of teaching time per läsår (SFS 2026:1487 3 §); see assignment-scope.ts. */
export const STAFF_TEACHER_OVER_SCOPE = 'STAFF_TEACHER_OVER_SCOPE' as const;
/**
 * The same verdict for a reader without HR-läs (CheckPolicy.showsPeriods): the upper edge is the ordinance's span times the
 * post, which gives the post's percentage back, so no hours and no limit.
 */
export const STAFF_TEACHER_OVER_SCOPE_HIDDEN = 'STAFF_TEACHER_OVER_SCOPE_HIDDEN' as const;
/** The generate pre-flight's refusal; see OptimizationProxyService. */
export const STAFF_UNSTAFFED_REQUIREMENTS = 'STAFF_UNSTAFFED_REQUIREMENTS' as const;

export type StaffingCheckCode =
  | typeof STAFF_TEACHER_NOT_QUALIFIED
  | typeof STAFF_TEACHER_OVER_TARGET
  | typeof STAFF_TEACHER_OVER_TARGET_IN_PERIOD
  | typeof STAFF_TEACHER_OVER_TARGET_HIDDEN
  | typeof STAFF_TEACHER_OVER_SCOPE
  | typeof STAFF_TEACHER_OVER_SCOPE_HIDDEN;

/** Which of a write's teachers a finding is about. */
export type StaffingRole = 'TEACHER' | 'CO_TEACHER' | 'SUBSTITUTE';

/** Scalars only, as the engine's catalogue takes them. */
export type StaffingParams = Record<string, string | number>;

/** What a WARN-mode write hands back beside the row. */
export interface StaffingWarning {
  code: StaffingCheckCode;
  params: StaffingParams;
}

/** One answer to one of the two questions, before the mode decides its fate. */
export interface StaffingFinding extends StaffingWarning {
  mode: 'WARN' | 'REFUSE';
  /** Whom it is about — kept for the caller, never put in a message or a log. */
  userId: string;
}

/** The policy fields the two questions read. */
export interface CheckPolicy {
  qualificationMode: StaffingCheckMode;
  overAllocationMode: StaffingCheckMode;
  overAllocationTolerancePercent: number;
  fullTimeTeachingMinutesPerWeek: number | null;
  /**
   * What a write that takes a teacher over the ordinance's highest level of teaching time may do (STAFF_TEACHER_OVER_SCOPE).
   * Absent reads as OFF, so a policy built before the column asks nothing new; the table's own default is WARN.
   */
  assignmentScopeMode?: StaffingCheckMode;
  /**
   * Whether the reader may see when and how a post changes during the year
   * (Roller i skolan: rektor, full and HR-läs, src/staffing/hr-visibility.ts).
   * False words a changing post's finding as STAFF_TEACHER_OVER_TARGET_HIDDEN:
   * the same verdict, without the stretch's minutes, target, limit and dates,
   * which would give back the post's level in that stretch. Absent reads as
   * true: the policy alone names no reader.
   */
  showsPeriods?: boolean;
}

/**
 * The table's own defaults: both checks WARN, ten percent, no riktmärke. A
 * school that has never saved the form is checked exactly as it would be the
 * moment it saves it untouched — which with no riktmärke means the over-target
 * question is inert for everybody without a per-teacher target.
 */
export const DEFAULT_CHECK_POLICY: CheckPolicy = {
  qualificationMode: 'WARN',
  overAllocationMode: 'WARN',
  overAllocationTolerancePercent: 10,
  fullTimeTeachingMinutesPerWeek: null,
  assignmentScopeMode: 'WARN',
};

/** The ordinance question's mode: OFF when the policy says nothing (a policy from before the column). */
export function scopeModeOf(policy: CheckPolicy): StaffingCheckMode {
  return policy.assignmentScopeMode ?? 'OFF';
}

/** Whether a policy asks any of the questions at all. */
export function checksAnything(policy: CheckPolicy): boolean {
  return policy.qualificationMode !== 'OFF' || policy.overAllocationMode !== 'OFF' || scopeModeOf(policy) !== 'OFF';
}

/**
 * A year span as the catalogue's sentences take it: "7", "7–9", or "any" when
 * the group's years cannot be derived. An EN DASH, as the engine's own
 * _grade_span_text writes it, so a gateway sentence and an engine sentence
 * print a span the same way.
 */
export function gradesParam(span: GradeSpan | null): string {
  if (span === null) return 'any';
  return span.min === span.max ? String(span.min) : `${span.min}–${span.max}`;
}

/**
 * Question one, for one teacher on one write.
 *
 * `window` is what "valid" means for this write: the läsår for a timplanspost or
 * a master lesson (valid at some point of it — the rule the report reads, so a
 * legitimation starting in August is not refused while next year is planned in
 * spring), the lesson's own date for a vikarie.
 */
export function qualificationFinding(args: {
  policy: CheckPolicy;
  /** Every behörighet row the school has; only `userId`'s are read. */
  qualifications: readonly LoadQualification[];
  userId: string;
  role: StaffingRole;
  subject: { id: string; name: string };
  span: GradeSpan | null;
  /** With the läsår's numbering when it is tioårig (qualificationCovers). */
  window: JudgedYear;
}): StaffingFinding | null {
  const mode = args.policy.qualificationMode;
  if (mode === 'OFF') return null;
  if (args.qualifications.length === 0) return null;
  const held = strongestCoveringQualification(
    args.qualifications as LoadQualification[],
    args.userId,
    { subjectId: args.subject.id, gradeSpan: args.span },
    args.window,
  );
  if (held !== null) return null;
  return {
    code: STAFF_TEACHER_NOT_QUALIFIED,
    mode,
    userId: args.userId,
    params: { role: args.role, subject: args.subject.name, grades: gradesParam(args.span) },
  };
}

/**
 * Question two, for one teacher: `before` and `after` are their counted
 * minutes (teaching at each row's percentage + uppdrag that count) without and
 * with the write, unrounded.
 */
export function overTargetFinding(args: {
  policy: CheckPolicy;
  employment: LoadEmployment | null;
  userId: string;
  role: StaffingRole;
  before: number;
  after: number;
}): StaffingFinding | null {
  const mode = args.policy.overAllocationMode;
  if (mode === 'OFF') return null;
  const target = targetMinutesPerWeek(args.employment, {
    fullTimeTeachingMinutesPerWeek: args.policy.fullTimeTeachingMinutesPerWeek,
    overAllocationTolerancePercent: args.policy.overAllocationTolerancePercent,
    // Not read by targetMinutesPerWeek; stated so the type is whole.
    fullTimeRegulatedHoursPerYear: 0,
    workDaysPerYear: 0,
    qualificationMode: args.policy.qualificationMode,
  });
  if (target === null) return null;
  // Floating-point noise from the weights must not read as "added load".
  if (args.after <= args.before + 1e-9) return null;
  const tolerance = args.policy.overAllocationTolerancePercent;
  if (loadStatus(args.after, target, tolerance) !== 'OVER') return null;
  return {
    code: STAFF_TEACHER_OVER_TARGET,
    mode,
    userId: args.userId,
    params: {
      role: args.role,
      minutes: Math.round(args.after),
      target,
      limit: Math.floor(target + (target * tolerance) / 100),
      tolerance,
    },
  };
}

/**
 * Question two for a teacher whose post changes during the year: `before` and
 * `after` are stretchLoads of their post without and with the write, stretch
 * for stretch. The first stretch, in date order, that holds teaching weeks,
 * has a target, and that the write takes past its limit while adding to it
 * answers, with its own minutes, target and dates.
 */
export function overTargetFindingByStretch(args: {
  policy: CheckPolicy;
  employment: LoadEmployment;
  userId: string;
  role: StaffingRole;
  before: readonly StretchLoad[];
  after: readonly StretchLoad[];
}): StaffingFinding | null {
  const mode = args.policy.overAllocationMode;
  if (mode === 'OFF') return null;
  const tolerance = args.policy.overAllocationTolerancePercent;
  for (const [index, stretch] of args.after.entries()) {
    if (stretch.weeks === 0) continue;
    const target = targetMinutesPerWeek(
      { ...args.employment, ...stretch.stretch.figures },
      {
        fullTimeTeachingMinutesPerWeek: args.policy.fullTimeTeachingMinutesPerWeek,
        overAllocationTolerancePercent: tolerance,
        // Not read by targetMinutesPerWeek; stated so the type is whole.
        fullTimeRegulatedHoursPerYear: 0,
        workDaysPerYear: 0,
        qualificationMode: args.policy.qualificationMode,
      },
    );
    if (target === null) continue;
    const before = args.before[index]?.counted ?? 0;
    if (stretch.counted <= before + 1e-9) continue;
    if (loadStatus(stretch.counted, target, tolerance) !== 'OVER') continue;
    // A reader who may not see how the post changes gets the verdict alone
    // (CheckPolicy.showsPeriods). The stretch is still what is judged: the
    // rule is the same whoever writes.
    if (args.policy.showsPeriods === false) {
      return {
        code: STAFF_TEACHER_OVER_TARGET_HIDDEN,
        mode,
        userId: args.userId,
        params: { role: args.role, tolerance },
      };
    }
    return {
      code: STAFF_TEACHER_OVER_TARGET_IN_PERIOD,
      mode,
      userId: args.userId,
      params: {
        role: args.role,
        minutes: Math.round(stretch.counted),
        target,
        limit: Math.floor(target + (target * tolerance) / 100),
        tolerance,
        from: stretch.stretch.from,
        to: stretch.stretch.to,
      },
    };
  }
  return null;
}

/**
 * Question two for one teacher of a write: per stretch when their post
 * changes during the year, otherwise over the year as always. `input` is the
 * year before the write, `after` the same year's requirements with it.
 */
function overTargetOfWrite(args: {
  policy: CheckPolicy;
  input: LoadInput;
  requirementsAfter: LoadRequirement[];
  employment: LoadEmployment | null;
  userId: string;
  role: StaffingRole;
  before: () => number;
  after: () => number;
}): StaffingFinding | null {
  const { employment } = args;
  if (employment !== null && changesDuringYear(employment, args.input.year)) {
    return overTargetFindingByStretch({
      policy: args.policy,
      employment,
      userId: args.userId,
      role: args.role,
      before: stretchLoads(args.input, employment),
      after: stretchLoads({ ...args.input, requirements: args.requirementsAfter }, employment),
    });
  }
  return overTargetFinding({
    policy: args.policy,
    employment,
    userId: args.userId,
    role: args.role,
    before: args.before(),
    after: args.after(),
  });
}

/**
 * Question three, for one teacher: `before` and `after` are their scope over the year (scopeOfTeacher) without and with the
 * write. It answers only when the teacher ends OVER the ordinance's highest level (3 §) AND the write added hours: a write
 * that adds nothing is never refused for a state the school is already in, which would refuse the very fix. The levels
 * under the upper edge, a teacher's own level (8 §) and the planning floor are the report's to show, never a write's to
 * refuse.
 */
export function overScopeFinding(args: {
  policy: CheckPolicy;
  userId: string;
  role: StaffingRole;
  before: TeacherScope | null;
  after: TeacherScope | null;
}): StaffingFinding | null {
  const mode = scopeModeOf(args.policy);
  if (mode === 'OFF') return null;
  const after = args.after;
  if (after === null || after.verdict !== 'OVER_MAX' || after.ordinanceHighestHours === null) return null;
  // OVER_MAX is judged on the hours in a stage (T7: förskoleklass and groups with no årskurs are counted in the total and are no reason
  // to say over), so the write is asked about those hours too: a write that adds no hour in a stage adds nothing to what makes the
  // teacher over, and a teacher who is over only in the stages is not refused a row of förskoleklass. The printed hours: a write that
  // moves them by less than a tenth added nothing a person could read.
  const shown = stageHoursOf(after);
  if (shown <= (args.before ? stageHoursOf(args.before) : 0) + 1e-9) return null;
  if (args.policy.showsPeriods === false) {
    return { code: STAFF_TEACHER_OVER_SCOPE_HIDDEN, mode, userId: args.userId, params: { role: args.role } };
  }
  return {
    code: STAFF_TEACHER_OVER_SCOPE,
    mode,
    userId: args.userId,
    // The hours the line is judged against: the stage hours, never less than a tenth over the line (the three figures round apart).
    params: {
      role: args.role,
      hours: hoursText(Math.max(shown, Math.round((after.ordinanceHighestHours + 0.1) * 10) / 10)),
      limit: hoursText(after.ordinanceHighestHours),
    },
  };
}

/** The hours that lie in a stage, one decimal: the total less förskoleklass and the groups with no årskurs (the same figure the card's "över med" reads). */
function stageHoursOf(scope: TeacherScope): number {
  return Math.round((scope.teachingHours - scope.unregulatedHours - scope.unknownGradeHours) * 10) / 10;
}

/** Hours as a sentence prints them: whole when whole, else one decimal with the Swedish comma ("602", "478,1"). */
export function hoursText(hours: number): string {
  return Number.isInteger(hours) ? String(hours) : hours.toFixed(1).replace('.', ',');
}

/**
 * Both questions for one timplanspost write.
 *
 * `input` is the year as read BEFORE the write — an update's own row
 * included, as it stood. `before` is that row (null for a create); `after` is
 * the row as the write leaves it. The qualification question is asked of a
 * role only when the write puts somebody new in it — re-saving a row with the
 * teacher it already had is not an assignment. The load question is asked of
 * every teacher the row ends up with, and answers only when their load grows
 * past the limit (see the header).
 *
 * Findings in a fixed order — lead before co-teacher before the shares'
 * teachers, behörighet before load — so the 409 a REFUSE answers with is the
 * same for the same write every time.
 */
export function judgeRequirementWrite(args: {
  input: LoadInput;
  policy: CheckPolicy;
  before: LoadRequirement | null;
  after: LoadRequirement;
  subjectName: string;
  /**
   * Every lydelse of the ordinance (readScopeVersions), for STAFF_TEACHER_OVER_SCOPE. Absent: the question is not asked,
   * whatever the policy's mode says (a caller that has not read them).
   */
  scopeVersions?: readonly ScopeVersion[];
}): StaffingFinding[] {
  const { input, policy, before, after } = args;
  if (!checksAnything(policy)) return [];

  const requirementsAfter = [
    ...input.requirements.filter((row) => row.id !== after.id),
    after,
  ];
  const needsLoad = policy.overAllocationMode !== 'OFF';
  const countedBefore = needsLoad ? countedMinutesByTeacher(input) : new Map<string, number>();
  const countedAfter = needsLoad
    ? countedMinutesByTeacher({ ...input, requirements: requirementsAfter })
    : new Map<string, number>();
  const employmentByUser = new Map(input.employments.map((row) => [row.userId, row]));

  const findings: StaffingFinding[] = [];
  const roles: [StaffingRole, string | null, string | null][] = [
    ['TEACHER', after.teacherId, before?.teacherId ?? null],
    ['CO_TEACHER', after.coTeacherId, before?.coTeacherId ?? null],
  ];
  // Delade lektioner: each share's teacher teaches their lessons as a
  // teacher of the row, after the lead and the medlärare, in the shares'
  // order. A teacher who already had a share of the row is not newly
  // assigned; a row with no share adds nothing here.
  const sharedBefore = new Set((before?.shares ?? []).map((share) => share.teacherId));
  for (const id of new Set((after.shares ?? []).map((share) => share.teacherId))) {
    if (id !== null) roles.push(['TEACHER', id, sharedBefore.has(id) ? id : null]);
  }
  for (const [role, userId, previous] of roles) {
    if (userId === null) continue;
    if (userId !== previous) {
      const finding = qualificationFinding({
        policy,
        qualifications: input.qualifications,
        userId,
        role,
        subject: { id: after.subjectId, name: args.subjectName },
        span: after.gradeSpan,
        window: input.year,
      });
      if (finding) findings.push(finding);
    }
    if (needsLoad) {
      const finding = overTargetOfWrite({
        policy,
        input,
        requirementsAfter,
        employment: employmentByUser.get(userId) ?? null,
        userId,
        role,
        before: () => countedBefore.get(userId) ?? 0,
        after: () => countedAfter.get(userId) ?? 0,
      });
      if (finding) findings.push(finding);
    }
    if (args.scopeVersions && scopeModeOf(policy) !== 'OFF') {
      const finding = overScopeFinding({
        policy,
        userId,
        role,
        before: scopeOfTeacher(input, args.scopeVersions, userId),
        after: scopeOfTeacher({ ...input, requirements: requirementsAfter }, args.scopeVersions, userId),
      });
      if (finding) findings.push(finding);
    }
  }
  return findings;
}

/** One row of a batch: the lead it ends up with (null: nobody). */
export interface BatchChange {
  requirementId: string;
  teacherId: string | null;
}

/**
 * A finding of a batch, with the rows it is about. A behörighet finding names
 * its one row; a load finding names, in row order, every changed row that adds
 * to the teacher — the first is the one a refusal is prefixed with.
 */
export interface BatchFinding extends StaffingFinding {
  requirementIds: string[];
}

/**
 * The two questions for a whole batch of lead changes judged as ONE write: the
 * staffing proposal's apply, and its undo.
 *
 * Judged one row at a time, a swap — Anna takes Bo's row and Bo takes Anna's —
 * would refuse its first half for putting Anna over, although the batch as a
 * whole leaves both where they were. So the year is laid over with EVERY
 * change before the load is counted, and a teacher is asked about once, over
 * the whole batch:
 *
 *   - behörighet, per changed row whose lead becomes somebody new (role
 *     TEACHER, window the läsår), in row-id order — judgeRequirementWrite's
 *     question for the same row;
 *   - load, once per teacher whose counted minutes GROW over the batch, in
 *     user-id order, with overTargetFinding's own threshold.
 *
 * Behörighet before load, rows and teachers in id order, so the 409 a REFUSE
 * answers with is the same for the same batch every time. `input` is the year
 * as read before the write; a change naming a row it does not hold throws (the
 * caller validated them). PURE, like the rest of this module.
 *
 * `restoring` makes the batch the undo of an earlier one: the leads the rows
 * of THAT batch had before it (row id → teacher, null for nobody). The
 * proposal deliberately sheds rows from a teacher already over the limit, so
 * putting one back is a "growth" from today that a REFUSE school would refuse
 * — and the school could not get back the state it had a minute earlier. So
 * an undo is asked what a write would be asked about the state the apply
 * FOUND, not about today: a lead put back on a row they had then is not
 * somebody new, and a teacher grows only past the larger of today's minutes
 * and the minutes they had before the apply. Anything beyond the reversal —
 * another lead, another row, a load above both — is asked as ever.
 */
export function judgeRequirementBatch(args: {
  input: LoadInput;
  policy: CheckPolicy;
  changes: readonly BatchChange[];
  restoring?: ReadonlyMap<string, string | null>;
  /** Every lydelse of the ordinance, for STAFF_TEACHER_OVER_SCOPE; absent: not asked (see judgeRequirementWrite). */
  scopeVersions?: readonly ScopeVersion[];
}): BatchFinding[] {
  const { input, policy } = args;
  if (!checksAnything(policy)) return [];
  const byId = new Map(input.requirements.map((row) => [row.id, row]));
  const changes = [...args.changes].sort((a, b) =>
    a.requirementId < b.requirementId ? -1 : a.requirementId > b.requirementId ? 1 : 0,
  );
  const changeById = new Map(changes.map((change) => [change.requirementId, change]));
  const rowOf = (requirementId: string): LoadRequirement => {
    const row = byId.get(requirementId);
    if (!row) throw new Error(`judgeRequirementBatch: requirement ${requirementId} is not in the input`);
    return row;
  };

  const restoring = args.restoring ?? new Map<string, string | null>();
  const putsBack = (change: BatchChange): boolean =>
    restoring.has(change.requirementId) && restoring.get(change.requirementId) === change.teacherId;

  const findings: BatchFinding[] = [];
  for (const change of changes) {
    const row = rowOf(change.requirementId);
    if (change.teacherId === null || change.teacherId === row.teacherId || putsBack(change)) continue;
    const finding = qualificationFinding({
      policy,
      qualifications: input.qualifications,
      userId: change.teacherId,
      role: 'TEACHER',
      subject: { id: row.subjectId, name: row.subjectName },
      span: row.gradeSpan,
      window: input.year,
    });
    if (finding) findings.push({ ...finding, requirementIds: [row.id] });
  }

  if (policy.overAllocationMode !== 'OFF') {
    // Who gains a row, and which rows, in row order.
    const gained = new Map<string, string[]>();
    for (const change of changes) {
      const row = rowOf(change.requirementId);
      if (change.teacherId === null || change.teacherId === row.teacherId) continue;
      const rows = gained.get(change.teacherId);
      if (rows) rows.push(row.id);
      else gained.set(change.teacherId, [row.id]);
    }
    const requirementsAfter = input.requirements.map((row) => {
      const change = changeById.get(row.id);
      return change ? { ...row, teacherId: change.teacherId } : row;
    });
    // Before the batch this undoes, when it undoes one: today with every row
    // of that batch given back the lead it had.
    const requirementsFound =
      restoring.size === 0
        ? null
        : input.requirements.map((row) =>
            restoring.has(row.id) ? { ...row, teacherId: restoring.get(row.id)! } : row,
          );
    const before = countedMinutesByTeacher(input);
    const after = countedMinutesByTeacher({ ...input, requirements: requirementsAfter });
    const found = requirementsFound ? countedMinutesByTeacher({ ...input, requirements: requirementsFound }) : null;
    const employmentByUser = new Map(input.employments.map((row) => [row.userId, row]));
    for (const userId of [...gained.keys()].sort()) {
      const employment = employmentByUser.get(userId) ?? null;
      let finding: StaffingFinding | null;
      if (employment !== null && changesDuringYear(employment, input.year)) {
        // Per stretch, each growing past the larger of today and what the
        // batch being undone found, as over the year below.
        const today = stretchLoads(input, employment);
        const then = requirementsFound ? stretchLoads({ ...input, requirements: requirementsFound }, employment) : null;
        finding = overTargetFindingByStretch({
          policy,
          employment,
          userId,
          role: 'TEACHER',
          before: today.map((stretch, index) => ({
            ...stretch,
            counted: Math.max(stretch.counted, then?.[index]?.counted ?? 0),
          })),
          after: stretchLoads({ ...input, requirements: requirementsAfter }, employment),
        });
      } else {
        finding = overTargetFinding({
          policy,
          employment,
          userId,
          role: 'TEACHER',
          before: Math.max(before.get(userId) ?? 0, found?.get(userId) ?? 0),
          after: after.get(userId) ?? 0,
        });
      }
      if (finding) findings.push({ ...finding, requirementIds: gained.get(userId)! });
    }
  }

  if (args.scopeVersions && scopeModeOf(policy) !== 'OFF') {
    const gained = new Map<string, string[]>();
    for (const change of changes) {
      const row = rowOf(change.requirementId);
      if (change.teacherId === null || change.teacherId === row.teacherId) continue;
      const rows = gained.get(change.teacherId);
      if (rows) rows.push(row.id);
      else gained.set(change.teacherId, [row.id]);
    }
    const requirementsAfter = input.requirements.map((row) => {
      const change = changeById.get(row.id);
      return change ? { ...row, teacherId: change.teacherId } : row;
    });
    const requirementsFound =
      restoring.size === 0
        ? null
        : input.requirements.map((row) => (restoring.has(row.id) ? { ...row, teacherId: restoring.get(row.id)! } : row));
    for (const userId of [...gained.keys()].sort()) {
      const today = scopeOfTeacher(input, args.scopeVersions, userId);
      // An undo is asked what the state the apply FOUND would be asked, as the load question is: a teacher grows only past
      // the larger of today's hours and the hours they had before the batch being undone.
      const then = requirementsFound ? scopeOfTeacher({ ...input, requirements: requirementsFound }, args.scopeVersions, userId) : null;
      const before = then && today && then.teachingHours > today.teachingHours ? then : today;
      const finding = overScopeFinding({
        policy,
        userId,
        role: 'TEACHER',
        before,
        after: scopeOfTeacher({ ...input, requirements: requirementsAfter }, args.scopeVersions, userId),
      });
      if (finding) findings.push({ ...finding, requirementIds: gained.get(userId)! });
    }
  }
  return findings;
}

const ROLE_SV: Record<StaffingRole, string> = {
  TEACHER: 'Läraren',
  CO_TEACHER: 'Medläraren',
  SUBSTITUTE: 'Vikarien',
};

/**
 * The Swedish sentence for a finding — the 409's `detail`, and an import row's
 * message. The same words as STAFF_* in web/messages/sv.json (engineMessages),
 * which the web renders from the code and params; the spec pins the two
 * together, so a reworded sentence here fails until the catalogue follows.
 */
export function staffingSentence(warning: StaffingWarning): string {
  const role = ROLE_SV[warning.params.role as StaffingRole] ?? 'Läraren';
  if (warning.code === STAFF_TEACHER_NOT_QUALIFIED) {
    const grades = String(warning.params.grades);
    const span = grades === 'any' ? '' : ` för åk ${grades}`;
    return `${role} saknar behörighet i ${warning.params.subject}${span}.`;
  }
  if (warning.code === STAFF_TEACHER_OVER_SCOPE) {
    return (
      `${role} skulle få ${warning.params.hours} timmars undervisning under läsåret mot förordningens ` +
      `högsta nivå ${warning.params.limit} timmar (SFS 2026:1487 3 §).`
    );
  }
  if (warning.code === STAFF_TEACHER_OVER_SCOPE_HIDDEN) {
    return (
      `${role} skulle få mer undervisning än förordningens högsta nivå för tjänsten (SFS 2026:1487 3 §). ` +
      `Timmarna visas för rektor, en fullständig administratör och den som har HR-läs.`
    );
  }
  const { minutes, target, limit, tolerance } = warning.params;
  if (warning.code === STAFF_TEACHER_OVER_TARGET_HIDDEN) {
    return (
      `${role} skulle få mer än gränsen, riktmärket med ${tolerance} % tolerans. ` +
      `Minuterna visas för rektor, en fullständig administratör och den som har HR-läs.`
    );
  }
  if (warning.code === STAFF_TEACHER_OVER_TARGET_IN_PERIOD) {
    return (
      `${role} skulle få ${minutes} min/v mot riktmärket ${target} min/v ` +
      `från ${warning.params.from} till och med ${warning.params.to} ` +
      `(gränsen är ${limit} min/v med ${tolerance} % tolerans).`
    );
  }
  return (
    `${role} skulle få ${minutes} min/v mot riktmärket ${target} min/v ` +
    `(gränsen är ${limit} min/v med ${tolerance} % tolerans).`
  );
}

/** A finding as the 409 a REFUSE answers with: the code, the params, the sentence. */
export function staffingRefusal(finding: StaffingWarning): ConflictException {
  return new ConflictException({
    message: staffingSentence(finding),
    code: finding.code,
    params: finding.params,
  });
}

/**
 * What the write does with its findings: throws the first REFUSE as a 409,
 * hands back the WARNs. `downgrade` turns REFUSE into WARN — the vikarie's
 * case, which never refuses (see CalendarLessonsService.assignSubstitute).
 */
export function settleFindings(
  findings: readonly StaffingFinding[],
  options: { downgrade?: boolean } = {},
): StaffingWarning[] {
  if (!options.downgrade) {
    const refusal = findings.find((finding) => finding.mode === 'REFUSE');
    if (refusal) throw staffingRefusal(refusal);
  }
  return findings.map(({ code, params }) => ({ code, params }));
}
