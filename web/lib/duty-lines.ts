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
