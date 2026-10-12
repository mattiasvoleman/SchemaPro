"use client";

// Avbokning: cancel lessons in bulk — a day, a week, a year group or named
// classes — for prao, a friluftsdag or a studiedag, and take it back.
//
// A PAGE OF ITS OWN, NOT A TAB OF LOV OR THE DAY PLANNER. Lov och studiedagar
// (/admin/breaks) is planning: days the läsår has but the timetable does not,
// counted before a lesson exists, and saving one REMOVES the published
// lessons. Dagsplanering (/admin/lessons) is one day's lessons, one at a time.
// An avbokning sits between them — dated, after publishing, many lessons at
// once — and keeps every lesson as CANCELLED with the day's name in its note,
// so it can be reversed and so pupils and guardians read "Inställd: Prao åk 9"
// rather than an empty hour. The lov page links here for the days that are
// not a lov.
//
// THE PAST IS NEVER TOUCHED. The gateway cancels only lessons that have not
// begun, are SCHEDULED and have no attendance; the preview counts what it
// leaves out and why. A reversal reinstates only lessons still cancelled by
// the batch and ahead, and leaves a lesson whose room was taken meanwhile.

import { useTranslations } from "next-intl";
import { CalendarRange } from "lucide-react";
import { Link } from "@/i18n/navigation";
import { useGroups, useRooms, useSubjects } from "@/lib/queries";
import { Page } from "@/components/layout/page";
import { PageHeader } from "@/components/layout/page-header";
import { YearSelect, useYearScope } from "@/components/schedule/year-select";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { LoadError } from "@/components/ui/load-error";
import { Skeleton } from "@/components/ui/skeleton";
import { BatchesCard } from "./batches-card";
import { CancellationFormCard } from "./cancellation-form-card";

export default function CancellationsPage() {
  const t = useTranslations("cancellations");
  const { year, yearId, setYearId, isLoading, isError } = useYearScope();
  const groupsQuery = useGroups();
  const roomsQuery = useRooms();
  const subjectsQuery = useSubjects();
  const lookupsFailed = groupsQuery.isError || roomsQuery.isError || subjectsQuery.isError;

  return (
    <Page>
      <PageHeader
        title={t("title")}
        subtitle={t("subtitle")}
        intro={t("intro")}
        actions={<YearSelect value={yearId} onValueChange={setYearId} label={t("yearLabel")} />}
      />
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
        <>
          {lookupsFailed ? (
            <LoadError variant="inline" title={t("lookupsFailed")} hint={t("lookupsFailedHint")} />
          ) : null}
          {/* Keyed by the year: a form filled for one läsår is not the next one's. */}
          <CancellationFormCard
            key={year.id}
            year={year}
            groups={groupsQuery.data ?? []}
            subjects={subjectsQuery.data ?? []}
          />
          <BatchesCard year={year} groups={groupsQuery.data ?? []} rooms={roomsQuery.data ?? []} />
        </>
      )}
    </Page>
  );
}
