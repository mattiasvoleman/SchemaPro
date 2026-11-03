"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import type { GradeSpan } from "@/lib/timplan-coverage";
import { sameSpan, spanText } from "@/lib/timplan-span";
import { SpanFields } from "@/components/timplan/span-fields";
import { Button } from "@/components/ui/button";
import { Notice } from "@/components/ui/notice";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

export interface SpanDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  plan: { name: string; status: "DRAFT" | "DECIDED"; span: GradeSpan | null };
  /** The årskurser the plan's form has, in its lydelse's numbering (spanGradeOptions). */
  grades: number[];
  /** The skolenheternas span in the plan's numbering, for a plan with none; null is none. */
  suggestedSpan?: GradeSpan | null;
  pending: boolean;
  /** Null is the whole school form, which only a draft can be given. */
  onConfirm: (span: GradeSpan | null) => Promise<void>;
}

/**
 * Planens årskurspann: which årskurser the check counts. A DRAFT takes any
 * span, "Hela skolformen" included. A DECIDED plan is a record that is not
 * edited, and takes ONE change: a span set once, from none — the minutes do not
 * change, and the gateway registers who set it and when, which the page shows.
 * A decided plan that has a span keeps it: the dialog says so, and says
 * Öppna igen, whose draft can be given another.
 *
 * Loaded on the click (React.lazy in the page), like every dialog there.
 */
export function SpanDialog({ open, onOpenChange, plan, grades, suggestedSpan = null, pending, onConfirm }: SpanDialogProps) {
  const t = useTranslations("timplan");
  const tCommon = useTranslations("common");
  const decided = plan.status === "DECIDED";
  const locked = decided && plan.span !== null;
  // undefined: not touched, so the plan's own span, else the suggestion.
  const [choice, setChoice] = useState<GradeSpan | null | undefined>(undefined);
  const span = choice === undefined ? (plan.span ?? suggestedSpan) : choice;

  // A decided plan is given a span, never "no span"; a draft only a change.
  const nothingToSave = decided ? span === null : sameSpan(span, plan.span);

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (pending) return;
        if (!next) setChoice(undefined);
        onOpenChange(next);
      }}
    >
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{t("spanDialogTitle")}</DialogTitle>
          <DialogDescription>
            {locked
              ? t("spanLockedBody", { name: plan.name, span: spanText(t, plan.span!) })
              : t(decided ? "spanDecidedBody" : "spanDraftBody", { name: plan.name })}
          </DialogDescription>
        </DialogHeader>
        {locked ? null : (
          <>
            <SpanFields
              id="timplan-span"
              grades={grades}
              value={span}
              onChange={setChoice}
              allowWhole={!decided}
              hint={t(span !== null && sameSpan(span, suggestedSpan) ? "spanHintFromUnits" : "spanHint")}
            />
            {decided ? <Notice tone="warning">{t("spanDecidedOnce")}</Notice> : null}
          </>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={pending}>
            {locked ? tCommon("close") : tCommon("cancel")}
          </Button>
          {locked ? null : (
            <Button onClick={() => void onConfirm(span)} disabled={pending || nothingToSave}>
              {t("spanConfirm")}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
