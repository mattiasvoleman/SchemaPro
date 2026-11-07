"use client";

// Schemavisaren: the school's published timetable shown outside Rastra, to
// whom and how (Schemavisarens lägen, 20270118090000).
//
// It was a tab of /admin/publishing, whose other tab is the planner's: direct
// or utkastläge, validity ranges, the checks. This is about the families and
// the staff room, and about codes: who may look (everyone with a link or a
// code, or only signed-in personnel), how each kind of schedule is reached
// (not at all, from a list, or only by the exact code), which schedules are
// hidden one by one, the codes and links themselves, and the frame on the
// school's website.
//
// THE DEFAULT SHOWS NOTHING, TO NOBODY BUT STAFF. A school that never opens
// this page has no schedule outside Rastra. The page only shows and saves the
// settings and makes codes; the database decides what a code answers, and a
// person with a protected identity is never shown whatever is set here.
//
// NO RADIX SELECT on this page, on purpose: it is a route cost of its own
// (components/ui/native-select.tsx), and on a phone, where a school hands out
// a code, the native picker is the better control anyway. The year is chosen
// with one for the same reason, and the year's groups and codes follow it.

import { useMemo, useState } from "react";
import { useTranslations } from "next-intl";
import { CalendarRange } from "lucide-react";
import { Link } from "@/i18n/navigation";
import { useAcademicYears, useGroups, usePeople, useRooms } from "@/lib/queries";
import { usePublicationSettings } from "@/lib/publication-queries";
import { Page } from "@/components/layout/page";
import { PageHeader } from "@/components/layout/page-header";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { LoadError } from "@/components/ui/load-error";
import { NativeSelect } from "@/components/ui/native-select";
import { Skeleton } from "@/components/ui/skeleton";
import { EmbedCard } from "./embed-card";
import { HiddenCard } from "./hidden-card";
import { LinksCard } from "./links-card";
import { useHiddenTargets, useHiddenTeachers } from "./use-public-links";
import { ViewerCard } from "./viewer-card";

export default function SchemavisarenPage() {
  const t = useTranslations("schemavisaren");
  const tCommon = useTranslations("common");
  const settings = usePublicationSettings();
  const yearsQuery = useAcademicYears();
  const groupsQuery = useGroups();
  const peopleQuery = usePeople();
  const roomsQuery = useRooms();
  const hiddenTeachersQuery = useHiddenTeachers();
  const hiddenTargetsQuery = useHiddenTargets();

  // The chosen year, else the active one, else the first.
  const [chosen, setChosen] = useState<string | null>(null);
  const years = yearsQuery.data ?? [];
  const year = years.find((candidate) => candidate.id === chosen) ?? years.find((candidate) => candidate.isActive) ?? years[0] ?? null;

  const people = peopleQuery.data;
  const teachers = useMemo(
    () => (people ?? []).filter((person) => person.role === "TEACHER" || person.role === "SCHOOL_ADMIN"),
    [people],
  );
  const students = useMemo(() => (people ?? []).filter((person) => person.role === "STUDENT"), [people]);
  const hiddenTeachers = useMemo(() => new Set(hiddenTeachersQuery.data ?? []), [hiddenTeachersQuery.data]);
  const hidden = useMemo(
    () => hiddenTargetsQuery.data ?? { groups: [], rooms: [], students: [] },
    [hiddenTargetsQuery.data],
  );
  const yearGroups = useMemo(
    () => (groupsQuery.data ?? []).filter((group) => group.academicYearId === year?.id),
    [groupsQuery.data, year?.id],
  );

  /*
   * The year-bound card (the codes) and what stands in its place while there is
   * no year to show: the years still loading, failed, or none at all yet. The
   * rest of the page is the school's, not a year's, and works without one.
   */
  const yearBound = (card: (shown: NonNullable<typeof year>) => React.ReactNode) =>
    year ? (
      card(year)
    ) : yearsQuery.isLoading ? (
      <div aria-busy="true">
        <Skeleton className="h-24 w-full" />
      </div>
    ) : yearsQuery.isError ? (
      <LoadError variant="inline" title={t("yearsLoadFailed")} hint={t("yearsLoadFailedHint")} />
    ) : (
      <EmptyState
        icon={CalendarRange}
        headingLevel={2}
        title={t("noYear")}
        description={t("noYearHint")}
        action={
          <Button variant="outline" asChild>
            <Link href="/admin/years">{t("noYearAction")}</Link>
          </Button>
        }
      />
    );

  return (
    <Page width="wide">
      <PageHeader
        title={t("title")}
        subtitle={t("subtitle")}
        intro={t("intro")}
        actions={
          year ? (
            <NativeSelect
              aria-label={tCommon("year")}
              className="w-44"
              value={year.id}
              onChange={(event) => setChosen(event.target.value)}
            >
              {years.map((candidate) => (
                <option key={candidate.id} value={candidate.id}>
                  {candidate.name}
                </option>
              ))}
            </NativeSelect>
          ) : undefined
        }
      />

      {/*
        A failed refetch keeps the settings on screen as last read, with this
        above them; the page-level error is only for settings never read.
      */}
      {settings.isError && settings.data ? (
        <LoadError variant="inline" title={t("loadFailed")} hint={tCommon("refetchFailedHint")} />
      ) : null}

      {settings.isLoading ? (
        <div aria-busy="true">
          <Skeleton className="h-64 w-full" />
        </div>
      ) : settings.isError && !settings.data ? (
        <LoadError title={t("loadFailed")} hint={t("loadFailedHint")} headingLevel={2} />
      ) : settings.data ? (
        <div className="space-y-4">
          <ViewerCard settings={settings.data} />
          <HiddenCard
            teachers={teachers.filter((teacher) => teacher.isActive)}
            groups={yearGroups}
            rooms={roomsQuery.data ?? []}
            students={students.filter((student) => student.isActive)}
            hiddenTeachers={hiddenTeachers}
            hiddenGroups={new Set(hidden.groups)}
            hiddenRooms={new Set(hidden.rooms)}
            hiddenStudents={new Set(hidden.students)}
            loading={Boolean(
              yearsQuery.isLoading ||
                hiddenTeachersQuery.isLoading ||
                hiddenTargetsQuery.isLoading ||
                peopleQuery.isLoading ||
                groupsQuery.isLoading ||
                roomsQuery.isLoading,
            )}
            failed={Boolean(
              hiddenTeachersQuery.isError ||
                hiddenTargetsQuery.isError ||
                peopleQuery.isError ||
                groupsQuery.isError ||
                roomsQuery.isError,
            )}
          />
          {yearBound((shown) => (
            <LinksCard
              year={shown}
              settings={settings.data!}
              groups={groupsQuery.data ?? []}
              teachers={teachers}
              students={students}
              rooms={roomsQuery.data ?? []}
              hiddenTeachers={hiddenTeachers}
              hidden={hidden}
            />
          ))}
          <EmbedCard settings={settings.data} />
        </div>
      ) : null}
    </Page>
  );
}
