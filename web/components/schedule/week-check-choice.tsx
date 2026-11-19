"use client";

import { Loader2, UsersRound } from "lucide-react";
import { useEffect } from "react";
import { useLocale, useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import { Notice } from "@/components/ui/notice";
import { Skeleton } from "@/components/ui/skeleton";
import { periodDay } from "@/lib/period-note";
import {
  useWeekCheckChoice,
  type ChoiceCount,
  type ChoicePeriod,
  type ChoiceWhatIf,
  type ChoiceYear,
  type WeekCheckChoiceOutcome,
  type WeekCheckChoiceView,
} from "@/lib/week-check-choice";
import type { WeekCheckResult } from "@/lib/week-check";

/*
 * Kontrollera veckan, med lärarval: under the check's answer on a tight or
 * impossible week, "what would the week be if teachers could be chosen?".
 *
 * ASKED FOR BY A BUTTON, not with the check. It is up to twelve checks of the
 * engine in a row (about half a minute), and Generera's own question before a
 * run ("Åk 9 är 95 % full. Kör ändå?") must not wait for it.
 *
 * WHAT IT SAYS, AND WHAT IT CANNOT. The floor is what no choice of teachers can
 * beat: above 100 % it is decisive, no choice helps; below it, a choice MIGHT
 * help, and never "it fits". A figure the engine's seconds cut is "minst" and
 * ranks nobody. The what-ifs name subjects and years and never a person, and
 * their split is one example, not the best.
 *
 * Imported only by the panel, which a page loads when somebody has asked for the
 * check (components/schedule/week-check.tsx), so none of it is in a route's chunk.
 */

export interface WeekCheckChoiceProps {
  academicYearId: string;
  /** The check this belongs to: asking again for another week or another year drops the old answer. */
  result: WeekCheckResult;
  /** The engine's sentence for a code, in the reader's language (the panel's own lookup). */
  engineText: (sentence: { code: string | null; message: string; params: Record<string, string | number> | null }) => string;
}

export function WeekCheckChoice({ academicYearId, result, engineText }: WeekCheckChoiceProps) {
  const t = useTranslations("weekCheckChoice");
  const choice = useWeekCheckChoice();
  const { reset } = choice;
  // A new check of the week (or of another year) is a new question: the answer to the last is not its answer.
  useEffect(() => reset(), [result, academicYearId, reset]);

  return (
    // A group, not a region: it sits inside the panel's own section, and a second landmark for it is one more stop for no gain.
    <div role="group" aria-labelledby="week-check-choice-title" className="space-y-2 border-t pt-3">
      <h3 id="week-check-choice-title" className="text-sm font-semibold">
        {t("title")}
      </h3>
      {!choice.outcome ? <p className="max-w-prose text-sm text-muted-foreground">{t("hint")}</p> : null}
      <Button
        variant="outline"
        size="sm"
        disabled={choice.isPending}
        aria-busy={choice.isPending}
        onClick={() => choice.ask(academicYearId)}
      >
        {choice.isPending ? <Loader2 className="animate-spin" /> : <UsersRound />}
        {choice.isPending ? t("asking") : choice.outcome ? t("again") : t("button")}
      </Button>
      {choice.isPending ? <Skeleton className="h-16 w-full" /> : null}
      {choice.outcome && !choice.isPending ? <ChoiceOutcome outcome={choice.outcome} engineText={engineText} /> : null}
    </div>
  );
}

type EngineText = WeekCheckChoiceProps["engineText"];

function ChoiceOutcome({ outcome, engineText }: { outcome: WeekCheckChoiceOutcome; engineText: EngineText }) {
  const t = useTranslations("weekCheckChoice");
  if (outcome.kind === "unavailable") {
    return <Notice role="status">{t(`unavailable.${outcome.reason}`)}</Notice>;
  }
  const view = outcome.view;
  if (view.status !== "DONE") return <Notice role="status">{t(`status.${view.status}`)}</Notice>;
  return <Answer view={view} engineText={engineText} />;
}

/** A count in words a reader has: short for a line of "from → to", long for a sentence of its own. */
function useCountText() {
  const t = useTranslations("weekCheckChoice");
  return (count: ChoiceCount, form: "short" | "long"): string => {
    switch (count.kind) {
      case "LOAD":
        return count.over
          ? t(`count.${form}.over`, {
              percent: count.percent,
              demandMinutes: count.demandMinutes,
              capacityMinutes: count.capacityMinutes,
            })
          : t(`count.${form}.load`, { percent: count.percent, atLeast: count.atLeast ? "yes" : "no" });
      case "UNDER":
        return t(`count.${form}.under`, { below: count.below });
      case "UNKNOWN":
        return t(`count.${form}.unknown`);
      case "REFUSED":
        return t(`count.${form}.refused`);
    }
  };
}

function Answer({ view, engineText }: { view: WeekCheckChoiceView; engineText: EngineText }) {
  const t = useTranslations("weekCheckChoice");
  const nobodyToRelease = view.qualificationsRecorded && view.releasedPosts === 0;
  return (
    <div className="space-y-4" role="status">
      {!view.qualificationsRecorded ? (
        <p className="max-w-prose text-sm">{t("floor.noQualifications")}</p>
      ) : nobodyToRelease ? (
        <p className="max-w-prose text-sm">{t("floor.nothingToRelease")}</p>
      ) : null}
      {view.years.map((year) => (
        <YearBlock key={year.year} year={year} engineText={engineText} />
      ))}
      <div className="space-y-1">
        <p className="max-w-prose text-xs text-muted-foreground">{t("limits")}</p>
        {view.notRun > 0 ? <p className="max-w-prose text-xs text-muted-foreground">{t("notRun", { count: view.notRun })}</p> : null}
      </div>
    </div>
  );
}

function PeriodLine({ period }: { period: ChoicePeriod | null }) {
  const t = useTranslations("weekCheckChoice");
  const locale = useLocale();
  if (!period) return null;
  return (
    <span className="block text-xs text-muted-foreground">
      {t("period", {
        from: periodDay(period.from, locale),
        to: periodDay(period.to, locale),
        more: period.more ? "yes" : "no",
      })}
    </span>
  );
}

const periodOf = (count: ChoiceCount): ChoicePeriod | null => (count.kind === "LOAD" ? count.period : null);

function YearBlock({ year, engineText }: { year: ChoiceYear; engineText: EngineText }) {
  const t = useTranslations("weekCheckChoice");
  const countText = useCountText();
  const headingId = `week-check-choice-year-${year.year}`;
  return (
    <div className="space-y-2" role="group" aria-labelledby={headingId}>
      <h4 id={headingId} className="text-sm font-medium">
        {t("year", { year: year.year })}
      </h4>
      <p className="max-w-prose text-sm">
        {t("today", { figure: countText(year.today, "long") })}
        <PeriodLine period={periodOf(year.today)} />
      </p>
      {year.floor ? <Floor year={year.year} count={year.floor} engineText={engineText} /> : null}
      {year.whatIf.length > 0 ? <WhatIfList year={year} /> : null}
    </div>
  );
}

/** The floor: what no choice of teachers can beat. Decisive above 100 %; below it a choice might help, and never "it fits". */
function Floor({ year, count, engineText }: { year: number; count: ChoiceCount; engineText: EngineText }) {
  const t = useTranslations("weekCheckChoice");
  const atLeast = count.kind === "LOAD" && count.atLeast;
  const decisive = count.kind === "LOAD" && count.over;
  return (
    <div className="space-y-1">
      <p className="max-w-prose text-sm">
        {count.kind === "LOAD" && count.over
          ? t("floor.over", { year, demandMinutes: count.demandMinutes, capacityMinutes: count.capacityMinutes })
          : count.kind === "LOAD"
            ? t("floor.load", { year, percent: count.percent })
            : count.kind === "UNDER"
              ? t("floor.under", { year, below: count.below })
              : count.kind === "UNKNOWN"
                ? t("floor.unknown", { year })
                : t("floor.refused")}
        <PeriodLine period={periodOf(count)} />
      </p>
      {count.kind === "REFUSED" ? (
        <p className="max-w-prose text-sm text-muted-foreground">{engineText({ code: count.code, message: "", params: count.params })}</p>
      ) : null}
      {atLeast ? <p className="max-w-prose text-sm text-muted-foreground">{t("floor.cut")}</p> : null}
      {count.kind === "UNKNOWN" || count.kind === "REFUSED" ? null : (
        <p className="max-w-prose text-sm font-medium">{decisive ? t("floor.overBody") : t("floor.mayHelp")}</p>
      )}
    </div>
  );
}

function WhatIfList({ year }: { year: ChoiceYear }) {
  const t = useTranslations("weekCheckChoice");
  const countText = useCountText();
  const today = countText(year.today, "short");
  return (
    <div className="space-y-1">
      <p className="text-sm font-medium">{t("whatIf.title")}</p>
      <ol className="space-y-1.5 text-sm">
        {year.whatIf.map((item) => (
          <WhatIfItem key={item.subject} item={item} today={today} />
        ))}
      </ol>
    </div>
  );
}

function WhatIfItem({ item, today }: { item: ChoiceWhatIf; today: string }) {
  const t = useTranslations("weekCheckChoice");
  const countText = useCountText();
  return (
    <li>
      <span className="font-medium">{t("whatIf.line", { subject: item.subject, from: today, to: countText(item.count, "short") })}</span>
      <span className="block text-xs text-muted-foreground">
        {t("whatIf.detail", { qualified: item.qualified, moved: item.moved, of: item.of })}
        {item.count.kind === "LOAD" && item.count.over ? ` ${t("whatIf.stillOver")}` : ""}
        {item.ranked ? "" : ` ${t("whatIf.unranked")}`}
      </span>
      <PeriodLine period={periodOf(item.count)} />
    </li>
  );
}
