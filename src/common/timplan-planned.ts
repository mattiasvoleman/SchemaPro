import { standardWeekWeight } from '../staffing/teacher-load';
import {
  teachingWeeks,
  type ClosedRange,
  type TeachingPeriod,
  type YearBounds,
} from '../staffing/teaching-weeks';
import { TIMPLAN_ALTERNATIVE_CODES } from './timplan-coverage';

/*
 * Planerat mot timplan — layer 1 of the timplan coverage: what a läsår's
 * timplansposter (TeachingRequirements) give each class and each pupil, set
 * against the lokal timplan the year attaches to the class's årskurs.
 * Computed, never stored.
 *
 * PURE ARITHMETIC. No Prisma, no clock, no school. The gateway reads the year
 * under RLS in one transaction and hands the rows in
 * (src/timplan/timplan-coverage.service.ts); web/lib/timplan-planned.ts
 * mirrors this file so the Timplansposter matrix can repaint a cell while the
 * admin edits, and both replay src/common/__fixtures__/timplan-planned-cases.json
 * (timplan-planned.contract.spec.ts here, .contract.test.ts there).
 *
 * EVERY VERDICT IS A WARNING OR A NOTICE. Nothing here refuses anything: the
 * law lets a pupil's anpassade studiegång and prioriterade timplan deviate, so
 * a short class is "under mål", never "fel", and neither saving a requirement
 * nor generating a timetable waits on this module.
 *
 * ## Minutes per week: the standardvecka
 *
 * planned = Σ lessonsPerWeek × minutesPerLesson × weight over the rows, where
 * the weight is the load report's standardvecka weight (teacher-load.ts
 * standardWeekWeight, the teaching-hours semantics): an undated row 1 every
 * week and 0.5 varannan vecka, a dated row its share of the year's teaching
 * weeks with lov and studiedagar subtracted from both sides. The grade handed
 * to the lov arithmetic is the årskurs of whoever is being judged — the class
 * for a class cell, the pupil's home class for a pupil — because a lågstadiet
 * studiedag closes school for a pupil in åk 2 whichever group the lesson
 * belongs to. Summed exactly, rounded once to whole minutes per figure; every
 * comparison is made between those whole minutes and the plan's integer
 * target, so a dated row's 179.9997 does not read as "under".
 *
 * Hours per year beside it: Σ lessons × minutes × teachingWeeks(row) / 60 for
 * the planned side and target × teachingWeeks(the whole year) / 60 for the
 * target — the timplan page's figures, to the tenth.
 *
 * ## Lines: a subject, or an alternative
 *
 * A comparison is made per LINE. Most lines are one school subject. The two
 * cells P1 hard-codes as alternatives (TIMPLAN_ALTERNATIVE_CODES: SV_SVA and
 * M2 — svenska or svenska som andraspråk; one språkval per pupil) are one line
 * each, holding every counted school subject with that national code: met when
 * the planned minutes ACROSS them reach the HIGHEST target among them. A pupil
 * reads Svenska or SvA, not both, and a class whose pupils read Svenska 200
 * has not left SvA "unplanned" by not planning it. countsTowardTimplan = false
 * subjects are excluded from everything, as P1 excludes them.
 *
 * ## The class
 *
 * Per CLASS group: the group's own rows against the plan attached to its
 * årskurs. Teaching groups are never judged as groups (they have no årskurs of
 * their own to read a target from); their rows reach pupils.
 *
 *   MET          planned ≥ target, any surplus under one lesson
 *   OVER         surplus of at least the line's smallest (weighted) lesson —
 *                a whole lesson could go and the target would still be met.
 *                175 planned as 3 × 60 is +5 and MET: lesson rounding, the
 *                surplus the generator itself reports. 240 is OVER.
 *   UNPLANNED    nothing planned for a target
 *   UNDER        something planned, less than the target
 *   PUPILS       the class's own rows are short, but a teaching group holding
 *                pupils of this class plans the line: the class is not the
 *                measure, its pupils are (språkval in teaching groups across
 *                classes is the ordinary case), so no class verdict — each
 *                pupil below target gets their own
 *   NO_TARGET    no plan attached to the årskurs, or no entry for the subject
 *
 * A class line is COVERED (the "n of m" a Täckning pill counts) when every
 * pupil of the class reaches the target — or, for a class with no pupils yet
 * (next year planned in the spring), when its own rows do.
 *
 * ## The pupil
 *
 * Σ over the home class's rows (User.studentGroupId) and the rows of every
 * TEACHING_GROUP the pupil is a member of, against the targets of the home
 * class's årskurs. A pupil getting the SAME subject from two groups (7A
 * matematik and Ma-fördjupning) is TIMPLAN_PUPIL_DOUBLE_PLANNED rather than
 * silently summed into "on target". A pupil below target is listed; the
 * verdict TIMPLAN_PUPIL_UNDERPLANNED is raised only where the class's own
 * verdict does not already say it (class line not UNDER/UNPLANNED), so a short
 * 7A reads as one finding, not as one per pupil — the pupils are still in the
 * list. Pupils whose home class is not a CLASS group of this year are counted,
 * not judged.
 *
 * The answer carries pupil IDS only. Names are the web's to resolve from data
 * it already holds; a pupil-level answer is for the admin, and `includePupils`
 * false strips every pupil figure and verdict for a teacher's read.
 */

export type PlannedStatus = 'MET' | 'OVER' | 'UNDER' | 'UNPLANNED' | 'PUPILS' | 'NO_TARGET';

export type PlannedVerdictCode =
  | 'TIMPLAN_YEAR_GRADE_UNATTACHED'
  | 'TIMPLAN_ATTACHED_DRAFT'
  | 'TIMPLAN_GROUP_UNPLANNED'
  | 'TIMPLAN_GROUP_UNDERPLANNED'
  | 'TIMPLAN_GROUP_OVERPLANNED'
  | 'TIMPLAN_PUPIL_UNDERPLANNED'
  | 'TIMPLAN_PUPIL_DOUBLE_PLANNED';

export interface PlannedPlan {
  id: string;
  name: string;
  status: 'DRAFT' | 'DECIDED';
  entries: { subjectId: string; gradeLevel: number; minutesPerWeek: number }[];
}

export interface PlannedSubject {
  id: string;
  name: string;
  nationalCode: string | null;
  countsTowardTimplan: boolean;
}

export interface PlannedGroup {
  id: string;
  name: string;
  kind: 'CLASS' | 'TEACHING_GROUP';
  gradeLevel: number | null;
}

export interface PlannedRequirement extends TeachingPeriod {
  id: string;
  studentGroupId: string;
  subjectId: string;
  lessonsPerWeek: number;
  minutesPerLesson: number;
}

export interface PlannedPupilInput {
  id: string;
  /** User.studentGroupId: the home class, possibly of another year, or none. */
  homeGroupId: string | null;
  /** StudentGroupMember rows; only TEACHING_GROUPs of this year count. */
  groupIds: string[];
}

export interface PlannedCoverageInput {
  year: YearBounds;
  closures: ClosedRange[];
  plans: PlannedPlan[];
  attachments: { gradeLevel: number; localTimplanId: string }[];
  subjects: PlannedSubject[];
  groups: PlannedGroup[];
  requirements: PlannedRequirement[];
  pupils: PlannedPupilInput[];
  /** False for a TEACHER's read: no pupil figure and no pupil verdict leaves. */
  includePupils: boolean;
}

export interface PlannedVerdict {
  code: PlannedVerdictCode;
  severity: 'notice' | 'warning';
  gradeLevel?: number;
  gradeLevels?: number[];
  localTimplanId?: string;
  studentGroupId?: string;
  studentGroupIds?: string[];
  subjectIds?: string[];
  alternativeCode?: string;
  pupilId?: string;
  params: Record<string, string | number>;
}

export interface PupilStats {
  min: number;
  median: number;
  max: number;
  /** Pupils of the class under the line's target. */
  below: number;
}

export interface PlannedLine {
  /** 'subject:<id>' or 'alt:<code>'. */
  key: string;
  alternativeCode: string | null;
  subjectIds: string[];
  targetMinutesPerWeek: number | null;
  plannedMinutesPerWeek: number;
  deltaMinutesPerWeek: number | null;
  targetHours: number | null;
  plannedHours: number;
  status: PlannedStatus;
  covered: boolean;
  /** Teaching groups holding pupils of this class that plan the line. */
  teachingGroupIds: string[];
  pupils?: PupilStats;
}

export interface PlannedCell {
  studentGroupId: string;
  subjectId: string;
  alternativeCode: string | null;
  /** The subject's own entry for the årskurs; null when the plan has none. */
  targetMinutesPerWeek: number | null;
  plannedMinutesPerWeek: number;
  targetHours: number | null;
  plannedHours: number;
  requirementIds: string[];
  /** The line's status: an alternative's cells share it. */
  status: PlannedStatus;
}

export interface PlannedGroupSummary {
  studentGroupId: string;
  gradeLevel: number | null;
  localTimplanId: string | null;
  planStatus: 'DRAFT' | 'DECIDED' | null;
  plannedMinutesPerWeek: number;
  targetMinutesPerWeek: number;
  plannedHours: number;
  targetHours: number;
  linesWithTarget: number;
  linesCovered: number;
  pupilCount: number;
  lines: PlannedLine[];
}

export interface PupilSource {
  studentGroupId: string;
  subjectId: string;
  minutesPerWeek: number;
}

export interface PupilLine {
  key: string;
  alternativeCode: string | null;
  subjectIds: string[];
  targetMinutesPerWeek: number | null;
  plannedMinutesPerWeek: number;
  status: 'MET' | 'UNDER' | 'NO_TARGET';
  sources: PupilSource[];
  doublePlannedSubjectIds: string[];
}

export interface PlannedPupil {
  pupilId: string;
  homeGroupId: string;
  gradeLevel: number | null;
  lines: PupilLine[];
}

export interface PlannedCoverage {
  pupilLevel: boolean;
  groups: PlannedGroupSummary[];
  cells: PlannedCell[];
  /** Pupils below target or double planned, with every line: the drill-down. */
  pupils: PlannedPupil[] | null;
  pupilCount: number;
  pupilsBelowTarget: number | null;
  pupilsOutsideClasses: number;
  verdicts: PlannedVerdict[];
}

const VERDICT_ORDER: Record<PlannedVerdictCode, number> = {
  TIMPLAN_YEAR_GRADE_UNATTACHED: 0,
  TIMPLAN_ATTACHED_DRAFT: 1,
  TIMPLAN_GROUP_UNPLANNED: 2,
  TIMPLAN_GROUP_UNDERPLANNED: 3,
  TIMPLAN_GROUP_OVERPLANNED: 4,
  TIMPLAN_PUPIL_UNDERPLANNED: 5,
  TIMPLAN_PUPIL_DOUBLE_PLANNED: 6,
};

const byCode = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const byName = (a: string, b: string): number => a.localeCompare(b, 'sv');

/** Minutes → hours to the tenth. */
const hours = (minutes: number): number => Math.round(minutes / 6) / 10;

const subjectKey = (id: string): string => `subject:${id}`;
const altKey = (code: string): string => `alt:${code}`;

/** What one requirement gives one årskurs, cached per (row, grade). */
interface Contribution {
  week: number;
  year: number;
  /** One lesson at the row's weight: the OVER threshold. */
  lesson: number;
}

/** A line being assembled for one class or one pupil. */
interface LineDraft {
  key: string;
  alternativeCode: string | null;
  subjectIds: Set<string>;
  target: number | null;
  week: number;
  year: number;
  smallestLesson: number;
}

export function computePlannedCoverage(input: PlannedCoverageInput): PlannedCoverage {
  const { year, closures } = input;
  const subjects = new Map(
    input.subjects.filter((s) => s.countsTowardTimplan).map((s) => [s.id, s]),
  );
  const subjectOrder = (a: string, b: string): number =>
    byName(subjects.get(a)?.name ?? '', subjects.get(b)?.name ?? '') || byCode(a, b);
  const groupsById = new Map(input.groups.map((g) => [g.id, g]));
  const groupOrder = (a: string, b: string): number =>
    byName(groupsById.get(a)?.name ?? '', groupsById.get(b)?.name ?? '') || byCode(a, b);
  const plans = new Map(input.plans.map((p) => [p.id, p]));
  const planOfGrade = new Map<number, PlannedPlan>();
  for (const row of input.attachments) {
    const plan = plans.get(row.localTimplanId);
    if (plan) planOfGrade.set(row.gradeLevel, plan);
  }

  // Targets per årskurs: subjectId → minutes, counted subjects only.
  const targetsByGrade = new Map<number, Map<string, number>>();
  const targetsOf = (grade: number | null): Map<string, number> | null => {
    if (grade === null) return null;
    const plan = planOfGrade.get(grade);
    if (!plan) return null;
    let targets = targetsByGrade.get(grade);
    if (!targets) {
      targets = new Map();
      for (const entry of plan.entries) {
        if (entry.gradeLevel === grade && subjects.has(entry.subjectId)) {
          targets.set(entry.subjectId, entry.minutesPerWeek);
        }
      }
      targetsByGrade.set(grade, targets);
    }
    return targets;
  };

  const yearWeeksByGrade = new Map<string, number>();
  const yearWeeks = (grade: number | null): number => {
    const key = String(grade);
    let weeks = yearWeeksByGrade.get(key);
    if (weeks === undefined) {
      weeks = teachingWeeks({}, year, closures, grade);
      yearWeeksByGrade.set(key, weeks);
    }
    return weeks;
  };

  const contributions = new Map<string, Contribution>();
  const contributionOf = (row: PlannedRequirement, grade: number | null): Contribution => {
    const key = `${row.id}:${grade}`;
    let found = contributions.get(key);
    if (!found) {
      const span = grade === null ? null : { min: grade, max: grade };
      const weight = standardWeekWeight({ ...row, gradeSpan: span }, year, closures);
      const perWeek = row.lessonsPerWeek * row.minutesPerLesson;
      found = {
        week: perWeek * weight,
        year: perWeek * teachingWeeks(row, year, closures, grade),
        lesson: row.minutesPerLesson * weight,
      };
      contributions.set(key, found);
    }
    return found;
  };

  // The rows per group, counted subjects only, in input order.
  const rowsByGroup = new Map<string, PlannedRequirement[]>();
  for (const row of input.requirements) {
    if (!subjects.has(row.subjectId) || !groupsById.has(row.studentGroupId)) continue;
    const list = rowsByGroup.get(row.studentGroupId) ?? [];
    list.push(row);
    rowsByGroup.set(row.studentGroupId, list);
  }

  const lineKeyOf = (subjectId: string): { key: string; alternativeCode: string | null } => {
    const code = subjects.get(subjectId)?.nationalCode ?? null;
    return code !== null && TIMPLAN_ALTERNATIVE_CODES.includes(code)
      ? { key: altKey(code), alternativeCode: code }
      : { key: subjectKey(subjectId), alternativeCode: null };
  };

  /** Lines for one årskurs from its targets and the rows that reach it. */
  const buildLines = (
    targets: Map<string, number> | null,
    rows: PlannedRequirement[],
    grade: number | null,
  ): Map<string, LineDraft> => {
    const lines = new Map<string, LineDraft>();
    const lineFor = (subjectId: string): LineDraft => {
      const { key, alternativeCode } = lineKeyOf(subjectId);
      let line = lines.get(key);
      if (!line) {
        line = {
          key,
          alternativeCode,
          subjectIds: new Set(),
          target: null,
          week: 0,
          year: 0,
          smallestLesson: Infinity,
        };
        lines.set(key, line);
      }
      line.subjectIds.add(subjectId);
      return line;
    };
    for (const [subjectId, minutes] of targets ?? []) {
      const line = lineFor(subjectId);
      line.target = Math.max(line.target ?? 0, minutes);
    }
    for (const row of rows) {
      const share = contributionOf(row, grade);
      const line = lineFor(row.subjectId);
      line.week += share.week;
      line.year += share.year;
      if (share.lesson > 0) line.smallestLesson = Math.min(line.smallestLesson, share.lesson);
    }
    for (const [key, line] of lines) {
      if (!(line.target !== null && line.target > 0) && Math.round(line.week) === 0) lines.delete(key);
    }
    return lines;
  };

  const lineOrder = (a: LineDraft, b: LineDraft): number => {
    const first = (line: LineDraft) => [...line.subjectIds].sort(subjectOrder)[0] ?? '';
    return subjectOrder(first(a), first(b)) || byCode(a.key, b.key);
  };

  const classes = input.groups
    .filter((g) => g.kind === 'CLASS')
    .map((g) => g.id)
    .sort(groupOrder);
  const classIds = new Set(classes);

  // ---- Pupils, computed always: a class's coverage is its pupils'.
  const pupilsByClass = new Map<string, PlannedPupilInput[]>();
  let pupilsOutsideClasses = 0;
  for (const pupil of input.pupils) {
    if (pupil.homeGroupId === null || !classIds.has(pupil.homeGroupId)) {
      pupilsOutsideClasses += 1;
      continue;
    }
    const list = pupilsByClass.get(pupil.homeGroupId) ?? [];
    list.push(pupil);
    pupilsByClass.set(pupil.homeGroupId, list);
  }

  interface PupilResult {
    pupil: PlannedPupilInput;
    grade: number | null;
    lines: Map<string, LineDraft>;
    perSource: Map<string, Map<string, number>>; // subjectId → groupId → week minutes
  }
  const teachingGroupsOf = (pupil: PlannedPupilInput): string[] =>
    [...new Set(pupil.groupIds)].filter((id) => groupsById.get(id)?.kind === 'TEACHING_GROUP');

  const pupilResults = new Map<string, PupilResult[]>();
  const carriersByClass = new Map<string, Set<string>>();
  for (const classId of classes) {
    const grade = groupsById.get(classId)!.gradeLevel;
    const targets = targetsOf(grade);
    const results: PupilResult[] = [];
    const carriers = new Set<string>();
    const ordered = [...(pupilsByClass.get(classId) ?? [])].sort((a, b) => byCode(a.id, b.id));
    for (const pupil of ordered) {
      const groups = [classId, ...teachingGroupsOf(pupil).sort(groupOrder)];
      for (const id of groups.slice(1)) carriers.add(id);
      const rows = groups.flatMap((id) => rowsByGroup.get(id) ?? []);
      const perSource = new Map<string, Map<string, number>>();
      for (const row of rows) {
        const bySubject = perSource.get(row.subjectId) ?? new Map<string, number>();
        bySubject.set(
          row.studentGroupId,
          (bySubject.get(row.studentGroupId) ?? 0) + contributionOf(row, grade).week,
        );
        perSource.set(row.subjectId, bySubject);
      }
      results.push({ pupil, grade, lines: buildLines(targets, rows, grade), perSource });
    }
    pupilResults.set(classId, results);
    carriersByClass.set(classId, carriers);
  }

  const verdicts: PlannedVerdict[] = [];
  const nameOf = (subjectIds: Iterable<string>): string =>
    [...subjectIds]
      .sort(subjectOrder)
      .map((id) => subjects.get(id)?.name ?? id)
      .join(' / ');

  // ---- Grade-level notices.
  const classGrades = new Map<number, string[]>();
  for (const classId of classes) {
    const grade = groupsById.get(classId)!.gradeLevel;
    if (grade === null) continue;
    const list = classGrades.get(grade) ?? [];
    list.push(classId);
    classGrades.set(grade, list);
  }
  for (const grade of [...classGrades.keys()].sort((a, b) => a - b)) {
    if (planOfGrade.has(grade)) continue;
    const ids = classGrades.get(grade)!;
    verdicts.push({
      code: 'TIMPLAN_YEAR_GRADE_UNATTACHED',
      severity: 'notice',
      gradeLevel: grade,
      studentGroupIds: ids,
      params: {
        gradeLevel: grade,
        groupCount: ids.length,
        groupNames: ids.map((id) => groupsById.get(id)!.name).join(', '),
      },
    });
  }
  const draftGrades = new Map<string, number[]>();
  for (const [grade, plan] of planOfGrade) {
    if (plan.status !== 'DRAFT') continue;
    const list = draftGrades.get(plan.id) ?? [];
    list.push(grade);
    draftGrades.set(plan.id, list);
  }
  const draftIds = [...draftGrades.keys()].sort(
    (a, b) => byName(plans.get(a)!.name, plans.get(b)!.name) || byCode(a, b),
  );
  for (const planId of draftIds) {
    const grades = draftGrades.get(planId)!.sort((a, b) => a - b);
    verdicts.push({
      code: 'TIMPLAN_ATTACHED_DRAFT',
      severity: 'notice',
      localTimplanId: planId,
      gradeLevels: grades,
      params: { planName: plans.get(planId)!.name, gradeLevels: grades.join(', ') },
    });
  }

  // ---- Classes.
  const summaries: PlannedGroupSummary[] = [];
  const cells: PlannedCell[] = [];
  const flaggedClassLines = new Map<string, Set<string>>();
  for (const classId of classes) {
    const group = groupsById.get(classId)!;
    const grade = group.gradeLevel;
    const targets = targetsOf(grade);
    const plan = grade === null ? undefined : planOfGrade.get(grade);
    const rows = rowsByGroup.get(classId) ?? [];
    const drafts = [...buildLines(targets, rows, grade).values()].sort(lineOrder);
    const results = pupilResults.get(classId) ?? [];
    const carriers = carriersByClass.get(classId) ?? new Set<string>();
    const weeks = yearWeeks(grade);
    const flagged = new Set<string>();

    let totalWeek = 0;
    let totalYear = 0;
    let totalTarget = 0;
    let withTarget = 0;
    let covered = 0;
    const lines: PlannedLine[] = [];
    for (const draft of drafts) {
      const planned = Math.round(draft.week);
      const target = draft.target;
      const carriedBy = [...carriers]
        .filter((id) =>
          (rowsByGroup.get(id) ?? []).some((row) => lineKeyOf(row.subjectId).key === draft.key),
        )
        .sort(groupOrder);
      let status: PlannedStatus;
      if (target === null) status = 'NO_TARGET';
      else if (planned >= target) {
        const surplus = planned - target;
        status =
          surplus > 0 && (target === 0 || surplus >= Math.round(draft.smallestLesson)) ? 'OVER' : 'MET';
      } else if (carriedBy.length > 0) status = 'PUPILS';
      else status = planned === 0 ? 'UNPLANNED' : 'UNDER';

      const values = results.map((result) => Math.round(result.lines.get(draft.key)?.week ?? 0));
      const below = target === null ? 0 : values.filter((value) => value < target).length;
      const isCovered =
        target !== null && target > 0
          ? results.length > 0
            ? below === 0
            : planned >= target
          : false;
      if (target !== null && target > 0) {
        withTarget += 1;
        if (isCovered) covered += 1;
      }
      if (target !== null) totalTarget += target;

      const subjectIds = [...draft.subjectIds].sort(subjectOrder);
      const line: PlannedLine = {
        key: draft.key,
        alternativeCode: draft.alternativeCode,
        subjectIds,
        targetMinutesPerWeek: target,
        plannedMinutesPerWeek: planned,
        deltaMinutesPerWeek: target === null ? null : planned - target,
        targetHours: target === null ? null : hours(target * weeks),
        plannedHours: hours(draft.year),
        status,
        covered: isCovered,
        teachingGroupIds: carriedBy,
      };
      if (input.includePupils && results.length > 0) {
        const sorted = [...values].sort((a, b) => a - b);
        const middle = sorted.length >> 1;
        line.pupils = {
          min: sorted[0]!,
          median:
            sorted.length % 2 === 1
              ? sorted[middle]!
              : Math.round((sorted[middle - 1]! + sorted[middle]!) / 2),
          max: sorted[sorted.length - 1]!,
          below,
        };
      }
      lines.push(line);

      const where = {
        studentGroupId: classId,
        subjectIds,
        ...(draft.alternativeCode ? { alternativeCode: draft.alternativeCode } : {}),
      };
      const named = {
        groupName: group.name,
        gradeLevel: grade ?? '',
        subjectName: nameOf(subjectIds),
        targetMinutesPerWeek: target ?? 0,
        plannedMinutesPerWeek: planned,
      };
      if (status === 'UNPLANNED' || status === 'UNDER') {
        flagged.add(draft.key);
        verdicts.push({
          code: status === 'UNPLANNED' ? 'TIMPLAN_GROUP_UNPLANNED' : 'TIMPLAN_GROUP_UNDERPLANNED',
          severity: 'warning',
          ...where,
          params: { ...named, deficitMinutesPerWeek: (target ?? 0) - planned },
        });
      } else if (status === 'OVER') {
        verdicts.push({
          code: 'TIMPLAN_GROUP_OVERPLANNED',
          severity: 'notice',
          ...where,
          params: { ...named, surplusMinutesPerWeek: planned - (target ?? 0) },
        });
      }

      // The matrix cells: one per subject of the line.
      for (const subjectId of subjectIds) {
        const own = rows.filter((row) => row.subjectId === subjectId);
        const week = own.reduce((sum, row) => sum + contributionOf(row, grade).week, 0);
        const yearMinutes = own.reduce((sum, row) => sum + contributionOf(row, grade).year, 0);
        const ownTarget = targets?.get(subjectId) ?? null;
        cells.push({
          studentGroupId: classId,
          subjectId,
          alternativeCode: draft.alternativeCode,
          targetMinutesPerWeek: ownTarget,
          plannedMinutesPerWeek: Math.round(week),
          targetHours: ownTarget === null ? null : hours(ownTarget * weeks),
          plannedHours: hours(yearMinutes),
          requirementIds: own.map((row) => row.id),
          status,
        });
      }
    }
    for (const row of rows) {
      const share = contributionOf(row, grade);
      totalWeek += share.week;
      totalYear += share.year;
    }
    flaggedClassLines.set(classId, flagged);
    summaries.push({
      studentGroupId: classId,
      gradeLevel: grade,
      localTimplanId: plan?.id ?? null,
      planStatus: plan?.status ?? null,
      plannedMinutesPerWeek: Math.round(totalWeek),
      targetMinutesPerWeek: totalTarget,
      plannedHours: hours(totalYear),
      targetHours: hours(totalTarget * weeks),
      linesWithTarget: withTarget,
      linesCovered: covered,
      pupilCount: results.length,
      lines,
    });
  }

  // ---- Pupils: the list and their verdicts.
  const listed: PlannedPupil[] = [];
  let pupilsBelow = 0;
  for (const classId of classes) {
    const group = groupsById.get(classId)!;
    const flagged = flaggedClassLines.get(classId)!;
    for (const result of pupilResults.get(classId) ?? []) {
      let isBelow = false;
      let isDouble = false;
      const lines: PupilLine[] = [];
      for (const draft of [...result.lines.values()].sort(lineOrder)) {
        const planned = Math.round(draft.week);
        const target = draft.target;
        const status: PupilLine['status'] =
          target === null ? 'NO_TARGET' : planned < target ? 'UNDER' : 'MET';
        const subjectIds = [...draft.subjectIds].sort(subjectOrder);
        const sources: PupilSource[] = [];
        const doubles: string[] = [];
        for (const subjectId of subjectIds) {
          const bySource = result.perSource.get(subjectId);
          if (!bySource) continue;
          const groupIds = [...bySource.keys()].sort(groupOrder);
          for (const groupId of groupIds) {
            sources.push({
              studentGroupId: groupId,
              subjectId,
              minutesPerWeek: Math.round(bySource.get(groupId)!),
            });
          }
          if (groupIds.length > 1) {
            doubles.push(subjectId);
            isDouble = true;
            verdicts.push({
              code: 'TIMPLAN_PUPIL_DOUBLE_PLANNED',
              severity: 'warning',
              pupilId: result.pupil.id,
              studentGroupId: classId,
              studentGroupIds: groupIds,
              subjectIds: [subjectId],
              params: {
                groupName: group.name,
                subjectName: nameOf([subjectId]),
                groupNames: groupIds.map((id) => groupsById.get(id)!.name).join(', '),
                plannedMinutesPerWeek: Math.round(
                  groupIds.reduce((sum, id) => sum + bySource.get(id)!, 0),
                ),
              },
            });
          }
        }
        if (status === 'UNDER') {
          isBelow = true;
          if (!flagged.has(draft.key)) {
            verdicts.push({
              code: 'TIMPLAN_PUPIL_UNDERPLANNED',
              severity: 'warning',
              pupilId: result.pupil.id,
              studentGroupId: classId,
              subjectIds,
              ...(draft.alternativeCode ? { alternativeCode: draft.alternativeCode } : {}),
              params: {
                groupName: group.name,
                gradeLevel: result.grade ?? '',
                subjectName: nameOf(subjectIds),
                targetMinutesPerWeek: target!,
                plannedMinutesPerWeek: planned,
                deficitMinutesPerWeek: target! - planned,
              },
            });
          }
        }
        lines.push({
          key: draft.key,
          alternativeCode: draft.alternativeCode,
          subjectIds,
          targetMinutesPerWeek: target,
          plannedMinutesPerWeek: planned,
          status,
          sources,
          doublePlannedSubjectIds: doubles,
        });
      }
      if (isBelow) pupilsBelow += 1;
      if (isBelow || isDouble) {
        listed.push({ pupilId: result.pupil.id, homeGroupId: classId, gradeLevel: result.grade, lines });
      }
    }
  }

  verdicts.sort((a, b) => VERDICT_ORDER[a.code] - VERDICT_ORDER[b.code]);
  const pupilCount = [...pupilResults.values()].reduce((sum, list) => sum + list.length, 0);
  return {
    pupilLevel: input.includePupils,
    groups: summaries,
    cells,
    pupils: input.includePupils ? listed : null,
    pupilCount,
    pupilsBelowTarget: input.includePupils ? pupilsBelow : null,
    pupilsOutsideClasses,
    verdicts: input.includePupils
      ? verdicts
      : verdicts.filter((verdict) => verdict.pupilId === undefined),
  };
}
