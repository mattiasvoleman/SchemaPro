// Årskursernas numrering, as the browser computes it.
//
// A MIRROR OF src/common/grade-numbering.ts, not a second opinion on it: the
// two numberings, an årskurs read in the other, and the plan row an årskurs
// reads. Both copies replay src/common/__fixtures__/grade-numbering-cases.json
// (grade-numbering.contract.spec.ts there, grade-numbering.contract.test.ts
// here). The sources and the reasoning are in the gateway file's header; the
// body below is that file with this package's quotes.

export type GradeNumbering = "NIOARIG" | "TIOARIG";

/** The first day a läsår may be TIOARIG (AcademicYears_tioarig_from_2028). */
export const TIOARIG_FROM = "2028-07-01";

/** The 400 for a TIOARIG läsår before TIOARIG_FROM, and the CHECK's name in prisma-errors. */
export const TIOARIG_TOO_EARLY =
  "gradeNumbering: den tioåriga numreringen gäller läsår som börjar 1 juli 2028 eller senare.";

/** An årskurs of a TIOARIG läsår in NIOARIG; a NIOARIG one as it is. Null for none. */
export function toNioarig(gradeLevel: number | null, numbering: GradeNumbering): number | null {
  if (gradeLevel === null) return null;
  if (numbering === "NIOARIG") return gradeLevel;
  if (gradeLevel >= 12) return 12;
  return gradeLevel <= 0 ? 0 : gradeLevel - 1;
}

/** An årskurs stated in NIOARIG, in `numbering`; toNioarig's inverse below 12. Null for none. */
export function fromNioarig(gradeLevel: number | null, numbering: GradeNumbering): number | null {
  if (gradeLevel === null) return null;
  if (numbering === "NIOARIG") return gradeLevel;
  return gradeLevel >= 11 ? 12 : gradeLevel + 1;
}

/**
 * The row of a lokal timplan an årskurs of a läsår reads, or null for none:
 * a plan on a lydelse from HT 2028 (planTioarig) numbers its rows TIOARIG,
 * an older one NIOARIG. A TIOARIG läsår reads an older plan one row down (åk
 * 10 its row 9, åk 1 its förskoleklass row), a NIOARIG läsår a 2028 plan one
 * row up — the same årskull, the same row.
 */
export function planRowOf(planTioarig: boolean, numbering: GradeNumbering, gradeLevel: number): number | null {
  const row = gradeLevel - (numbering === "TIOARIG" ? 1 : 0) + (planTioarig ? 1 : 0);
  return row < 0 ? null : row;
}

/** The årskurs of a läsår in `numbering` that reads row `row` of a plan; planRowOf's inverse. */
export function gradeOfPlanRow(planTioarig: boolean, numbering: GradeNumbering, row: number): number | null {
  const grade = row + (numbering === "TIOARIG" ? 1 : 0) - (planTioarig ? 1 : 0);
  return grade < 0 ? null : grade;
}

/** Whether a lydelse ("HT2028", "HT2024" …) numbers its årskurser TIOARIG. */
export function lydelseIsTioarig(appliesFromCohortTerm: string): boolean {
  const match = /^(?:HT|VT)(\d{4})$/.exec(appliesFromCohortTerm);
  return match !== null && Number(match[1]) >= 2028;
}
