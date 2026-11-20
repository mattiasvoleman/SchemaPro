"use client";

import { useEffect, useRef, useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import { Notice } from "@/components/ui/notice";
import { Skeleton } from "@/components/ui/skeleton";
import { engineMessage, type MessageLookup } from "@/lib/engine-message";
import { periodDay } from "@/lib/period-note";
import {
  changesKey,
  useStaffingWeek,
  type ChoiceCount,
  type ChoicePeriod,
  type StaffingWeekChange,
  type StaffingWeekOutcome,
  type StaffingWeekView,
  type StaffingWeekYear,
} from "@/lib/staffing-week";

/*
 * Föreslå bemanning: the week before and after the proposal, under the teachers' figures.
 *
 * ADVICE, NOT A GATE. It is asked when the proposal appears and again, a moment after the admin stops changing what
 * is selected; the dialog is usable throughout, and a figure that could not be made says so and says that the
 * proposal can be applied all the same. Nothing here refuses anything.
 *
 * WHAT IT SAYS, AND WHAT IT CANNOT. The gateway says how each year after stands to the year before (`verdict`), and
 * this draws it. A week is "tighter" or "lighter" only where the engine can prove it: two figures over the supply
 * are only the first period the engine refused each, a count its seconds cut is "at least", and neither is ever
 * set against another. The figures name years and the dates of a period, never a person.
 *
 * React.lazy from the dialog, which is itself lazy from the page: none of it is in the staffing page's chunk.
 */

/** How long the selection must stand still before it is asked about: a click on every row is one question, not nine. */
export const STAFFING_WEEK_SETTLE_MS = 700;

export interface StaffingWeekProps {
  academicYearId: string;
  /** Which proposal this is: a new one, even with the same basis, is asked about afresh (useStaffingWeek). */
  serial: number;
  /** The basis the proposal returned. */
  basisSha256: string;
  /** The selected part of the proposal. */
  changes: StaffingWeekChange[];
  /**
   * The basis an apply should carry: the proposal's and the week's together, when a figure for the selection on the
   * screen has been shown; null while one is being counted and when none could be made. Not reset when the panel goes
   * (the second confirmation takes its place and the figure stands); the dialog resets it with the proposal.
   */
  onBasis: (basis: string | null) => void;
}

export function StaffingWeek({ academicYearId, serial, basisSha256, changes, onBasis }: StaffingWeekProps) {
  const t = useTranslations("staffing.proposal.week");
  const key = changesKey(changes);
  const latest = useRef(changes);
  latest.current = changes;
  // The selection the question was last asked for, and the one on the screen: they differ for a moment after a click.
  const [settled, setSettled] = useState({ key, changes });
  useEffect(() => {
    if (key === settled.key) return;
    const timer = setTimeout(() => setSettled({ key, changes: latest.current }), STAFFING_WEEK_SETTLE_MS);
    return () => clearTimeout(timer);
  }, [key, settled.key]);

  const week = useStaffingWeek(
    settled.changes.length > 0 ? { academicYearId, basisSha256, changes: settled.changes } : null,
    serial,
  );
  const settling = key !== settled.key;
  const waiting = settled.changes.length > 0 && (settling || week.isPending);

  // The digest the apply carries: only the figure of the selection that is on the screen, and only a figure that was made.
  const outcome = week.outcome;
  const basis =
    !settling && outcome?.kind === "result" && outcome.view.status === "DONE" ? outcome.view.basisSha256 : null;
  useEffect(() => {
    onBasis(basis);
  }, [basis, onBasis]);

  return (
    <section aria-labelledby="proposal-week-title" aria-busy={waiting} className="space-y-2 border-t pt-3">
      <h3 id="proposal-week-title" className="text-sm font-semibold">
        {t("title")}
      </h3>
      {changes.length === 0 ? (
        <p className="max-w-prose text-sm text-muted-foreground">{t("noSelection")}</p>
      ) : waiting ? (
        <div role="status" className="space-y-2">
          <p className="text-sm text-muted-foreground">{t(outcome ? "updating" : "asking")}</p>
          <Skeleton className="h-12 w-full" />
        </div>
      ) : outcome ? (
        <Outcome outcome={outcome} />
      ) : null}
    </section>
  );
}

function Outcome({ outcome }: { outcome: StaffingWeekOutcome }) {
  const t = useTranslations("staffing.proposal.week");
  if (outcome.kind === "unavailable") return <Notice role="status">{t(`unavailable.${outcome.reason}`)}</Notice>;
  const view = outcome.view;
  if (view.status !== "DONE") {
    return <Notice role="status">{t(`notChecked.${view.reason ?? "ENGINE_ERROR"}`)}</Notice>;
  }
  return <Answer view={view} />;
}

/** The verdicts that say a year is no heavier after: nothing else is said to be an improvement. */
const NOT_TIGHTER = new Set(["LOOSER", "SAME"]);

function Answer({ view }: { view: StaffingWeekView }) {
  const t = useTranslations("staffing.proposal.week");
  const allNotTighter = view.years.length > 0 && view.years.every((year) => NOT_TIGHTER.has(year.verdict));
  return (
    <div className="space-y-3">
      {view.worse ? (
        <Notice tone="warning" role="status" title={t("worseTitle")}>
          {t("worseBody")}
        </Notice>
      ) : view.years.length === 0 ? (
        <p role="status" className="max-w-prose text-sm">
          {t("noYears")}
        </p>
      ) : allNotTighter ? (
        <p role="status" className="max-w-prose text-sm">
          {t("notWorse")}
        </p>
      ) : null}
      {view.years.map((year) => (
        <YearBlock key={year.year} year={year} />
      ))}
      <div className="space-y-1">
        {view.overlay.fromNobody > 0 ? (
          <p className="max-w-prose text-xs text-muted-foreground">{t("overlay.fromNobody", { count: view.overlay.fromNobody })}</p>
        ) : null}
        {view.overlay.newToTheWeek > 0 ? (
          <p className="max-w-prose text-xs text-muted-foreground">
            {t("overlay.newToTheWeek", { count: view.overlay.newToTheWeek })}
          </p>
        ) : null}
        {view.overlay.notLaidOver > 0 ? (
          <p className="max-w-prose text-xs text-muted-foreground">{t("overlay.notLaidOver", { count: view.overlay.notLaidOver })}</p>
        ) : null}
        <p className="max-w-prose text-xs text-muted-foreground">{t("limits")}</p>
      </div>
    </div>
  );
}

/** A count in words a reader has: "minst 114 %" for a figure that is a lower bound, "under 85 %" for a year the engine gave no row. */
function useCountText() {
  const t = useTranslations("staffing.proposal.week");
  return (count: ChoiceCount): string => {
    switch (count.kind) {
      case "LOAD":
        return count.over
          ? t("count.over", { percent: count.percent })
          : t("count.load", { percent: count.percent, atLeast: count.atLeast ? "yes" : "no" });
      case "UNDER":
        return t("count.under", { below: count.below });
      case "UNKNOWN":
        return t("count.unknown");
      case "REFUSED":
        return t("count.refused");
    }
  };
}

const periodOf = (count: ChoiceCount): ChoicePeriod | null => (count.kind === "LOAD" ? count.period : null);

function PeriodLine({ when, period }: { when: "before" | "after"; period: ChoicePeriod | null }) {
  const t = useTranslations("staffing.proposal.week");
  const locale = useLocale();
  if (!period) return null;
  return (
    <span className="block text-xs text-muted-foreground">
      {t("period", {
        when,
        from: periodDay(period.from, locale),
        to: periodDay(period.to, locale),
        more: period.more ? "yes" : "no",
      })}
    </span>
  );
}

function YearBlock({ year }: { year: StaffingWeekYear }) {
  const t = useTranslations("staffing.proposal.week");
  const tEngine = useTranslations("engineMessages") as unknown as MessageLookup;
  const countText = useCountText();
  const headingId = `proposal-week-year-${year.year}`;
  const line = t(`line.${year.verdict}`, { before: countText(year.before), after: countText(year.after) });
  const refusal = year.after.kind === "REFUSED" ? year.after : null;
  return (
    <div className="space-y-1" role="group" aria-labelledby={headingId}>
      <h4 id={headingId} className="text-sm font-medium">
        {t("year", { year: year.year })}
      </h4>
      {/* Tighter is said in words, never by colour alone, and never as an improvement. */}
      <p className="max-w-prose text-sm" data-verdict={year.verdict}>
        {line}
      </p>
      {refusal ? (
        <p className="max-w-prose text-sm text-muted-foreground">
          {engineMessage(tEngine, { code: refusal.code, message: "", params: refusal.params })}
        </p>
      ) : null}
      {year.verdict === "STILL_OVER" || year.verdict === "NOT_COMPARED" ? (
        <p className="max-w-prose text-xs text-muted-foreground">{t(`note.${year.verdict}`)}</p>
      ) : null}
      <PeriodLine when="before" period={periodOf(year.before)} />
      <PeriodLine when="after" period={periodOf(year.after)} />
    </div>
  );
}
