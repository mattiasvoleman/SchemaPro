"use client";

import { Suspense, lazy, useState } from "react";
import { useTranslations } from "next-intl";
import { Page } from "@/components/layout/page";
import { PageHeader } from "@/components/layout/page-header";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { reportTabOf, type ReportTab } from "@/lib/report-tabs";
import { AttendanceReport } from "./attendance-report";

export type { ReportTab };

/**
 * The Tjänstefördelning tab: React.lazy, as the staffing drawer is (not
 * next/dynamic, whose loader costs 1.4KB of its own). An admin who opens
 * Rapporter for attendance — the page's use until staffing Fas 3 — never
 * loads it, and its exports are a further import() on click.
 */
const StaffingReport = lazy(() =>
  import("./staffing-report").then((module) => ({ default: module.StaffingReport })),
);

/**
 * Vikarietimmar, lazy for the same reason: the hour statement for payroll is
 * a few admins' monthly read, and its CSV builder is a further import() on
 * the export click.
 */
const CoverHoursReport = lazy(() =>
  import("./cover-hours-report").then((module) => ({ default: module.CoverHoursReport })),
);

/**
 * Frånvarostatistik, lazy for the same reason: a rektor's or a mentor's read of
 * absence over time is not what an administrator opens Rapporter for every
 * day, and the chart, the patterns and the pupil's card are code of its own.
 */
const AbsenceStatsReport = lazy(() =>
  import("./absence-stats-report").then((module) => ({ default: module.AbsenceStatsReport })),
);

/** What a lazy tab shows while its chunk arrives: the page-level skeleton. */
const tabLoading = (
  <div aria-busy="true">
    <Skeleton className="h-64 w-full" />
  </div>
);

/**
 * The four reports under one page. The tab is remembered in the URL
 * (`?tab=staffing`), written with history.replaceState so switching neither
 * navigates nor adds a history entry; page.tsx reads it back on a reload.
 *
 * ONE HEADER ABOVE THE TABS. Each tab used to draw its own PageHeader below
 * the tab list (and Vikarietimmar none), so the h1 sat under the controls
 * that switch it and changed with them. Now the page says once what it is,
 * the tabs sit under it, and each tab opens with its own sentence. The tab
 * bodies are radix tabpanels, named by their tab; only the chosen one is
 * mounted, so the lazy tabs still load on their first choice.
 */
export function ReportsTabs({ initialTab }: { initialTab: ReportTab }) {
  const t = useTranslations("reports.tabs");
  const [tab, setTab] = useState<ReportTab>(initialTab);

  const choose = (value: string) => {
    const next: ReportTab = reportTabOf(value);
    setTab(next);
    const url = new URL(window.location.href);
    if (next === "attendance") url.searchParams.delete("tab");
    else url.searchParams.set("tab", next);
    window.history.replaceState(window.history.state, "", url);
  };

  return (
    <Page>
      <PageHeader title={t("title")} subtitle={t("subtitle")} />
      <Tabs value={tab} onValueChange={choose} className="space-y-4">
        <TabsList aria-label={t("label")} className="h-auto flex-wrap justify-start">
          <TabsTrigger value="attendance">{t("attendance")}</TabsTrigger>
          <TabsTrigger value="staffing">{t("staffing")}</TabsTrigger>
          <TabsTrigger value="cover">{t("cover")}</TabsTrigger>
          <TabsTrigger value="absence-stats">{t("absenceStats")}</TabsTrigger>
        </TabsList>
        <TabsContent value="attendance" className="mt-0">
          <AttendanceReport />
        </TabsContent>
        <TabsContent value="staffing" className="mt-0">
          <Suspense fallback={tabLoading}>
            <StaffingReport />
          </Suspense>
        </TabsContent>
        <TabsContent value="cover" className="mt-0">
          <Suspense fallback={tabLoading}>
            <CoverHoursReport />
          </Suspense>
        </TabsContent>
        <TabsContent value="absence-stats" className="mt-0">
          <Suspense fallback={tabLoading}>
            <AbsenceStatsReport />
          </Suspense>
        </TabsContent>
      </Tabs>
    </Page>
  );
}
