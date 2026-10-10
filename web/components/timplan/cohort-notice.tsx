"use client";

// "Timplaner per årskull" — which lydelse each cohort's stadier are judged
// against, read-only. Two places show it: /admin/timplan, where the rows are
// computed in the browser from the year's classes (lib/timplan-cohorts.ts,
// nothing else of the stage module, for that route's bundle), and the
// Stadium tab on Täckning, where the gateway sends the same rows. One
// component, so the two read alike.
//
// THE REFERENCE DATA'S SOURCES, NOT LAW FOR A PUPIL. Every version named is
// a row of SchemaPro's reference data, and the sources sentence says which
// statutes those rows are read from and when. A cohort the reference data has
// no lydelse for says so; a lydelse without a published distribution says
// "bara totalen"; an old cohort read against bilaga 1 after 2028 says the
// distribution is assumed (SFS 2025:729 övergångsbestämmelse 12 keeps only the
// total). Individual exceptions ("annat beslutas", övergångsbestämmelse 4)
// are not modelled, and the sentence does not pretend they are.
//
// A <details>, closed: it is a reference the admin opens when a class's
// version is in question, not a warning.

import { useTranslations } from "next-intl";
import type { CohortNoticeRow } from "@/lib/timplan-cohorts";

/** "SFS2023:945/B1" → "SFS 2023:945 B1": the reference data's code, readable. */
export const versionText = (code: string) => code.replace(/^SFS(?=\d)/, "SFS ").replace("/", " ");

export function CohortNotice({ rows, className }: { rows: readonly CohortNoticeRow[]; className?: string }) {
  const t = useTranslations("timplanCohorts");
  if (rows.length === 0) return null;
  return (
    <details className={`rounded-lg border bg-card px-4 py-3 text-sm ${className ?? ""}`}>
      <summary className="cursor-pointer font-medium">{t("title")}</summary>
      <p className="mt-2 max-w-prose text-muted-foreground">{t("intro")}</p>
      <ul className="mt-2 space-y-2">
        {rows.map((row) => (
          <li key={`${row.regime}:${row.cohortStartHT}`}>
            <span className="font-medium">{t("cohort", { regime: row.regime, ht: String(row.cohortStartHT) })}</span>
            {" · "}
            {row.classNames.length > 0 ? row.classNames.join(", ") : t("noClasses")}
            <span className="block text-muted-foreground">
              {row.stages
                .map((stage) =>
                  t("stageVersion", {
                    stage: stage.stage,
                    version: stage.versionCode ? versionText(stage.versionCode) : "",
                    state:
                      stage.versionCode === null
                        ? "missing"
                        : !stage.distributionPublished
                          ? "unpublished"
                          : stage.assumed
                            ? "assumed"
                            : "published",
                  }),
                )
                .join(" · ")}
            </span>
          </li>
        ))}
      </ul>
      <p className="mt-2 max-w-prose text-xs text-muted-foreground">{t("sources")}</p>
    </details>
  );
}
