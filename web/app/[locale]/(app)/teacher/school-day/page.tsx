"use client";

import { useSchoolDaySettings } from "@/lib/school-day-queries";
import { Page } from "@/components/layout/page";
import { PageHeader } from "@/components/layout/page-header";
import { NotOpen } from "@/components/school-day/not-open";
import { SchoolDayBody } from "@/components/school-day/school-day-view";
import { useSchoolDayText } from "@/components/school-day/use-school-day-text";
import { LoadError } from "@/components/ui/load-error";
import { Skeleton } from "@/components/ui/skeleton";

/**
 * /teacher/school-day — Skolans dag, in the form the school has decided
 * teachers get: nothing (a calm page, and the way to the room booking), the
 * rooms, or the whole schedule. The same body as the administrators' page,
 * drawn from what the gateway answers this reader: with the rooms there are no
 * class or teacher rows, and who is free is never told to a teacher (absence,
 * uppdrag and rastvakt are not theirs to read).
 *
 * The menu entry is static, as the other teacher pages': the school's decision
 * is read here and not in the shell, which is on every route's bill.
 */
export default function TeacherSchoolDayPage() {
  const { t } = useSchoolDayText();
  const settings = useSchoolDaySettings();

  return (
    <Page className="school-day-sheet">
      <PageHeader title={t("title")} subtitle={t("subtitle")} intro={t("intro.teacher")} />
      {settings.isLoading ? (
        <div aria-busy="true">
          <Skeleton className="h-64 w-full" />
        </div>
      ) : settings.isError || !settings.data ? (
        <LoadError title={t("loadFailed")} hint={t("loadFailedHint")} headingLevel={2} />
      ) : settings.data.teacherView === "NONE" ? (
        <NotOpen />
      ) : (
        <SchoolDayBody />
      )}
    </Page>
  );
}
