"use client";

import { useTranslations } from "next-intl";
import { CircleCheck, Info, TriangleAlert } from "lucide-react";
import type { TimplanVerdict } from "@/lib/timplan-coverage";
import { formatH } from "@/lib/timplan-view";
import { cn } from "@/lib/utils";

export interface WarningsRailProps {
  verdicts: TimplanVerdict[];
  /** National code → its Swedish name, from GET /national-timplans. */
  nationalNames: ReadonlyMap<string, string>;
  /** True while the list is computed from unsaved edits, not the saved plan. */
  live: boolean;
  selected: number | null;
  onSelect: (index: number | null) => void;
}

/**
 * The TIMPLAN_* verdicts as a list beside the grid, each a button that lights
 * the cells it is about (see verdictHighlight in lib/timplan-view.ts).
 *
 * The sentence is formatted HERE, under the web's own sv/en keys, from the
 * figures the check carries — not taken from the gateway's `message`, which is
 * Swedish only and absent from the live check the browser computes while the
 * admin types. The figures are spelled with the decimal comma the grid uses,
 * so "25,2 h" in the rail is "25,2" in the cell.
 *
 * A warning is labelled "Under mål", a notice "Notering". Neither says "fel",
 * and the hint under the heading says outright that nothing here blocks a save
 * or a decision: the law lets a school deviate, and the list is there to make
 * the deviation visible, not to refuse it.
 */
export function WarningsRail({ verdicts, nationalNames, live, selected, onSelect }: WarningsRailProps) {
  const t = useTranslations("timplan");
  const name = (code: string | undefined) => (code ? (nationalNames.get(code) ?? code) : "");

  const sentence = (verdict: TimplanVerdict): string => {
    const values: Record<string, string> = {};
    for (const [key, value] of Object.entries(verdict.params)) {
      values[key] = typeof value === "number" ? formatH(value) : value;
    }
    values.subject = name(verdict.subjectCode);
    values.child = name(verdict.childCode);
    values.stage = verdict.stage ? t(`stagesInline.${verdict.stage}`) : "";
    return t(`verdicts.${verdict.code}`, values);
  };

  return (
    <section aria-labelledby="timplan-warnings" className="rounded-lg border bg-card p-4">
      <h2 id="timplan-warnings" className="font-semibold">
        {t("warningsTitle")}
      </h2>
      <p className="mb-3 text-xs text-muted-foreground">{t("warningsHint")}</p>
      {live ? (
        <p role="status" className="mb-3 rounded-md bg-muted px-2 py-1 text-xs text-foreground">
          {t("warningsLive")}
        </p>
      ) : null}
      {verdicts.length === 0 ? (
        <p className="flex items-center gap-2 text-sm text-foreground">
          <CircleCheck className="h-4 w-4 text-success" aria-hidden />
          {t("warningsEmpty")}
        </p>
      ) : (
        <ul className="space-y-1.5">
          {verdicts.map((verdict, index) => {
            const Icon = verdict.severity === "warning" ? TriangleAlert : Info;
            const active = selected === index;
            return (
              <li key={`${verdict.code}-${verdict.subjectCode ?? ""}-${verdict.stage ?? ""}-${verdict.childCode ?? ""}-${index}`}>
                <button
                  type="button"
                  aria-pressed={active}
                  data-code={verdict.code}
                  onClick={() => onSelect(active ? null : index)}
                  className={cn(
                    "flex w-full items-start gap-2 rounded-md border px-2 py-1.5 text-left text-sm transition-colors",
                    "hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                    verdict.severity === "warning" ? "border-l-2 border-l-destructive" : "border-l-2 border-l-warning",
                    active && "bg-accent ring-2 ring-primary",
                  )}
                >
                  <Icon
                    className={cn(
                      "mt-0.5 h-4 w-4 shrink-0",
                      verdict.severity === "warning" ? "text-destructive" : "text-warning-foreground dark:text-warning",
                    )}
                    aria-hidden
                  />
                  <span>
                    <span className="block text-xs font-medium text-muted-foreground">
                      {t(`severity.${verdict.severity}`)}
                    </span>
                    {sentence(verdict)}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
