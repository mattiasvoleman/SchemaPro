"use client";

import { useTranslations } from "next-intl";
import type { AcademicYear, Person, StudentGroup, Subject } from "@/lib/types";
import { SectionCard } from "@/components/ui/section-card";
import { ActivityFormBody } from "./activity-form";

/** Ny aktivitet. Every part of it is Drift's: even its preview is a POST the gateway answers by area. */
export function NewActivityCard({
  year,
  groups,
  subjects,
  people,
}: {
  year: AcademicYear;
  groups: readonly StudentGroup[];
  subjects: readonly Subject[];
  people: readonly Person[];
}) {
  const t = useTranslations("scheduleActivities");
  return (
    <SectionCard id="activity-form" title={t("formTitle")} description={t("formIntro")} data-writes="DRIFT">
      <ActivityFormBody year={year} groups={groups} subjects={subjects} people={people} idPrefix="activity-new" />
    </SectionCard>
  );
}
