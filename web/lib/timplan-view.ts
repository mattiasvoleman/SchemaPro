/**
 * What the timplan grid on /admin/timplan shows, as pure functions.
 *
 * The verdicts come from lib/timplan-coverage.ts (the gateway's mirror) and
 * are not recomputed here; this file decides only how a verdict document
 * lands on a grid of SCHOOL subjects × årskurser — which columns exist, which
 * colour a stage sum takes, which cells a verdict lights up — and how the
 * grid's text inputs become the PUT body. Kept out of the page so each rule is
 * tested on its own, without rendering 200 inputs to reach it.
 *
 * THE COLOURS SAY "UNDER MÅL", NEVER "FEL". Three tones and a neutral:
 *
 *   met    the national cell is reached or passed
 *   below  under the cell, but within what the law lets skolans val take —
 *          the reduction cap, outside the protected subjects (a NOTICE)
 *   under  what the statute's own sentences rule out: a protected subject
 *          reduced, a cell cut past the cap, a NO/SO child under its minimum
 *          (a WARNING)
 *   none   nothing national to compare with: a subject without a code, a
 *          code the version prints no cell for, a lydelse whose fördelning
 *          is not published
 *
 * A stage sum is shown per school subject, but judged per NATIONAL cell:
 * Svenska and Svenska som andraspråk share SV_SVA, Biologi rolls into NO, and
 * a row is coloured by the cell it feeds. A child of an ämnesgrupp is
 * coloured `under` when the check found that child under its own minimum, and
 * by its group's cell otherwise.
 */

import type {
  BaseStage,
  CellCoverage,
  CoverageVersion,
  TimplanCheck,
  TimplanStage,
  TimplanVerdict,
} from "@/lib/timplan-coverage";
import type { NationalTimplanVersion } from "@/lib/types";
import type { EntryBody } from "@/lib/timplan-queries";

export type Tone = "met" | "below" | "under" | "none";

export const BASE_STAGES: BaseStage[] = ["LAG", "MELLAN", "HOG"];

export type GridColumn =
  | { kind: "grade"; grade: number; stage: BaseStage | null }
  | { kind: "stage"; stage: BaseStage };

/**
 * The grid's columns for a plan: F, then each stage's årskurser followed by
 * that stage's sum. The range follows the LYDELSE (via the check's
 * stageGrades), not the school form alone — specialskolan runs to årskurs 10,
 * sameskolan to 6, the 2028 grundskola to 10 — and a grade the plan holds
 * minutes for outside that range (an imported årskurs 10 in a nine-year plan)
 * gets a column of its own at the end rather than being hidden: the minutes
 * are stored, so they are shown, greyed as outside every stage.
 */
export function gridColumns(
  stageGrades: Record<BaseStage, number[]>,
  extraGrades: Iterable<number> = [],
): GridColumn[] {
  const columns: GridColumn[] = [{ kind: "grade", grade: 0, stage: null }];
  const placed = new Set<number>([0]);
  for (const stage of BASE_STAGES) {
    const grades = stageGrades[stage];
    if (grades.length === 0) continue;
    for (const grade of grades) {
      columns.push({ kind: "grade", grade, stage });
      placed.add(grade);
    }
    columns.push({ kind: "stage", stage });
  }
  for (const grade of [...new Set(extraGrades)].sort((a, b) => a - b)) {
    if (!placed.has(grade)) {
      columns.push({ kind: "grade", grade, stage: null });
      placed.add(grade);
    }
  }
  return columns;
}

/** The national cell a code feeds in a base stage: its own, or the merged låg+mellan one. */
export function cellFor(
  check: Pick<TimplanCheck, "cells">,
  topCode: string,
  stage: BaseStage,
): CellCoverage | undefined {
  return (
    check.cells.find((cell) => cell.subjectCode === topCode && cell.stage === stage) ??
    (stage === "HOG"
      ? undefined
      : check.cells.find((cell) => cell.subjectCode === topCode && cell.stage === "LAG_MELLAN"))
  );
}

const UNDER_CODES = new Set<TimplanVerdict["code"]>([
  "TIMPLAN_PROTECTED_SUBJECT_REDUCED",
  "TIMPLAN_REDUCTION_OVER_CAP",
  "TIMPLAN_GROUP_MINIMUM_UNMET",
]);

/**
 * The tone of one national cell, from the verdicts the check gave it.
 * `withChildMinima` false leaves the NO/SO children's minima out — the view a
 * child row takes of its group, where another child's shortfall is not its own.
 */
export function cellTone(
  check: TimplanCheck,
  cell: CellCoverage | undefined,
  withChildMinima = true,
): Tone {
  if (!cell || cell.nationalHours === 0) return "none";
  const about = check.verdicts.filter(
    (verdict) =>
      verdict.subjectCode === cell.subjectCode &&
      verdict.stage === cell.stage &&
      (withChildMinima || verdict.code !== "TIMPLAN_GROUP_MINIMUM_UNMET"),
  );
  if (about.some((verdict) => UNDER_CODES.has(verdict.code))) return "under";
  if (about.some((verdict) => verdict.code === "TIMPLAN_STAGE_BELOW_NATIONAL")) return "below";
  return "met";
}

/**
 * The tone of a school subject's stage sum. `nationalCode` is the subject's
 * own code (KE), `topCode` its group's (NO) or itself.
 *
 * A child row is `under` when the check found THAT child under its minimum;
 * otherwise it takes its group cell's tone without the other children's
 * minima — Biologi is not painted red because Kemi is short.
 */
export function rowTone(
  check: TimplanCheck,
  nationalCode: string | null,
  topCode: string | null,
  stage: BaseStage,
): Tone {
  if (nationalCode === null || topCode === null) return "none";
  const cell = cellFor(check, topCode, stage);
  if (nationalCode === topCode || !cell) return cellTone(check, cell);
  const childUnder = check.verdicts.some(
    (verdict) =>
      verdict.code === "TIMPLAN_GROUP_MINIMUM_UNMET" &&
      verdict.childCode === nationalCode &&
      verdict.stage === cell.stage,
  );
  return childUnder ? "under" : cellTone(check, cell, false);
}

/** The årskurser of a stage in this check, the merged LAG_MELLAN included. */
export function gradesOfStage(
  stageGrades: Record<BaseStage, number[]>,
  stage: TimplanStage,
): number[] {
  return stage === "LAG_MELLAN" ? [...stageGrades.LAG, ...stageGrades.MELLAN] : stageGrades[stage];
}

export interface Highlight {
  /** School subjects whose row is lit; null = no row (a plan-wide verdict). */
  subjectIds: Set<string> | null;
  /** Årskurser lit within those rows; null = every column of the row. */
  grades: Set<number> | null;
  /** The stage sums lit. */
  stages: Set<BaseStage>;
  /** The Totalt / Skolans val footer is what the verdict is about. */
  footer: boolean;
}

/**
 * The cells a verdict is about, for the warnings rail's click.
 *
 * A child's minimum lights the rows that ARE that child (Kemi), not every NO
 * subject; if the plan has no Kemi row at all — the commonest way to be under
 * a minimum — the group's rows are lit instead, since that is where the time
 * would have to come from. A cell no subject has minutes in yet lights the
 * subjects mapped to its code. A plan-wide verdict lights the footer.
 */
export function verdictHighlight(
  verdict: TimplanVerdict,
  subjects: { id: string; nationalCode: string | null }[],
  stageGrades: Record<BaseStage, number[]>,
  parentOf: ReadonlyMap<string, string | null> = new Map(),
): Highlight {
  const none: Highlight = { subjectIds: null, grades: null, stages: new Set(), footer: true };
  if (verdict.code === "TIMPLAN_SUBJECT_UNMAPPED") {
    return {
      subjectIds: new Set(verdict.subjectIds ?? [String(verdict.params.subjectId)]),
      grades: null,
      stages: new Set(),
      footer: false,
    };
  }
  if (!verdict.stage) return none;

  let ids = verdict.subjectIds ?? [];
  if (ids.length === 0 && verdict.subjectCode) {
    // A cell nobody has planned a minute in has no subjects behind it in the
    // check — the commonest shape of "under mål" while a plan is being built.
    // The rows that WOULD feed it are where the time has to go, so those.
    ids = subjects
      .filter(
        (subject) =>
          subject.nationalCode !== null &&
          (parentOf.get(subject.nationalCode) ?? subject.nationalCode) === verdict.subjectCode,
      )
      .map((subject) => subject.id);
  }
  if (verdict.childCode) {
    const children = subjects
      .filter((subject) => subject.nationalCode === verdict.childCode)
      .map((subject) => subject.id);
    if (children.length > 0) ids = children;
  }
  const stages: BaseStage[] =
    verdict.stage === "LAG_MELLAN" ? ["LAG", "MELLAN"] : [verdict.stage];
  return {
    subjectIds: new Set(ids),
    grades: new Set(gradesOfStage(stageGrades, verdict.stage)),
    stages: new Set(stages),
    footer: false,
  };
}

/** A grid cell's key: subject and årskurs. */
export const cellKey = (subjectId: string, grade: number): string => `${subjectId}:${grade}`;

/** What the admin typed, per cell. An absent key is an empty cell (no entry). */
export type DraftCells = Map<string, string>;

export function draftFromEntries(
  entries: { subjectId: string; gradeLevel: number; minutesPerWeek: number }[],
): DraftCells {
  return new Map(
    entries.map((entry) => [cellKey(entry.subjectId, entry.gradeLevel), String(entry.minutesPerWeek)]),
  );
}

/** A cell's text as minutes per week, or null when it is not 0..1200 whole minutes. */
export function parseMinutes(text: string): number | null {
  const trimmed = text.trim();
  if (!/^\d{1,4}$/.test(trimmed)) return null;
  const minutes = Number(trimmed);
  return minutes <= 1200 ? minutes : null;
}

/**
 * The grid as the PUT body, plus the cells that cannot be sent.
 *
 * An EMPTY cell is no entry; "0" is an entry of 0 minutes ("not taught that
 * year"), which the table holds as a value — the two are different on purpose
 * and the grid keeps them apart. A stored cell's note travels with it, since
 * the PUT replaces the plan whole and a note left out would be deleted.
 */
export function entriesFromDraft(
  draft: DraftCells,
  notes: ReadonlyMap<string, string | null>,
): { entries: EntryBody[]; invalid: string[] } {
  const entries: EntryBody[] = [];
  const invalid: string[] = [];
  for (const [key, text] of draft) {
    if (text.trim() === "") continue;
    const minutes = parseMinutes(text);
    if (minutes === null) {
      invalid.push(key);
      continue;
    }
    const separator = key.lastIndexOf(":");
    const subjectId = key.slice(0, separator);
    const gradeLevel = Number(key.slice(separator + 1));
    const note = notes.get(key);
    entries.push({ subjectId, gradeLevel, minutesPerWeek: minutes, ...(note ? { note } : {}) });
  }
  entries.sort((a, b) => a.gradeLevel - b.gradeLevel || (a.subjectId < b.subjectId ? -1 : 1));
  return { entries, invalid };
}

/** Two drafts hold the same entries (an empty cell and an absent one are equal). */
export function sameDraft(a: DraftCells, b: DraftCells): boolean {
  const filled = (draft: DraftCells) =>
    new Map([...draft].filter(([, text]) => text.trim() !== "").map(([key, text]) => [key, text.trim()]));
  const left = filled(a);
  const right = filled(b);
  if (left.size !== right.size) return false;
  for (const [key, text] of left) if (right.get(key) !== text) return false;
  return true;
}

/**
 * The weeks field as tenths, accepting the decimal comma a Swedish keyboard
 * types. Null for anything the column would not store — never a guess.
 */
export function parseWeeksTenths(text: string): number | null {
  const normalized = text.trim().replace(",", ".");
  if (!/^\d{2}(\.\d)?$/.test(normalized)) return null;
  const tenths = Math.round(Number(normalized) * 10);
  return tenths >= 200 && tenths <= 400 ? tenths : null;
}

/** 178 skoldagar / 5 = 35.6 weeks: the suggestion the field states. */
export const SUGGESTED_WEEKS = 35.6;

/** The gateway's NationalTimplanVersion, in the shape the pure check takes. */
export function toCoverageVersion(version: NationalTimplanVersion): CoverageVersion {
  return {
    code: version.code,
    schoolForm: version.schoolForm,
    totalHours: version.totalHours,
    skolansValHours: version.skolansValHours,
    reductionCapPercent: version.reductionCapPercent,
    appliesFromCohortTerm: version.appliesFromCohortTerm,
    entries: version.entries,
  };
}

/**
 * A school subject's hours in one stage: Σ minutesPerWeek × weeks / 60, in
 * minute-tenths as the check counts, rounded to the tenth only here.
 */
export function stageHours(
  draft: DraftCells,
  subjectId: string,
  grades: number[],
  weeksTenths: number,
): number {
  let minuteTenths = 0;
  for (const grade of grades) {
    const minutes = parseMinutes(draft.get(cellKey(subjectId, grade)) ?? "");
    if (minutes !== null) minuteTenths += minutes * weeksTenths;
  }
  return Math.round(minuteTenths / 60) / 10;
}

/**
 * Hours as this page prints them: the decimal comma, no group separator, one
 * decimal at most and none for a whole number — lib/teaching-hours'
 * formatHours convention, for a figure that is already in hours (the check
 * hands hours out, rounded by its own rules; this only spells them).
 */
export function formatH(value: number): string {
  const rounded = Math.round(value * 10) / 10;
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1).replace(".", ",");
}
