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
  /** The check is being read again (it is, each time the dialog opens): its counts are not yet today's. */
  checking: boolean;
  /**
   * That read failed (a network error, the check's throttle). The check in
   * hand is then the last good one, perhaps from page load, so nothing is
   * confirmed on it: the dialog says so and offers the read again.
   */
  checkFailed: boolean;
  onRetryCheck: () => void;
  /** Where focus goes on close when the opener can no longer take it. */
  onCloseAutoFocus?: (event: Event) => void;
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
 * The page reads the check again as the dialog opens, so the counts and the
 * verdict are the moment's, not the page load's: nothing can be confirmed
 * until that read is back and succeeded — a failed read leaves only the old
 * counts, so it blocks too, with a retry — and a batch it finds stale or
 * refused cannot be confirmed at all (the apply would answer 409 anyway).
 *
 * Focus is the shared DialogContent's: the first control on open, back to
 * the button that opened it on close, and nothing can close the dialog while
 * the write is in flight.
 */
export function ApplyDialog({
  candidate,
  label,
  check,
  checking,
  checkFailed,
  onRetryCheck,
  onCloseAutoFocus,
  pending,
  onOpenChange,
  onConfirm,
}: ApplyDialogProps) {
  const t = useTranslations("scheduleCandidates");
  const tCommon = useTranslations("common");
  const direct = check?.mode === "DIRECT";
  const ordinal = candidate?.ordinal ?? 0;
  const failed = !checking && checkFailed;
  const noLonger = !checking && !failed && check !== null && (check.stale || check.refusalCode !== null);
  const blocked = pending || checking || failed || noLonger || check === null;

  return (
    <Dialog open={candidate !== null} onOpenChange={(open) => (pending ? undefined : onOpenChange(open))}>
      <DialogContent
        className="max-w-lg"
        closeDisabled={pending}
        onCloseAutoFocus={onCloseAutoFocus}
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

        {checking ? (
          <p role="status" aria-busy="true" className="text-sm text-foreground">
            {t("apply.checking")}
          </p>
        ) : failed ? (
          <Notice
            tone="destructive"
            title={t("check.failed")}
            action={
              <Button variant="outline" size="sm" onClick={onRetryCheck}>
                {t("check.retry")}
              </Button>
            }
          >
            {t("check.failedHint")}
          </Notice>
        ) : noLonger ? (
          <Notice tone="warning" title={t("apply.noLonger")}>
            {t("apply.noLongerHint")}
          </Notice>
        ) : direct && check ? (
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
                data-writes="SCHEMALAGGNING DRIFT"
                onClick={onConfirm}
                disabled={blocked}
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
            <Button data-writes="SCHEMALAGGNING DRIFT" onClick={onConfirm} disabled={blocked}>
              {pending ? <Loader2 className="animate-spin" aria-hidden="true" /> : null}
              {pending ? t("apply.applying") : t("apply.confirm")}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
