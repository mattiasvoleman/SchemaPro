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
// are not modelled, and the sentence does not pretend they are. The reformed
// cohort is named by its numbering, not as "tioårig grundskola": the rows
// carry no school form, and specialskolan has eleven grades, sameskolan
// seven.
//
// Closed by default: it is a reference the admin opens when a class's
// version is in question, not a warning. A disclosure button, not <details>
// (as publishing's log): the native marker is a glyph no other control draws,
// and the summary had no focus ring of the app's own. The panel stays in the
// DOM, hidden, as the <details> body did.

import { useId, useState } from "react";
import { useTranslations } from "next-intl";
import { ChevronDown, ChevronRight } from "lucide-react";
import type { CohortNoticeRow } from "@/lib/timplan-cohorts";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/** "SFS2023:945/B1" → "SFS 2023:945 B1": the reference data's code, readable. */
export const versionText = (code: string) => code.replace(/^SFS(?=\d)/, "SFS ").replace("/", " ");

export function CohortNotice({ rows, className }: { rows: readonly CohortNoticeRow[]; className?: string }) {
  const t = useTranslations("timplanCohorts");
  const [open, setOpen] = useState(false);
  const id = useId();
  if (rows.length === 0) return null;
  return (
    <div className={cn("rounded-lg border bg-card px-4 py-2 text-sm", className)}>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="-ml-2"
        id={`${id}-toggle`}
        aria-expanded={open}
        aria-controls={`${id}-panel`}
        onClick={() => setOpen((value) => !value)}
      >
        {open ? <ChevronDown aria-hidden="true" /> : <ChevronRight aria-hidden="true" />}
        {t("title")}
      </Button>
      <div
        id={`${id}-panel`}
        role="region"
        aria-labelledby={`${id}-toggle`}
        hidden={!open}
        className="space-y-2 pb-2 pt-1"
      >
        <p className="max-w-prose text-muted-foreground">{t("intro")}</p>
        <ul className="space-y-2">
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
                      // A reformed cohort's missing version is the 2028 one (specialskolan's
                      // 8 604 h is unseeded), never an "older" one.
                      state:
                        stage.versionCode === null
                          ? row.regime === "REFORMED_2028"
                            ? "missingReformed"
                            : "missing"
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
        <p className="max-w-prose text-xs text-muted-foreground">{t("sources")}</p>
      </div>
    </div>
  );
}
