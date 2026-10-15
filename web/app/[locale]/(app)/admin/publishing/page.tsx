"use client";

// Publicering: how the school's grundschema reaches the calendar, which
// published timetable is valid when, the checks a publish must pass, and
// Schemavisaren — the timetable shown without a login.
//
// Two tabs, because they are two audiences. "Publicering" is the planner's:
// direct or utkastläge, the validity ranges and the log, the policy for the
// named checks. "Schemavisaren" is about the families and the staff room: what
// the school shows outside SchemaPro, to whom, and through which links.
//
// THE DEFAULT CHANGES NOTHING. A school that never opens this page publishes
// directly, as before: every grundschema edit reaches the calendar as it is
// saved, and every check only warns. Utkastläge is opted into here; in it,
// teachers, pupils, guardians and the app keep reading what was published
// until an admin publishes the draft (from the timetable or from this page),
// and the admin sees the draft against the published one first.
//
// The publish itself is the same review dialog the timetable opens
// (components/publication/publish-review-dialog.tsx): validity range, the
// draft's changes, the dry run's counts and the checks, "Publicera ändå".

import { useMemo, useState } from "react";
import { useTranslations } from "next-intl";
import { CalendarRange } from "lucide-react";
import { Link } from "@/i18n/navigation";
import { useGroups, usePeople, useRooms, useSubjects } from "@/lib/queries";
import { usePublicationSettings } from "@/lib/publication-queries";
import { Page } from "@/components/layout/page";
import { PageHeader } from "@/components/layout/page-header";
import { PublishReviewDialog } from "@/components/publication/publish-review-dialog";
import { YearSelect, useYearScope } from "@/components/schedule/year-select";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { LoadError } from "@/components/ui/load-error";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { GatePolicyCard } from "./gate-policy-card";
import { EmbedCard } from "./embed-card";
import { HiddenTeachersCard } from "./hidden-teachers-card";
import { LinksCard } from "./links-card";
import { ModeCard } from "./mode-card";
import { useHiddenTeachers } from "./use-public-links";
import { ValidityCard } from "./validity-card";
import { ViewerCard } from "./viewer-card";

export default function PublishingPage() {
  const t = useTranslations("publishing");
  const tCommon = useTranslations("common");
  // The chosen year, else the active one, else the first — as before.
  const scope = useYearScope();
  const { year, yearId, setYearId } = scope;

  const settings = usePublicationSettings();
  const { data: groups } = useGroups();
  const peopleQuery = usePeople();
  const people = peopleQuery.data;
  const { data: rooms } = useRooms();
  const { data: subjects } = useSubjects();
  const hiddenQuery = useHiddenTeachers();
  const hidden = useMemo(() => new Set(hiddenQuery.data ?? []), [hiddenQuery.data]);
  const teachers = useMemo(
    () => (people ?? []).filter((person) => person.role === "TEACHER" || person.role === "SCHOOL_ADMIN"),
    [people],
  );
  const [reviewOpen, setReviewOpen] = useState(false);

  /*
   * The two year-bound cards (validity, links) and what stands in their place
   * while there is no year to show: the years still loading, failed, or none
   * at all yet. The rest of the page is the school's, not a year's, and works
   * without one.
   */
  const yearBound = (card: (shown: NonNullable<typeof year>) => React.ReactNode) =>
    year ? (
      card(year)
    ) : scope.isLoading ? (
      <div aria-busy="true">
        <Skeleton className="h-24 w-full" />
      </div>
    ) : scope.isError ? (
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
    <Page>
      <PageHeader
        title={t("title")}
        subtitle={t("subtitle")}
        intro={t("intro")}
        actions={
          <div className="flex flex-wrap items-end gap-2">
            <Button variant="outline" asChild>
              <Link href="/admin/publishing/print">{t("printAction")}</Link>
            </Button>
            <YearSelect value={yearId} onValueChange={setYearId} label={t("yearLabel")} />
          </div>
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
        <Tabs defaultValue="publishing" className="space-y-4">
          <TabsList aria-label={t("tabsLabel")}>
            <TabsTrigger value="publishing">{t("tabPublishing")}</TabsTrigger>
            <TabsTrigger value="viewer">{t("tabViewer")}</TabsTrigger>
          </TabsList>
          <TabsContent value="publishing" className="space-y-4">
            <ModeCard mode={settings.data.publishMode} />
            {yearBound((shown) => (
              <ValidityCard year={shown} mode={settings.data!.publishMode} onReview={() => setReviewOpen(true)} />
            ))}
            <GatePolicyCard settings={settings.data} />
          </TabsContent>
          <TabsContent value="viewer" className="space-y-4">
            <ViewerCard settings={settings.data} />
            <EmbedCard settings={settings.data} />
            {yearBound((shown) => (
              <LinksCard
                year={shown}
                settings={settings.data!}
                groups={groups ?? []}
                teachers={teachers}
                rooms={rooms ?? []}
                hidden={hidden}
              />
            ))}
            <HiddenTeachersCard
              teachers={teachers.filter((teacher) => teacher.isActive)}
              hidden={hidden}
              loading={Boolean(hiddenQuery.isLoading || peopleQuery.isLoading)}
              failed={Boolean(hiddenQuery.isError || peopleQuery.isError)}
            />
          </TabsContent>
        </Tabs>
      ) : null}

      <PublishReviewDialog
        open={reviewOpen}
        onOpenChange={setReviewOpen}
        year={year}
        subjects={subjects}
        groups={groups}
        teachers={teachers}
        rooms={rooms}
      />
    </Page>
  );
}
