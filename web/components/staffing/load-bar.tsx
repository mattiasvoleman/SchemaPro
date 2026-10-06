"use client";

import { useTranslations } from "next-intl";
import { loadBarSegments, formatPercent, type WeekView } from "@/lib/staffing-view";
import type { TeacherLoad } from "@/lib/teacher-load";

/*
 * Undervisning / kvar till mål / över mål, as one bar and one sentence.
 *
 * CONTRAST, MEASURED — and the design that makes it hold. The bar carries NO
 * text of its own: the label sits beside it in `text-foreground` on the card
 * (18.69:1 light, 15.43:1 dark, AAA both ways), so the colour of a segment
 * never has to carry a word. The segments are graphical objects under WCAG
 * 1.4.11 (3:1 against what they sit on), computed from the HSL tokens in
 * app/globals.css, rounded to 8-bit:
 *
 *   primary on card           4.98 / 5.21   — undervisning
 *   success on card           4.52 / 3.81   — kvar till mål
 *   destructive on card       4.63 / 4.11   — över mål
 *   muted on card             1.08 / 1.21   — the empty track, exempt: it is
 *                                             the background the segments
 *                                             sit on, not an object
 *
 * The three segments also touch each other, and adjacent fills need to be
 * told apart: primary/success 1.10, primary/destructive 1.07 — under 3:1, so
 * a hairline of the card's own colour (`gap-px` on a card-coloured track)
 * separates them, and the label names each minute count anyway. Colour is
 * the first reading and the sentence is the one a screen reader gets, via
 * role="img" and the full description; nothing is said by colour alone.
 */
export function LoadBar({
  teacher,
  week = "standard",
  className,
}: {
  teacher: Pick<TeacherLoad, "assignedMinutesPerWeek" | "targetMinutesPerWeek" | "peakMinutesPerWeek" | "percentOfTarget">;
  week?: WeekView;
  className?: string;
}) {
  const t = useTranslations("staffing");
  const segments = loadBarSegments(teacher, week, teacher.peakMinutesPerWeek);
  const target = teacher.targetMinutesPerWeek;
  const assigned = week === "peak" ? teacher.peakMinutesPerWeek : teacher.assignedMinutesPerWeek;

  const label =
    target === null || target <= 0
      ? t("barNoTarget")
      : t("barLabel", { percent: formatPercent((assigned / target) * 100) });

  const balance =
    segments.overMinutes > 0
      ? t("barOver", { minutes: segments.overMinutes })
      : t("barRemaining", { minutes: segments.remainingMinutes });
  const description =
    target === null || target <= 0
      ? `${t("barTeaching", { minutes: assigned })} · ${t("barNoTarget")}`
      : t("barDescription", { teaching: segments.teachingMinutes, target, balance });

  const width = (share: number) => ({ width: `${Math.round(share * 1000) / 10}%` });

  return (
    <div className={className}>
      <div className="flex items-center gap-2">
        <div
          role="img"
          aria-label={description}
          title={description}
          className="flex h-2.5 min-w-24 flex-1 gap-px overflow-hidden rounded-full bg-muted"
        >
          {segments.teaching > 0 ? (
            <span data-segment="teaching" className="h-full bg-primary" style={width(segments.teaching)} />
          ) : null}
          {segments.remaining > 0 ? (
            <span data-segment="remaining" className="h-full bg-success" style={width(segments.remaining)} />
          ) : null}
          {segments.over > 0 ? (
            <span data-segment="over" className="h-full bg-destructive" style={width(segments.over)} />
          ) : null}
        </div>
        <span className="shrink-0 text-xs font-medium tabular-nums text-foreground">{label}</span>
      </div>
    </div>
  );
}
