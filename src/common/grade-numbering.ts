/**
 * Årskursernas numrering: the two ways a läsår numbers its årskurser, and how
 * an årskurs of one is read in the other.
 *
 * PURE and small on purpose: lager 1 (timplan-planned), Skapa timplans-
 * poster, the rollover and their web mirrors import it, and /admin/requirements
 * has no room for the cohort module. web/lib/grade-numbering.ts is this file
 * with the web's quotes; both replay src/common/__fixtures__/grade-numbering-cases.json.
 *
 * SFS 2025:729 (utfärdad 2025-06-19, tillämpas på utbildning efter
 * 2028-06-30) numbers every årskurs of grundskolan, anpassade grundskolan,
 * specialskolan and sameskolan anew from HT 2028: förskoleklassen ends, and
 * övergångsbestämmelse 4 moves everyone already in school one årskurs
 * further than a normal year ("ska i stället börja i en årskurs som
 * överstiger den årskursen med ett år"; last year's förskoleklass "börja
 * direkt i årskurs 2"). The stadier keep their pupils: old 1–3 / 4–6 / 7–9
 * are new 2–4 / 5–7 / 8–10. So one årskull, one åldersband, has two numbers,
 * one in each numbering, and they differ by one:
 *
 *   NIOARIG  F  1  2 … 9  10   (specialskolan's 10; 11 is no årskurs)
 *   TIOARIG  1  2  3 … 10 11   (specialskolan's 11; there is no 0)
 *
 * A läsår stores its numbering (AcademicYears.gradeNumbering, 20261121091000).
 * A lokal timplan's rows are in its lydelse's numbering (one applying from HT
 * 2028 is TIOARIG). School-wide spans — frames, lunch, raster, salsregler,
 * årskursregler, behörigheter, salar — are stated in NIOARIG and never move;
 * a reader of a TIOARIG läsår reads its årskurs in NIOARIG before comparing
 * (toNioarig). Twelve is "and above" in both, as the bounds that run to 12
 * have always meant it: TIOARIG 12 is NIOARIG 12, and NIOARIG 11, which no
 * school form has, reads as 12.
 */

export type GradeNumbering = 'NIOARIG' | 'TIOARIG';

/** The first day a läsår may be TIOARIG (AcademicYears_tioarig_from_2028). */
export const TIOARIG_FROM = '2028-07-01';

/** The 400 for a TIOARIG läsår before TIOARIG_FROM, and the CHECK's name in prisma-errors. */
export const TIOARIG_TOO_EARLY =
  'gradeNumbering: den tioåriga numreringen gäller läsår som börjar 1 juli 2028 eller senare.';

/** An årskurs of a TIOARIG läsår in NIOARIG; a NIOARIG one as it is. Null for none. */
export function toNioarig(gradeLevel: number | null, numbering: GradeNumbering): number | null {
  if (gradeLevel === null) return null;
  if (numbering === 'NIOARIG') return gradeLevel;
  if (gradeLevel >= 12) return 12;
  return gradeLevel <= 0 ? 0 : gradeLevel - 1;
}

/** An årskurs stated in NIOARIG, in `numbering`; toNioarig's inverse below 12. Null for none. */
export function fromNioarig(gradeLevel: number | null, numbering: GradeNumbering): number | null {
  if (gradeLevel === null) return null;
  if (numbering === 'NIOARIG') return gradeLevel;
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
  const row = gradeLevel - (numbering === 'TIOARIG' ? 1 : 0) + (planTioarig ? 1 : 0);
  return row < 0 ? null : row;
}

/** The årskurs of a läsår in `numbering` that reads row `row` of a plan; planRowOf's inverse. */
export function gradeOfPlanRow(planTioarig: boolean, numbering: GradeNumbering, row: number): number | null {
  const grade = row + (numbering === 'TIOARIG' ? 1 : 0) - (planTioarig ? 1 : 0);
  return grade < 0 ? null : grade;
}

/** Whether a lydelse ('HT2028', 'HT2024' …) numbers its årskurser TIOARIG. */
export function lydelseIsTioarig(appliesFromCohortTerm: string): boolean {
  const match = /^(?:HT|VT)(\d{4})$/.exec(appliesFromCohortTerm);
  return match !== null && Number(match[1]) >= 2028;
}
