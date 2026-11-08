"use client";

import { useState } from "react";
import { useChecklistActions } from "@/lib/checklists-queries";
import { askBody } from "@/lib/checklists";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Notice } from "@/components/ui/notice";
import type { DialogSpec } from "./dialog-spec";
import { EntryForm } from "./entry-form";
import { PupilCardBody } from "./pupil-card";
import { useChecklistsText } from "./use-checklists-text";
import { VoidForm } from "./void-form";

/**
 * Every dialog of Checklistor in one lazily fetched module (use-dialogs.tsx):
 * void a tick, a pupil's card, write an answer down, the question before asking
 * the guardians, and the question before ending a list. The open one is the
 * page's `spec`; each closes by calling `onClose`.
 */
export function ChecklistDialog({ spec, onClose }: { spec: DialogSpec; onClose: () => void }) {
  const { t } = useChecklistsText();
  const close = (open: boolean) => {
    if (!open) onClose();
  };

  switch (spec.kind) {
    case "void":
      return (
        <Dialog open onOpenChange={close}>
          <DialogContent className="max-w-md">
            <DialogHeader>
              <DialogTitle>{t("void.title")}</DialogTitle>
              <DialogDescription>{t("void.description")}</DialogDescription>
            </DialogHeader>
            <VoidForm proofId={spec.proofId} label={spec.label} onDone={onClose} onCancel={onClose} />
          </DialogContent>
        </Dialog>
      );
    case "card":
      return (
        <Dialog open onOpenChange={close}>
          <DialogContent className="max-w-2xl">
            <DialogHeader>
              <DialogTitle>{spec.name}</DialogTitle>
              <DialogDescription>{t("card.description")}</DialogDescription>
            </DialogHeader>
            <PupilCardBody studentId={spec.studentId} />
          </DialogContent>
        </Dialog>
      );
    case "entry":
      return (
        <Dialog open onOpenChange={close}>
          <DialogContent className="max-w-lg">
            <DialogHeader>
              <DialogTitle>{t(`entry.title.${spec.entryKind}`)}</DialogTitle>
              <DialogDescription>{t(`entry.description.${spec.entryKind}`)}</DialogDescription>
            </DialogHeader>
            <EntryForm
              listId={spec.listId}
              kind={spec.entryKind}
              studentIds={spec.studentIds}
              onDone={(written) => {
                spec.onDone(written);
                onClose();
              }}
              onCancel={onClose}
            />
          </DialogContent>
        </Dialog>
      );
    case "ask":
      return <AskDialog spec={spec} onClose={onClose} />;
    case "close":
      return <CloseDialog spec={spec} onClose={onClose} />;
  }
}

/**
 * The question before the guardians are asked: a notice goes to their phones and
 * the question cannot be taken back, so it is asked once, with what will happen,
 * and a refusal is said here with the dialog left open.
 */
function AskDialog({ spec, onClose }: { spec: Extract<DialogSpec, { kind: "ask" }>; onClose: () => void }) {
  const { t, tCommon, refusal } = useChecklistsText();
  const { ask } = useChecklistActions();
  const [problem, setProblem] = useState<string | null>(null);
  const pending = ask.isPending;

  const send = async () => {
    setProblem(null);
    try {
      const asked = await ask.mutateAsync({ id: spec.listId, body: askBody(spec.studentIds ?? []) });
      spec.onDone(asked);
      onClose();
    } catch (error) {
      setProblem(refusal(error));
    }
  };

  return (
    <Dialog open onOpenChange={(open) => (!open && !pending ? onClose() : undefined)}>
      <DialogContent className="max-w-md" closeDisabled={pending}>
        <DialogHeader>
          <DialogTitle>{t("ask.title")}</DialogTitle>
          <DialogDescription>{t(spec.studentIds ? "ask.chosen" : "ask.unanswered", { count: spec.count })}</DialogDescription>
        </DialogHeader>
        <p className="text-sm">{t("ask.how")}</p>
        <p className="text-sm text-muted-foreground">{t("ask.final")}</p>
        {problem ? (
          <Notice tone="destructive" title={t("ask.failed")}>
            {problem}
          </Notice>
        ) : null}
        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose} disabled={pending}>
            {tCommon("cancel")}
          </Button>
          <Button type="button" onClick={() => void send()} disabled={pending}>
            {pending ? t("ask.sending") : t("ask.submit")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** The question before a list is ended: it takes no more answers, and what was written stays. */
function CloseDialog({ spec, onClose }: { spec: Extract<DialogSpec, { kind: "close" }>; onClose: () => void }) {
  const { t, tCommon, refusal } = useChecklistsText();
  const { close } = useChecklistActions();
  const [problem, setProblem] = useState<string | null>(null);
  const pending = close.isPending;

  const end = async () => {
    setProblem(null);
    try {
      await close.mutateAsync(spec.listId);
      spec.onDone();
      onClose();
    } catch (error) {
      setProblem(refusal(error));
    }
  };

  return (
    <Dialog open onOpenChange={(open) => (!open && !pending ? onClose() : undefined)}>
      <DialogContent className="max-w-md" closeDisabled={pending}>
        <DialogHeader>
          <DialogTitle>{t("close.title", { title: spec.title })}</DialogTitle>
          <DialogDescription>{t("close.description")}</DialogDescription>
        </DialogHeader>
        <p className="text-sm text-muted-foreground">{t("close.guardians")}</p>
        {problem ? (
          <Notice tone="destructive" title={t("close.failed")}>
            {problem}
          </Notice>
        ) : null}
        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose} disabled={pending}>
            {tCommon("cancel")}
          </Button>
          <Button type="button" variant="destructive" onClick={() => void end()} disabled={pending}>
            {pending ? t("close.closing") : t("close.submit")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
