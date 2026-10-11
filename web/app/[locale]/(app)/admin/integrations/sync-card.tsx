"use client";

import { Suspense, lazy, useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import { toast } from "sonner";
import { History, Loader2, RefreshCw } from "lucide-react";
import type { MessageLookup } from "@/lib/engine-message";
import { SYNC_RUN_VARIANT } from "@/lib/status-variants";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { LoadError } from "@/components/ui/load-error";
import { Notice } from "@/components/ui/notice";
import { SectionCard } from "@/components/ui/section-card";
import { Skeleton } from "@/components/ui/skeleton";
import { codeText, errorText, formatWhen } from "./ss12000-messages";
import type { ChangeEntity, ChangeOp, RunCounts, RunMode, RunStatus, SourceView, SyncRun } from "./ss12000-types";
import { RUNS_PAGE, fetchOlderRuns, useStartRun, useSyncRuns } from "./use-ss12000-sync";

/*
 * Synka nu and Synkhistorik.
 *
 * A run only READS the register and writes a diff: nothing in the school
 * changes until the admin opens the diff, chooses and applies it (or a night
 * the admin let apply the safe part does). Every run is listed, with what it
 * read and found, why it failed when it did, and who or what applied it — the
 * run row is the log (Ss12000SyncRuns). A run's review dialog is fetched when
 * it is first opened, not with the page.
 */

const DiffReviewDialog = lazy(() =>
  import("./diff-review-dialog").then((module) => ({ default: module.DiffReviewDialog })),
);

const ENTITIES: ChangeEntity[] = ["PERSON", "GROUP", "CLASS_MEMBERSHIP", "GROUP_MEMBERSHIP", "RESPONSIBLE", "DUTY_LINK", "ORGANISATION"];
const CHANGE_OPS: ChangeOp[] = ["CREATE", "LINK", "RELINK", "UPDATE", "MOVE", "DEACTIVATE", "REACTIVATE", "ADD", "END"];
const NOTE_OPS: ChangeOp[] = ["CONFLICT", "INFO"];

/** Changes and notes a run's counts name ({entity: {op: n}}). */
export function changeTotals(counts: RunCounts): { changes: number; notes: number; fetchedPersons: number; fetchedGroups: number } {
  let changes = 0;
  let notes = 0;
  for (const entity of ENTITIES) {
    const row = counts[entity] ?? {};
    for (const op of CHANGE_OPS) changes += row[op] ?? 0;
    for (const op of NOTE_OPS) notes += row[op] ?? 0;
  }
  return {
    changes,
    notes,
    fetchedPersons: counts["PERSON"]?.["fetched"] ?? 0,
    fetchedGroups: counts["GROUP"]?.["fetched"] ?? 0,
  };
}

/** A run's error codes in words, each once, with how many times it occurred. */
export function errorSummary(errors: SyncRun["errors"], codeLabel: (code: string) => string): string {
  const tally = new Map<string, number>();
  for (const error of errors) tally.set(error.code, (tally.get(error.code) ?? 0) + 1);
  return [...tally.entries()].map(([code, n]) => (n > 1 ? `${codeLabel(code)} (${n})` : codeLabel(code))).join(" · ");
}

/** A run whose changes are worth opening: it produced a diff. */
const HAS_DIFF: ReadonlySet<RunStatus> = new Set(["DIFF_READY", "APPLIED", "APPLY_FAILED", "DISCARDED", "SUPERSEDED", "NO_CHANGES"]);

export function SyncCard({ source }: { source: SourceView }) {
  const t = useTranslations("integrations.sync");
  const tErrors = useTranslations("integrations.errors") as unknown as MessageLookup;
  const tCodes = useTranslations("integrations.codes") as unknown as MessageLookup;
  const tCommon = useTranslations("common");
  const locale = useLocale();
  const runs = useSyncRuns(true);
  const start = useStartRun();
  const [reviewing, setReviewing] = useState<string | null>(null);
  // Every run is kept (the run row is the log); older pages are read on demand.
  const [older, setOlder] = useState<SyncRun[]>([]);
  const [olderLeft, setOlderLeft] = useState(true);
  const [loadingOlder, setLoadingOlder] = useState(false);

  const recent = runs.data ?? [];
  const list = [...recent, ...older.filter((run) => !recent.some((shown) => shown.id === run.id))];
  const canPage = olderLeft && (older.length > 0 || recent.length >= RUNS_PAGE);
  const showOlder = () => {
    const oldest = list[list.length - 1];
    if (!oldest) return;
    setLoadingOlder(true);
    fetchOlderRuns(oldest.startedAt)
      .then((page) => {
        setOlder((current) => [...current, ...page]);
        setOlderLeft(page.length >= RUNS_PAGE);
      })
      .catch((error) => toast.error(errorText(tErrors, error, tCommon("error"))))
      .finally(() => setLoadingOlder(false));
  };
  const running = list.some((run) => run.status === "RUNNING");
  const waiting = list.find((run) => run.status === "DIFF_READY") ?? null;
  const reviewRun = list.find((run) => run.id === reviewing) ?? null;
  const ready = source.enabled && source.organisationIds.length > 0;

  const startRun = (mode: RunMode) =>
    start.mutate(mode, {
      onSuccess: (result) => toast.success(result.mode === "FULL" ? t("startedFull") : t("startedIncremental")),
      onError: (error) => toast.error(errorText(tErrors, error, tCommon("error"))),
    });

  return (
    <SectionCard id="ss-sync" title={t("title")} description={t("body")}>
      <div className="space-y-4">
        <div className="flex flex-wrap items-center gap-2">
          <Button type="button" onClick={() => startRun("INCREMENTAL")} disabled={!ready || running || start.isPending}>
            {running || start.isPending ? <Loader2 className="animate-spin" aria-hidden="true" /> : <RefreshCw aria-hidden="true" />}
            {t("syncNow")}
          </Button>
          <Button type="button" variant="outline" onClick={() => startRun("FULL")} disabled={!ready || running || start.isPending}>
            {t("syncFull")}
          </Button>
          {source.lastFullAt ? (
            <span className="text-xs text-muted-foreground">{t("lastFull", { when: formatWhen(locale, source.lastFullAt) })}</span>
          ) : null}
        </div>
        {!ready ? <p className="text-sm text-muted-foreground">{source.enabled ? t("needsOrganisation") : t("disabled")}</p> : null}
        <p className="text-xs text-muted-foreground">{t("modeHint")}</p>

        {waiting ? (
          <Notice
            tone="warning"
            action={
              <Button type="button" size="sm" variant="outline" onClick={() => setReviewing(waiting.id)}>
                {t("review")}
              </Button>
            }
          >
            {t("waiting", { when: formatWhen(locale, waiting.startedAt) })}
          </Notice>
        ) : null}

        <section aria-labelledby="ss-history-title" className="space-y-2 border-t pt-4">
          <h3 id="ss-history-title" className="flex items-center gap-2 text-sm font-semibold">
            <History className="size-4 text-muted-foreground" aria-hidden="true" />
            {t("historyTitle")}
          </h3>
          {runs.isLoading ? (
            <div aria-busy="true">
              <Skeleton className="h-16 w-full" />
            </div>
          ) : null}
          {runs.isError ? (
            <LoadError
              variant="inline"
              title={t("historyLoadFailed")}
              hint={errorText(tErrors, runs.error, tCommon("error"))}
            />
          ) : null}
          {runs.data && list.length === 0 ? <p className="text-sm text-muted-foreground">{t("historyEmpty")}</p> : null}
          {list.length > 0 ? (
            <ul className="divide-y rounded-md border">
              {list.map((run) => (
                <RunRow
                  key={run.id}
                  run={run}
                  locale={locale}
                  codeLabel={(code) => codeText(tCodes, code)}
                  onOpen={() => setReviewing(run.id)}
                />
              ))}
            </ul>
          ) : null}
          {canPage ? (
            <Button type="button" size="sm" variant="outline" onClick={showOlder} disabled={loadingOlder}>
              {loadingOlder ? <Loader2 className="animate-spin" aria-hidden="true" /> : null}
              {t("older")}
            </Button>
          ) : null}
        </section>
      </div>

      {reviewRun ? (
        <Suspense fallback={null}>
          <DiffReviewDialog run={reviewRun} fullEveryDays={source.fullEveryDays} onClose={() => setReviewing(null)} />
        </Suspense>
      ) : null}
    </SectionCard>
  );
}

function RunRow({
  run,
  locale,
  codeLabel,
  onOpen,
}: {
  run: SyncRun;
  locale: string;
  codeLabel: (code: string) => string;
  onOpen: () => void;
}) {
  const t = useTranslations("integrations.sync");
  const totals = changeTotals(run.counts ?? {});
  const openable = HAS_DIFF.has(run.status) && totals.changes + totals.notes > 0;
  const applied = run.counts?.["applied"];
  return (
    <li className="flex flex-wrap items-start justify-between gap-2 px-3 py-2 text-sm">
      <div className="min-w-0 space-y-0.5">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-medium">{formatWhen(locale, run.startedAt)}</span>
          <Badge variant={SYNC_RUN_VARIANT[run.status]}>{t(`status.${run.status}`)}</Badge>
          <span className="text-xs text-muted-foreground">
            {t(`trigger.${run.trigger}`)} · {t(`mode.${run.mode}`)}
          </span>
          {run.autoApplied ? <Badge variant="secondary">{t("autoApplied")}</Badge> : null}
        </div>
        {run.statusCode ? <p className="text-xs text-muted-foreground">{codeLabel(run.statusCode)}</p> : null}
        {run.status !== "RUNNING" && run.status !== "SKIPPED" && run.fetchedAt ? (
          <p className="text-xs text-muted-foreground">
            {t("counts", { persons: totals.fetchedPersons, groups: totals.fetchedGroups, changes: totals.changes, notes: totals.notes })}
          </p>
        ) : null}
        {applied ? (
          <p className="text-xs text-muted-foreground">
            {t("appliedCounts", { applied: (applied["admin"] ?? 0) + (applied["auto"] ?? 0), skipped: applied["skipped"] ?? 0 })}
          </p>
        ) : null}
        {run.appliedAt && run.status !== "APPLIED" ? (
          <p className="text-xs text-muted-foreground">{t("partlyApplied", { when: formatWhen(locale, run.appliedAt) })}</p>
        ) : null}
        {run.autoApplyBlockedReason ? (
          <p className="text-xs text-destructive">
            {run.autoApplyBlockedReason === "STALE"
              ? t("autoBlockedStale")
              : run.autoApplyBlockedReason === "REVIEW_REQUIRED"
                ? t("autoBlockedReview")
                : t("autoBlocked")}
          </p>
        ) : null}
        {run.errors.length > 0 ? (
          <p className="text-xs text-muted-foreground">
            {t("errorCodes", { codes: errorSummary(run.errors, codeLabel) })}
          </p>
        ) : null}
      </div>
      {openable ? (
        <Button type="button" size="sm" variant={run.status === "DIFF_READY" ? "default" : "outline"} onClick={onOpen}>
          {run.status === "DIFF_READY" ? t("review") : t("show")}
        </Button>
      ) : null}
    </li>
  );
}
