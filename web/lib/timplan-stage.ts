// Stadiesummor per elev, as the browser computes them.
//
// A MIRROR OF src/common/timplan-stage.ts, not a second opinion on it: a
// pupil's hours over a stadium, summed across the stadium's läsår, against the
// national hours of the lydelse that applies to that pupil, and the class
// summary (min / median / max) over a class's pupils. The Stadium tab on
// /admin/timplan/tackning gets the school's class rows from the gateway, and
// paints an opened class from the drill-down it fetches — summarizeClassStages
// over that class's pupils, here — so the row and its drill-down are one
// computation. If the two copies drifted, a class would read "3 under
// timplanen" in the table and two in its own panel. Both replay
// src/common/__fixtures__/timplan-stage-cases.json, generated from the gateway
// copy; timplan-stage.contract.test.ts asserts it here.
//
// What is summed (planned, outcome, projected), why "unrecorded" is never a
// number of hours, why a shortfall under an hour is not a finding, and every
// verdict being a warning or a notice, never a refusal, is argued in the
// gateway file's header and not repeated here. The body below is that file
// with the quotes this package's style uses; keep it that way, so a diff of
// the two shows only the header.

import {
  baseStageOf,
  cohortStartYear,
  pupilRegime,
  stageAssumesOldDistribution,
  stageCutOf,
  stageVersionFor,
  versionGradeOf,
  type Regime,
} from "@/lib/timplan-cohorts";
import { nationalCellOf, type BaseStage, type SchoolForm, type TimplanStage } from "@/lib/timplan-coverage";

export type StageApplicability = "STAGES_NOT_COMPLETED" | "COHORTS_STARTING";

export interface StageVersionEntry {
  subjectCode: string;
  stage: TimplanStage;
  hours: number;
  minimumHoursPerChild: number | null;
  protectedFromReduction: boolean;
}

export interface StageVersion {
  code: string;
  schoolForm: SchoolForm;
  totalHours: number;
  reductionCapPercent: number | null;
  appliesFromCohortTerm: string;
  appliesBy: StageApplicability;
  entries: StageVersionEntry[];
}

export interface StageNationalSubject {
  code: string;
  name: string;
  parentCode: string | null;
}

/** One line of a cell block: a school subject's minutes under its national code. */
export interface StageLine {
  /** The subject's own national code (BI, not NO); null for a subject without one. */
  code: string | null;
  plannedMinutes: number;
  deliveredMinutes: number;
  creditedMinutes: number;
  /** P3's planned minutes of published-gap days, counted at plan (in the outcome). */
  atPlanMinutes: number;
  /** The current year's projection ahead (calendar, grundschema, credits); a future grade's whole target. */
  aheadMinutes: number;
}

/** A pupil's minutes in one läsår at one årskurs (a grade change mid-year is two blocks). */
export interface StageYearCells {
  /** Null for a future grade. */
  academicYearId: string | null;
  /** The HT the year starts in (a future grade's: the HT it will be sat in). */
  yearStartHT: number;
  /** As recorded (or, for a future grade, as projected): the new numbering from HT 2028. */
  gradeLevel: number | null;
  /** The form of the lokal timplan the year attaches to this årskurs; null when none. */
  schoolForm: SchoolForm | null;
  basis: "RECORDED" | "FUTURE";
  /**
   * Per mille of the year's weekdays the pupil is recorded in a class of this
   * årskurs (0..1000). FUTURE: 1000 when a plan carries the grade, else 0.
   */
  recordedPermille: number;
  /** The first day recorded in this block; null for a future grade. */
  recordedFrom: string | null;
  /** A segment of this block was written by the migration's backfill. */
  backfilled: boolean;
  /** Some of the pupil's days this year were in a class since deleted (unrecorded). */
  classDeleted: boolean;
  /**
   * Some of the pupil's days this year had a home group that is not a class
   * (a teaching group): unrecorded, as P2 and P3 count no pupil without a
   * CLASS home. Absent when false.
   */
  homeNotClass?: boolean;
  lines: StageLine[];
}

export interface StagePupilInput {
  id: string;
  homeGroupId: string | null;
  years: StageYearCells[];
}

export interface StageInput {
  /** The school's today, YYYY-MM-DD; the statement and the page say "as of". */
  asOfDate: string;
  /** The active year: the pupil's current stage is the one they sit in it. */
  activeYearId: string;
  versions: StageVersion[];
  nationalSubjects: StageNationalSubject[];
  pupils: StagePupilInput[];
}

export type StageCellStatus = "MET" | "BELOW" | "BELOW_WITHIN_CAP" | "UNRECORDED" | "NO_NATIONAL";

export interface StageChild {
  code: string;
  minimumHours: number;
  plannedHours: number;
}

export interface StageCell {
  /** Top-level national code: MA, SV_SVA, NO, SO, HKK … */
  code: string;
  /** Null without a version, or with one that prints no distribution (or no such cell). */
  nationalHours: number | null;
  plannedHours: number;
  outcomeHours: number;
  projectedHours: number;
  /** national − planned / projected, rounded UP to the tenth; 0 when met or not judged. */
  plannedShortfallHours: number;
  projectedShortfallHours: number;
  protectedFromReduction: boolean;
  status: StageCellStatus;
  projectedStatus: StageCellStatus;
  children?: StageChild[];
}

export interface PupilStage {
  stage: TimplanStage;
  versionCode: string | null;
  distributionPublished: boolean;
  totalHours: number | null;
  /** The stage's version grades. */
  grades: number[];
  recordedGrades: number[];
  /** Recorded, but for part of the year only. */
  partlyRecordedGrades: number[];
  /** No class history at all. */
  unrecordedGrades: number[];
  /** Ahead, carried by a plan. */
  plannedGrades: number[];
  /** Ahead, and no plan carries them. */
  unplannedGrades: number[];
  /** The pupil sits in this stage in the active year. */
  current: boolean;
  /** Every grade recorded in full or planned ahead: the verdicts judge it. */
  complete: boolean;
  recordedFrom: string | null;
  backfilled: boolean;
  classDeleted: boolean;
  /** A PRE_2028 stage read against SFS 2023:945's cells for a year from HT 2028. */
  distributionAssumed: boolean;
  cells: StageCell[];
  /** Subjects without a national code, outside every cell. */
  unmapped: { plannedHours: number; outcomeHours: number; projectedHours: number };
}

export type StageVerdictCode =
  | "TIMPLAN_PUPIL_STAGE_BELOW_NATIONAL"
  | "TIMPLAN_PUPIL_STAGE_PROJECTED_BELOW_NATIONAL"
  | "TIMPLAN_PUPIL_STAGE_GROUP_MINIMUM_UNMET"
  | "TIMPLAN_PUPIL_STAGE_PARTLY_UNRECORDED"
  | "TIMPLAN_PUPIL_STAGE_BACKFILLED"
  | "TIMPLAN_STAGE_VERSION_NOT_IN_REFERENCE"
  | "TIMPLAN_STAGE_DISTRIBUTION_UNPUBLISHED"
  | "TIMPLAN_STAGE_OLD_COHORT_DISTRIBUTION_ASSUMED"
  | "TIMPLAN_PUPIL_STAGE_FORM_CHANGED"
  | "TIMPLAN_PUPIL_STAGE_GRADE_UNKNOWN"
  | "TIMPLAN_PUPIL_STAGE_GRADE_REPEATED"
  | "TIMPLAN_PUPIL_STAGE_PRESCHOOL_AFTER_2028"
  | "TIMPLAN_PUPIL_STAGE_HOME_NOT_A_CLASS"
  | "TIMPLAN_PUPIL_STAGE_SUBJECTS_UNMAPPED";

export interface StageVerdict {
  code: StageVerdictCode;
  severity: "notice" | "warning";
  pupilId: string;
  stage?: TimplanStage;
  subjectCode?: string;
  params: Record<string, string | number>;
}

export interface StagePupil {
  pupilId: string;
  homeGroupId: string | null;
  regime: Regime;
  /** The HT the pupil began åk 1 in their regime's numbering; null when no grade is known. */
  cohortStartHT: number | null;
  schoolForm: SchoolForm;
  stages: PupilStage[];
  verdicts: StageVerdict[];
}

export interface StageCoverage {
  asOfDate: string;
  pupils: StagePupil[];
}

/** One hour, in minutes; the verdict threshold. */
const HOUR = 60;
/** A grade counts as recorded in full from this share (per mille): a day or two of rounding. */
const FULL = 995;

const STAGE_ORDER: Record<TimplanStage, number> = { LAG: 0, LAG_MELLAN: 1, MELLAN: 2, HOG: 3 };
const VERDICT_ORDER: Record<StageVerdictCode, number> = {
  TIMPLAN_STAGE_VERSION_NOT_IN_REFERENCE: 0,
  TIMPLAN_STAGE_DISTRIBUTION_UNPUBLISHED: 1,
  TIMPLAN_STAGE_OLD_COHORT_DISTRIBUTION_ASSUMED: 2,
  TIMPLAN_PUPIL_STAGE_PRESCHOOL_AFTER_2028: 3,
  TIMPLAN_PUPIL_STAGE_GRADE_UNKNOWN: 4,
  TIMPLAN_PUPIL_STAGE_HOME_NOT_A_CLASS: 5,
  TIMPLAN_PUPIL_STAGE_GRADE_REPEATED: 6,
  TIMPLAN_PUPIL_STAGE_FORM_CHANGED: 7,
  TIMPLAN_PUPIL_STAGE_SUBJECTS_UNMAPPED: 8,
  TIMPLAN_PUPIL_STAGE_PARTLY_UNRECORDED: 9,
  TIMPLAN_PUPIL_STAGE_BACKFILLED: 10,
  TIMPLAN_PUPIL_STAGE_BELOW_NATIONAL: 11,
  TIMPLAN_PUPIL_STAGE_PROJECTED_BELOW_NATIONAL: 12,
  TIMPLAN_PUPIL_STAGE_GROUP_MINIMUM_UNMET: 13,
};

const byCode = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
/** Minutes → hours to the tenth. */
const hours = (minutes: number): number => Math.round(minutes / 6) / 10;
/** Minutes → hours rounded UP to the tenth: a shortfall never reads 0,0. */
const hoursUp = (minutes: number): number => Math.ceil(minutes / 6) / 10;

interface CellSum {
  code: string;
  stage: TimplanStage;
  planned: number;
  outcome: number;
  projected: number;
  childPlanned: Map<string, number>;
}

/** The base stages a reported stage spans: HKK's merged cell spans two. */
const BASES_OF: Record<TimplanStage, BaseStage[]> = {
  LAG: ["LAG"],
  LAG_MELLAN: ["LAG", "MELLAN"],
  MELLAN: ["MELLAN"],
  HOG: ["HOG"],
};

export function computePupilStages(input: StageInput): StageCoverage {
  const parentOf = new Map(input.nationalSubjects.map((subject) => [subject.code, subject.parentCode]));
  const pupils = [...input.pupils].sort((a, b) => byCode(a.id, b.id)).map((pupil) => stagesOfPupil(input, pupil, parentOf));
  return { asOfDate: input.asOfDate, pupils };
}

function stagesOfPupil(
  input: StageInput,
  pupil: StagePupilInput,
  parentOf: ReadonlyMap<string, string | null>,
): StagePupil {
  const verdicts: StageVerdict[] = [];
  const say = (verdict: Omit<StageVerdict, "pupilId">) => verdicts.push({ ...verdict, pupilId: pupil.id });
  const recorded = pupil.years.filter((year) => year.basis === "RECORDED");
  const regime = pupilRegime(recorded.map((year) => ({ ht: year.yearStartHT, gradeLevel: year.gradeLevel })));

  // The form: the latest year's attached plan; grundskola when none says.
  const byTime = [...pupil.years].sort((a, b) => a.yearStartHT - b.yearStartHT || (a.gradeLevel ?? -1) - (b.gradeLevel ?? -1));
  const formed = byTime.filter((year) => year.schoolForm !== null);
  const schoolForm: SchoolForm = formed.length > 0 ? formed[formed.length - 1]!.schoolForm! : "GRUNDSKOLA";
  const cut = stageCutOf(regime, schoolForm);

  // Each block's version grade and base stage.
  const blocks = byTime.map((year) => {
    const versionGrade = versionGradeOf(regime, year.yearStartHT, year.gradeLevel);
    return { year, versionGrade, base: baseStageOf(cut, versionGrade) };
  });
  // A home group that is not a class, once per läsår: those days are unrecorded.
  for (const ht of [...new Set(blocks.filter(({ year }) => year.basis === "RECORDED" && year.homeNotClass).map(({ year }) => year.yearStartHT))]) {
    say({ code: "TIMPLAN_PUPIL_STAGE_HOME_NOT_A_CLASS", severity: "notice", params: { yearStartHT: ht } });
  }
  for (const { year } of blocks) {
    if (year.basis !== "RECORDED" || year.recordedPermille === 0) continue;
    if (year.gradeLevel === null) {
      say({ code: "TIMPLAN_PUPIL_STAGE_GRADE_UNKNOWN", severity: "notice", params: { yearStartHT: year.yearStartHT } });
    } else if (year.gradeLevel === 0 && year.yearStartHT >= 2028) {
      say({ code: "TIMPLAN_PUPIL_STAGE_PRESCHOOL_AFTER_2028", severity: "notice", params: { yearStartHT: year.yearStartHT } });
    }
  }

  // The cohort, from the latest recorded block with a grade (a repeated year
  // moves it; STAGES_NOT_COMPLETED is judged on when the stage really ends).
  const graded = blocks.filter((block) => block.year.basis === "RECORDED" && block.versionGrade !== null);
  const latest = graded.length > 0 ? graded[graded.length - 1]! : null;
  const cohortStartHT = latest ? cohortStartYear(latest.versionGrade!, latest.year.yearStartHT) : null;

  const activeBlock = blocks.filter((block) => block.year.academicYearId === input.activeYearId && block.year.recordedPermille > 0);
  const currentBase = activeBlock.length > 0 ? activeBlock[activeBlock.length - 1]!.base : null;

  // The version each base stage is judged against: by when its last grade is
  // (or will be) sat — from a block of that grade, else from the latest grade.
  const versionOf = (base: BaseStage): StageVersion | null => {
    const grades = cut[base];
    if (grades.length === 0) return null;
    const last = grades[grades.length - 1]!;
    const lastBlock = [...blocks].reverse().find((block) => block.base === base && block.versionGrade === last);
    const stageEndHT = lastBlock
      ? lastBlock.year.yearStartHT
      : latest
        ? latest.year.yearStartHT + (last - latest.versionGrade!)
        : null;
    return stageVersionFor(input.versions, schoolForm, regime, cohortStartHT, stageEndHT);
  };
  // HKK's merged cell: printed by the version mellanstadiet (the later half)
  // is judged against; its minutes leave LAG and MELLAN for LAG_MELLAN.
  const mellanVersion = versionOf("MELLAN");
  const mergedCodes = new Set(
    (mellanVersion?.entries ?? []).filter((entry) => entry.stage === "LAG_MELLAN").map((entry) => entry.subjectCode),
  );

  const stages: PupilStage[] = [];
  for (const stageKey of ["LAG", "LAG_MELLAN", "MELLAN", "HOG"] as const) {
    const bases = BASES_OF[stageKey];
    if (stageKey === "LAG_MELLAN" && mergedCodes.size === 0) continue;
    const grades = bases.flatMap((base) => cut[base]);
    const inStage = blocks.filter((block) => block.base !== null && bases.includes(block.base));
    const current = currentBase !== null && bases.includes(currentBase);
    if (grades.length === 0 || (inStage.length === 0 && !current)) continue;
    const version = stageKey === "LAG_MELLAN" ? mellanVersion : versionOf(stageKey);
    const merged = stageKey === "LAG_MELLAN";

    // Per grade: what is known of it. A recorded block that records no day
    // (a grade sat wholly in a class since deleted, or in no class) says
    // nothing about its grade: the grade is unrecorded, never a recorded 0 h
    // that would complete the stage and read as a shortfall.
    const share = new Map<number, number>();
    const future = new Map<number, number>();
    for (const block of inStage) {
      if (block.year.basis === "RECORDED" && block.year.recordedPermille === 0) continue;
      const target = block.year.basis === "RECORDED" ? share : future;
      target.set(block.versionGrade!, (target.get(block.versionGrade!) ?? 0) + block.year.recordedPermille);
    }
    const recordedGrades = grades.filter((grade) => (share.get(grade) ?? 0) >= FULL);
    const partlyRecordedGrades = grades.filter((grade) => (share.get(grade) ?? 0) > 0 && (share.get(grade) ?? 0) < FULL);
    const plannedGrades = grades.filter((grade) => !share.has(grade) && (future.get(grade) ?? 0) >= FULL);
    const unplannedGrades = grades.filter((grade) => !share.has(grade) && future.has(grade) && (future.get(grade) ?? 0) < FULL);
    const unrecordedGrades = grades.filter((grade) => !share.has(grade) && !future.has(grade));
    const complete = partlyRecordedGrades.length === 0 && unrecordedGrades.length === 0 && unplannedGrades.length === 0;

    const recordedBlocks = inStage.filter((block) => block.year.basis === "RECORDED");
    const froms = recordedBlocks.map((block) => block.year.recordedFrom).filter((from): from is string => from !== null).sort();
    const recordedFrom = froms[0] ?? null;
    const backfilled = recordedBlocks.some((block) => block.year.backfilled);
    const classDeleted = recordedBlocks.some((block) => block.year.classDeleted);
    const assumed = version !== null && stageAssumesOldDistribution(regime, inStage.map((block) => block.year.yearStartHT));
    const published = (version?.entries.length ?? 0) > 0;

    // The base stages' own notices (the merged stage repeats none of them).
    if (!merged) {
      const repeated = grades.filter(
        (grade) =>
          new Set(recordedBlocks.filter((block) => block.versionGrade === grade).map((block) => block.year.academicYearId)).size > 1,
      );
      for (const grade of repeated) {
        say({ code: "TIMPLAN_PUPIL_STAGE_GRADE_REPEATED", severity: "notice", stage: stageKey, params: { gradeLevel: grade } });
      }
      const forms = new Set(inStage.map((block) => block.year.schoolForm).filter((form): form is SchoolForm => form !== null));
      if (forms.size > 1) {
        say({ code: "TIMPLAN_PUPIL_STAGE_FORM_CHANGED", severity: "notice", stage: stageKey, params: { schoolForm } });
      }
      if (version === null) {
        say({ code: "TIMPLAN_STAGE_VERSION_NOT_IN_REFERENCE", severity: "notice", stage: stageKey, params: { schoolForm, regime } });
      } else if (!published) {
        say({
          code: "TIMPLAN_STAGE_DISTRIBUTION_UNPUBLISHED",
          severity: "notice",
          stage: stageKey,
          params: { versionCode: version.code, totalHours: version.totalHours },
        });
      }
      if (assumed) {
        say({ code: "TIMPLAN_STAGE_OLD_COHORT_DISTRIBUTION_ASSUMED", severity: "notice", stage: stageKey, params: { versionCode: version!.code } });
      }
      if (!complete) {
        say({
          code: "TIMPLAN_PUPIL_STAGE_PARTLY_UNRECORDED",
          severity: "notice",
          stage: stageKey,
          params: {
            unrecordedGrades: unrecordedGrades.join(", "),
            partlyRecordedGrades: partlyRecordedGrades.join(", "),
            unplannedGrades: unplannedGrades.join(", "),
            recordedFrom: recordedFrom ?? "",
            classDeleted: classDeleted ? 1 : 0,
          },
        });
      }
      if (backfilled) {
        say({ code: "TIMPLAN_PUPIL_STAGE_BACKFILLED", severity: "notice", stage: stageKey, params: { recordedFrom: recordedFrom ?? "" } });
      }
    }

    // Roll the lines into this stage's cells.
    const sums = new Map<string, CellSum>();
    const unmapped = { planned: 0, outcome: 0, projected: 0 };
    for (const block of inStage) {
      for (const line of block.year.lines) {
        const outcome = line.deliveredMinutes + line.creditedMinutes + line.atPlanMinutes;
        const projected = outcome + line.aheadMinutes;
        if (line.code === null) {
          if (merged) continue;
          unmapped.planned += line.plannedMinutes;
          unmapped.outcome += outcome;
          unmapped.projected += projected;
          continue;
        }
        const { top, stage } = nationalCellOf(line.code, block.base!, parentOf, mergedCodes);
        if (stage !== stageKey) continue;
        let sum = sums.get(top);
        if (!sum) sums.set(top, (sum = { code: top, stage, planned: 0, outcome: 0, projected: 0, childPlanned: new Map() }));
        sum.planned += line.plannedMinutes;
        sum.outcome += outcome;
        sum.projected += projected;
        if (top !== line.code) sum.childPlanned.set(line.code, (sum.childPlanned.get(line.code) ?? 0) + line.plannedMinutes);
      }
    }
    // Every printed cell of the stage, planned or not: a cell with nothing
    // planned is the clearest shortfall there is — once the school maps its
    // subjects at all. A stage whose every minute is a subject without a
    // national code says nothing of any cell (SUBJECTS_UNMAPPED), rather than
    // reading every cell as 0 h: the mapping is missing, not the teaching.
    const mapped = inStage.some((block) => block.year.lines.some((entry) => entry.code !== null));
    if (!merged && !mapped && unmapped.planned + unmapped.projected > 0) {
      say({ code: "TIMPLAN_PUPIL_STAGE_SUBJECTS_UNMAPPED", severity: "notice", stage: stageKey, params: { plannedHours: hours(unmapped.planned) } });
    }
    for (const entry of mapped ? (version?.entries ?? []) : []) {
      if (entry.stage !== stageKey || parentOf.get(entry.subjectCode)) continue;
      if (!sums.has(entry.subjectCode)) {
        sums.set(entry.subjectCode, { code: entry.subjectCode, stage: stageKey, planned: 0, outcome: 0, projected: 0, childPlanned: new Map() });
      }
    }

    const cap = version?.reductionCapPercent ?? null;
    const cells: StageCell[] = [];
    for (const sum of [...sums.values()].sort((a, b) => byCode(a.code, b.code))) {
      const entry = version?.entries.find((candidate) => candidate.subjectCode === sum.code && candidate.stage === stageKey);
      const national = entry ? entry.hours * HOUR : null;
      const judge = (figure: number): { status: StageCellStatus; shortfall: number } => {
        if (!published || national === null) return { status: "NO_NATIONAL", shortfall: 0 };
        if (!complete) return { status: "UNRECORDED", shortfall: 0 };
        const short = national - figure;
        if (short < HOUR) return { status: "MET", shortfall: 0 };
        const within = !entry!.protectedFromReduction && cap !== null && short * 100 <= cap * national;
        return { status: within ? "BELOW_WITHIN_CAP" : "BELOW", shortfall: short };
      };
      const planned = judge(sum.planned);
      const projected = judge(sum.projected);
      const children: StageChild[] = [];
      const printedChildren = (version?.entries ?? [])
        .filter((candidate) => parentOf.get(candidate.subjectCode) === sum.code && candidate.stage === stageKey)
        .sort((a, b) => byCode(a.subjectCode, b.subjectCode));
      for (const child of printedChildren) {
        const childPlanned = sum.childPlanned.get(child.subjectCode) ?? 0;
        children.push({ code: child.subjectCode, minimumHours: child.hours, plannedHours: hours(childPlanned) });
        // Judged where the pupil's subjects name the children at all (P1's rule).
        if (complete && published && sum.childPlanned.size > 0 && child.hours * HOUR - childPlanned >= HOUR) {
          say({
            code: "TIMPLAN_PUPIL_STAGE_GROUP_MINIMUM_UNMET",
            severity: "warning",
            stage: stageKey,
            subjectCode: sum.code,
            params: {
              childCode: child.subjectCode,
              minimumHours: child.hours,
              plannedHours: hours(childPlanned),
              shortfallHours: hoursUp(child.hours * HOUR - childPlanned),
            },
          });
        }
      }
      const cell: StageCell = {
        code: sum.code,
        nationalHours: national === null ? null : national / HOUR,
        plannedHours: hours(sum.planned),
        outcomeHours: hours(sum.outcome),
        projectedHours: hours(sum.projected),
        plannedShortfallHours: hoursUp(planned.shortfall),
        projectedShortfallHours: hoursUp(projected.shortfall),
        protectedFromReduction: entry?.protectedFromReduction ?? false,
        status: planned.status,
        projectedStatus: projected.status,
        ...(children.length > 0 ? { children } : {}),
      };
      for (const [judged, figure, code] of [
        [planned, cell.plannedHours, "TIMPLAN_PUPIL_STAGE_BELOW_NATIONAL"],
        [projected, cell.projectedHours, "TIMPLAN_PUPIL_STAGE_PROJECTED_BELOW_NATIONAL"],
      ] as const) {
        if (judged.status !== "BELOW" && judged.status !== "BELOW_WITHIN_CAP") continue;
        say({
          code,
          severity: judged.status === "BELOW" ? "warning" : "notice",
          stage: stageKey,
          subjectCode: sum.code,
          params: {
            versionCode: version!.code,
            nationalHours: national! / HOUR,
            hours: figure,
            shortfallHours: hoursUp(judged.shortfall),
            withinCap: judged.status === "BELOW_WITHIN_CAP" ? 1 : 0,
            ...(cap !== null ? { capPercent: cap } : {}),
          },
        });
      }
      cells.push(cell);
    }

    stages.push({
      stage: stageKey,
      versionCode: version?.code ?? null,
      distributionPublished: published,
      totalHours: version?.totalHours ?? null,
      grades,
      recordedGrades,
      partlyRecordedGrades,
      unrecordedGrades,
      plannedGrades,
      unplannedGrades,
      current,
      complete,
      recordedFrom,
      backfilled,
      classDeleted,
      distributionAssumed: assumed,
      cells,
      unmapped: { plannedHours: hours(unmapped.planned), outcomeHours: hours(unmapped.outcome), projectedHours: hours(unmapped.projected) },
    });
  }

  verdicts.sort(
    (a, b) =>
      VERDICT_ORDER[a.code] - VERDICT_ORDER[b.code] ||
      (a.stage ? STAGE_ORDER[a.stage] : -1) - (b.stage ? STAGE_ORDER[b.stage] : -1) ||
      byCode(a.subjectCode ?? "", b.subjectCode ?? "") ||
      byCode(String(a.params["childCode"] ?? ""), String(b.params["childCode"] ?? "")),
  );
  return { pupilId: pupil.id, homeGroupId: pupil.homeGroupId, regime, cohortStartHT, schoolForm, stages, verdicts };
}

/** min / median / max, P3's statsOf convention, over hours to the tenth. */
export interface HourStats {
  min: number;
  median: number;
  max: number;
}

function statsOf(values: number[]): HourStats {
  const tenths = values.map((value) => Math.round(value * 10)).sort((a, b) => a - b);
  const middle = tenths.length >> 1;
  const median = tenths.length % 2 === 1 ? tenths[middle]! : Math.round((tenths[middle - 1]! + tenths[middle]!) / 2);
  return { min: tenths[0]! / 10, median: median / 10, max: tenths[tenths.length - 1]! / 10 };
}

export interface ClassStageCell {
  code: string;
  /** The national hours when every pupil's version prints the same figure; null otherwise. */
  nationalHours: number | null;
  pupils: number;
  planned: HourStats;
  projected: HourStats;
  belowNational: number;
  projectedBelowNational: number;
  unrecordedPupils: number;
}

export interface ClassStageSummary {
  studentGroupId: string;
  stage: TimplanStage;
  /** The version codes the class's pupils are judged against, sorted; empty for none. */
  versionCodes: string[];
  pupils: number;
  completePupils: number;
  backfilledPupils: number;
  cells: ClassStageCell[];
}

/**
 * Per home class and CURRENT stage, per cell: min / median / max over the
 * class's pupils, how many are below, how many unrecorded. Carries no pupil
 * id — the overview is per class; the drill-down is the pupils.
 */
export function summarizeClassStages(coverage: StageCoverage): ClassStageSummary[] {
  const groups = new Map<string, { classId: string; stage: TimplanStage; entries: { pupil: StagePupil; stage: PupilStage }[] }>();
  for (const pupil of coverage.pupils) {
    if (pupil.homeGroupId === null) continue;
    for (const stage of pupil.stages) {
      if (!stage.current) continue;
      const key = `${pupil.homeGroupId}:${stage.stage}`;
      let group = groups.get(key);
      if (!group) groups.set(key, (group = { classId: pupil.homeGroupId, stage: stage.stage, entries: [] }));
      group.entries.push({ pupil, stage });
    }
  }
  const out: ClassStageSummary[] = [];
  for (const group of groups.values()) {
    const codes = [...new Set(group.entries.flatMap((entry) => entry.stage.cells.map((cell) => cell.code)))].sort(byCode);
    const cells: ClassStageCell[] = codes.map((code) => {
      const found = group.entries.map((entry) => entry.stage.cells.find((cell) => cell.code === code) ?? null);
      const present = found.filter((cell): cell is StageCell => cell !== null);
      const nationals = new Set(present.map((cell) => cell.nationalHours));
      const below = (status: StageCellStatus) => status === "BELOW" || status === "BELOW_WITHIN_CAP";
      return {
        code,
        nationalHours: nationals.size === 1 ? [...nationals][0]! : null,
        pupils: present.length,
        planned: statsOf(present.map((cell) => cell.plannedHours)),
        projected: statsOf(present.map((cell) => cell.projectedHours)),
        belowNational: present.filter((cell) => below(cell.status)).length,
        projectedBelowNational: present.filter((cell) => below(cell.projectedStatus)).length,
        unrecordedPupils: present.filter((cell) => cell.status === "UNRECORDED").length,
      };
    });
    out.push({
      studentGroupId: group.classId,
      stage: group.stage,
      versionCodes: [...new Set(group.entries.map((entry) => entry.stage.versionCode).filter((code): code is string => code !== null))].sort(byCode),
      pupils: group.entries.length,
      completePupils: group.entries.filter((entry) => entry.stage.complete).length,
      backfilledPupils: group.entries.filter((entry) => entry.stage.backfilled).length,
      cells,
    });
  }
  return out.sort((a, b) => byCode(a.studentGroupId, b.studentGroupId) || STAGE_ORDER[a.stage] - STAGE_ORDER[b.stage]);
}
