"use client";

import { useState } from "react";
import { CalendarOff, ChevronLeft, ChevronRight, Users } from "lucide-react";
import { useReportingRate } from "@/lib/reporting-rate-queries";
import {
  DEFAULT_SORT,
  REPORTING_PERIODS,
  neighbourAnchor,
  nextSort,
  openOf,
  percentOf,
  type ReportingPeriod,
  type ReportingSort,
  type ReportingSortKey,
} from "@/lib/reporting-rate";
import { useReportingRateText } from "@/components/reporting-rate/use-reporting-rate-text";
import { Page } from "@/components/layout/page";
import { PageHeader } from "@/components/layout/page-header";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { FilterBar } from "@/components/ui/filter-bar";
import { KpiStrip, KpiTile } from "@/components/ui/kpi";
import { LoadError } from "@/components/ui/load-error";
import { SectionCard } from "@/components/ui/section-card";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { RateTable } from "./rate-table";
import { SettingsCard } from "./settings-card";

/**
 * Rapporteringsgrad (20270108090100): the share of the lessons each teacher
 * held whose register is saved, for a week, a month or the läsår, and the two
 * notices the school can turn on.
 *
 * A lesson is reported when at least one pupil has a mark. The gateway counts
 * it every night, from yesterday back, so the page says how far the figures
 * reach ("uppdaterad t.o.m.") and never counts today. The table opens on the
 * lowest share. Reading it is recorded in the läslogg, as the teachers' names
 * are other people's data; the switches are Drift's and a läsare
 * (Läsbehörighet) reads them and changes none.
 *
 * The period and the day it is around are the page's state, not the address:
 * the arrows take the day the gateway names for the week or month before and
 * after, and aim into the neighbouring läsår (neighbourAnchor says why).
 */
export default function ReportingRatePage() {
  const { t, day, number, periodName } = useReportingRateText();
  const [period, setPeriod] = useState<ReportingPeriod>("WEEK");
  // null: the school's today, which the gateway knows (the browser's clock may not be the school's).
  const [anchor, setAnchor] = useState<string | null>(null);
  const [sort, setSort] = useState<ReportingSort>(DEFAULT_SORT);
  const query = useReportingRate(period, anchor);
  const view = query.data;
  const moving = query.isPlaceholderData;

  const range = view?.from && view.to ? `${day(view.from)} – ${day(view.to)}` : null;
  const label = view?.from ? `${periodName(period, view.from, view.yearName)} · ${range}` : t("period.none");
  const share = view ? percentOf(view.total) : null;
  const previous = view ? neighbourAnchor(view, -1) : null;
  const next = view ? neighbourAnchor(view, 1) : null;

  return (
    <Page>
      <PageHeader title={t("title")} subtitle={t("subtitle")} intro={t("intro")} />

      <FilterBar>
        <Tabs value={period} onValueChange={(value) => setPeriod(value as ReportingPeriod)}>
          <TabsList aria-label={t("period.label")}>
            {REPORTING_PERIODS.map((one) => (
              <TabsTrigger key={one} value={one}>
                {t(`period.${one}`)}
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>
        <div className="flex flex-wrap items-center gap-2">
          <Button
            variant="outline"
            size="icon"
            aria-label={t(`period.previous.${period}`)}
            disabled={!previous || moving}
            onClick={() => previous && setAnchor(previous)}
          >
            <ChevronLeft />
          </Button>
          {/* Live, so a screen reader hears which period the arrows landed on. */}
          <span className="min-w-48 text-center text-sm font-medium" aria-live="polite">
            {label}
          </span>
          <Button
            variant="outline"
            size="icon"
            aria-label={t(`period.next.${period}`)}
            disabled={!next || moving}
            onClick={() => next && setAnchor(next)}
          >
            <ChevronRight />
          </Button>
          {/* The way back after paging, and out of a period with no läsår. Disabled rather than hidden on the current one. */}
          <Button variant="ghost" size="sm" disabled={anchor === null} onClick={() => setAnchor(null)}>
            {t("period.current")}
          </Button>
        </div>
      </FilterBar>

      {query.isLoading ? (
        <div aria-busy="true">
          <Skeleton className="h-64 w-full" />
        </div>
      ) : query.isError || !view ? (
        <LoadError
          title={t("loadFailed")}
          hint={t("loadFailedHint")}
          headingLevel={2}
          action={
            <Button variant="outline" size="sm" onClick={() => void query.refetch()}>
              {t("retry")}
            </Button>
          }
        />
      ) : view.from === null ? (
        <EmptyState icon={CalendarOff} headingLevel={2} title={t("noYear.title")} description={t("noYear.body")} />
      ) : (
        <>
          <KpiStrip columns={3}>
            <KpiTile
              label={t("kpi.share")}
              value={share === null ? null : t("percent", { percent: share })}
              fallback={t("kpi.noLessons")}
              detail={t("kpi.shareDetail", { reported: number(view.total.reported), held: number(view.total.held) })}
            />
            <KpiTile label={t("kpi.held")} value={number(view.total.held)} />
            <KpiTile label={t("kpi.open")} value={number(openOf(view.total))} />
          </KpiStrip>

          <SectionCard
            id="reporting-rate-teachers"
            title={t("table.title")}
            description={view.through ? t("updatedThrough", { date: day(view.through) }) : t("notCountedYet")}
          >
            {view.teachers.length === 0 ? (
              <EmptyState icon={Users} headingLevel={3} title={t("empty.title")} description={t("empty.body")} />
            ) : (
              <RateTable
                teachers={view.teachers}
                sort={sort}
                onSort={(key: ReportingSortKey) => setSort((current) => nextSort(current, key))}
                busy={moving}
              />
            )}
          </SectionCard>
        </>
      )}

      <SettingsCard />
    </Page>
  );
}
