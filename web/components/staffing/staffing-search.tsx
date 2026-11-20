"use client";

import { useEffect, useId, useMemo, useRef, useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import { Loader2 } from "lucide-react";
import type { StaffingProposal } from "@/app/[locale]/(app)/admin/staffing/use-staffing-proposal";
import { Button } from "@/components/ui/button";
import { DialogFooter } from "@/components/ui/dialog";
import { Notice } from "@/components/ui/notice";
import { Skeleton } from "@/components/ui/skeleton";
import { engineMessage, type MessageLookup } from "@/lib/engine-message";
import {
  classifyProposalError,
  classifyStartError,
  endedKey,
  failedKey,
  isActiveSearch,
  splitDuration,
  useCancelStaffingSearch,
  useLatestStaffingSearch,
  useStaffingSearchProposal,
  useStartStaffingSearch,
  yearLines,
  type ProposalProblem,
  type StartProblem,
  type StaffingSearchView,
  type YearLine,
} from "@/lib/staffing-search";

/*
 * Föreslå bemanning: the search for the choice of teachers that eases the week (lärarval F3), as a panel of the proposal
 * dialog. The gateway runs it as a job (minutes, in the background), so this starts it, reads it every few seconds while it
 * goes on, can stop it, and when it has ended reads the proposal it gave and HANDS IT TO THE DIALOG as the dialog's own: an
 * ordinary proposal, shown, selected, asked about for the week before and after, and applied by the dialog's code and by
 * nothing here. The panel writes nothing of the school and names nobody: the proposal's teachers are named by the dialog.
 *
 * WHAT IT SAYS, AND WHAT IT CANNOT. Every figure is the engine's lower bound on a year's tightest week, counted without the
 * teachers' lessons in other years and without the posts nobody leads. It shows that a week can be eased, never that a
 * timetable exists, and says so beside the figures, as a sentence and never as a tooltip.
 *
 * THE LIVE REGION IS ONE SHORT SENTENCE (what state the search is in). The figures move every few seconds and are
 * read by whoever goes to them; a region that held the panel would speak at every poll. The long wording of how a
 * search ended is plain text under it.
 *
 * React.lazy from the dialog, which is itself lazy from the page: it loads when the admin opens it and none of it is in the
 * staffing page's chunk.
 */

export interface StaffingSearchProps {
  academicYearId: string;
  /** The posts the admin asked the dialog to keep as they are: the search leaves them be. */
  pinnedRequirementIds?: readonly string[];
  /** The proposal the search gave, read from the gateway once the run has ended: the dialog takes it as its own. */
  onProposal: (proposal: StaffingProposal) => void;
  /** Back to what the dialog showed before the panel. The search goes on at the gateway. */
  onBack: () => void;
}

type Phase = "loading" | "failedToLoad" | "start" | "active" | "cancelling" | "ended";

function phaseOf(query: ReturnType<typeof useLatestStaffingSearch>): Phase {
  const view = query.data;
  if (view === undefined) return query.isError ? "failedToLoad" : "loading";
  if (view === null) return "start";
  if (view.status === "CANCELLING") return "cancelling";
  return isActiveSearch(view.status) ? "active" : "ended";
}

export function StaffingSearch({ academicYearId, pinnedRequirementIds = [], onProposal, onBack }: StaffingSearchProps) {
  const t = useTranslations("staffing.search");
  const tCommon = useTranslations("common");
  const locale = useLocale();
  const latest = useLatestStaffingSearch(academicYearId);
  const start = useStartStaffingSearch();
  const cancel = useCancelStaffingSearch();
  const read = useStaffingSearchProposal();
  const [startProblem, setStartProblem] = useState<StartProblem | null>(null);
  const [proposalProblem, setProposalProblem] = useState<ProposalProblem | null>(null);
  const root = useRef<HTMLElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const ids = useId();

  const view = latest.data ?? null;
  const phase = phaseOf(latest);

  /*
   * Focus. The panel opens on its heading: the button that opened it is gone with the step. And when the control that was
   * pressed goes (Sök lärarval turns into the running search, Avbryt sökningen into its own sentence), focus is put on the
   * heading rather than left to fall to the page — but only then: a run that ends while the admin is on Tillbaka does not
   * take focus from it.
   */
  const shownPhase = useRef<Phase | null>(null);
  useEffect(() => {
    const first = shownPhase.current === null;
    const changed = shownPhase.current !== phase;
    shownPhase.current = phase;
    if (first) {
      heading.current?.focus();
      return;
    }
    if (!changed) return;
    const active = document.activeElement;
    const lost =
      !active || active === document.body || (active instanceof HTMLElement && active.getAttribute("role") === "dialog");
    if (lost) heading.current?.focus();
  }, [phase]);

  const percent = useMemo(() => new Intl.NumberFormat(locale, { minimumFractionDigits: 1, maximumFractionDigits: 1 }), [locale]);
  const duration = (ms: number): string => {
    const { minutes, seconds } = splitDuration(ms);
    return minutes === 0
      ? t("duration.seconds", { seconds })
      : seconds === 0
        ? t("duration.minutes", { minutes })
        : t("duration.both", { minutes, seconds });
  };

  const begin = async () => {
    setStartProblem(null);
    setProposalProblem(null);
    try {
      await start.mutateAsync({
        academicYearId,
        ...(pinnedRequirementIds.length > 0 ? { pinnedRequirementIds: [...pinnedRequirementIds] } : {}),
      });
    } catch (error) {
      setStartProblem(classifyStartError(error));
    }
  };

  const showProposal = async () => {
    if (!view) return;
    setProposalProblem(null);
    try {
      const answer = await read.mutateAsync(view.id);
      onProposal(answer.proposal);
    } catch (error) {
      const problem = classifyProposalError(error);
      setProposalProblem(problem);
      // A run that was still going, or is gone: what the panel shows is read again.
      if (problem.kind === "NOT_DONE" || problem.kind === "GONE") void latest.refetch();
    }
  };

  const stop = () => {
    if (view) cancel.mutate(view.id);
  };

  const starting = start.isPending;
  const lines = yearLines(view?.figures ?? null);
  // A proposal the gateway has said it will not give (gone old, nothing to give, the run gone) is not asked for again: only a new search helps.
  const blocked = proposalProblem?.kind === "STALE" || proposalProblem?.kind === "GONE" || proposalProblem?.kind === "NO_PROPOSAL";
  const hasProposal = view?.hasProposal === true && !blocked;

  // "A search is already running" is about the search shown; once it has ended it is no longer true.
  const startNotice =
    startProblem && !(startProblem.kind === "ALREADY_RUNNING" && phase === "ended") ? <StartNotice problem={startProblem} /> : null;
  const proposalNotice = proposalProblem ? (
    <Notice tone="warning" role="alert">
      {t(`proposalProblem.${proposalProblem.kind}`, proposalValues(proposalProblem, tCommon("error")))}
    </Notice>
  ) : null;

  return (
    <section ref={root} aria-labelledby={`${ids}-title`} aria-busy={phase === "loading"} className="space-y-4">
      <h3 id={`${ids}-title`} ref={heading} tabIndex={-1} className="text-base font-semibold focus:outline-none">
        {t("title")}
      </h3>
      {/* The one live region: how the search stands, in one short sentence. Mounted empty so that its first sentence is announced. */}
      <p role="status" className="text-sm font-medium empty:hidden">
        {view && phase !== "start" ? t(`status.${view.status}`) : null}
      </p>

      {phase === "loading" ? <Skeleton className="h-16 w-full" /> : null}

      {phase === "failedToLoad" ? (
        <Notice tone="warning" role="alert" action={<RetryButton onClick={() => void latest.refetch()} />}>
          {t("loadFailed")}
        </Notice>
      ) : null}

      {/* A poll that failed through its retries: the figures below are the last that were read. */}
      {latest.isError && view !== null ? (
        <Notice tone="warning" role="alert" action={<RetryButton onClick={() => void latest.refetch()} />}>
          {t("pollFailed")}
        </Notice>
      ) : null}

      {startNotice}
      {/* In the ended state it sits under the sentence of how the search ended; a run that is gone has no such state. */}
      {phase === "ended" ? null : proposalNotice}

      {phase === "start" ? (
        <div className="space-y-2">
          <p className="max-w-prose text-sm">{t("intro")}</p>
          <p className="max-w-prose text-sm text-muted-foreground">{t("introNote")}</p>
          {pinnedRequirementIds.length > 0 ? (
            <p className="max-w-prose text-sm text-muted-foreground">{t("pinned", { count: pinnedRequirementIds.length })}</p>
          ) : null}
        </div>
      ) : null}

      {view && (phase === "active" || phase === "cancelling") ? (
        <div className="space-y-4">
          <div className="space-y-1">
            <p id={`${ids}-time`} className="text-sm">
              {t("timeUsed", { used: duration(view.elapsedMs), budget: duration(view.budgetMs) })}
            </p>
            <progress
              className="h-2 w-full max-w-sm accent-primary"
              value={Math.min(view.elapsedMs, Math.max(view.budgetMs, 1))}
              max={Math.max(view.budgetMs, 1)}
              aria-labelledby={`${ids}-time`}
            />
          </div>
          <p className="text-sm">
            {t("rounds", { round: view.round, evaluations: view.evaluations })} {t("moves", { count: view.acceptedMoves })}
          </p>
          <Figures id={ids} view={view} lines={lines} percent={percent} running />
          {view.acceptedMoves > 0 ? <p className="max-w-prose text-sm text-muted-foreground">{t("bestLater")}</p> : null}
          {cancel.isError ? <Notice tone="warning" role="alert">{t("cancelFailed")}</Notice> : null}
        </div>
      ) : null}

      {view && phase === "ended" ? (
        <div className="space-y-4">
          <Notice tone={view.status === "FAILED" ? "warning" : "neutral"} role={null}>
            {view.status === "FAILED"
              ? t(`failed.${failedKey(view)}`)
              : t(`ended.${endedKey(view)}`, { count: view.acceptedMoves })}
            {view.status === "FAILED" && view.hasProposal ? ` ${t("failedBest", { count: view.acceptedMoves })}` : ""}
          </Notice>
          {proposalNotice}
          <Figures id={ids} view={view} lines={lines} percent={percent} running={false} />
        </div>
      ) : null}

      <DialogFooter className="flex-wrap gap-2">
        <Button type="button" variant="outline" onClick={onBack}>
          {tCommon("back")}
        </Button>
        {phase === "start" ? (
          <Button type="button" onClick={() => void begin()} disabled={starting} data-writes="SCHEMALAGGNING">
            {starting ? (
              <>
                <Loader2 className="animate-spin" aria-hidden="true" />
                {t("starting")}
              </>
            ) : (
              t("start")
            )}
          </Button>
        ) : null}
        {phase === "active" ? (
          <Button type="button" variant="outline" onClick={stop} disabled={cancel.isPending} data-writes="SCHEMALAGGNING">
            {cancel.isPending ? <Loader2 className="animate-spin" aria-hidden="true" /> : null}
            {t("cancel")}
          </Button>
        ) : null}
        {phase === "ended" ? (
          <>
            <Button
              type="button"
              variant={hasProposal ? "outline" : "default"}
              onClick={() => void begin()}
              disabled={starting || read.isPending}
              data-writes="SCHEMALAGGNING"
            >
              {starting ? <Loader2 className="animate-spin" aria-hidden="true" /> : null}
              {t("again")}
            </Button>
            {hasProposal ? (
              <Button type="button" onClick={() => void showProposal()} disabled={read.isPending || starting}>
                {read.isPending ? (
                  <>
                    <Loader2 className="animate-spin" aria-hidden="true" />
                    {t("reading")}
                  </>
                ) : view?.status === "SUCCEEDED" && view.stopReason !== "CANCELLED" ? (
                  t("showProposal")
                ) : (
                  t("showBest")
                )}
              </Button>
            ) : null}
          </>
        ) : null}
      </DialogFooter>
    </section>
  );
}

/** The values a proposal problem's sentence takes: only the gateway's own words for one it has no sentence of its own for. */
function proposalValues(problem: ProposalProblem, fallback: string): Record<string, string> {
  return { message: problem.kind === "OTHER" && problem.message !== "" ? problem.message : fallback };
}

function RetryButton({ onClick }: { onClick: () => void }) {
  const tCommon = useTranslations("common");
  return (
    <Button type="button" variant="outline" size="sm" onClick={onClick}>
      {tCommon("retry")}
    </Button>
  );
}

/** A start that did not go through, in a sentence of its own: the gateway's English is never what a school reads. */
function StartNotice({ problem }: { problem: StartProblem }) {
  const t = useTranslations("staffing.search");
  const tCommon = useTranslations("common");
  const tEngine = useTranslations("engineMessages") as unknown as MessageLookup;
  if (problem.kind === "ALREADY_RUNNING") return <Notice role="alert">{t("refused.ALREADY_RUNNING")}</Notice>;
  if (problem.kind !== "OTHER") return <Notice tone="warning" role="alert">{t(`refused.${problem.kind}`)}</Notice>;
  // A refusal of the week itself comes as the engine's sentence, in the catalogue's words when it has them.
  const sentence = engineMessage(tEngine, { code: problem.code, message: problem.message, params: problem.params });
  return (
    <Notice tone="warning" role="alert">
      {sentence || tCommon("error")}
    </Notice>
  );
}

/**
 * Each judged year's tightest week before the search and as far as it has come, as a share of the week's own supply, and the
 * honest limit of what such a figure says, beside it. The limit is shown whatever the figures are, and whether there are any:
 * "nothing to win" and "no move helps" are claims of the same kind.
 */
function Figures({
  id,
  view,
  lines,
  percent,
  running,
}: {
  id: string;
  view: StaffingSearchView;
  lines: readonly YearLine[];
  percent: Intl.NumberFormat;
  running: boolean;
}) {
  const t = useTranslations("staffing.search");
  const skipped = view.figures?.skippedPosts ?? 0;
  const immovable = view.figures?.immovablePosts ?? 0;
  return (
    <section aria-labelledby={`${id}-figures`} className="space-y-2">
      <h4 id={`${id}-figures`} className="text-sm font-semibold">
        {t("figuresTitle")}
      </h4>
      {lines.length === 0 ? (
        running ? <p className="text-sm text-muted-foreground">{t("figuresNone")}</p> : null
      ) : (
        <ul className="space-y-1 text-sm tabular-nums">
          {lines.map((line) => {
            const before = percent.format(line.before);
            const after = percent.format(line.after);
            // A year no move has eased (as far as the figure shows) is said as it stands, not as an arrow from a figure to itself.
            return (
              <li key={line.year}>
                {before === after
                  ? t("yearLineSame", { year: line.year, percent: before })
                  : running
                    ? t("yearLineSoFar", { year: line.year, before, after })
                    : t("yearLine", { year: line.year, before, after })}
              </li>
            );
          })}
        </ul>
      )}
      {skipped > 0 ? <p className="max-w-prose text-sm text-muted-foreground">{t("skipped", { count: skipped })}</p> : null}
      {immovable > 0 ? <p className="max-w-prose text-sm text-muted-foreground">{t("immovable", { count: immovable })}</p> : null}
      <p className="max-w-prose text-sm text-muted-foreground">{t("limits")}</p>
    </section>
  );
}
