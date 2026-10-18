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
 * weekly årskursregler, behörigheter, salar, skolenheter — are stated in
 * NIOARIG and never move; a reader of a TIOARIG läsår reads its årskurs in
 * NIOARIG before comparing (toNioarig, toNioarigSpan), and says the årskurs in
 * the läsår's own numbering. Two readings differ:
 *
 *   * a skolenhet: SFS 2025:729 övergångsbestämmelse 5 moves an approval at
 *     the bottom too (an åk 1 approval also covers the new åk 1; one for
 *     förskoleklass alone lapses), so a TIOARIG läsår reads a unit's span as
 *     the statute does (unitSpanIn), not one down. A pair an admin confirms
 *     instead is a follow-up;
 *   * a DATED årskursregel — a closure on a day, a prao, a studiedag — is
 *     stated in the numbering of the läsår its day falls in, as the admin who
 *     adds it for that day reads the classes; only the solver, which compares
 *     in NIOARIG, reads it over.
 *
 * Twelve is "and above" in both, as the bounds that run to 12
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

/**
 * A span of årskurser in a läsår of `numbering`, read in NIOARIG — what every
 * school-wide span (frames, lunch, raster, salsregler, årskursregler,
 * behörigheter, salar) is stated in. A TIOARIG läsår's 8–10 is NIOARIG 7–9.
 * Readers compare a class's or a group's span through this, never raw.
 */
export function toNioarigSpan(
  span: { min: number; max: number } | null,
  numbering: GradeNumbering,
): { min: number; max: number } | null {
  return span === null ? null : { min: toNioarig(span.min, numbering)!, max: toNioarig(span.max, numbering)! };
}

/**
 * A skolenhet's årskurser in a läsår of `numbering`. Its span is stated in
 * NIOARIG; a TIOARIG läsår reads it as SFS 2025:729 övergångsbestämmelse 5
 * reads an approval: one årskurs up, an approval from åk 1 also for the new
 * åk 1, and one for förskoleklass alone lapses — F–6 and 1–6 are 1–7, 7–9 is
 * 8–10, specialskolan's F–10 is 1–11, F–F holds nothing. Not toNioarig at
 * the bottom: the new åk 1 belongs to a 1–6 unit, not to an F unit. Null for
 * a unit without a span. (The pair an admin confirms instead is a follow-up.)
 */
export function unitSpanIn(
  span: { gradeFrom: number | null; gradeTo: number | null },
  numbering: GradeNumbering,
): { gradeFrom: number; gradeTo: number } | null {
  if (span.gradeFrom === null || span.gradeTo === null) return null;
  if (numbering === 'NIOARIG') return { gradeFrom: span.gradeFrom, gradeTo: span.gradeTo };
  if (span.gradeTo === 0) return null;
  return { gradeFrom: span.gradeFrom <= 1 ? 1 : span.gradeFrom + 1, gradeTo: span.gradeTo + 1 };
}

/**
 * The årskurs a skolenhet's nioårig span must hold for a class of `grade` in a
 * läsår of `numbering`: unitSpanIn read the other way, one class at a time, so
 * a unit holds the class exactly when gradeFrom <= this <= gradeTo. A tioårig
 * åk 1 is a 1–6 unit's (övergångsbestämmelse 5), never förskoleklassens, so
 * it reads as 1; every other tioårig årskurs one down. For a reader that sets
 * or widens a unit's span from where its classes are (the SS12000 sync).
 */
export function unitGradeOf(grade: number | null, numbering: GradeNumbering): number | null {
  if (grade === null || numbering === 'NIOARIG') return grade;
  return grade <= 1 ? 1 : toNioarig(grade, numbering);
}

/** Whether a lydelse ('HT2028', 'HT2024' …) numbers its årskurser TIOARIG. */
export function lydelseIsTioarig(appliesFromCohortTerm: string): boolean {
  const match = /^(?:HT|VT)(\d{4})$/.exec(appliesFromCohortTerm);
  return match !== null && Number(match[1]) >= 2028;
}
