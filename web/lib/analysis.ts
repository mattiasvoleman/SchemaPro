import { serializeCsv } from "@/lib/csv-export";
import { compareSwedish } from "@/lib/sorting";
import { COST_CATEGORIES, type CostBasis, type CostCategory, type SchoolPart, type TeacherKeyFigures } from "@/lib/analysis-types";

/*
 * Analys och planering: the page's own arithmetic on what the gateway answers
 * with. The figures themselves are the gateway's (the load report's time, the
 * rosters' pupils, the school's rates); this module only words, sorts and
 * exports them.
 */

/** 90 min → "1,5"; hours with at most two decimals, the way a payroll office writes them. */
export function hoursOf(minutes: number): number {
  return Math.round((minutes / 60) * 100) / 100;
}

/** 0.8725 → 87.3: a share as a percent with one decimal. */
export function percentOfShare(share: number): number {
  return Math.round(share * 1000) / 10;
}

/** A skoldel's span as a person writes it: "F–3", "4–6", "9". */
export function spanLabel(part: Pick<SchoolPart, "gradeFrom" | "gradeTo">): string {
  const grade = (value: number): string => (value === 0 ? "F" : String(value));
  return part.gradeFrom === part.gradeTo ? grade(part.gradeFrom) : `${grade(part.gradeFrom)}–${grade(part.gradeTo)}`;
}

export type KeyFigureSortKey = "teacher" | "teaching" | "scheduled" | "load" | "pupils" | "qualified" | "employment";
export interface KeyFigureSort {
  key: KeyFigureSortKey;
  direction: "asc" | "desc";
}

/** Opens by name; the headings sort the rest. */
export const DEFAULT_KEY_SORT: KeyFigureSort = { key: "teacher", direction: "asc" };

export function nextKeySort(current: KeyFigureSort, key: KeyFigureSortKey): KeyFigureSort {
  if (current.key !== key) return { key, direction: key === "teacher" ? "asc" : "desc" };
  return { key, direction: current.direction === "asc" ? "desc" : "asc" };
}

export function ariaSortOf(sort: KeyFigureSort, key: KeyFigureSortKey): "ascending" | "descending" | "none" {
  return sort.key !== key ? "none" : sort.direction === "asc" ? "ascending" : "descending";
}

/** The teachers in the order asked; a person without a figure last either way, ties by name then id. */
export function sortTeachers(
  rows: readonly TeacherKeyFigures[],
  sort: KeyFigureSort,
  nameOf: (userId: string) => string,
): TeacherKeyFigures[] {
  const value = (row: TeacherKeyFigures): number | string | null => {
    switch (sort.key) {
      case "teacher":
        return nameOf(row.userId);
      case "teaching":
        return row.teachingMinutesPerWeek;
      case "scheduled":
        return row.scheduledMinutesPerWeek;
      case "load":
        return row.percentOfTarget;
      case "pupils":
        return row.pupils;
      case "qualified":
        return row.qualifiedShare;
      case "employment":
        return row.employmentPercent;
    }
  };
  const sign = sort.direction === "asc" ? 1 : -1;
  return [...rows].sort((a, b) => {
    const left = value(a);
    const right = value(b);
    if (left === null && right !== null) return 1;
    if (right === null && left !== null) return -1;
    if (left !== null && right !== null && left !== right) {
      const order = typeof left === "string" ? compareSwedish(left, String(right)) : left - (right as number);
      if (order !== 0) return sign * order;
    }
    return compareSwedish(nameOf(a.userId), nameOf(b.userId)) || a.userId.localeCompare(b.userId);
  });
}

/** "7" for a ten-year läsår's åk 8 read in its own numbering is the gateway's business: the grade is shown as given. */
export const gradeText = (gradeLevel: number | null, none: string): string =>
  gradeLevel === null ? none : gradeLevel === 0 ? "F" : String(gradeLevel);

export const COST_HEADERS = ["Skoldel", "Konto", "Årskurs", "Elever", "Behörig lärare (tim)", "Lärare utan behörighet (tim)", "Vikarie (tim)", "Lärartid per elev (tim)", "Kostnad (kr)", "Kostnad per elev (kr)"] as const;

/** A number as Swedish Excel writes it in a ';'-separated file: a decimal comma, no thousands separator. */
const decimal = (value: number | null, places: number): string => (value === null ? "" : value.toFixed(places).replace(".", ","));

/**
 * The cost basis as a CSV (Excel's Swedish dialect, UTF-8 with BOM like the
 * web's other files): a row per årskurs with its skoldel and konto, then a row
 * per skoldel and one for the school. It names nobody: skoldelar, årskurser,
 * hours and kronor.
 */
export function costBasisCsv(basis: CostBasis, parts: readonly SchoolPart[], noPart: string, noGrade: string, whole: string): string {
  const partOf = new Map(parts.map((part) => [part.id, part]));
  const row = (label: string, account: string, grade: string, figures: CostBasis["total"]): string[] => [
    label,
    account,
    grade,
    String(figures.pupils),
    ...COST_CATEGORIES.map((category: CostCategory) => decimal(figures.hours[category], 2)),
    decimal(figures.hoursPerPupil, 2),
    decimal(figures.cost, 2),
    decimal(figures.costPerPupil, 2),
  ];
  const rows: string[][] = [];
  for (const cell of basis.cells) {
    const part = cell.schoolPartId === null ? undefined : partOf.get(cell.schoolPartId);
    rows.push(row(part?.name ?? noPart, part?.account ?? "", gradeText(cell.gradeLevel, noGrade), cell));
  }
  for (const part of basis.parts) rows.push(row(part.name ?? noPart, part.account ?? "", "", part));
  rows.push(row(whole, "", "", basis.total));
  // The columns of the hours are in COST_CATEGORIES order: TEACHER, UNQUALIFIED_TEACHER, SUBSTITUTE.
  return serializeCsv([...COST_HEADERS], rows);
}

export const costBasisFilename = (yearName: string): string => `kostnad-per-elev-${yearName.replace(/[^\p{L}\p{N}]+/gu, "-")}.csv`;
