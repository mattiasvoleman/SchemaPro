"use client";

import { useTranslations } from "next-intl";
import type { TeacherWorkRule } from "@/lib/types";
import { formatTime } from "@/lib/utils";

/*
 * A stored working-time rule read back, and the two helpers that reading
 * needs.
 *
 * A MODULE OF ITS OWN BECAUSE OF WHO LOADS IT. Every staff row on
 * /admin/people draws this summary, so everything it imports is part of that
 * page's own JS, which sits at its 190KB budget. The dialog that WRITES a rule
 * is fetched only when somebody opens it (React.lazy in the page), and with it
 * lib/teacher-work-rules, the form's bounds and refusals. A module the page and
 * that lazy chunk both import stays whole on the page, so this one imports
 * nothing of the form's: the type is erased, and hasAnyRule and splitHours
 * live here rather than there.
 */

/**
 * Whether a stored row says anything at all, as opposed to being six nulls.
 *
 * Every field counts, the soft wish included: the summary says "no
 * working-time rule" when this is false, and a row holding only a cap or only
 * a free-day wish is a rule the school wrote.
 */
export function hasAnyRule(rule: TeacherWorkRule | undefined): boolean {
  if (!rule) return false;
  // `!= null`: a row read without the two newer columns has no key for them,
  // and an absent key says no more than a null.
  return (
    rule.lunchMinutes !== null ||
    rule.lunchStartTime !== null ||
    rule.lunchEndTime !== null ||
    rule.minDailyRestMinutes !== null ||
    rule.maxTeachingMinutesPerDay != null ||
    rule.preferredFreeDayOfWeek != null
  );
}

/**
 * Minutes as hours and the remainder, for reading a rest rule or a day's cap
 * back.
 *
 * 660 is eleven hours to everybody who set it and a meaningless number on a
 * page. The split is done here rather than formatted here because the cases
 * need different sentences — "11 timmar" and "9 tim 30 min" — and a locale's
 * decimal comma is the translator's business, not this module's.
 */
export function splitHours(minutes: number): { hours: number; minutes: number } {
  return { hours: Math.floor(minutes / 60), minutes: minutes % 60 };
}

/**
 * A stored rule read back in prose.
 *
 * Sits beside the form rather than in it, because the two answer different
 * questions with the same row: the dialog is where a rule is written, this is
 * where a school checks what it wrote without opening anything. NULLS ARE
 * SPELLED OUT — "no working-time rule", not a column of dashes and not of
 * zeroes. The difference is the whole design: zero minutes of lunch would be a
 * promise the solver keeps, and nothing said is a promise it never makes.
 *
 * The cap and the wish are read back like the rest, one line each, and the
 * wish says it is a wish. Never the post's undervisningsdagar: those are HR
 * (src/staffing/hr-visibility.ts), this summary is every administrator's, and
 * the days are said on the Anställning card to the readers who may see them.
 */
export function TeacherWorkTimeSummary({ rule }: { rule: TeacherWorkRule | undefined }) {
  const t = useTranslations("teacherWorkTime");

  if (!hasAnyRule(rule) || !rule) {
    return <p className="text-sm text-muted-foreground">{t("noRule")}</p>;
  }

  const lunch =
    rule.lunchMinutes !== null &&
    rule.lunchStartTime !== null &&
    rule.lunchEndTime !== null
      ? t("summaryLunch", {
          minutes: rule.lunchMinutes,
          // The seconds PostgREST adds are cut here for the same reason the
          // form cuts them: "10:30:00" is not how anybody writes a lunch.
          start: formatTime(rule.lunchStartTime),
          end: formatTime(rule.lunchEndTime),
        })
      : null;

  const rest =
    rule.minDailyRestMinutes === null
      ? null
      : (() => {
          const split = splitHours(rule.minDailyRestMinutes);
          return split.minutes === 0
            ? t("summaryRestHours", { hours: split.hours })
            : t("summaryRestHoursMinutes", {
                hours: split.hours,
                minutes: split.minutes,
              });
        })();

  const cap =
    rule.maxTeachingMinutesPerDay == null
      ? null
      : t("summaryDayCap", { minutes: rule.maxTeachingMinutesPerDay });

  // The weekday by its number: the sentence's own select names it, so this
  // module needs no table of day names and the plural form is the translator's.
  const freeDay =
    rule.preferredFreeDayOfWeek == null
      ? null
      : t("summaryFreeDay", { day: rule.preferredFreeDayOfWeek });

  return (
    <ul className="space-y-0.5 text-sm">
      {lunch === null ? null : <li>{lunch}</li>}
      {rest === null ? null : <li>{rest}</li>}
      {cap === null ? null : <li>{cap}</li>}
      {freeDay === null ? null : <li>{freeDay}</li>}
    </ul>
  );
}
