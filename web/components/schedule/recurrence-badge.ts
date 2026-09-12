import type { LessonRecurrence } from "@/lib/types";

/**
 * The grid's label for a lesson that does not run every week.
 *
 * Its own module, apart from RecurrenceFields, because the two are wanted at
 * different times: a week draws a badge on every card it shows, while the
 * fields are edited inside a dialog. Together in one module the fields — and
 * the date picker they use — were loaded by every page that draws a grid.
 */

/** A short label for the grid: "udda", "jämna", "period". */
export function recurrenceBadge(
  lesson: {
    recurrence: LessonRecurrence;
    startDate: string | null;
    endDate: string | null;
  },
  t: (key: string) => string,
): string | null {
  const parts: string[] = [];
  if (lesson.recurrence === "ODD_WEEKS") parts.push(t("badgeOdd"));
  if (lesson.recurrence === "EVEN_WEEKS") parts.push(t("badgeEven"));
  // A period is worth flagging even without a parity: a lesson that stops in
  // October looks identical to a year-long one on a weekly grid.
  if (lesson.startDate || lesson.endDate) parts.push(t("badgePeriod"));
  return parts.length > 0 ? parts.join(" · ") : null;
}
