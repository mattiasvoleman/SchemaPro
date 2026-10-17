"use client";

import { useTranslations } from "next-intl";
import type { MessageLookup } from "@/lib/engine-message";
import type { RolloverProblem } from "@/lib/types";
import { Notice } from "@/components/ui/notice";
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
  ROLLOVER_2028_NOT_RENUMBERED: "year",
  ROLLOVER_2028_SCHOOL_FORM_UNKNOWN: "year",
  ROLLOVER_2028_RENUMBERING_REQUIRED: "year",
  ROLLOVER_GRADE_ABOVE_12: "groups",
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

/**
 * Blocking findings first, as destructive notices announced at once; the rest
 * are warnings to look at, not to fix, and are not announced as alerts.
 */
export function ProblemList({ problems }: { problems: readonly RolloverProblem[] }) {
  const t = useTranslations("years");
  const tProblems = useTranslations("years.problems") as unknown as MessageLookup;
  return (
    <ul className="space-y-2" aria-label={t("problemsLabel")}>
      {problems.map((problem, index) => (
        <li key={`${problem.code}-${index}`}>
          <Notice tone={problem.blocking ? "destructive" : "warning"} role={problem.blocking ? "alert" : null}>
            <span className="sr-only">{problem.blocking ? t("blocking") : t("notice")}: </span>
            {problemText(tProblems, problem)}
          </Notice>
        </li>
      ))}
    </ul>
  );
}
