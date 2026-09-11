import type { LessonRecurrence } from "@/lib/types";

/*
 * The grid's word for which weeks a lesson runs.
 *
 * It sits in lib/ rather than beside RecurrenceFields, which is the control
 * that SETS the same thing, because the two are needed at different moments: a
 * grid names every lesson it draws on first paint, while the fields are only
 * drawn once someone opens the create or edit dialog. Sharing one module tied
 * the badge to the fields' date picker, and the timetable route downloaded the
 * picker before it drew anything.
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
