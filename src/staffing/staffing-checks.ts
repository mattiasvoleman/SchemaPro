import { ConflictException } from '@nestjs/common';
import type { StaffingCheckMode } from '@prisma/client';
import {
  countedMinutesByTeacher,
  loadStatus,
  strongestCoveringQualification,
  targetMinutesPerWeek,
  type GradeSpan,
  type LoadEmployment,
  type LoadInput,
  type LoadQualification,
  type LoadRequirement,
} from './teacher-load';
import type { YearBounds } from './teaching-weeks';

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
 * PARAMS NAME A SUBJECT AND A SPAN, NEVER A PERSON. The admin who made the write
 * knows whom they assigned; the role ('TEACHER', 'CO_TEACHER', 'SUBSTITUTE')
 * says which of the row's teachers the sentence is about.
 *
 * PURE. The rows come in; nothing here reads a database or a clock.
 */

export const STAFF_TEACHER_NOT_QUALIFIED = 'STAFF_TEACHER_NOT_QUALIFIED' as const;
export const STAFF_TEACHER_OVER_TARGET = 'STAFF_TEACHER_OVER_TARGET' as const;
/** The generate pre-flight's refusal; see OptimizationProxyService. */
export const STAFF_UNSTAFFED_REQUIREMENTS = 'STAFF_UNSTAFFED_REQUIREMENTS' as const;

export type StaffingCheckCode =
  | typeof STAFF_TEACHER_NOT_QUALIFIED
  | typeof STAFF_TEACHER_OVER_TARGET;

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
};

/** Whether a policy asks either question at all. */
export function checksAnything(policy: CheckPolicy): boolean {
  return policy.qualificationMode !== 'OFF' || policy.overAllocationMode !== 'OFF';
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
  window: YearBounds;
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
 * Findings in a fixed order — lead before co-teacher, behörighet before load —
 * so the 409 a REFUSE answers with is the same for the same write every time.
 */
export function judgeRequirementWrite(args: {
  input: LoadInput;
  policy: CheckPolicy;
  before: LoadRequirement | null;
  after: LoadRequirement;
  subjectName: string;
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
      const finding = overTargetFinding({
        policy,
        employment: employmentByUser.get(userId) ?? null,
        userId,
        role,
        before: countedBefore.get(userId) ?? 0,
        after: countedAfter.get(userId) ?? 0,
      });
      if (finding) findings.push(finding);
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
  const { minutes, target, limit, tolerance } = warning.params;
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
