// Täckning, layer 1 — the gateway's answer laid out for the page that reads it.
//
// GET /timplan-coverage?layer=planned is computed on the gateway from
// src/common/timplan-planned.ts; this file only arranges that document for
// /admin/timplan/tackning: one row per class, one column per subject that any
// class has a target or a post in, the pupils of each class with a finding of
// their own, and the year-level notices. It COMPUTES nothing the gateway
// already did — a figure on that page is the gateway's figure — so it imports
// only the module's types, and the arithmetic stays out of this route's
// bundle (the Timplansposter matrix's Mål mode is where the mirror runs,
// because it has to follow fields that are not saved yet).

import type {
  PlannedCell,
  PlannedCoverage,
  PlannedGroupSummary,
  PlannedLine,
  PlannedPupil,
  PlannedStatus,
  PlannedVerdict,
} from "@/lib/timplan-planned";
import { compareSwedish } from "@/lib/sorting";

/** Mirror of TimplanCoverageResponse in src/timplan/timplan-coverage.service.ts. */
export interface TimplanCoverageResponse extends Omit<PlannedCoverage, "verdicts"> {
  academicYearId: string;
  layer: "planned";
  verdicts: (PlannedVerdict & { message: string })[];
}

/**
 * How a cell is painted — the Mål mode's tones (lib/requirements-target.ts),
 * so the two pages that show planerat mot mål agree on what amber and red say.
 */
export type CoverageTone = "unplanned" | "under" | "pupils" | "met" | "over" | "none";

export function coverageTone(status: PlannedStatus): CoverageTone {
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

export interface CoverageCellView {
  cell: PlannedCell;
  line: PlannedLine;
  tone: CoverageTone;
}

export interface CoverageClassRow {
  id: string;
  name: string;
  summary: PlannedGroupSummary;
  /** The class's pupils with a finding of their own, in name order. */
  pupils: PlannedPupil[];
}

export interface CoverageMatrix {
  /** The document the matrix was built from. */
  coverage: TimplanCoverageResponse;
  classes: CoverageClassRow[];
  /** Every subject a class has a target or a post in, in the school's order. */
  subjects: { id: string; name: string }[];
  cell(groupId: string, subjectId: string): CoverageCellView | null;
  /** Årskurser with classes and no plan this year. */
  unattachedGrades: number[];
  /** Attached plans that are drafts, with the årskurser that follow them. */
  draftPlans: { id: string; name: string; gradeLevels: number[] }[];
  /** Årskurser with classes attached to a plan that gives them no minutes. */
  emptyPlanGrades: { gradeLevel: number; planName: string }[];
}

export interface NamedGroup {
  id: string;
  name: string;
}

export interface NamedSubject {
  id: string;
  name: string;
}

export interface NamedPupil {
  id: string;
  firstName: string;
  lastName: string;
}

/**
 * The page's table. Classes in the gateway's order (årskurs, then name);
 * subjects in the order `subjects` comes in — useSubjects sorts in Swedish —
 * with any subject the school list does not know (deleted since) after them,
 * named by its id rather than dropped. `people` names the listed pupils; a
 * pupil it does not hold sorts last.
 */
export function buildCoverageMatrix(
  coverage: TimplanCoverageResponse,
  groups: readonly NamedGroup[],
  subjects: readonly NamedSubject[],
  people: readonly NamedPupil[] = [],
): CoverageMatrix {
  const groupName = new Map(groups.map((group) => [group.id, group.name]));
  const person = new Map(people.map((entry) => [entry.id, entry]));
  const pupilName = (id: string) => {
    const entry = person.get(id);
    return entry ? `${entry.lastName} ${entry.firstName}` : "￿";
  };

  const pupilsByClass = new Map<string, PlannedPupil[]>();
  for (const pupil of coverage.pupils ?? []) {
    const list = pupilsByClass.get(pupil.homeGroupId) ?? [];
    list.push(pupil);
    pupilsByClass.set(pupil.homeGroupId, list);
  }
  for (const list of pupilsByClass.values()) {
    list.sort((a, b) => compareSwedish(pupilName(a.pupilId), pupilName(b.pupilId)));
  }

  const lineByCell = new Map<string, PlannedLine>();
  for (const summary of coverage.groups) {
    for (const line of summary.lines) {
      for (const subjectId of line.subjectIds) {
        lineByCell.set(`${summary.studentGroupId}:${subjectId}`, line);
      }
    }
  }
  const cells = new Map<string, PlannedCell>();
  const used = new Set<string>();
  for (const cell of coverage.cells) {
    cells.set(`${cell.studentGroupId}:${cell.subjectId}`, cell);
    used.add(cell.subjectId);
  }

  const ordered = subjects.filter((subject) => used.has(subject.id));
  const known = new Set(ordered.map((subject) => subject.id));
  const unknown = [...used]
    .filter((id) => !known.has(id))
    .sort()
    .map((id) => ({ id, name: id }));

  const unattachedGrades: number[] = [];
  const draftPlans: CoverageMatrix["draftPlans"] = [];
  const emptyPlanGrades: CoverageMatrix["emptyPlanGrades"] = [];
  for (const verdict of coverage.verdicts) {
    if (verdict.code === "TIMPLAN_YEAR_GRADE_UNATTACHED" && verdict.gradeLevel !== undefined) {
      unattachedGrades.push(verdict.gradeLevel);
    } else if (verdict.code === "TIMPLAN_ATTACHED_PLAN_EMPTY" && verdict.gradeLevel !== undefined) {
      emptyPlanGrades.push({
        gradeLevel: verdict.gradeLevel,
        planName: String(verdict.params.planName ?? ""),
      });
    } else if (verdict.code === "TIMPLAN_ATTACHED_DRAFT" && verdict.localTimplanId) {
      draftPlans.push({
        id: verdict.localTimplanId,
        name: String(verdict.params.planName ?? ""),
        gradeLevels: verdict.gradeLevels ?? [],
      });
    }
  }

  return {
    coverage,
    classes: coverage.groups.map((summary) => ({
      id: summary.studentGroupId,
      name: groupName.get(summary.studentGroupId) ?? summary.studentGroupId,
      summary,
      pupils: pupilsByClass.get(summary.studentGroupId) ?? [],
    })),
    subjects: [...ordered.map(({ id, name }) => ({ id, name })), ...unknown],
    cell(groupId, subjectId) {
      const key = `${groupId}:${subjectId}`;
      const cell = cells.get(key);
      const line = lineByCell.get(key);
      if (!cell || !line) return null;
      return { cell, line, tone: coverageTone(cell.status) };
    },
    unattachedGrades,
    draftPlans,
    emptyPlanGrades,
  };
}

/** A signed difference with a real minus sign, as the timplan pages write one. */
export const signedMinutes = (value: number): string =>
  value > 0 ? `+${value}` : value < 0 ? `−${-value}` : "0";
