"use client";

/*
 * Frågan före en ändring i Direkt som når familjer (P5, beslut 8). Fetched on its own, the first time a school is asked
 * (lib/use-direct-reach-ask.tsx): a question asked once per school belongs in no page's first load.
 *
 * It says what a change does (the published lessons move in the calendar at once), who gets the notice (the pupils of the lesson and their
 * guardians; the counts are the school's, not the change's), and offers the other way: utkast, where nothing reaches anybody until a
 * publish. "Fortsätt i Direkt" is the answer the gateway keeps; "Använd utkast" switches the school's mode (which also takes an old
 * answer back); Avbryt leaves everything as it was, the change included.
 */

import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { apiErrorText } from "@/lib/api-error-text";
import { useAcknowledgeDirectReach, type DirectReach } from "@/lib/direct-reach";
import { useSwitchPublishMode } from "@/lib/publication-queries";

export interface DirectReachDialogProps {
  reach: DirectReach;
  /** The school has answered: "Fortsätt i Direkt" was kept, or the school is in utkast now. */
  onAnswered: (answer: "DIRECT" | "DRAFT") => void;
  /** Avbryt, Escape or a click outside. */
  onDeclined: () => void;
}

export function DirectReachDialog({ reach, onAnswered, onDeclined }: DirectReachDialogProps) {
  const t = useTranslations("directReach");
  const tCommon = useTranslations("common");
  const acknowledge = useAcknowledgeDirectReach();
  const switchMode = useSwitchPublishMode();
  const busy = acknowledge.isPending || switchMode.isPending;

  const stay = async () => {
    try {
      await acknowledge.mutateAsync(reach.academicYearId);
      onAnswered("DIRECT");
    } catch (error) {
      toast.error(apiErrorText(error, tCommon));
    }
  };
  const draft = async () => {
    try {
      await switchMode.mutateAsync("DRAFT");
      onAnswered("DRAFT");
    } catch (error) {
      toast.error(apiErrorText(error, tCommon));
    }
  };

  return (
    <Dialog open onOpenChange={(open) => (!open && !busy ? onDeclined() : undefined)}>
      <DialogContent
        className="max-w-lg"
        closeDisabled={busy}
        onEscapeKeyDown={(event) => {
          if (busy) event.preventDefault();
        }}
        onInteractOutside={(event) => {
          if (busy) event.preventDefault();
        }}
      >
        <DialogHeader>
          <DialogTitle>{t("title")}</DialogTitle>
          <DialogDescription>
            {reach.period ? t("published", { from: reach.period.from, to: reach.period.to }) : t("publishedNoPeriod")}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3 text-sm">
          <p>{t("who")}</p>
          {reach.audience ? (
            <p data-testid="direct-reach-audience">
              {t("audience", { pupils: reach.audience.pupils, guardians: reach.audience.guardians })}
            </p>
          ) : null}
          <p>{t("draftOffer")}</p>
          <p className="text-muted-foreground">{t("onlyOnce")}</p>
        </div>
        <DialogFooter className="gap-2 sm:gap-2">
          <Button variant="outline" onClick={onDeclined} disabled={busy}>
            {tCommon("cancel")}
          </Button>
          <Button variant="outline" onClick={() => void draft()} disabled={busy}>
            {switchMode.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden /> : null}
            {t("useDraft")}
          </Button>
          <Button onClick={() => void stay()} disabled={busy}>
            {acknowledge.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden /> : null}
            {t("stayDirect")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
