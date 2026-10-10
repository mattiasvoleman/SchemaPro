"use client";

import { useTranslations } from "next-intl";
import { Info, TriangleAlert } from "lucide-react";
import type { MessageLookup } from "@/lib/engine-message";
import type { RolloverProblem } from "@/lib/types";
import { problemText } from "../year-messages";

export type RolloverStep = "year" | "groups" | "breaks" | "review";

/**
 * The step each finding belongs to, so it is shown beside the fields that
 * cause it. Every finding is shown again on the review step; a code this
 * table does not know (a newer gateway) is shown there only.
 */
const STEP_OF: Record<string, RolloverStep> = {
  ROLLOVER_TARGET_DATES: "year",
  YEAR_NAME_TAKEN: "year",
  YEAR_DATES_OVERLAP: "year",
  GRADUATING_GRADE_REQUIRED: "year",
  // The new year's start date is what raises it (a year from HT 2028, the
  // tioårig grundskola), so it is said where that date is typed — and again on
  // the review, beside the classes whose grades it asks the admin to check.
  ROLLOVER_2028_RENUMBERING: "year",
  ROLLOVER_NAME_COLLISION: "groups",
  ROLLOVER_NAME_CASE_COLLISION: "groups",
  ROLLOVER_GROUP_CHOICE_INVALID: "groups",
  ROLLOVER_UNKNOWN_GROUP: "groups",
  VOLUME_DIFFERS_FROM_TIMPLAN: "groups",
  BREAK_NEEDS_DATES: "breaks",
  BREAK_OUTSIDE_YEAR: "breaks",
  ROLLOVER_UNKNOWN_BREAK: "breaks",
};

export function problemsOfStep(problems: readonly RolloverProblem[], step: RolloverStep): RolloverProblem[] {
  if (step === "review") return [...problems].sort((a, b) => Number(b.blocking) - Number(a.blocking));
  return problems.filter((problem) => STEP_OF[problem.code] === step);
}

/** Blocking findings first and red; the rest are things to look at, not to fix. */
export function ProblemList({ problems }: { problems: readonly RolloverProblem[] }) {
  const t = useTranslations("years");
  const tProblems = useTranslations("years.problems") as unknown as MessageLookup;
  return (
    <ul className="space-y-2" aria-label={t("problemsLabel")}>
      {problems.map((problem, index) => (
        <li
          key={`${problem.code}-${index}`}
          role={problem.blocking ? "alert" : undefined}
          className={
            problem.blocking
              ? "flex gap-2 rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive"
              : "flex gap-2 rounded-md border border-warning/40 bg-warning/5 p-3 text-sm"
          }
        >
          {problem.blocking ? (
            <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
          ) : (
            <Info className="mt-0.5 h-4 w-4 shrink-0 text-warning" aria-hidden />
          )}
          <span>
            <span className="sr-only">{problem.blocking ? t("blocking") : t("notice")}: </span>
            {problemText(tProblems, problem)}
          </span>
        </li>
      ))}
    </ul>
  );
}
