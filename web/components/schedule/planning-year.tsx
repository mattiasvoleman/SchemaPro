"use client";

/*
 * The year choice and the förberäknade-klasslistor banner of the two planning
 * pages, /admin/generate and /admin/timetable — see lib/planning-year.ts and
 * lib/projected-rosters.ts for what they show.
 */

import { useTranslations } from "next-intl";
import { Link } from "@/i18n/navigation";
import type { AcademicYear, YearRosters } from "@/lib/types";
import { Button } from "@/components/ui/button";
import { Notice } from "@/components/ui/notice";

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
  /** Extra classes on the group; the page's own rhythm spaces it (both pages put it in the header's actions). */
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
    return <Notice tone="destructive">{t("rostersFailed", { year: year.name })}</Notice>;
  }
  if (rosters?.basis !== "PROJECTED") return null;
  const { missing, stale } = rosters.membershipsOutOfDate;
  return (
    <Notice title={t("bannerTitle", { year: year.name })}>
      <div className="space-y-1">
        <p>
          {t("bannerBody", {
            year: year.name,
            active: active.name,
            ...rosters.counts,
          })}
        </p>
        {missing + stale > 0 ? <p>{t("bannerMemberships", { missing, stale })}</p> : null}
        <p>{t("bannerChanges", { active: active.name })}</p>
        <Link href="/admin/years" className="underline underline-offset-4">
          {t("bannerLink", { active: active.name })}
        </Link>
      </div>
    </Notice>
  );
}
