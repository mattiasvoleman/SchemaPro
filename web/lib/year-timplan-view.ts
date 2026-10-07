// "Timplan per årskurs" — the year dialog's pure part.

/** Förskoleklass to åk 9: the rows the year dialog always offers. */
export const DEFAULT_GRADES = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9] as const;

/**
 * The årskurser the dialog lists: F–9, plus any grade the year already
 * attaches or one of its classes is in (10 is the column's reserved tioårig
 * grade), in order. A row is never hidden while it holds a plan, so a save
 * cannot drop a grade the admin did not see.
 */
export function dialogGrades(attached: readonly number[], classGrades: readonly (number | null)[]): number[] {
  const grades = new Set<number>(DEFAULT_GRADES);
  for (const grade of attached) grades.add(grade);
  for (const grade of classGrades) {
    if (grade !== null && grade >= 0 && grade <= 10) grades.add(grade);
  }
  return [...grades].sort((a, b) => a - b);
}

/** Each listed årskurs and the plan chosen for it; "" is none. */
export type YearChoices = ReadonlyMap<number, string>;

/**
 * The PUT body: every listed årskurs, a chosen plan's id or null. Wholesale,
 * like the endpoint — a grade sent as null ends with no plan — and every
 * listed grade is sent explicitly, so nothing is emptied by being left out.
 */
export function yearTimplansBody(
  grades: readonly number[],
  choices: YearChoices,
): { gradeLevel: number; localTimplanId: string | null }[] {
  return grades.map((gradeLevel) => {
    const chosen = choices.get(gradeLevel) ?? "";
    return { gradeLevel, localTimplanId: chosen === "" ? null : chosen };
  });
}

/** Whether the choices differ from what the year holds. */
export function yearTimplansChanged(
  grades: readonly number[],
  choices: YearChoices,
  saved: readonly { gradeLevel: number; localTimplanId: string }[],
): boolean {
  const held = new Map(saved.map((row) => [row.gradeLevel, row.localTimplanId]));
  return grades.some((grade) => (choices.get(grade) ?? "") !== (held.get(grade) ?? ""));
}
