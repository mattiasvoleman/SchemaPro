"use client";

import { BarChart3 } from "lucide-react";
import { MIN_GROUP } from "@/lib/absence-stats";
import { useSchoolStats } from "@/lib/absence-stats-queries";
import { ClassBrowser } from "@/components/absence-stats/class-browser";
import { SeriesSection } from "@/components/absence-stats/series-section";
import { useAbsenceStatsText } from "@/components/absence-stats/use-absence-stats-text";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { LoadError } from "@/components/ui/load-error";
import { Skeleton } from "@/components/ui/skeleton";

/**
 * Frånvarostatistik, the fourth tab of /admin/reports: the school's absence
 * month by month over three läsår, then its classes over a period and, class
 * by class, the months, the patterns, the pupils and a pupil's card.
 *
 * Loaded on the tab's first choice (reports-tabs.tsx), so an administrator who
 * opens Rapporter for attendance never downloads it. The figures are the
 * gateway's (src/absence-stats/), counted by the definition the attendance
 * report and Frånvarobevakningen count by; this tab only draws them, with the
 * rapporteringsgrad beside each month and the same month a year before under
 * each figure. A figure under five pupils is not given, and said so.
 *
 * The huvudman's läsare reads the school and the classes and never a pupil:
 * the pupil list and the card are replaced by the explanation
 * (components/absence-stats/pupil-list.tsx).
 */
export function AbsenceStatsReport() {
  const { t } = useAbsenceStatsText();

  return (
    <div className="space-y-4">
      <p className="max-w-prose text-sm text-muted-foreground">{t("intro", { min: MIN_GROUP })}</p>
      <SchoolSection />
      <ClassBrowser audience="admin" />
    </div>
  );
}

function SchoolSection() {
  const { t } = useAbsenceStatsText();
  const query = useSchoolStats();
  const view = query.data;

  if (query.isLoading) {
    return (
      <div aria-busy="true">
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }
  if (query.isError || !view) {
    return (
      <LoadError
        title={t("school.loadFailed")}
        hint={t("loadFailedHint")}
        headingLevel={2}
        action={
          <Button variant="outline" size="sm" onClick={() => void query.refetch()}>
            {t("retry")}
          </Button>
        }
      />
    );
  }
  if (view.series.length === 0) {
    return <EmptyState icon={BarChart3} headingLevel={2} title={t("school.emptyTitle")} description={t("school.emptyBody")} />;
  }
  return (
    <SeriesSection
      id="absence-stats-school"
      title={t("school.title")}
      description={t("school.description")}
      caption={t("school.caption")}
      series={view.series}
      minGroup={view.window.minGroup}
    />
  );
}
