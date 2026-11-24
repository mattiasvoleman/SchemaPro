"use client";

import { AlertTriangle, CheckCircle2 } from "lucide-react";
import { useTranslations } from "next-intl";
import { LunchLocksNote, PeriodNote } from "@/components/schedule/period-note";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Notice } from "@/components/ui/notice";
import { SectionCard } from "@/components/ui/section-card";
import { Skeleton } from "@/components/ui/skeleton";
import { WeekCheckChoice } from "@/components/schedule/week-check-choice";
import { engineMessage, type MessageLookup } from "@/lib/engine-message";
import type { WeekCheckOutcome, WeekCheckResult, WeekCheckYear } from "@/lib/week-check";

/*
 * Kontrollera veckan, drawn: the answer under the prerequisites, and the
 * question before a run ("Åk 7 är 94 % full. Kör ändå?"). Behind a lazy import
 * on the pages that carry it — a route near its bundle budget pays for the
 * button and its state, and for this (and, on Förlägg i veckan, for the request
 * in lib/week-check.ts) only when somebody asks.
 *
 * The rows are the ones a refused run shows (Notice + category badge + the
 * engine catalogue's sentence), so a school reads the same sentence before a
 * run as after one.
 */

const grades = (year: number | null) => (year === null ? "any" : String(year));

/** The week load's seconds ran out: a year with no row was not counted, and a year with one may be higher than its figure says. */
const weekLoadCut = (result: WeekCheckResult): boolean => result.skipped.includes("WEEK_LOAD_DEADLINE");

/** Said under the year lines wherever they are drawn (the answer, and the question before a run) when the count did not finish. */
function AtLeastNote() {
  const t = useTranslations("weekCheck");
  return <p className="max-w-prose text-sm text-muted-foreground">{t("atLeast")}</p>;
}

export interface WeekCheckPanelProps {
  /** The last check's outcome; null before one has been asked for. */
  outcome: WeekCheckOutcome | null;
  /** A check is on its way. */
  pending: boolean;
  /**
   * The run was asked for on a week the check warned about: the dialog is open. Absent on a page with no run to ask
   * before (Förlägg i veckan), which then draws the answer alone.
   */
  asking?: boolean;
  onRunAnyway?: () => void;
  onCancelRun?: () => void;
}

export function WeekCheckPanel({ outcome, pending, asking = false, onRunAnyway, onCancelRun }: WeekCheckPanelProps) {
  const t = useTranslations("weekCheck");
  if (!pending && !outcome) return null;
  return (
    <>
      <SectionCard id="week-check" title={t("title")} description={t("hint")} aria-busy={pending}>
        {pending ? (
          <div role="status">
            <p className="sr-only">{t("checking")}</p>
            <Skeleton className="h-16 w-full" />
          </div>
        ) : outcome ? (
          <Outcome outcome={outcome} />
        ) : null}
      </SectionCard>
      {onRunAnyway && onCancelRun ? (
        <AskBeforeRun
          open={asking && !pending && outcome !== null}
          outcome={outcome}
          onRunAnyway={onRunAnyway}
          onCancel={onCancelRun}
        />
      ) : null}
    </>
  );
}

/** The year lines: "Åk 9 ligger på 97 % av ramtiden." and, for a year the bound puts above it, what it needs. */
function YearLines({ years }: { years: WeekCheckYear[] }) {
  const t = useTranslations("weekCheck");
  if (years.length === 0) return null;
  return (
    <ul className="space-y-0.5 text-sm">
      {years.map((year) => (
        <li key={year.year ?? "any"}>
          {year.over
            ? t("yearOver", {
                grades: grades(year.year),
                demandMinutes: year.demandMinutes,
                capacityMinutes: year.capacityMinutes,
              })
            : t("yearTight", { grades: grades(year.year), percent: year.percent })}
        </li>
      ))}
    </ul>
  );
}

function Outcome({ outcome }: { outcome: WeekCheckOutcome }) {
  const t = useTranslations("weekCheck");
  const tEngine = useTranslations("engineMessages");
  const engineText = (sentence: Parameters<typeof engineMessage>[1]) =>
    engineMessage(tEngine as unknown as MessageLookup, sentence);

  if (outcome.kind === "unavailable") {
    return (
      <Notice role="status">
        {outcome.reason === "ENGINE_OLDER" ? t("unavailableOlder") : t("unavailable")}
      </Notice>
    );
  }
  if (outcome.kind === "refused") {
    return (
      <div className="space-y-2" role="status">
        <p className="flex items-center gap-2 font-medium">
          <AlertTriangle className="size-4 shrink-0 text-warning-strong" aria-hidden="true" />
          {t("refusedTitle")}
        </p>
        <p className="max-w-prose text-sm">
          {engineText({ code: outcome.code, message: outcome.message, params: outcome.params })}
        </p>
        <PeriodNote params={outcome.params} />
        <LunchLocksNote params={outcome.params} />
      </div>
    );
  }
  return <Result result={outcome.result} academicYearId={outcome.academicYearId} engineText={engineText} />;
}

function Result({
  result,
  academicYearId,
  engineText,
}: {
  result: WeekCheckResult;
  academicYearId?: string;
  engineText: (sentence: Parameters<typeof engineMessage>[1]) => string;
}) {
  const t = useTranslations("weekCheck");
  const tConflicts = useTranslations("conflictCategories");
  const conflictLabel = (category: string): string =>
    tConflicts.has(category as never) ? tConflicts(category as never) : category;
  const ok = result.verdict === "OK";
  // The week load's seconds ran out: a year with no row was not counted, and a year with one may be higher than it
  // says. An OK is then "nothing found so far", and is not drawn as the green all-clear.
  const cut = weekLoadCut(result);
  const clear = ok && !cut;
  const summary = result.conflicts?.summaryCode || result.conflicts?.summary ? result.conflicts : null;

  return (
    <div className="space-y-3">
      <div className="space-y-1.5" role="status">
        <p className="flex items-center gap-2 font-medium">
          {clear ? (
            <CheckCircle2 className="size-4 shrink-0 text-success-strong" aria-hidden="true" />
          ) : (
            <AlertTriangle className="size-4 shrink-0 text-warning-strong" aria-hidden="true" />
          )}
          {ok && cut ? t("okCutTitle") : t(`verdict.${result.verdict}`)}
        </p>
        <YearLines years={result.years} />
        {cut && result.years.length > 0 ? <AtLeastNote /> : null}
        <p className="max-w-prose text-sm text-muted-foreground">
          {ok ? (cut ? t("okCutBody") : t("okBody")) : result.verdict === "TIGHT" ? t("tightBody") : t("impossibleBody")}
        </p>
      </div>

      {summary ? (
        <div className="space-y-1">
          <p className="max-w-prose text-sm text-muted-foreground">
            {engineText({ code: summary.summaryCode, message: summary.summary, params: summary.summaryParams })}
          </p>
          <PeriodNote params={summary.summaryParams} />
        </div>
      ) : null}

      {result.conflicts && result.conflicts.conflicts.length > 0 ? (
        <ul className="space-y-2">
          {result.conflicts.conflicts.map((conflict, index) => (
            <li key={index}>
              {/* role null: the headline above is the live region, and this list is its detail. */}
              <Notice tone="warning" role={null}>
                <div className="space-y-1">
                  <Badge variant="warning">{conflictLabel(conflict.category)}</Badge>
                  <p>{engineText(conflict)}</p>
                  <LunchLocksNote params={conflict.params} />
                  {conflict.resourceNames && conflict.resourceNames.length > 0 ? (
                    <p className="font-medium">{conflict.resourceNames.join(", ")}</p>
                  ) : null}
                </div>
              </Notice>
            </li>
          ))}
        </ul>
      ) : null}

      {/* What the week would be if teachers could be chosen: only for a year the check counted tight, by a button. */}
      {academicYearId && result.checkedBy === "ENGINE" && result.verdict !== "OK" && result.years.some((year) => year.year !== null) ? (
        <WeekCheckChoice academicYearId={academicYearId} result={result} engineText={engineText} />
      ) : null}

      {result.skipped.length > 0 ? (
        <div className="space-y-1">
          <p className="text-sm font-medium">{t("notRun")}</p>
          <ul className="list-disc space-y-0.5 pl-5 text-sm text-muted-foreground">
            {result.skipped.map((skipped) => (
              <li key={skipped}>{t(`skipped.${skipped}`)}</li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}

/** "Åk 7 är 94 % full. Kör ändå?": asked when Generera is pressed on a week the check warned about. */
function AskBeforeRun({
  open,
  outcome,
  onRunAnyway,
  onCancel,
}: {
  open: boolean;
  outcome: WeekCheckOutcome | null;
  onRunAnyway: () => void;
  onCancel: () => void;
}) {
  const t = useTranslations("weekCheck");
  const tCommon = useTranslations("common");
  if (!outcome) return null;

  let title: string;
  let body: string;
  let years: WeekCheckYear[] = [];
  const cut = outcome.kind === "result" && weekLoadCut(outcome.result);
  if (outcome.kind === "result" && outcome.result.verdict === "TIGHT") {
    const heaviest = outcome.result.years[0];
    title = heaviest
      ? t("ask.titleTight", { grades: grades(heaviest.year), percent: heaviest.percent })
      : t("ask.titleTightPlain");
    body = t("ask.bodyTight");
    years = outcome.result.years;
  } else if (outcome.kind === "result" && outcome.result.verdict === "IMPOSSIBLE") {
    title = t("ask.titleImpossible");
    body = t("ask.bodyImpossible");
    years = outcome.result.years;
  } else {
    title = t("ask.titleRefused");
    body = t("ask.bodyImpossible");
  }

  return (
    <Dialog open={open} onOpenChange={(next) => (next ? undefined : onCancel())}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{body}</DialogDescription>
        </DialogHeader>
        <YearLines years={years} />
        {cut && years.length > 0 ? <AtLeastNote /> : null}
        <DialogFooter>
          <Button variant="outline" onClick={onCancel}>
            {tCommon("cancel")}
          </Button>
          <Button onClick={onRunAnyway}>{t("ask.confirm")}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
