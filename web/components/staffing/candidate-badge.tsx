"use client";

import { useTranslations } from "next-intl";
import type { CandidateQualification, CandidateRemaining } from "@/lib/staffing-candidates";
import type { TeacherQualificationKind } from "@/lib/types";
import { badgeVariants } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

/*
 * What the timplan's teacher pickers say beside each name: the behörighet the
 * candidate holds for this row, and the minutes they have left to their mål.
 *
 * INFORMATION, NOT A GATE — see lib/staffing-candidates.ts for why nothing is
 * refused here and why the minutes are read off the load report instead of
 * recomputed. This file only decides how the two facts are painted.
 *
 * Rendered as <span>s, not the Badge component's <div>: the badge sits inside
 * Radix's SelectItemText, a span the trigger mirrors when the option is
 * chosen, and a block element inside it is the kind of nesting that renders
 * today and breaks on the next primitive upgrade. The classes are the Badge's
 * own, via badgeVariants, so the colours are the product's and not a second
 * palette.
 *
 * COLOUR CARRIES NOTHING ALONE. Every badge has a word in it (Legitimation /
 * Behörig / Tillåten / Saknar behörighet), the minutes are a sentence, and the
 * variants are the ones the status badges in the matrix already use, measured
 * there. "Saknar behörighet" is the warning variant rather than destructive:
 * in this phase it is a note to the admin, not a refusal, and painting it the
 * colour of an error would promise a gate the page does not have.
 */

const KIND_VARIANT: Record<TeacherQualificationKind, "success" | "secondary" | "outline"> = {
  LEGITIMATION: "success",
  BEHORIG: "secondary",
  TILLATEN: "outline",
};

export function CandidateBadge({
  qualification,
  remaining,
  afterRow = false,
  className,
}: {
  qualification: CandidateQualification;
  remaining: CandidateRemaining;
  /**
   * Whether `remaining` is the room left AFTER taking the row in question
   * (Föreslå lärare: the gateway's target − (counted + this row)) rather than
   * the room the teacher has today (the requirements dialog: the report's
   * saldo). Two different numbers for one person, so two different sentences.
   */
  afterRow?: boolean;
  className?: string;
}) {
  const t = useTranslations("staffing");

  return (
    <span className={cn("inline-flex flex-wrap items-center gap-1.5", className)}>
      {qualification.recorded ? (
        qualification.kind ? (
          <span className={badgeVariants({ variant: KIND_VARIANT[qualification.kind] })}>
            {t(`kind${qualification.kind}`)}
          </span>
        ) : (
          <span className={badgeVariants({ variant: "warning" })}>{t("candidateUnqualified")}</span>
        )
      ) : null}
      {remaining.status === "REMAINING" ? (
        <span className="text-xs tabular-nums text-muted-foreground">
          {t(afterRow ? "candidateRemainingAfter" : "candidateRemaining", { minutes: remaining.minutes })}
        </span>
      ) : remaining.status === "OVER" ? (
        <span className="text-xs font-medium tabular-nums text-destructive">
          {t(afterRow ? "candidateOverAfter" : "candidateOver", { minutes: remaining.minutes })}
        </span>
      ) : (
        <span className="text-xs text-muted-foreground">{t("candidateNoTarget")}</span>
      )}
    </span>
  );
}
