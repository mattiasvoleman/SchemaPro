"use client";

import { useTranslations } from "next-intl";
import { formatPercent } from "@/lib/staffing-view";
import type { LoadModel, TeacherLoad } from "@/lib/teacher-load";

export interface AnnualCardProps {
  annual: TeacherLoad["annual"];
  /** Under FACTOR the teaching hours are räknad tid, and the label says so. */
  loadModel: LoadModel;
  /**
   * Where the settings live, for an admin who can change them. A teacher's own
   * page leaves it out: "skolans inställningar" without a path they cannot open.
   */
  showSettingsPath?: boolean;
  /** "h2" on a page of its own, "h3" inside the drawer's cards. */
  headingLevel?: "h2" | "h3";
}

/**
 * Årsarbetstid (staffing Fas 3): a teacher's year in hours beside the frame
 * the school has set.
 *
 * Every figure comes from GET /staffing/load's `annual`, which the gateway
 * computes from StaffingPolicy and the post — nothing here knows an
 * agreement's numbers. That is the point of the caption under every figure:
 * 1 360 reglerade timmar or 194 A-dagar are the SCHOOL'S settings (förvalda
 * efter Bilaga M), not a statement of the law, and a school with another
 * local agreement has changed them on the settings card.
 *
 *   FERIE    undervisning, uppdrag, reglerad arbetstid, årsarbetstid, övrig
 *            arbetstid (årsarbetstid − reglerad), A-dagar unscaled, and the
 *            teaching as a share of the regulated hours;
 *   SEMESTER the week the school has set for a full semestertjänst, scaled by
 *            the post — a semestertjänst has no reglerad/oreglerad split;
 *   no post  teaching and uppdrag only: every other figure is the post's.
 *
 * A-dagar are shown as the school's setting and NOT scaled by the post:
 * whether a part-time ferietjänst has fewer A-dagar is the school's call, and
 * a figure computed on a guess would be the page answering it.
 */
export function AnnualCard({
  annual,
  loadModel,
  showSettingsPath = false,
  headingLevel = "h3",
}: AnnualCardProps) {
  const t = useTranslations("staffing.annual");
  const Heading = headingLevel;
  const hours = (value: number) => t("hours", { hours: formatPercent(value) });
  const rows: { label: string; value: string }[] = [
    {
      label: loadModel === "FACTOR" ? t("teachingHoursFactor") : t("teachingHours"),
      value: hours(annual.assignedHoursPerYear),
    },
    { label: t("dutyHours"), value: hours(annual.dutyHoursPerYear) },
  ];
  if (annual.contractKind === "FERIE") {
    if (annual.regulatedHoursPerYear !== null) {
      rows.push({ label: t("regulated"), value: hours(annual.regulatedHoursPerYear) });
    }
    if (annual.annualHours !== null) {
      rows.push({ label: t("annualHours"), value: hours(annual.annualHours) });
    }
    if (annual.unregulatedHoursPerYear !== null) {
      rows.push({ label: t("unregulated"), value: hours(annual.unregulatedHoursPerYear) });
    }
    rows.push({ label: t("workDays"), value: String(annual.workDaysPerYear) });
    if (annual.percentOfRegulated !== null) {
      rows.push({
        label: loadModel === "FACTOR" ? t("percentOfRegulatedFactor") : t("percentOfRegulated"),
        value: `${formatPercent(annual.percentOfRegulated)} %`,
      });
    }
  }
  rows.push({ label: t("teachingWeeks"), value: formatPercent(annual.teachingWeeksPerYear) });

  return (
    <section className="rounded-lg border bg-card p-4 break-inside-avoid" aria-labelledby="annual-card-title">
      <Heading id="annual-card-title" className="mb-2 font-semibold">
        {t("title")}
      </Heading>
      {annual.contractKind === "SEMESTER" && annual.semesterHoursPerWeek !== null ? (
        <p className="mb-2 text-sm">
          {t("semesterWeekly", { hours: formatPercent(annual.semesterHoursPerWeek) })}
        </p>
      ) : null}
      {annual.contractKind === null ? <p className="mb-2 text-sm">{t("noPost")}</p> : null}
      <dl className="grid grid-cols-[1fr_auto] gap-x-4 gap-y-1 text-sm">
        {rows.map((row) => (
          <div key={row.label} className="contents">
            <dt>{row.label}</dt>
            <dd className="text-right tabular-nums">{row.value}</dd>
          </div>
        ))}
      </dl>
      <p className="mt-2 text-xs text-muted-foreground">
        {showSettingsPath ? t("captionAdmin") : t("caption")}
      </p>
    </section>
  );
}
