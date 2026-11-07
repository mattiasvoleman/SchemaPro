"use client";

// Prov och skrivsalar: the school enters its exams, marks the rooms exams may be
// written in, and asks the planner for a time, rooms and invigilators.
//
// AN EXAM THAT IS LAID IS AN ACTIVITY. Its result is a schemabrytande aktivitet
// (Drift > Aktiviteter) with one replacement lesson per class, which carries
// the attendance; the exam's minutes are credited to its subject; each room is
// booked; and the invigilators stand on the lesson of the classes that write in
// their room. The page for all that is Aktiviteter, which is why it is linked
// from there and back.
//
// THE PLANNER IS OFF UNTIL THE SCHOOL TURNS IT ON (Inställningar). Exams and
// rooms are entered either way; only "Planera" is refused.

import { useTranslations } from "next-intl";
import { CalendarRange } from "lucide-react";
import { Link } from "@/i18n/navigation";
import { useGroups, useSubjects } from "@/lib/queries";
import { Page } from "@/components/layout/page";
import { PageHeader } from "@/components/layout/page-header";
import { YearSelect, useYearScope } from "@/components/schedule/year-select";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { LoadError } from "@/components/ui/load-error";
import { Skeleton } from "@/components/ui/skeleton";
import { ExamsSection } from "./exams-section";
import { ExamRoomsCard } from "./rooms-card";
import { ExamSettingsCard } from "./settings-card";

export default function ExamsPage() {
  const t = useTranslations("exams");
  const { year, yearId, setYearId, isLoading, isError } = useYearScope();
  const groupsQuery = useGroups();
  const subjectsQuery = useSubjects();
  const lookupsFailed = groupsQuery.isError || subjectsQuery.isError;

  return (
    <Page>
      <PageHeader
        title={t("title")}
        subtitle={t("subtitle")}
        intro={t("intro")}
        back={{ href: "/admin/activities", label: t("backToActivities") }}
        actions={<YearSelect value={yearId} onValueChange={setYearId} label={t("yearLabel")} />}
      />
      {lookupsFailed ? <LoadError variant="inline" title={t("lookupsFailed")} hint={t("lookupsFailedHint")} /> : null}
      <ExamSettingsCard subjects={subjectsQuery.data ?? []} />
      <ExamRoomsCard />
      {isLoading ? (
        <div aria-busy="true">
          <Skeleton className="h-64 w-full" />
        </div>
      ) : isError ? (
        <LoadError title={t("loadFailed")} hint={t("loadFailedHint")} headingLevel={2} />
      ) : !year ? (
        <EmptyState
          icon={CalendarRange}
          title={t("noYearTitle")}
          description={t("noYearBody")}
          headingLevel={2}
          action={
            <Button asChild>
              <Link href="/admin/years">{t("goToYears")}</Link>
            </Button>
          }
        />
      ) : (
        <ExamsSection key={year.id} year={year} groups={groupsQuery.data ?? []} subjects={subjectsQuery.data ?? []} />
      )}
    </Page>
  );
}
