"use client";

import { useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import { DoorOpen, Plus } from "lucide-react";
import { LazyDialog } from "@/components/local/lazy-dialog";
import { Page } from "@/components/layout/page";
import { PageHeader } from "@/components/layout/page-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { FilterBar } from "@/components/ui/filter-bar";
import { LoadError } from "@/components/ui/load-error";
import { Notice } from "@/components/ui/notice";
import { Skeleton } from "@/components/ui/skeleton";
import { TableCard } from "@/components/ui/table-card";
import { TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { clockRangeText, dayText, ruleText, type ExternalBookingSummary, type ExternalState } from "@/lib/local";
import { useExternalBookings, useExternalClashes } from "@/lib/local-queries";

/** The two dialogs, each fetched when first opened. */
const loadNewDialog = () => import("./new-booking-dialog").then((module) => ({ default: module.NewBookingDialog }));
const loadSeriesDialog = () => import("./series-dialog").then((module) => ({ default: module.SeriesDialog }));

type Shown = Exclude<ExternalState, "all">;
const SHOWN: readonly Shown[] = ["active", "ended", "cancelled"];

/**
 * Externa bokningar (20270204091000): a series of days a room or a resource is
 * let to somebody who has no login, an association or a company, registered by
 * the expedition. A day stands in the room's calendar as any booking does, so a
 * lesson cannot be placed over it; if one is placed over it anyway (the schedule
 * moved), the band at the top says how many days now clash and which.
 *
 * The contact of a series is personal data about somebody who has none: it is
 * read in the detail, one series at a time, and the table names the organisation
 * only. Registering and cancelling are Drift's; the läsare reads.
 */
export default function ExternalBookingsPage() {
  const t = useTranslations("adminExternalBookings");
  const locale = useLocale();
  const [shown, setShown] = useState<Shown>("active");
  const list = useExternalBookings(shown);
  const clashes = useExternalClashes();
  const [newOpen, setNewOpen] = useState(false);
  // The series the detail is about stays set while the dialog closes, so its content does not empty under the fade.
  const [seriesId, setSeriesId] = useState<string | null>(null);
  const [seriesOpen, setSeriesOpen] = useState(false);

  const open = (id: string) => {
    setSeriesId(id);
    setSeriesOpen(true);
  };

  const rows = list.data ?? [];
  const clashList = clashes.data ?? [];

  return (
    <Page>
      <PageHeader
        title={t("title")}
        subtitle={t("subtitle")}
        actions={
          <Button data-writes="DRIFT" onClick={() => setNewOpen(true)}>
            <Plus aria-hidden="true" />
            {t("newBooking")}
          </Button>
        }
      />

      {clashes.isError ? <LoadError variant="inline" title={t("clashesLoadFailed")} hint={t("clashesLoadFailedHint")} /> : null}
      {clashList.length > 0 ? (
        <Notice tone="warning" title={t("clashTitle", { count: clashList.length })}>
          <p>{t("clashHint")}</p>
          <div role="region" aria-label={t("clashList")} tabIndex={0} className="mt-2 max-h-56 overflow-y-auto rounded-md">
            <ul className="space-y-1.5">
              {clashList.map((clash) => (
                <li key={clash.dayId} className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 text-sm">
                  <span className="min-w-0">
                    <span className="font-medium">{clash.organisation}</span>, {clash.targetName}:{" "}
                    <span className="tabular-nums">
                      {dayText(clash.date, locale)} {clockRangeText(clash.startsAt, clash.endsAt, locale)}
                    </span>
                    {clash.lesson !== "" ? <> · {t("clashLesson", { lesson: clash.lesson })}</> : null}
                  </span>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => open(clash.seriesId)}
                    aria-label={t("openNamed", { name: `${clash.organisation}, ${clash.targetName}` })}
                  >
                    {t("open")}
                  </Button>
                </li>
              ))}
            </ul>
          </div>
        </Notice>
      ) : null}

      <FilterBar>
        <Tabs value={shown} onValueChange={(value) => setShown(value as Shown)}>
          <TabsList aria-label={t("stateLabel")}>
            {SHOWN.map((state) => (
              <TabsTrigger key={state} value={state}>
                {t(`state.${state}`)}
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>
      </FilterBar>

      {list.isLoading ? (
        <div aria-busy="true">
          <Skeleton className="h-48 w-full" />
        </div>
      ) : list.isError ? (
        <LoadError title={t("loadFailed")} hint={t("loadFailedHint")} headingLevel={2} />
      ) : rows.length === 0 ? (
        <EmptyState icon={DoorOpen} title={t(`empty.${shown}`)} description={t("emptyHint")} headingLevel={2} />
      ) : (
        <TableCard caption={t("tableCaption", { state: shown })}>
          <TableHeader>
            <TableRow>
              <TableHead>{t("organisation")}</TableHead>
              <TableHead>{t("targetColumn")}</TableHead>
              <TableHead>{t("ruleColumn")}</TableHead>
              <TableHead className="text-right">{t("daysColumn")}</TableHead>
              <TableHead className="w-24 text-right">{t("actionsColumn")}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((series) => (
              <SeriesRow key={series.id} series={series} onOpen={() => open(series.id)} />
            ))}
          </TableBody>
        </TableCard>
      )}

      <LazyDialog load={loadNewDialog} kind="form" props={{ open: newOpen, onOpenChange: setNewOpen }} />
      <LazyDialog
        load={loadSeriesDialog}
        kind="form"
        props={{ open: seriesOpen, onOpenChange: setSeriesOpen, seriesId }}
      />
    </Page>
  );
}

function SeriesRow({ series, onOpen }: { series: ExternalBookingSummary; onOpen: () => void }) {
  const t = useTranslations("adminExternalBookings");
  const tLocal = useTranslations("local");
  const locale = useLocale();
  const target = `${series.target.name}${series.resourceQuantity ? ` × ${series.resourceQuantity}` : ""}`;
  return (
    <TableRow>
      <TableCell className="font-medium">
        {series.organisation}
        {series.purpose ? <span className="block text-xs font-normal text-muted-foreground">{series.purpose}</span> : null}
      </TableCell>
      <TableCell>
        {target}
        <span className="block text-xs text-muted-foreground">{t(series.target.kind === "ROOM" ? "kindRoom" : "kindResource")}</span>
      </TableCell>
      <TableCell className="text-sm">{ruleText(series, tLocal, locale)}</TableCell>
      <TableCell className="text-right tabular-nums">
        {t("upcomingOf", { upcoming: series.days.upcoming, total: series.days.total })}
        {series.clashes > 0 ? (
          <span className="block">
            <Badge variant="warning">{t("clashBadge", { count: series.clashes })}</Badge>
          </span>
        ) : null}
      </TableCell>
      <TableCell className="text-right">
        <Button
          variant="outline"
          size="sm"
          onClick={onOpen}
          aria-label={t("openNamed", { name: `${series.organisation}, ${series.target.name}` })}
        >
          {t("open")}
        </Button>
      </TableCell>
    </TableRow>
  );
}
