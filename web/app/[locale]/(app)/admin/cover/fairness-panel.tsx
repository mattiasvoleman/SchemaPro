"use client";

import { useState } from "react";
import { Scale } from "lucide-react";
import { useTranslations } from "next-intl";
import { useCoverFairness } from "@/lib/cover-request-queries";
import { fairnessPeriodOk, lastDays, sortFairness } from "@/lib/cover-request-view";
import { toDateString } from "@/lib/utils";
import { DateField } from "@/components/ui/date-field";
import { FilterBar, FilterField } from "@/components/ui/filter-bar";
import { LoadError } from "@/components/ui/load-error";
import { Notice } from "@/components/ui/notice";
import { PurgedNotice } from "@/components/retention/purged-notice";
import { SectionCard } from "@/components/ui/section-card";
import { Skeleton } from "@/components/ui/skeleton";

/**
 * "Rättvisa", beside the cover counter: per colleague, how many questions
 * they were asked, said yes and no to, and left unanswered, over a period
 * (the last 30 days to start with). The counter says who has covered; this
 * says who has been asked, so the same few are not asked every time.
 *
 * A reading, for every admin profile: no button writes anything. Only people
 * who were asked appear, and the names come from the people list the board
 * has already read.
 */
export function FairnessPanel({ nameOf }: { nameOf: (userId: string) => string }) {
  const t = useTranslations("coverFairness");
  const [period, setPeriod] = useState(() => lastDays(toDateString(new Date())));
  const valid = fairnessPeriodOk(period.from, period.to);
  const { data, isLoading, isError } = useCoverFairness(period.from, period.to, valid);
  const rows = sortFairness(data?.rows ?? [], nameOf);

  return (
    <SectionCard id="cover-fairness" title={t("title")} icon={Scale} description={t("body")}>
      <FilterBar className="gap-2">
        <FilterField id="fairness-from" label={t("from")}>
          <DateField
            id="fairness-from"
            label={t("from")}
            className="w-36"
            value={period.from}
            onChange={(value) => value && setPeriod((current) => ({ ...current, from: value }))}
          />
        </FilterField>
        <FilterField id="fairness-to" label={t("to")}>
          <DateField
            id="fairness-to"
            label={t("to")}
            className="w-36"
            value={period.to}
            onChange={(value) => value && setPeriod((current) => ({ ...current, to: value }))}
          />
        </FilterField>
      </FilterBar>
      {/* A period reaching back past the school's gallring says so, rather than a table that is empty for that reason. */}
      {valid ? <PurgedNotice kind="COVER_REQUESTS" from={period.from} /> : null}
      {!valid ? (
        <Notice tone="warning">{t("periodInvalid")}</Notice>
      ) : isLoading ? (
        <div aria-busy="true">
          <Skeleton className="h-16 w-full" />
        </div>
      ) : isError ? (
        <LoadError variant="inline" title={t("loadFailed")} hint={t("loadFailedHint")} />
      ) : rows.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t("empty")}</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <caption className="sr-only">{t("caption", { from: period.from, to: period.to })}</caption>
            <thead>
              <tr className="text-left text-xs text-muted-foreground">
                <th scope="col" className="py-1.5 pr-3 font-medium">
                  {t("name")}
                </th>
                <th scope="col" className="px-1.5 py-1.5 text-right font-medium">
                  {t("received")}
                </th>
                <th scope="col" className="px-1.5 py-1.5 text-right font-medium">
                  {t("accepted")}
                </th>
                <th scope="col" className="px-1.5 py-1.5 text-right font-medium">
                  {t("declined")}
                </th>
                <th scope="col" className="py-1.5 pl-1.5 text-right font-medium">
                  {t("unanswered")}
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.userId}>
                  <td className="py-1.5 pr-3">{nameOf(row.userId)}</td>
                  <td className="px-1.5 py-1.5 text-right tabular-nums">{row.received}</td>
                  <td className="px-1.5 py-1.5 text-right tabular-nums">{row.accepted}</td>
                  <td className="px-1.5 py-1.5 text-right tabular-nums">{row.declined}</td>
                  <td className="py-1.5 pl-1.5 text-right tabular-nums">{row.unanswered}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </SectionCard>
  );
}
