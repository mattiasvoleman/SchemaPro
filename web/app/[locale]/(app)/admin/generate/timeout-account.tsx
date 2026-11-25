"use client";

import { useTranslations } from "next-intl";
import type { ConflictDetail, TimeoutReport } from "@/lib/queries";
import { searchesOf, timeoutAccountOf, weekLoadThresholdOf, type TimeoutCause } from "./timeout-cause";

/*
 * WHAT A RUN THAT RAN OUT OF TIME SAYS FOR ITSELF (omgång 13, M2 Förklaringen när tiden tar slut).
 *
 * Where the time went, how far the search got, the likely cause and what to do next, drawn from the engine's report and the
 * rows a TIMEOUT has always carried. Behind a lazy import: /admin/generate is near its bundle budget, and this is only drawn
 * when a run ended in TIMEOUT.
 *
 * MEASURED, AND SAID AS WHAT IT IS. The seconds are the solve's own clock. What CP-SAT counted (conflicts, branches) is the
 * work it did and not how near it came, so it sits in a fold with that said, and nothing here says "X % of the way": a search for
 * a timetable has no bound. A tight week's percentage is a lower bound ("at least"), the years are never ranked, and a year the
 * week load did not reach is said not to be counted (timeout-cause.ts).
 */

export interface TimeoutAccountProps {
  report: TimeoutReport;
  /** The run's rows: what a probe found, and which years the arithmetic found tight. */
  conflicts: readonly ConflictDetail[];
}

/** A step's colour: the checks and builds muted, the searches in the page's own colour, the explanation lighter. */
const STAGE_CLASS: Record<TimeoutReport["stages"][number]["stage"], string> = {
  PRECHECKS: "bg-muted-foreground/30",
  BUILD: "bg-muted-foreground/50",
  SITES: "bg-accent",
  SEARCH_CLEAN: "bg-primary",
  SEARCH_CLONE: "bg-primary/70",
  PROBE: "bg-warning/40",
};

export function TimeoutAccount({ report, conflicts }: TimeoutAccountProps) {
  const t = useTranslations("generate.timeoutAccount");
  const account = timeoutAccountOf(report, conflicts);
  const spent = report.stages.reduce((sum, stage) => sum + stage.seconds, 0);
  // Counted from the steps the list below shows (the walk's search among them), never from `search.phases`, which has no phase for it.
  const searched = searchesOf(report);
  const threshold = weekLoadThresholdOf(conflicts);

  return (
    <section aria-labelledby="timeout-account-title" className="space-y-4">
      <h3 id="timeout-account-title" className="text-sm font-semibold">
        {t("title")}
      </h3>

      <div className="space-y-2">
        <h4 className="text-sm font-medium">{t("whereTitle")}</h4>
        {/* The bar is a picture of the list under it: the figures are the text, so a screen reader and a reader who sees no colour lose nothing. */}
        <div aria-hidden="true" className="flex h-3 w-full max-w-prose overflow-hidden rounded bg-muted">
          {report.stages
            .filter((stage) => stage.seconds > 0)
            .map((stage) => (
              <div
                key={stage.stage}
                className={STAGE_CLASS[stage.stage]}
                style={{ width: `${spent > 0 ? (stage.seconds / spent) * 100 : 0}%` }}
              />
            ))}
        </div>
        <ul className="space-y-0.5 text-sm">
          {report.stages.map((stage) => (
            <li key={stage.stage} className="flex max-w-prose items-baseline gap-2">
              <span aria-hidden="true" className={`mt-1 inline-block size-2 shrink-0 rounded-sm ${STAGE_CLASS[stage.stage]}`} />
              <span>{t("stage", { stage: stage.stage, seconds: stage.seconds })}</span>
            </li>
          ))}
        </ul>
        <p className="max-w-prose text-sm text-muted-foreground">{t("total", { seconds: report.totalSeconds })}</p>
      </div>

      <div className="space-y-1">
        <h4 className="text-sm font-medium">{t("searchTitle")}</h4>
        <p className="max-w-prose text-sm">
          {searched.count > 0 ? t("searchNone", { count: searched.count, seconds: searched.seconds }) : t("searchNotRun")}
        </p>
        <p className="max-w-prose text-sm text-muted-foreground">
          {report.budgetSeconds < report.configuredBudgetSeconds
            ? t("budgetShort", { budget: report.budgetSeconds, configured: report.configuredBudgetSeconds })
            : t("budget", { budget: report.budgetSeconds })}
        </p>
      </div>

      <div className="space-y-1">
        <h4 className="text-sm font-medium">{t("causeTitle")}</h4>
        <ul className="list-disc space-y-1.5 pl-5 text-sm">
          {account.causes.map((cause) => (
            <li key={cause.kind} className="max-w-prose">
              <CauseText cause={cause} />
            </li>
          ))}
        </ul>
        {account.weekLoadCut ? (
          <p className="max-w-prose text-sm text-muted-foreground">
            {/* The threshold is the engine's own row's (WEEK_LOAD_NOT_COUNTED): with no row, a sentence that names none. */}
            {threshold !== null ? t("weekLoadCut", { percent: threshold }) : t("weekLoadCutPlain")}
          </p>
        ) : null}
      </div>

      <div className="space-y-1">
        <h4 className="text-sm font-medium">{t("nextTitle")}</h4>
        <ul className="list-disc space-y-1 pl-5 text-sm">
          {account.causes.map((cause) => (
            <li key={cause.kind} className="max-w-prose">
              {t(`next.${cause.kind}` as never)}
            </li>
          ))}
        </ul>
      </div>

      <details className="text-sm">
        <summary className="cursor-pointer font-medium">{t("technicalTitle")}</summary>
        <div className="mt-2 space-y-1 text-muted-foreground">
          <p className="max-w-prose">{t("technicalNote")}</p>
          <ul className="list-disc space-y-0.5 pl-5">
            {report.search.phases.map((phase) => (
              <li key={phase.phase}>
                {/* Loose on purpose: a count the gateway left out is undefined, and `{conflicts, number}` cannot be formatted without one. */}
                {phase.conflicts == null || phase.branches == null
                  ? t("phaseNoFigures", { phase: phase.phase, seconds: phase.seconds })
                  : t("phase", {
                      phase: phase.phase,
                      seconds: phase.seconds,
                      conflicts: phase.conflicts,
                      branches: phase.branches,
                    })}
              </li>
            ))}
            {report.callerWaitSeconds !== null ? <li>{t("callerWait", { seconds: report.callerWaitSeconds })}</li> : null}
            <li>{t("configured", { configured: report.configuredBudgetSeconds, budget: report.budgetSeconds })}</li>
          </ul>
        </div>
      </details>
    </section>
  );
}

function CauseText({ cause }: { cause: TimeoutCause }) {
  const t = useTranslations("generate.timeoutAccount");
  switch (cause.kind) {
    case "RULES_MEASURED":
      return <>{t("cause.RULES_MEASURED", { count: cause.count })}</>;
    case "PROBE_CHANGED_WEEK":
      return <>{t("cause.PROBE_CHANGED_WEEK", { count: cause.count })}</>;
    case "TIGHT_WEEK":
      return (
        <>
          {t("cause.TIGHT_WEEK")}
          {/* In grade order, each a lower bound: the list is never sorted by weight and no year is called the tightest. */}
          <ul className="mt-1 list-none space-y-0.5 pl-0">
            {cause.years.map((year) => (
              <li key={year.grades}>{t("tightYear", { grades: year.grades, percent: year.percent })}</li>
            ))}
          </ul>
          <span className="mt-1 block text-muted-foreground">{t("tightYearsBound")}</span>
        </>
      );
    case "SHORT_CLOCK":
      return (
        <>
          {cause.callerWaitSeconds !== null
            ? t("cause.SHORT_CLOCK_WAIT", {
                budget: cause.budgetSeconds,
                configured: cause.configuredBudgetSeconds,
                wait: cause.callerWaitSeconds,
              })
            : t("cause.SHORT_CLOCK", { budget: cause.budgetSeconds, configured: cause.configuredBudgetSeconds })}
        </>
      );
    case "SLOW_SETUP":
      return <>{t("cause.SLOW_SETUP", { setup: cause.setupSeconds, total: cause.totalSeconds })}</>;
    case "NOTHING_FOUND":
      return <>{t("cause.NOTHING_FOUND")}</>;
  }
}
