"use client";

// Aktiviteter: a dated activity that replaces the ordinary lessons — a
// friluftsdag, prao, the national tests — for one or more classes and days.
//
// A PAGE OF ITS OWN, BESIDE AVBOKNING. Avbokning (/admin/cancellations)
// cancels lessons and leaves the hour empty, with the day's name in its
// note. An aktivitet owns such an avbokning and puts one lesson in the empty
// hour's place per class and day: it carries the attendance, it names the
// teachers responsible, and the pupils read a short description on it. The
// day's minutes are counted as undervisningstid by credits on named subjects,
// not by the replacement lesson, which is held in a subject that does not
// count — so the same hours are never counted twice.
//
// THE PAST IS NEVER TOUCHED, as in an avbokning: the gateway cancels only
// lessons that have not begun, are SCHEDULED and have no attendance. A
// removal puts back only what is still cancelled by the activity and ahead,
// and keeps a replacement lesson that has been held.

import { useTranslations } from "next-intl";
import { CalendarRange } from "lucide-react";
import { Link } from "@/i18n/navigation";
import { usePeople, useGroups, useRooms, useSubjects } from "@/lib/queries";
import { Page } from "@/components/layout/page";
import { PageHeader } from "@/components/layout/page-header";
import { useReadOnly } from "@/components/profile-context";
import { YearSelect, useYearScope } from "@/components/schedule/year-select";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { LoadError } from "@/components/ui/load-error";
import { Skeleton } from "@/components/ui/skeleton";
import { ActivitiesCard } from "./activities-card";
import { NewActivityCard } from "./new-activity-card";

export default function ActivitiesPage() {
  const t = useTranslations("scheduleActivities");
  const { year, yearId, setYearId, isLoading, isError } = useYearScope();
  const readOnly = useReadOnly();
  const groupsQuery = useGroups();
  const roomsQuery = useRooms();
  const subjectsQuery = useSubjects();
  const peopleQuery = usePeople();
  const lookupsFailed = groupsQuery.isError || roomsQuery.isError || subjectsQuery.isError || peopleQuery.isError;

  return (
    <Page>
      <PageHeader
        title={t("title")}
        subtitle={t("subtitle")}
        intro={t("intro")}
        actions={
          <>
            <YearSelect value={yearId} onValueChange={setYearId} label={t("yearLabel")} />
            <Button variant="outline" asChild>
              <Link href="/admin/exams">{t("examsLink")}</Link>
            </Button>
          </>
        }
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
          {/* Keyed by the year: a form filled for one läsår is not the next one's. A reader has no form. */}
          {readOnly ? null : (
            <NewActivityCard
              key={year.id}
              year={year}
              groups={groupsQuery.data ?? []}
              subjects={subjectsQuery.data ?? []}
              people={peopleQuery.data ?? []}
            />
          )}
          <ActivitiesCard
            year={year}
            groups={groupsQuery.data ?? []}
            rooms={roomsQuery.data ?? []}
            subjects={subjectsQuery.data ?? []}
            people={peopleQuery.data ?? []}
          />
        </>
      )}
    </Page>
  );
}
