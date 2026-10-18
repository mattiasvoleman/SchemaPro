"use client";

import { useTranslations } from "next-intl";
import { Loader2 } from "lucide-react";
import { Link } from "@/i18n/navigation";
import type { CandidateCheck, CandidateView } from "@/lib/candidates/types";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Notice } from "@/components/ui/notice";

export interface ApplyDialogProps {
  /** The candidate being applied; the dialog is open while there is one. */
  candidate: CandidateView | null;
  label: string;
  /** The batch's check: the mode the apply names, and in DIRECT what the calendar loses. */
  check: CandidateCheck | null;
  pending: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: () => void;
}

/*
 * Tillämpa. In DRAFT a plain confirmation: the draft's generated lessons are
 * replaced as Generera replaces them, and nothing is published. In DIRECT the
 * same write also reaches the calendar — the upcoming lessons it replaces
 * leave the calendar until the next publish — so the dialog says so with the
 * counts the check measured, and offers the way round first: switch to draft
 * mode, where the calendar changes only when somebody publishes.
 *
 * Focus is the shared DialogContent's: the first control on open, back to
 * the button that opened it on close, and nothing can close the dialog while
 * the write is in flight.
 */
export function ApplyDialog({ candidate, label, check, pending, onOpenChange, onConfirm }: ApplyDialogProps) {
  const t = useTranslations("scheduleCandidates");
  const tCommon = useTranslations("common");
  const direct = check?.mode === "DIRECT";
  const ordinal = candidate?.ordinal ?? 0;

  return (
    <Dialog open={candidate !== null} onOpenChange={(open) => (pending ? undefined : onOpenChange(open))}>
      <DialogContent
        className="max-w-lg"
        closeDisabled={pending}
        onEscapeKeyDown={(event) => {
          if (pending) event.preventDefault();
        }}
        onInteractOutside={(event) => {
          if (pending) event.preventDefault();
        }}
      >
        <DialogHeader>
          <DialogTitle>
            {direct ? t("apply.titleDirect", { ordinal, label }) : t("apply.titleDraft", { ordinal, label })}
          </DialogTitle>
          <DialogDescription className="text-foreground">
            {direct ? t("apply.bodyDirect") : t("apply.bodyDraft")}
          </DialogDescription>
        </DialogHeader>

        {direct && check ? (
          <Notice tone="warning" role={null}>
            <ul className="list-disc space-y-1 pl-5">
              <li>{t("apply.futureLessons", { count: check.futureCalendarLessons })}</li>
              <li>{t("apply.coverAssignments", { count: check.coverAssignments })}</li>
            </ul>
            <p className="mt-2">{t("apply.switchFirstHint")}</p>
          </Notice>
        ) : null}

        <DialogFooter className="gap-2 sm:gap-0">
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={pending}>
            {tCommon("cancel")}
          </Button>
          {direct ? (
            <>
              <Button
                variant="outline"
                className="border-destructive text-destructive hover:bg-destructive/10 hover:text-destructive"
                onClick={onConfirm}
                disabled={pending}
              >
                {pending ? <Loader2 className="animate-spin" aria-hidden="true" /> : null}
                {pending ? t("apply.applying") : t("apply.direct")}
              </Button>
              {pending ? (
                <Button disabled>{t("apply.switchFirst")}</Button>
              ) : (
                <Button asChild>
                  <Link href="/admin/publishing">{t("apply.switchFirst")}</Link>
                </Button>
              )}
            </>
          ) : (
            <Button onClick={onConfirm} disabled={pending}>
              {pending ? <Loader2 className="animate-spin" aria-hidden="true" /> : null}
              {pending ? t("apply.applying") : t("apply.confirm")}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
