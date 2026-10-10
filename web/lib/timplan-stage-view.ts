// The Stadium tab on Täckning: GET /timplan-stages as the browser reads it,
// and the few pure steps between that answer and the tables.
//
// The response types mirror TimplanStageResponse in
// src/timplan/timplan-stage.service.ts. The overview carries one row per
// home class and CURRENT stage (min / median / max per cell, no pupil id);
// the drill-down (studentGroupId) adds every pupil of that class with their
// stages and verdicts, ids only. Names are the page's: the roster it already
// reads names a pupil, and a pupil it does not hold is "okänd elev".
//
// AN OPENED CLASS IS PAINTED FROM ITS OWN PUPILS. The drill-down is fetched
// afresh when it opens, and the class's row in it is summarizeClassStages
// over those pupils — the gateway's function, mirrored in lib/timplan-stage.ts
// and held to one fixture — so the panel's figures and its pupils are one
// computation, as of the same moment, even when the overview beside it was
// read a minute earlier.

import type { CohortNoticeRow } from "@/lib/timplan-cohorts";
import type { TimplanStage } from "@/lib/timplan-coverage";
import {
  summarizeClassStages,
  type ClassStageSummary,
  type StagePupil,
  type StageVerdict,
} from "@/lib/timplan-stage";

export interface StagePublicationSummary {
  academicYearId: string;
  publishedAt: string;
  publishedByUserId: string | null;
  asOfDate: string;
  pupils: number;
}

export type StageVerdictView = StageVerdict & { message: string };

export type StagePupilView = Omit<StagePupil, "verdicts"> & { verdicts: StageVerdictView[] };

export interface TimplanStageResponse {
  academicYearId: string;
  asOfDate: string;
  isActiveYear: boolean;
  classes: ClassStageSummary[];
  /** Only with studentGroupId: every pupil of that home class. */
  pupils: StagePupilView[] | null;
  verdictCounts: { code: StageVerdict["code"]; severity: StageVerdict["severity"]; pupils: number }[];
  cohorts: CohortNoticeRow[];
  publication: StagePublicationSummary | null;
}

/** The order stages are shown in: by age, HKK's merged cell between its halves. */
export const STAGE_ORDER: readonly TimplanStage[] = ["LAG", "LAG_MELLAN", "MELLAN", "HOG"];

/** The codes whose BELOW counts read "within the cap" when their severity is a notice. */
export const BELOW_CODES: readonly StageVerdict["code"][] = [
  "TIMPLAN_PUPIL_STAGE_BELOW_NATIONAL",
  "TIMPLAN_PUPIL_STAGE_PROJECTED_BELOW_NATIONAL",
];

export interface StageTable {
  stage: TimplanStage;
  /** Every cell code any class of the stage has, in code order. */
  codes: string[];
  rows: ClassStageSummary[];
}

/**
 * The overview as one table per stage: rows are the classes whose pupils sit
 * in it, sorted by the class's name; columns the cells any of them has. A
 * class with pupils in two stages (an F–1 class across the 2028 reform, or
 * HKK's merged cell beside lågstadiet) is a row in each.
 */
export function stageTables(classes: readonly ClassStageSummary[], className: (id: string) => string): StageTable[] {
  return STAGE_ORDER.flatMap((stage) => {
    const rows = classes
      .filter((row) => row.stage === stage)
      .sort(
        (a, b) =>
          className(a.studentGroupId).localeCompare(className(b.studentGroupId), "sv", { numeric: true }) ||
          (a.studentGroupId < b.studentGroupId ? -1 : 1),
      );
    if (rows.length === 0) return [];
    const codes = [...new Set(rows.flatMap((row) => row.cells.map((cell) => cell.code)))].sort((a, b) =>
      a < b ? -1 : a > b ? 1 : 0,
    );
    return [{ stage, codes, rows }];
  });
}

/** The pupils with a current stage: every class row but HKK's merged one, which repeats them. */
export function pupilsInStages(classes: readonly ClassStageSummary[]): number {
  return classes.filter((row) => row.stage !== "LAG_MELLAN").reduce((sum, row) => sum + row.pupils, 0);
}

/**
 * The opened class's rows, from its own drill-down: summarizeClassStages over
 * the pupils whose home class it is, one row per current stage.
 */
export function drillRows(response: TimplanStageResponse, studentGroupId: string): ClassStageSummary[] {
  const pupils = (response.pupils ?? []).filter((pupil) => pupil.homeGroupId === studentGroupId);
  return summarizeClassStages({ asOfDate: response.asOfDate, pupils }).filter(
    (row) => row.studentGroupId === studentGroupId,
  );
}

/** Whether a pupil carries a warning: the finding the drill-down lists by default. */
export const hasWarning = (pupil: StagePupilView): boolean =>
  pupil.verdicts.some((verdict) => verdict.severity === "warning");

/**
 * The pupils the drill-down lists: by default those with a warning of their
 * own; with `all`, the whole class. Ordered by name, ids breaking ties, so a
 * list read twice reads the same.
 */
export function listedPupils(
  pupils: readonly StagePupilView[],
  all: boolean,
  pupilName: (id: string) => string,
): StagePupilView[] {
  return pupils
    .filter((pupil) => all || hasWarning(pupil))
    .sort(
      (a, b) =>
        pupilName(a.pupilId).localeCompare(pupilName(b.pupilId), "sv") || (a.pupilId < b.pupilId ? -1 : 1),
    );
}

/** Hours to the tenth in the reader's language: "1 234,5 h", "1,234.5 h". */
export function stageHours(hours: number, locale: string): string {
  return `${new Intl.NumberFormat(locale, { maximumFractionDigits: 1 }).format(hours)} h`;
}

/** A list of grades in the reader's language: "1, 2 och 3", "1, 2, and 3". */
export function gradeList(grades: readonly (number | string)[], locale: string): string {
  return new Intl.ListFormat(locale, { type: "conjunction" }).format(grades.map(String));
}

/** "1, 2" — how the stage module joins grades into a verdict's params — back to a list. */
export const gradesOfParam = (value: string | number | undefined): string[] =>
  String(value ?? "")
    .split(", ")
    .filter((entry) => entry !== "");
