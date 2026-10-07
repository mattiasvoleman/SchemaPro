"use client";

/*
 * The year choice and the förberäknade-klasslistor banner of the two planning
 * pages, /admin/generate and /admin/timetable — see lib/planning-year.ts and
 * lib/projected-rosters.ts for what they show.
 */

import { useTranslations } from "next-intl";
import { Users } from "lucide-react";
import { Link } from "@/i18n/navigation";
import type { AcademicYear, YearRosters } from "@/lib/types";
import { Button } from "@/components/ui/button";

/**
 * This year, or next year before its activation: two buttons, one pressed.
 * Nothing at all while there is no next year to plan — one option is no
 * choice, and the page's own subtitle already names the year.
 *
 * Buttons rather than a Select. There are never more than two years to plan,
 * both names fit, and Radix's Select would have put its popper and its list
 * on /admin/generate's bill (+8,7 KB measured), a page that had no dropdown.
 */
export function PlanningYearPicker({
  year,
  active,
  successor,
  onChoose,
  className,
}: {
  year: AcademicYear | null;
  active: AcademicYear | null;
  successor: AcademicYear | null;
  onChoose: (yearId: string) => void;
  /** Spacing from the page: it sits in a header's actions on one page and in a row of its own on another. */
  className?: string;
}) {
  const t = useTranslations("planningYear");
  if (!active || !successor || !year) return null;
  const option = (entry: AcademicYear, label: string) => (
    <Button
      size="sm"
      variant={entry.id === year.id ? "default" : "outline"}
      aria-pressed={entry.id === year.id}
      onClick={() => entry.id !== year.id && onChoose(entry.id)}
    >
      {label}
    </Button>
  );
  return (
    <div role="group" aria-label={t("label")} className={className ? `flex gap-1 ${className}` : "flex gap-1"}>
      {option(active, t("optionActive", { name: active.name }))}
      {option(successor, t("optionNext", { name: successor.name }))}
    </div>
  );
}

/**
 * Says that the year on screen is planned on the class lists its activation
 * will give, and what that means: how many pupils move, leave or end up
 * without a class; that the teaching groups were fixed at the rollover; that a
 * class change this year changes the lists at once; and where activation is.
 *
 * A status, not an alert — the page works, and this is how. The one alert is
 * an overlay that was asked for and never came: then the clash colours and
 * the årskurser on the page are computed as if nobody had moved, and an admin
 * must not plan on that believing otherwise.
 */
export function ProjectedRostersBanner({
  year,
  active,
  rosters,
  failed,
}: {
  year: AcademicYear | null;
  active: AcademicYear | null;
  rosters: YearRosters | null;
  failed: boolean;
}) {
  const t = useTranslations("planningYear");
  if (!year || !active) return null;
  if (failed) {
    return (
      <p
        role="alert"
        className="mb-4 rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm"
      >
        {t("rostersFailed", { year: year.name })}
      </p>
    );
  }
  if (rosters?.basis !== "PROJECTED") return null;
  const { missing, stale } = rosters.membershipsOutOfDate;
  return (
    <div
      role="status"
      className="mb-4 flex items-start gap-2 rounded-md border border-primary/30 bg-primary/5 p-3 text-sm"
    >
      <Users className="mt-0.5 size-4 shrink-0 text-primary" aria-hidden />
      <div className="space-y-1">
        <p className="font-medium">{t("bannerTitle", { year: year.name })}</p>
        <p>
          {t("bannerBody", {
            year: year.name,
            active: active.name,
            ...rosters.counts,
          })}
        </p>
        {missing + stale > 0 ? <p>{t("bannerMemberships", { missing, stale })}</p> : null}
        <p className="text-muted-foreground">{t("bannerChanges", { active: active.name })}</p>
        <Link href="/admin/years" className="underline underline-offset-4">
          {t("bannerLink", { active: active.name })}
        </Link>
      </div>
    </div>
  );
}
