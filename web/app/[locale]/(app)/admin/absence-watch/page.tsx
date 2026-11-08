"use client";

import { useTranslations } from "next-intl";
import { useAbsenceWatchOverview } from "@/lib/absence-watch-queries";
import { FindingsSection } from "@/components/absence-watch/findings-section";
import { Page } from "@/components/layout/page";
import { PageHeader } from "@/components/layout/page-header";
import { Button } from "@/components/ui/button";
import { LoadError } from "@/components/ui/load-error";
import { Skeleton } from "@/components/ui/skeleton";
import { Link } from "@/i18n/navigation";
import { LimitsCard } from "./limits-card";
import { SettingsCard } from "./settings-card";

/**
 * Frånvarobevakning (20261231090100): the school's limits for absence, who is
 * told when a pupil passes one, and the pupils who have.
 *
 * Off until an administrator turns it on. A job counts every night, from the
 * attendance the reports already count, and the recipients (mentors, rektor,
 * kansli, guardians) get a sammanställning per week or month: a count, never
 * a name or a reason. Who the pupils are is read here, behind the login, and
 * each reading is recorded in the läslogg.
 *
 * The switch, the cadences and the limits are Drift's, as the attendance and
 * the leave they count; a läsare (Läsbehörighet) reads them all and changes
 * none. The findings are read from their own route (the overview failing does
 * not take them away) and are the same list a mentor and a guardian read for
 * their own pupils.
 *
 * A link leads on to Frånvarostatistik över tid, the fourth tab of
 * /admin/reports: the same absence month by month, with the rapporteringsgrad.
 */
export default function AbsenceWatchPage() {
  const t = useTranslations("absenceWatch");
  const tStats = useTranslations("absenceStats");
  const overview = useAbsenceWatchOverview();

  return (
    <Page>
      <PageHeader
        title={t("title")}
        subtitle={t("subtitle")}
        actions={
          <Button variant="outline" size="sm" asChild>
            <Link href="/admin/reports?tab=absence-stats">{tStats("link")}</Link>
          </Button>
        }
      />
      {overview.isLoading ? (
        <div aria-busy="true">
          <Skeleton className="h-64 w-full" />
        </div>
      ) : overview.isError || !overview.data ? (
        <LoadError title={t("loadFailed")} hint={t("loadFailedHint")} headingLevel={2} />
      ) : (
        <>
          <SettingsCard overview={overview.data} />
          <LimitsCard limits={overview.data.limits} />
        </>
      )}
      <FindingsSection audience="admin" watchOn={overview.data?.settings.enabled} />
    </Page>
  );
}
