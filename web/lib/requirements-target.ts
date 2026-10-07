// The Timplansposter matrix's Mål mode, as data: what each cell, row and
// column says once the year's timplan is laid over the posts.
//
// NOTHING IS COMPUTED HERE THAT lib/timplan-planned.ts DOES NOT ALREADY
// COMPUTE. That module is the gateway's own arithmetic (a mirror of
// src/common/timplan-planned.ts, held to it by a shared fixture), and the
// coverage page will read the same figures from GET /timplan-coverage. This
// file only (1) assembles the module's input from what the matrix has already
// loaded, (2) indexes its answer by the matrix's own coordinates, and (3) asks
// it one narrow question for the cell dialog's hint. A figure computed a
// second way here would be the matrix and the coverage page disagreeing
// about the same class.
//
// Why the browser computes at all rather than reading the endpoint: the hint
// in the cell dialog has to follow the fields as they are typed, before
// anything is saved, and a cell's delta has to move the moment a save lands
// without waiting for a second round trip. Both are the reason the mirror
// exists (see its header).
//
// The figures are standardvecka minutes — a row run on odd weeks counts half,
// a dated row by its share of the year's teaching weeks — which is why a
// matrix cell can read "90 / 120" for a post that says 3 × 60: the cell's
// own badge says "udda", and the hint in the dialog says what that amounts
// to. The year hours are the same rows over the year's teaching weeks.

import {
  computePlannedCoverage,
  type PlannedCell,
  type PlannedCoverage,
  type PlannedCoverageInput,
  type PlannedGroupSummary,
  type PlannedLine,
  type PlannedPlan,
  type PlannedRequirement,
  type PlannedStatus,
} from "@/lib/timplan-planned";
import type { ClosedRange, YearBounds } from "@/lib/teaching-hours";
import type { LessonRecurrence, StudentGroup, Subject, TeachingRequirement } from "@/lib/types";

/** What the matrix needs to have loaded before Mål mode can say anything. */
export interface TargetSources {
  year: YearBounds;
  closures: ClosedRange[];
  attachments: { gradeLevel: number; localTimplanId: string }[];
  plans: PlannedPlan[];
  subjects: Pick<Subject, "id" | "name" | "nationalCode" | "countsTowardTimplan">[];
  /** The picked läsår's groups only: two years may both own a "7A". */
  groups: Pick<StudentGroup, "id" | "name" | "kind" | "gradeLevel">[];
  requirements: Pick<
    TeachingRequirement,
    | "id"
    | "studentGroupId"
    | "subjectId"
    | "lessonsPerWeek"
    | "minutesPerLesson"
    | "recurrence"
    | "startDate"
    | "endDate"
  >[];
  people: { id: string; role: string; isActive: boolean; studentGroupId: string | null }[];
  memberships: { studentId: string; studentGroupId: string }[];
}

/**
 * The module's input, built the way the gateway builds it for an admin:
 * active pupils only, each with their home class and every group they are a
 * member of (the module keeps the year's TEACHING_GROUPs and ignores the
 * rest), pupil level on.
 */
export function targetInput(sources: TargetSources): PlannedCoverageInput {
  const groupsByPupil = new Map<string, string[]>();
  for (const row of sources.memberships) {
    const list = groupsByPupil.get(row.studentId);
    if (list) list.push(row.studentGroupId);
    else groupsByPupil.set(row.studentId, [row.studentGroupId]);
  }
  return {
    year: sources.year,
    closures: sources.closures,
    plans: sources.plans,
    attachments: sources.attachments,
    subjects: sources.subjects.map((subject) => ({
      id: subject.id,
      name: subject.name,
      nationalCode: subject.nationalCode ?? null,
      countsTowardTimplan: subject.countsTowardTimplan ?? true,
    })),
    groups: sources.groups.map((group) => ({
      id: group.id,
      name: group.name,
      kind: group.kind,
      gradeLevel: group.gradeLevel,
    })),
    requirements: sources.requirements.map(toPlannedRequirement),
    pupils: sources.people
      .filter((person) => person.role === "STUDENT" && person.isActive)
      .map((person) => ({
        id: person.id,
        homeGroupId: person.studentGroupId,
        groupIds: groupsByPupil.get(person.id) ?? [],
      })),
    includePupils: true,
  };
}

function toPlannedRequirement(row: TargetSources["requirements"][number]): PlannedRequirement {
  return {
    id: row.id,
    studentGroupId: row.studentGroupId,
    subjectId: row.subjectId,
    lessonsPerWeek: row.lessonsPerWeek,
    minutesPerLesson: row.minutesPerLesson,
    recurrence: row.recurrence ?? "ALL_WEEKS",
    startDate: row.startDate ?? null,
    endDate: row.endDate ?? null,
  };
}

/**
 * How a cell is painted. Under is amber and unplanned is red, as the plan
 * says; "pupils" is a class whose own posts are short while a teaching group
 * holding its pupils plans the subject — neither red nor fine until the
 * coverage page has looked at the pupils, so it is drawn neutral and says why.
 */
export type TargetTone = "unplanned" | "under" | "pupils" | "met" | "over" | "none";

export interface TargetCellView {
  /** The cell's own subject: its standardvecka minutes and its own target. */
  planned: number;
  target: number | null;
  /**
   * The LINE's signed difference, which is what the tone is judged on. For a
   * plain subject that is the cell's own; for Svenska/SvA or a språkval it is
   * the alternatives together, so an empty SvA cell beside a full Svenska one
   * does not read as a deficit.
   */
  delta: number | null;
  tone: TargetTone;
  /** Part of an alternative line (SV_SVA, M2): the cell says so. */
  alternative: boolean;
  /** The line's subjects other than this cell's, for the sentence. */
  partnerSubjectIds: string[];
}

export function toneOf(status: PlannedStatus): TargetTone {
  switch (status) {
    case "UNPLANNED":
      return "unplanned";
    case "UNDER":
      return "under";
    case "PUPILS":
      return "pupils";
    case "MET":
      return "met";
    case "OVER":
      return "over";
    case "NO_TARGET":
      return "none";
  }
}

export interface TargetTotal {
  planned: number;
  /** Null when no class has a target in this column. */
  target: number | null;
  plannedHours: number;
  targetHours: number | null;
}

export interface TargetView {
  coverage: PlannedCoverage;
  cell(groupId: string, subjectId: string): TargetCellView | null;
  summary(groupId: string): PlannedGroupSummary | null;
  /** Per subject column, over the year's CLASSES. */
  subjectTotals: Map<string, TargetTotal>;
  /** Every class together, alternatives counted once (the summaries' rule). */
  total: TargetTotal;
  /** Årskurser with classes and no plan attached this year. */
  unattachedGrades: number[];
  /** Attached plans that are DRAFTs, with the grades that follow them. */
  draftPlans: { id: string; name: string; gradeLevels: number[] }[];
  /** Årskurser with classes attached to a plan that gives them no minutes. */
  emptyPlanGrades: { gradeLevel: number; planName: string }[];
}

/** Hours arrive to the tenth already; a sum of them is rounded the same way. */
const tenth = (value: number): number => Math.round(value * 10) / 10;

export function buildTargetView(coverage: PlannedCoverage, plans: PlannedPlan[]): TargetView {
  const lineByCell = new Map<string, PlannedLine>();
  const summaries = new Map<string, PlannedGroupSummary>();
  for (const summary of coverage.groups) {
    summaries.set(summary.studentGroupId, summary);
    for (const line of summary.lines) {
      for (const subjectId of line.subjectIds) {
        lineByCell.set(`${summary.studentGroupId}:${subjectId}`, line);
      }
    }
  }
  const cells = new Map<string, PlannedCell>();
  const subjectTotals = new Map<string, TargetTotal>();
  for (const cell of coverage.cells) {
    cells.set(`${cell.studentGroupId}:${cell.subjectId}`, cell);
    const total = subjectTotals.get(cell.subjectId) ?? {
      planned: 0,
      target: null,
      plannedHours: 0,
      targetHours: null,
    };
    total.planned += cell.plannedMinutesPerWeek;
    total.plannedHours = tenth(total.plannedHours + cell.plannedHours);
    if (cell.targetMinutesPerWeek !== null) {
      total.target = (total.target ?? 0) + cell.targetMinutesPerWeek;
      total.targetHours = tenth((total.targetHours ?? 0) + (cell.targetHours ?? 0));
    }
    subjectTotals.set(cell.subjectId, total);
  }

  let planned = 0;
  let target = 0;
  let plannedHours = 0;
  let targetHours = 0;
  let anyTarget = false;
  for (const summary of coverage.groups) {
    planned += summary.plannedMinutesPerWeek;
    plannedHours += summary.plannedHours;
    if (summary.localTimplanId !== null) {
      anyTarget = true;
      target += summary.targetMinutesPerWeek;
      targetHours += summary.targetHours;
    }
  }

  const unattachedGrades: number[] = [];
  const drafts: TargetView["draftPlans"] = [];
  const emptyPlanGrades: TargetView["emptyPlanGrades"] = [];
  for (const verdict of coverage.verdicts) {
    if (verdict.code === "TIMPLAN_YEAR_GRADE_UNATTACHED" && verdict.gradeLevel !== undefined) {
      unattachedGrades.push(verdict.gradeLevel);
    } else if (verdict.code === "TIMPLAN_ATTACHED_PLAN_EMPTY" && verdict.gradeLevel !== undefined) {
      emptyPlanGrades.push({
        gradeLevel: verdict.gradeLevel,
        planName: String(verdict.params.planName ?? ""),
      });
    } else if (verdict.code === "TIMPLAN_ATTACHED_DRAFT" && verdict.localTimplanId) {
      drafts.push({
        id: verdict.localTimplanId,
        name: plans.find((plan) => plan.id === verdict.localTimplanId)?.name ?? "",
        gradeLevels: verdict.gradeLevels ?? [],
      });
    }
  }

  return {
    coverage,
    cell(groupId, subjectId) {
      const key = `${groupId}:${subjectId}`;
      const cell = cells.get(key);
      const line = lineByCell.get(key);
      if (!cell || !line) return null;
      return {
        planned: cell.plannedMinutesPerWeek,
        target: cell.targetMinutesPerWeek,
        delta: line.deltaMinutesPerWeek,
        tone: toneOf(cell.status),
        alternative: cell.alternativeCode !== null,
        partnerSubjectIds: line.subjectIds.filter((id) => id !== subjectId),
      };
    },
    summary: (groupId) => summaries.get(groupId) ?? null,
    subjectTotals,
    total: {
      planned,
      target: anyTarget ? target : null,
      plannedHours: tenth(plannedHours),
      targetHours: anyTarget ? tenth(targetHours) : null,
    },
    unattachedGrades,
    draftPlans: drafts,
    emptyPlanGrades,
  };
}

/** The cell dialog's fields, as text, the way the dialog holds them. */
export interface DraftFields {
  lessonsPerWeek: string;
  minutesPerLesson: string;
  recurrence: LessonRecurrence;
  /** "" for the year's own boundary. */
  startDate: string;
  endDate: string;
}

/**
 * What the dialog's hint says, for the post being edited.
 *
 * - `teachingGroup`: a teaching group has no årskurs of its own and so no
 *   target; its pupils are judged on the coverage page.
 * - `noGrade`: a class without an årskurs cannot be matched to a plan.
 * - `noPlan`: the year attaches no plan to the class's årskurs.
 * - `notCounted`: the subject is not undervisningstid (Mentorstid and the
 *   like), so no timplan line exists for it.
 * - `noTarget`: the plan has no minutes for this subject in this årskurs.
 * - `target`: the plan's figure, and — when the fields hold a post the API
 *   would take — what the post gives with them, judged on the line.
 */
export type DraftHint =
  | { kind: "teachingGroup" }
  | { kind: "noGrade" }
  | { kind: "noPlan"; gradeLevel: number }
  | { kind: "notCounted"; gradeLevel: number; draft: boolean }
  | { kind: "noTarget"; gradeLevel: number; draft: boolean }
  | {
      kind: "target";
      gradeLevel: number;
      draft: boolean;
      target: number;
      /** Null while the fields do not hold a post the API would accept. */
      planned: number | null;
      delta: number | null;
      status: PlannedStatus | null;
      lessonsPerWeek: number;
      minutesPerLesson: number;
      /** The line's other subjects: SvA beside Svenska, the other språkval. */
      partnerSubjectIds: string[];
    };

/** The bounds the dialog's save button and CreateTeachingRequirementDto hold. */
function validDraft(fields: DraftFields): { lessons: number; minutes: number } | null {
  const lessons = Number(fields.lessonsPerWeek);
  const minutes = Number(fields.minutesPerLesson);
  if (fields.lessonsPerWeek.trim() === "" || fields.minutesPerLesson.trim() === "") return null;
  if (!Number.isInteger(lessons) || lessons < 1 || lessons > 40) return null;
  if (!Number.isInteger(minutes) || minutes < 15 || minutes > 240) return null;
  return { lessons, minutes };
}

/**
 * The hint for one cell, with the post as the fields hold it right now.
 *
 * The module is asked about ONE class with no pupils: the class's own line is
 * all a post can change, and a class-only run costs nothing per keystroke even
 * in a 600-pupil school. The post being edited replaces the stored row for
 * the same (group, subject) — the matrix holds one per cell — so an edit is
 * judged as the save would leave it, and a new post is judged as if added.
 */
export function draftHint(
  input: PlannedCoverageInput,
  groupId: string,
  subjectId: string,
  fields: DraftFields,
): DraftHint | null {
  const group = input.groups.find((entry) => entry.id === groupId);
  if (!group) return null;
  if (group.kind !== "CLASS") return { kind: "teachingGroup" };
  const gradeLevel = group.gradeLevel;
  if (gradeLevel === null) return { kind: "noGrade" };
  const attachment = input.attachments.find((row) => row.gradeLevel === gradeLevel);
  const plan = attachment
    ? input.plans.find((entry) => entry.id === attachment.localTimplanId)
    : undefined;
  if (!plan) return { kind: "noPlan", gradeLevel };
  const draft = plan.status === "DRAFT";
  const subject = input.subjects.find((entry) => entry.id === subjectId);
  if (subject && !subject.countsTowardTimplan) return { kind: "notCounted", gradeLevel, draft };

  const valid = validDraft(fields);
  const rows = input.requirements.filter(
    (row) => row.studentGroupId === groupId && row.subjectId !== subjectId,
  );
  if (valid) {
    rows.push({
      id: "__draft__",
      studentGroupId: groupId,
      subjectId,
      lessonsPerWeek: valid.lessons,
      minutesPerLesson: valid.minutes,
      recurrence: fields.recurrence,
      startDate: fields.startDate === "" ? null : fields.startDate,
      endDate: fields.endDate === "" ? null : fields.endDate,
    });
  }
  const coverage = computePlannedCoverage({
    ...input,
    groups: [group],
    requirements: rows,
    pupils: [],
    includePupils: false,
  });
  const line = coverage.groups[0]?.lines.find((entry) => entry.subjectIds.includes(subjectId));
  if (!line || line.targetMinutesPerWeek === null) return { kind: "noTarget", gradeLevel, draft };
  return {
    kind: "target",
    gradeLevel,
    draft,
    target: line.targetMinutesPerWeek,
    planned: valid ? line.plannedMinutesPerWeek : null,
    delta: valid ? line.deltaMinutesPerWeek : null,
    status: valid ? line.status : null,
    lessonsPerWeek: valid?.lessons ?? 0,
    minutesPerLesson: valid?.minutes ?? 0,
    partnerSubjectIds: line.subjectIds.filter((id) => id !== subjectId),
  };
}
