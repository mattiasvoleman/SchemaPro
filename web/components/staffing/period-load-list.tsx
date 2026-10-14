"use client";

import { useTranslations } from "next-intl";
import { isJudged } from "@/lib/period-view";
import { formatPercent } from "@/lib/staffing-view";
import type { PeriodLoad } from "@/lib/teacher-load";
import { StatusBadge } from "@/components/staffing/staffing-matrix";

/**
 * A post that changes during the year, stretch by stretch: the dates, the
 * figures, and each stretch's own verdict — so the one that is over is read
 * on the page, not from a badge's hover. The drawer's list; Min tjänst says
 * the same to the teacher in their own words.
 */
export function PeriodLoadList({ periods }: { periods: readonly PeriodLoad[] }) {
  const t = useTranslations("staffing");
  return (
    <ol className="divide-y text-sm">
      {periods.map((period) => (
        <li
          key={`${period.kind}-${period.from}`}
          className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 py-1.5"
        >
          <span>
            <span className="font-medium">{t("periodDates", { from: period.from, to: period.to })}</span>
            {" · "}
            {period.reductionPercent > 0
              ? t("periodFiguresReduction", {
                  percent: formatPercent(period.employmentPercent),
                  reduction: formatPercent(period.reductionPercent),
                })
              : t("periodFigures", { percent: formatPercent(period.employmentPercent) })}
          </span>
          {isJudged(period) ? (
            <span className="flex items-center gap-2 text-muted-foreground">
              {period.targetMinutesPerWeek === null
                ? t("periodCountedOnly", { counted: period.countedMinutesPerWeek })
                : t("periodTargetCounted", {
                    target: period.targetMinutesPerWeek,
                    counted: period.countedMinutesPerWeek,
                  })}
              <StatusBadge status={period.status} />
            </span>
          ) : (
            <span className="text-muted-foreground">
              {period.effectiveFrom === null ? t("periodNoWeek") : t("periodNoTeachingWeek")}
            </span>
          )}
        </li>
      ))}
    </ol>
  );
}
