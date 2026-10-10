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

import { useMemo, useState } from "react";
import { useTranslations } from "next-intl";
import { useAcademicYears, useGroups, useRooms, useSubjects } from "@/lib/queries";
import { PageHeader } from "@/components/layout/page-header";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { BatchesCard } from "./batches-card";
import { CancellationFormCard } from "./cancellation-form-card";

export default function CancellationsPage() {
  const t = useTranslations("cancellations");
  const { data: years } = useAcademicYears();
  const { data: groups } = useGroups();
  const { data: rooms } = useRooms();
  const { data: subjects } = useSubjects();
  const [selectedYearId, setSelectedYearId] = useState<string | null>(null);
  const yearId = selectedYearId ?? years?.find((year) => year.isActive)?.id ?? years?.[0]?.id ?? null;
  const year = useMemo(() => years?.find((entry) => entry.id === yearId) ?? null, [years, yearId]);

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
      {year ? (
        <>
          {/* Keyed by the year: a form filled for one läsår is not the next one's. */}
          <CancellationFormCard key={year.id} year={year} groups={groups ?? []} subjects={subjects ?? []} />
          <BatchesCard year={year} groups={groups ?? []} rooms={rooms ?? []} />
        </>
      ) : null}
    </div>
  );
}
