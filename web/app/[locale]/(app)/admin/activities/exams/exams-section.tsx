"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import type { AcademicYear, StudentGroup, Subject } from "@/lib/types";
import { useReadOnly } from "@/components/profile-context";
import { SectionCard } from "@/components/ui/section-card";
import { ExamFormBody } from "./exam-form";
import { ExamsCard } from "./exams-card";
import { PlannerCard } from "./planner-card";
import { useExamSettings } from "./use-exams";

/**
 * What belongs to one läsår: the form for a new exam, the year's exams and the
 * planner. Keyed by the year at the page, so that neither a half-filled form,
 * the exams ticked for the next run nor a proposal read for one läsår is
 * carried over to the next. The ticks live here because two cards read them:
 * the list ticks, the planner asks for the ticked exams.
 */
export function ExamsSection({
  year,
  groups,
  subjects,
}: {
  year: AcademicYear;
  groups: readonly StudentGroup[];
  subjects: readonly Subject[];
}) {
  const t = useTranslations("exams");
  const readOnly = useReadOnly();
  const settings = useExamSettings();
  const [picked, setPicked] = useState<ReadonlySet<string>>(new Set());

  const pick = (examId: string, on: boolean) =>
    setPicked((previous) => {
      const next = new Set(previous);
      if (on) next.add(examId);
      else next.delete(examId);
      return next;
    });

  return (
    <>
      {/* A reader has no form. */}
      {readOnly ? null : (
        <SectionCard id="exam-form" title={t("formTitle")} description={t("formIntro")} data-writes="DRIFT">
          <ExamFormBody year={year} groups={groups} subjects={subjects} idPrefix="exam-new" />
        </SectionCard>
      )}
      <ExamsCard
        year={year}
        groups={groups}
        subjects={subjects}
        picked={picked}
        onPick={pick}
        canPick={settings.data?.enabled === true}
      />
      <PlannerCard year={year} picked={picked} />
    </>
  );
}
