"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

export interface DecideDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  planName: string;
  pending: boolean;
  /** Called with the trimmed note; the dialog closes itself only when this resolves. */
  onConfirm: (decisionNote: string) => Promise<void>;
}

/**
 * Besluta: the one field the decision needs, the note that identifies it.
 *
 * The note is REQUIRED and checked here with the gateway's own bounds
 * (DecideLocalTimplanDto: non-blank, at most 500), so the admin reads why the
 * button does nothing before a round trip rather than after. The body says
 * what the decision does to the grid — it locks — and how to change a decided
 * plan afterwards, because the next thing an admin wants after deciding is
 * usually one more change.
 *
 * Loaded on the click (React.lazy in the page), like every dialog there.
 */
export function DecideDialog({ open, onOpenChange, planName, pending, onConfirm }: DecideDialogProps) {
  const t = useTranslations("timplan");
  const tCommon = useTranslations("common");
  const [note, setNote] = useState("");
  const [touched, setTouched] = useState(false);

  const trimmed = note.trim();
  const problem =
    trimmed === "" ? t("decisionNoteRequired") : note.length > 500 ? t("decisionNoteTooLong") : null;

  const submit = async () => {
    setTouched(true);
    if (problem) return;
    await onConfirm(trimmed);
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (pending) return;
        if (!next) {
          setNote("");
          setTouched(false);
        }
        onOpenChange(next);
      }}
    >
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{t("decideTitle")}</DialogTitle>
          <DialogDescription>{t("decideBody", { name: planName })}</DialogDescription>
        </DialogHeader>
        <div className="space-y-2">
          <Label htmlFor="timplan-decision-note">{t("decisionNoteLabel")}</Label>
          <Textarea
            id="timplan-decision-note"
            value={note}
            maxLength={600}
            placeholder={t("decisionNotePlaceholder")}
            aria-invalid={(touched && problem !== null) || undefined}
            aria-describedby="timplan-decision-note-hint"
            onChange={(event) => setNote(event.target.value)}
            onBlur={() => setTouched(true)}
          />
          <p id="timplan-decision-note-hint" className="text-xs text-muted-foreground">
            {t("decisionNoteHint")}
          </p>
          {touched && problem ? (
            <p role="alert" className="text-sm text-destructive">
              {problem}
            </p>
          ) : null}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={pending}>
            {tCommon("cancel")}
          </Button>
          <Button onClick={() => void submit()} disabled={pending}>
            {t("decideConfirm")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
