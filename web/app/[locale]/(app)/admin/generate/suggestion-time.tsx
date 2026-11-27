"use client";

import { useTranslations } from "next-intl";
import type { TimeoutReport } from "@/lib/queries";
import { searchesOf, timeoutAccountOf } from "./timeout-cause";

/*
 * WHERE THE ANALYSIS' TIME WENT, for an analysis that found no timetable in its time (G6b: the engine's `report` of a NOT_FOUND).
 *
 * "Found nothing in 60 s" does not say whether the minute was the model's builds or the search, and the account does: the same steps, the
 * same sentences and the same measured causes as a run that ran out of time (timeout-account.tsx), drawn smaller, since an analysis has no
 * conflict rows of its own. With none, `timeoutAccountOf` can name only the causes the report itself carries: a search that was given less
 * than the engine is set to give it, and setup that took a large part of the run. "No cause could be measured" is not said here: the card
 * above it already says that the answer is no proof either way.
 *
 * MEASURED, AND SAID AS WHAT IT IS: the seconds are the solve's own clock, and nothing says how near the search came.
 */
export function SuggestionTime({ report }: { report: TimeoutReport }) {
  const t = useTranslations("generate.timeoutAccount");
  const tCard = useTranslations("generate.suggestions");
  // Only the causes the report itself carries, each as its sentence; "no cause could be measured" is not one.
  const causes = timeoutAccountOf(report, []).causes.flatMap((cause): string[] => {
    if (cause.kind === "SLOW_SETUP") return [t("cause.SLOW_SETUP", { setup: cause.setupSeconds, total: cause.totalSeconds })];
    if (cause.kind !== "SHORT_CLOCK") return [];
    return [
      cause.callerWaitSeconds !== null
        ? t("cause.SHORT_CLOCK_WAIT", { budget: cause.budgetSeconds, configured: cause.configuredBudgetSeconds, wait: cause.callerWaitSeconds })
        : t("cause.SHORT_CLOCK", { budget: cause.budgetSeconds, configured: cause.configuredBudgetSeconds }),
    ];
  });
  // Steps the gateway has no name for (an engine newer than it): their seconds are said, and no search is said not to have begun for them.
  const other = report.otherSeconds ?? 0;
  const searched = searchesOf(report);

  return (
    <div className="space-y-1.5" data-testid="suggestion-time">
      <h4 className="text-sm font-medium">{tCard("time.title")}</h4>
      <ul className="space-y-0.5 text-sm">
        {report.stages.map((stage) => (
          <li key={stage.stage} className="max-w-prose">
            {t("stage", { stage: stage.stage, seconds: stage.seconds })}
          </li>
        ))}
        {other > 0 ? <li className="max-w-prose">{t("otherSteps", { seconds: other })}</li> : null}
      </ul>
      {/* "No search began" is not said of a run whose steps the page cannot all name: one of them may have been the search. */}
      {searched.count > 0 || other === 0 ? (
        <p className="max-w-prose text-sm">
          {searched.count > 0 ? t("searchNone", { count: searched.count, seconds: searched.seconds }) : t("searchNotRun")}
        </p>
      ) : null}
      {other > 0 ? <p className="max-w-prose text-sm">{t("searchOther", { seconds: other })}</p> : null}
      <p className="max-w-prose text-sm text-muted-foreground">
        {report.budgetSeconds < report.configuredBudgetSeconds
          ? t("budgetShort", { budget: report.budgetSeconds, configured: report.configuredBudgetSeconds })
          : t("budget", { budget: report.budgetSeconds })}
      </p>
      {causes.map((sentence) => (
        <p key={sentence} className="max-w-prose text-sm">
          {sentence}
        </p>
      ))}
    </div>
  );
}
