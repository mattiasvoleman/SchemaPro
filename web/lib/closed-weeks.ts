/**
 * Veckor utan skoldag, as the board reads them: the weeks of the läsår in which no lesson is written.
 *
 * THE BROWSER'S COPY of src/calendar/school-weeks.ts (the two packages share no build), replayed by
 * both suites against src/calendar/__fixtures__/school-weeks-cases.json. A week has no school day when
 * every weekday of it that lies in the läsår (Monday to Friday) is a day no årskurs has school: a lov or
 * a studiedag covers the day for each group by the group's årskurs, a group with no year only by a break
 * for the whole school — what publish does with a lesson (publish-days.ts breakCoversGroup,
 * noSchoolDays). Two lessons that can meet ONLY in such weeks are no double booking: nobody sits either
 * that week, and the generator may lay them on one hour for that reason (year-periods.ts). A week with
 * no weekday in the läsår at all, or with one open day, has school.
 *
 * Dates are 'YYYY-MM-DD' and compare as text.
 */

export interface ClosedWeeks {
  /** The läsår's first and last day: nothing outside them is read as closed. */
  from: string;
  to: string;
  /** The Mondays of the weeks with no school day. */
  mondays: ReadonlySet<string>;
}

interface BreakSpan {
  startDate: string;
  endDate: string;
  minGradeLevel: number | null;
  maxGradeLevel: number | null;
}

const DAY_MS = 86_400_000;
const parse = (day: string): Date => new Date(`${day}T00:00:00.000Z`);
const text = (date: Date): string => date.toISOString().slice(0, 10);
const plus = (date: Date, days: number): Date => new Date(date.getTime() + days * DAY_MS);
const mondayOf = (date: Date): Date => plus(date, 1 - (date.getUTCDay() || 7));

/** The ISO week number of a Monday: the week its Thursday is in, counted from the year's first Thursday. */
function isoWeek(monday: Date): number {
  const thursday = plus(monday, 3);
  const january = Date.UTC(thursday.getUTCFullYear(), 0, 1);
  return Math.floor((thursday.getTime() - january) / (7 * DAY_MS)) + 1;
}

/** Whether the break takes the group's lessons that day: the whole school, or a span the årskurs is in. */
function covers(entry: BreakSpan, grade: number | null): boolean {
  if (entry.minGradeLevel === null && entry.maxGradeLevel === null) return true;
  if (typeof grade !== "number") return false;
  return (
    (entry.minGradeLevel === null || grade >= entry.minGradeLevel) &&
    (entry.maxGradeLevel === null || grade <= entry.maxGradeLevel)
  );
}

/**
 * The closed weeks of a läsår, or undefined where no week is closed. `grades` are the årskurs of every
 * group of the läsår, null for a group with none (a nivågrupp).
 */
export function closedWeeksOf(
  year: { startDate: string; endDate: string },
  breaks: readonly BreakSpan[],
  grades: readonly (number | null)[],
): ClosedWeeks | undefined {
  if (breaks.length === 0) return undefined;
  const distinct = [...new Set(grades)];
  const isOff = (day: string): boolean => {
    const here = breaks.filter((entry) => entry.startDate <= day && day <= entry.endDate);
    return (
      here.some((entry) => entry.minGradeLevel === null && entry.maxGradeLevel === null) ||
      (distinct.length > 0 && distinct.every((grade) => here.some((entry) => covers(entry, grade))))
    );
  };
  const mondays = new Set<string>();
  for (let monday = mondayOf(parse(year.startDate)); text(monday) <= year.endDate; monday = plus(monday, 7)) {
    const weekdays = [0, 1, 2, 3, 4]
      .map((offset) => text(plus(monday, offset)))
      .filter((day) => day >= year.startDate && day <= year.endDate);
    if (weekdays.length > 0 && weekdays.every(isOff)) mondays.add(text(monday));
  }
  return mondays.size === 0 ? undefined : { from: year.startDate, to: year.endDate, mondays };
}

/** The weeks a lesson is held in: ISO days, null for the läsår's own bound. */
interface HeldWeeks {
  recurrence?: "ALL_WEEKS" | "ODD_WEEKS" | "EVEN_WEEKS" | null;
  startDate?: string | null;
  endDate?: string | null;
}

/**
 * Whether two lessons can meet only in weeks with no school day, in which case they are no clash. False
 * where they might meet in a week with school, and wherever this cannot be said: no closed week, an
 * overlap that is empty or reaches outside the läsår, or no week of a parity both run in. Asked after
 * weeksCanOverlap, which it only narrows:
 *
 *     clash  =  weeksCanOverlap(a, b)  &&  !meetOnlyInClosedWeeks(a, b, closed)
 */
export function meetOnlyInClosedWeeks(a: HeldWeeks, b: HeldWeeks, closed: ClosedWeeks | undefined): boolean {
  if (!closed) return false;
  const aStart = a.startDate ?? closed.from;
  const bStart = b.startDate ?? closed.from;
  const aEnd = a.endDate ?? closed.to;
  const bEnd = b.endDate ?? closed.to;
  const start = aStart > bStart ? aStart : bStart;
  const end = aEnd < bEnd ? aEnd : bEnd;
  if (start > end || start < closed.from || end > closed.to) return false;
  const first = a.recurrence ?? "ALL_WEEKS";
  const second = b.recurrence ?? "ALL_WEEKS";
  let asked = false;
  for (let monday = mondayOf(parse(start)); text(monday) <= end; monday = plus(monday, 7)) {
    const odd = isoWeek(monday) % 2 === 1;
    const sits = (recurrence: typeof first): boolean => recurrence === "ALL_WEEKS" || (recurrence === "ODD_WEEKS") === odd;
    if (!sits(first) || !sits(second)) continue;
    asked = true;
    if (!closed.mondays.has(text(monday))) return false;
  }
  return asked;
}
