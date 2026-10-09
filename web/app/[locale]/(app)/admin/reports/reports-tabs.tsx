"use client";

import { Suspense, lazy, useState } from "react";
import { useTranslations } from "next-intl";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { AttendanceReport } from "./attendance-report";

export type ReportTab = "attendance" | "staffing";

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
 * The two reports under one page. The tab is remembered in the URL
 * (`?tab=staffing`), written with history.replaceState so switching neither
 * navigates nor adds a history entry; page.tsx reads it back on a reload.
 */
export function ReportsTabs({ initialTab }: { initialTab: ReportTab }) {
  const t = useTranslations("reports.tabs");
  const [tab, setTab] = useState<ReportTab>(initialTab);

  const choose = (value: string) => {
    const next: ReportTab = value === "staffing" ? "staffing" : "attendance";
    setTab(next);
    const url = new URL(window.location.href);
    if (next === "attendance") url.searchParams.delete("tab");
    else url.searchParams.set("tab", next);
    window.history.replaceState(window.history.state, "", url);
  };

  return (
    <div className="space-y-4">
      <Tabs value={tab} onValueChange={choose}>
        <TabsList aria-label={t("label")}>
          <TabsTrigger value="attendance">{t("attendance")}</TabsTrigger>
          <TabsTrigger value="staffing">{t("staffing")}</TabsTrigger>
        </TabsList>
      </Tabs>
      {tab === "attendance" ? (
        <AttendanceReport />
      ) : (
        <Suspense fallback={<Skeleton className="h-72 w-full" />}>
          <StaffingReport />
        </Suspense>
      )}
    </div>
  );
}
