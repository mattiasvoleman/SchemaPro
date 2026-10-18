"use client";

import { useId, useMemo, useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import { toast } from "sonner";
import { ArrowRight, Layers, Loader2 } from "lucide-react";
import { Link } from "@/i18n/navigation";
import { ApiError } from "@/lib/api";
import { firstFailedKey, isActiveRun, isApplicable, requestErrorKey, runErrorText } from "@/lib/candidates/labels";
import type { CandidatesOverview } from "@/lib/candidates/types";
import type { AcademicYear } from "@/lib/types";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { LoadError } from "@/components/ui/load-error";
import { NativeSelect } from "@/components/ui/native-select";
import { SectionCard } from "@/components/ui/section-card";
import { Skeleton } from "@/components/ui/skeleton";
import { useStartCandidates } from "./use-schedule-candidates";

/** 2–4 candidates (the gateway's bounds); three unless the admin says otherwise. */
const COUNTS = [2, 3, 4] as const;

/** The compare page for the year on screen: next year's needs saying, this year's is the default. */
export function candidatesHref(year: AcademicYear | null): string {
  return `/admin/generate/candidates${year && !year.isActive ? `?year=${encodeURIComponent(year.id)}` : ""}`;
}

export interface CandidatesSectionProps {
  year: AcademicYear | null;
  /** useScheduleCandidates(year), read by the page: the Generera button waits on it too. */
  overview: { data?: CandidatesOverview; isLoading: boolean; isError: boolean };
  /** The checklist above is met and answered: what Generera itself needs. */
  canStart: boolean;
  /** A Generera job of the year is running; the gateway refuses a start meanwhile (GENERATE_RUNNING). */
  generating: boolean;
  /** The page's optimisation profile: the first candidate is Generera's own request. */
  weights: Record<string, number>;
}

/**
 * Schemaförslag on /admin/generate: start a run, see how the newest one
 * stands, go to the comparison. Small and static on purpose — the
 * comparison, its håltimmar and its week view are the compare page's, which
 * has a budget of its own.
 */
export function CandidatesSection({ year, overview, canStart, generating, weights }: CandidatesSectionProps) {
  const t = useTranslations("scheduleCandidates");
  const tEngine = useTranslations("engineMessages");
  const locale = useLocale();
  const start = useStartCandidates();
  const [count, setCount] = useState<number>(3);
  const countId = useId();
  const reasonId = useId();
  const statusId = useId();

  const runDate = useMemo(
    () =>
      new Intl.DateTimeFormat(locale === "en" ? "en-GB" : "sv-SE", { dateStyle: "medium", timeStyle: "short" }),
    [locale],
  );

  const latest = overview.data?.latest ?? null;
  const active = isActiveRun(latest?.run.status);
  const hasBatch = Boolean(overview.data?.batch ?? latest);

  const run = async () => {
    if (!year) return;
    try {
      await start.mutateAsync({ academicYearId: year.id, count, weights });
      toast.success(t("section.started"));
    } catch (error) {
      toast.error(t(requestErrorKey(error instanceof ApiError ? error : null, "start")));
    }
  };

  /*
   * One reason beside the button, the first that holds: a greyed button
   * with no sentence next to it is one people click at and then call
   * support about (the generate page's own rule).
   */
  const reason = generating
    ? t("section.blockedGenerating")
    : !canStart
      ? t("section.blockedPrerequisites")
      : null;

  const status = (() => {
    if (!latest) return t("status.none");
    const { run: latestRun, candidates } = latest;
    const when = runDate.format(new Date(latestRun.finishedAt ?? latestRun.createdAt));
    switch (latestRun.status) {
      case "PENDING":
        return t("status.PENDING");
      case "RUNNING":
        return t("status.RUNNING", { done: latestRun.progress, total: latestRun.requested });
      case "CANCELLING":
        return t("status.CANCELLING");
      case "SUCCEEDED": {
        const applied = candidates.find((candidate) => candidate.id === latestRun.appliedCandidateId);
        return [
          t("status.SUCCEEDED", { count: candidates.filter(isApplicable).length, date: when }),
          applied ? t("status.applied", { ordinal: applied.ordinal }) : null,
        ]
          .filter(Boolean)
          .join(" ");
      }
      default: {
        // Nothing is listed on this page: what stopped the first candidate
        // is on the compare page, so its sentence promises nothing below.
        const why =
          latestRun.errorCode === "CANDIDATES_FIRST_FAILED"
            ? t(firstFailedKey(candidates.find((candidate) => candidate.ordinal === 1), false))
            : runErrorText(t, tEngine, latestRun);
        return `${t("status.FAILED", { date: when })} ${why}`;
      }
    }
  })();

  return (
    <SectionCard
      id="candidates"
      title={t("section.title")}
      icon={Layers}
      description={
        <>
          {t("section.description")} {t("section.retention")}
        </>
      }
      footer={
        <div className="flex w-full flex-wrap items-end justify-end gap-3">
          {reason ? (
            <p id={reasonId} className="mr-auto max-w-prose text-sm text-foreground">
              {reason}
            </p>
          ) : null}
          {/* The count belongs to the start, and goes with it for a profile that does not write SCHEMALAGGNING. */}
          <div className="space-y-1" data-writes="SCHEMALAGGNING">
            <Label htmlFor={countId}>{t("section.count")}</Label>
            <NativeSelect
              id={countId}
              className="w-24"
              value={count}
              onChange={(event) => setCount(Number(event.target.value))}
              disabled={active || start.isPending}
            >
              {COUNTS.map((option) => (
                <option key={option} value={option}>
                  {option}
                </option>
              ))}
            </NativeSelect>
          </div>
          <Button
            // POST candidates is SCHEMALAGGNING's: hidden from a profile that
            // does not write it (Läsbehörighet's läsare among them).
            data-writes="SCHEMALAGGNING"
            variant="outline"
            className="w-full sm:w-auto"
            disabled={!year || !canStart || generating || active || start.isPending}
            onClick={run}
            aria-describedby={reason ? reasonId : active ? statusId : undefined}
          >
            {start.isPending ? <Loader2 className="animate-spin" aria-hidden="true" /> : null}
            {start.isPending ? t("section.starting") : t("section.start")}
          </Button>
        </div>
      }
    >
      {overview.isLoading ? (
        <div aria-busy="true">
          <Skeleton className="h-6 w-full" />
        </div>
      ) : overview.isError && overview.data === undefined ? (
        <LoadError variant="inline" title={t("section.loadFailed")} hint={t("section.loadFailedHint")} />
      ) : (
        <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2 text-sm">
          {/* Polite, not a status role: the page's own status notices are the news. */}
          <p id={statusId} aria-live="polite" className="text-foreground">
            {active ? <Loader2 className="mr-1.5 inline size-4 animate-spin" aria-hidden="true" /> : null}
            {status}
          </p>
          {hasBatch ? (
            <Button asChild variant="outline" size="sm">
              <Link href={candidatesHref(year)}>
                {t("section.compare")}
                <ArrowRight aria-hidden="true" />
              </Link>
            </Button>
          ) : null}
        </div>
      )}
    </SectionCard>
  );
}
