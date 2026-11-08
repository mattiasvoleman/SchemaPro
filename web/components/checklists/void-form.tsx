"use client";

import { useState } from "react";
import { toast } from "sonner";
import { ApiError } from "@/lib/api";
import { useChecklistActions } from "@/lib/checklists-queries";
import { CHECKLIST_NOT_FOUND, CHECKLIST_NOT_STAFF, REASON_MAX, voidProblem } from "@/lib/checklists";
import { Button } from "@/components/ui/button";
import { FormField } from "@/components/ui/form-field";
import { Notice } from "@/components/ui/notice";
import { Textarea } from "@/components/ui/textarea";
import { useChecklistsText } from "./use-checklists-text";

/**
 * Void a tick made in error: the reason is asked for and kept. The tick is not
 * deleted; it stays on the pupil's card as voided, with who voided it, when and
 * why, and the form says so before it is sent.
 *
 * Only the person who made a tick, or an administrator, can void it. The
 * gateway answers anyone else with "no such tick" (it is not theirs to see), and
 * the form says that in words a teacher can act on.
 */
export function VoidForm({
  proofId,
  label,
  onDone,
  onCancel,
}: {
  proofId: string;
  /** The tick, as the person reads it ("Ada Berg, 3 okt. 2026"). */
  label: string;
  onDone: () => void;
  onCancel: () => void;
}) {
  const { t, tCommon, refusal } = useChecklistsText();
  const { voidProof } = useChecklistActions();
  const [reason, setReason] = useState("");
  const [tried, setTried] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const pending = voidProof.isPending;
  const wrong = voidProblem(reason);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (pending) return;
    setTried(true);
    setProblem(null);
    if (wrong) {
      document.getElementById("void-reason")?.focus();
      return;
    }
    try {
      await voidProof.mutateAsync({ id: proofId, reason: reason.trim() });
      toast.success(t("void.done"));
      onDone();
    } catch (error) {
      const notYours = error instanceof ApiError && (error.code === CHECKLIST_NOT_FOUND || error.code === CHECKLIST_NOT_STAFF);
      setProblem(notYours ? t("void.notYours") : refusal(error));
    }
  };

  return (
    <form onSubmit={submit} noValidate className="space-y-4" aria-busy={pending || undefined}>
      <p className="rounded-md bg-muted px-3 py-2 text-sm font-medium">{label}</p>
      <Notice tone="neutral">{t("void.stays")}</Notice>
      <FormField
        id="void-reason"
        label={t("void.reasonLabel")}
        hint={`${t("void.reasonHint")} ${t("counter", { count: reason.trim().length, max: REASON_MAX })}`}
        error={tried && wrong ? t(`void.problem.${wrong}`, { max: REASON_MAX }) : undefined}
      >
        <Textarea rows={3} value={reason} onChange={(event) => setReason(event.target.value)} disabled={pending} />
      </FormField>
      {problem ? (
        <Notice tone="destructive" title={t("void.failed")}>
          {problem}
        </Notice>
      ) : null}
      <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
        <Button type="button" variant="outline" onClick={onCancel} disabled={pending}>
          {tCommon("cancel")}
        </Button>
        <Button type="submit" variant="destructive" disabled={pending}>
          {pending ? t("void.voiding") : t("void.submit")}
        </Button>
      </div>
    </form>
  );
}
