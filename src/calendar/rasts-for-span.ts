/**
 * Which rasts bind one year on one weekday.
 *
 * The THIRD implementation of this rule, after web/lib/rasts.ts and
 * optimization-engine/app/solver/rasts.py, and each of the three exists for a
 * reason the others cannot serve: the engine subtracts slots, the web page
 * previews a week before anything is generated, and publish dates rows for a
 * pupil to read. What must never differ is the answer, so all three carry the
 * same two rules and the same wording for them.
 *
 *   MATCHING IS OVERLAP. Here the caller has a single year rather than a span,
 *   which is the same test with min === max: a class is in one year.
 *
 *   A DAY-SPECIFIC ROW SHADOWS ONLY THE EVERY-DAY ROWS IT OVERLAPS. Not all of
 *   them, which is what the lunch servings do — several rasts a day is the
 *   ordinary Swedish week, and replacing all of them would publish a Friday
 *   missing a stage's midday and afternoon breaks.
 */
export interface RastRow {
  name: string;
  minGradeLevel: number;
  maxGradeLevel: number;
  dayOfWeek: number | null;
  startTime: Date;
  endTime: Date;
}

/** Minutes since midnight from a `@db.Time` value Prisma hands back. */
function minutesOf(time: Date): number {
  return time.getUTCHours() * 60 + time.getUTCMinutes();
}

function overlaps(a: RastRow, b: RastRow): boolean {
  return (
    minutesOf(a.startTime) < minutesOf(b.endTime) &&
    minutesOf(b.startTime) < minutesOf(a.endTime)
  );
}

export function rastsForSpan(
  rasts: RastRow[],
  grade: number,
  dayOfWeek: number,
): RastRow[] {
  const matching = rasts.filter(
    (rast) => grade >= rast.minGradeLevel && grade <= rast.maxGradeLevel,
  );
  const today = matching.filter((rast) => rast.dayOfWeek === dayOfWeek);
  const everyDay = matching.filter(
    (rast) =>
      rast.dayOfWeek === null &&
      !today.some((specific) => overlaps(rast, specific)),
  );
  return [...today, ...everyDay].sort(
    (a, b) => minutesOf(a.startTime) - minutesOf(b.startTime),
  );
}
