import type { RetentionDecision } from "@/lib/retention-types";

/** "12 månader" reads worse than "1 år": whole years are said in years. */
export function periodLabel(
  months: number,
  t: (key: "periodMonths" | "periodYears", values: { count: number }) => string,
): string {
  return months % 12 === 0 ? t("periodYears", { count: months / 12 }) : t("periodMonths", { count: months });
}

/** The badge's sentence for a decision, or ej beslutat. */
export function decisionLabel(
  decision: Pick<RetentionDecision, "decision" | "months"> | null,
  t: (key: string, values?: Record<string, string | number>) => string,
): string {
  if (!decision || decision.decision === "UNDECIDED") return t("undecided");
  if (decision.decision === "KEEP") return t("keep");
  return t("purgeAfter", {
    period: periodLabel(decision.months ?? 0, (key, values) => t(key, values)),
  });
}
