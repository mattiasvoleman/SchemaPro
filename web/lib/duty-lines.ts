import type { TeacherDuty } from "@/lib/types";

/*
 * An uppdrag's dates and times as one line each, for every place that lists
 * uppdrag: the duties card, Min tjänst and the uppdragsbeskrivning. The
 * sentences are `staffing.*` keys; the translators come in from the caller,
 * so this stays a module of strings that every one of those pages can carry
 * without pulling a form or a query along.
 */

type Translate = (key: string, values?: Record<string, string | number>) => string;

const clock = (value: string) => value.slice(0, 5);

/**
 * "Gäller från 2027-01-07", "Gäller till och med 2026-12-18" or both; null
 * for an undated uppdrag, which runs the whole läsår and needs no line.
 */
export function dutyPeriodLine(t: Translate, duty: Pick<TeacherDuty, "validFrom" | "validTo">): string | null {
  if (duty.validFrom && duty.validTo) return t("dutyRunsFromTo", { from: duty.validFrom, to: duty.validTo });
  if (duty.validFrom) return t("dutyRunsFrom", { from: duty.validFrom });
  if (duty.validTo) return t("dutyRunsTo", { to: duty.validTo });
  return null;
}

/** "Blockerar mån 10:00–10:20, ons 10:00–10:20", Monday first; null without times. */
export function dutySlotsLine(
  t: Translate,
  tDays: (day: string) => string,
  slots: TeacherDuty["slots"] | undefined,
): string | null {
  if (!slots || slots.length === 0) return null;
  const times = [...slots]
    .sort((a, b) => a.dayOfWeek - b.dayOfWeek || a.startTime.localeCompare(b.startTime))
    .map((slot) =>
      t("dutySlotTime", { day: tDays(String(slot.dayOfWeek)), start: clock(slot.startTime), end: clock(slot.endTime) }),
    )
    .join(", ");
  return t("dutyBlocksList", { times });
}

/**
 * Whether the generator keeps an uppdrag's fixed times free in weeks the
 * uppdrag does not run: it has times, and its Från or Till shortens it inside
 * the läsår. The weekly master is one week and the engine has no dated weeks
 * (src/staffing/duty-slot-year.ts), so such a time is held free all läsår,
 * while the load and the vikarietavla count only the uppdrag's dates. Dates
 * on the läsår's own bounds shorten nothing. Without the year's bounds, any
 * date counts: the sentence is then said once too often, never once too few.
 *
 * One rule for the two places a school meets the limit: the generate page,
 * before a run, and the duties card, beside the uppdrag.
 */
export function keepsTimesAllYear(
  duty: Pick<TeacherDuty, "validFrom" | "validTo"> & { slots?: readonly unknown[] },
  year: { startDate: string; endDate: string } | null | undefined,
): boolean {
  if (!duty.slots || duty.slots.length === 0) return false;
  if (!year) return Boolean(duty.validFrom || duty.validTo);
  // The day alone, whether the year came as a date or as a timestamp.
  const start = year.startDate.slice(0, 10);
  const end = year.endDate.slice(0, 10);
  return Boolean((duty.validFrom && duty.validFrom > start) || (duty.validTo && duty.validTo < end));
}
