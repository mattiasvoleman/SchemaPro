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
import { useAcademicYears, useGroups, usePeople, useRooms, useSubjects } from "@/lib/queries";
import type { MessageLookup } from "@/lib/engine-message";
import { usePublicationSettings } from "@/lib/publication-queries";
import { publicationErrorText } from "@/lib/publication-messages";
import { PageHeader } from "@/components/layout/page-header";
import { PublishReviewDialog } from "@/components/publication/publish-review-dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { GatePolicyCard } from "./gate-policy-card";
import { HiddenTeachersCard } from "./hidden-teachers-card";
import { LinksCard } from "./links-card";
import { ModeCard } from "./mode-card";
import { useHiddenTeachers } from "./use-public-links";
import { ValidityCard } from "./validity-card";
import { ViewerCard } from "./viewer-card";

export default function PublishingPage() {
  const t = useTranslations("publishing");
  const tErrors = useTranslations("publishing.errors") as unknown as MessageLookup;
  const tCommon = useTranslations("common");
  const { data: years } = useAcademicYears();
  const [selectedYearId, setSelectedYearId] = useState<string | null>(null);
  const yearId = selectedYearId ?? years?.find((year) => year.isActive)?.id ?? years?.[0]?.id ?? null;
  const year = years?.find((entry) => entry.id === yearId) ?? null;

  const settings = usePublicationSettings();
  const { data: groups } = useGroups();
  const { data: people } = usePeople();
  const { data: rooms } = useRooms();
  const { data: subjects } = useSubjects();
  const hiddenQuery = useHiddenTeachers();
  const hidden = useMemo(() => new Set(hiddenQuery.data ?? []), [hiddenQuery.data]);
  const teachers = useMemo(
    () => (people ?? []).filter((person) => person.role === "TEACHER" || person.role === "SCHOOL_ADMIN"),
    [people],
  );
  const [reviewOpen, setReviewOpen] = useState(false);

  return (
    <div className="space-y-4">
      <PageHeader
        title={t("title")}
        actions={
          years && years.length > 0 ? (
            <Select value={yearId ?? undefined} onValueChange={setSelectedYearId}>
              <SelectTrigger className="w-44" aria-label={t("yearLabel")}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {years.map((entry) => (
                  <SelectItem key={entry.id} value={entry.id}>
                    {entry.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          ) : null
        }
      />
      <p className="text-sm">{t("intro")}</p>

      {settings.isLoading ? <Skeleton className="h-40 w-full" /> : null}
      {settings.isError ? (
        <p role="alert" className="text-sm">
          {publicationErrorText(tErrors, settings.error, tCommon("error"))}
        </p>
      ) : null}

      {settings.data ? (
        <Tabs defaultValue="publishing">
          <TabsList>
            <TabsTrigger value="publishing">{t("tabPublishing")}</TabsTrigger>
            <TabsTrigger value="viewer">{t("tabViewer")}</TabsTrigger>
          </TabsList>
          <TabsContent value="publishing" className="space-y-4">
            <ModeCard mode={settings.data.publishMode} />
            {year ? (
              <ValidityCard year={year} mode={settings.data.publishMode} onReview={() => setReviewOpen(true)} />
            ) : null}
            <GatePolicyCard settings={settings.data} />
          </TabsContent>
          <TabsContent value="viewer" className="space-y-4">
            <ViewerCard settings={settings.data} />
            {year ? (
              <LinksCard
                year={year}
                settings={settings.data}
                groups={groups ?? []}
                teachers={teachers}
                rooms={rooms ?? []}
                hidden={hidden}
              />
            ) : null}
            <HiddenTeachersCard teachers={teachers.filter((teacher) => teacher.isActive)} hidden={hidden} />
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
    </div>
  );
}
