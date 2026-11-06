"use client";

import { percentOf, type ReportingFigures } from "@/lib/reporting-rate";
import { useReportingRateText } from "./use-reporting-rate-text";

/**
 * A share of reported lessons as a bar and a whole percent. The percent is the
 * reading and the bar only the eye's help (hidden from assistive tech), so
 * nothing depends on telling the bar's colour from the track's. A teacher with
 * no held lesson has no share: a dash, never 0 %.
 */
export function RateBar({ figures }: { figures: ReportingFigures }) {
  const { t } = useReportingRateText();
  const percent = percentOf(figures);
  return (
    <div className="flex items-center gap-2">
      <div aria-hidden="true" className="h-2 w-20 shrink-0 overflow-hidden rounded-full bg-muted sm:w-28">
        <div className="h-full rounded-full bg-primary" style={{ width: `${percent ?? 0}%` }} />
      </div>
      <span className="whitespace-nowrap tabular-nums">{percent === null ? "—" : t("percent", { percent })}</span>
    </div>
  );
}
