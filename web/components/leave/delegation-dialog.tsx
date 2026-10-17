"use client";

import { useState } from "react";
import { useLocale, useTranslations } from "next-intl";
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
import { FormField } from "@/components/ui/form-field";
import { Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/ui/native-select";
import type { LeaveDelegation } from "@/lib/leave-queries";

export interface DelegationDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  current: LeaveDelegation | null;
  history: LeaveDelegation[];
  pending: boolean;
  /** Records the decision; the dialog closes itself only when this resolves. */
  onSave: (body: { mentorMaxSchoolDays: number | null; reference?: string }) => Promise<void>;
}

const LIMITS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];

/**
 * Rektor's delegation of leave decisions to the pupil's mentor: at most how
 * many skoldagar a request the mentor decides, or none. A new decision every
 * time, never an edit (the database keeps them all), so the dialog shows the
 * earlier ones under the form. Ten is the most the gateway takes: längre
 * ledighet stays with rektor. The body says that a jurist should confirm the
 * limit; the product suggests none.
 *
 * Loaded on the click (React.lazy in the page).
 */
export function DelegationDialog({ open, onOpenChange, current, history, pending, onSave }: DelegationDialogProps) {
  const t = useTranslations("adminLeave");
  const tInbox = useTranslations("leaveInbox");
  const tCommon = useTranslations("common");
  const locale = useLocale();
  const [limit, setLimit] = useState<string>(current?.mentorMaxSchoolDays == null ? "" : String(current.mentorMaxSchoolDays));
  const [reference, setReference] = useState(current?.reference ?? "");
  const when = new Intl.DateTimeFormat(locale, { dateStyle: "medium" });

  const tooLong = reference.length > 200;
  const save = async () => {
    if (tooLong) return;
    const trimmed = reference.trim();
    await onSave({ mentorMaxSchoolDays: limit === "" ? null : Number(limit), ...(trimmed ? { reference: trimmed } : {}) });
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (pending) return;
        onOpenChange(next);
      }}
    >
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{t("delegationDialogTitle")}</DialogTitle>
          <DialogDescription>{t("delegationDialogBody")}</DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <FormField id="leave-delegation-limit" label={t("delegationLimitLabel")} hint={t("delegationLimitHint")}>
            <NativeSelect value={limit} onChange={(event) => setLimit(event.target.value)} disabled={pending}>
              <option value="">{t("delegationNone")}</option>
              {LIMITS.map((value) => (
                <option key={value} value={String(value)}>
                  {t("delegationLimitOption", { count: value })}
                </option>
              ))}
            </NativeSelect>
          </FormField>
          <FormField
            id="leave-delegation-reference"
            optional
            label={t("delegationReferenceLabel")}
            hint={t("delegationReferenceHint")}
            error={tooLong ? t("delegationReferenceTooLong") : undefined}
          >
            <Input value={reference} maxLength={240} onChange={(event) => setReference(event.target.value)} disabled={pending} />
          </FormField>
          {history.length > 0 ? (
            <section aria-labelledby="leave-delegation-history" className="space-y-2">
              <h3 id="leave-delegation-history" className="text-sm font-medium">
                {t("delegationHistory")}
              </h3>
              <ul className="divide-y rounded-md border">
                {history.map((entry) => (
                  <li key={entry.decidedAt} className="px-3 py-2 text-sm">
                    <span className="font-medium">
                      {entry.mentorMaxSchoolDays === null
                        ? tInbox("delegationNoneTitle")
                        : tInbox("delegationTitle", { count: entry.mentorMaxSchoolDays })}
                    </span>
                    <span className="block text-xs text-muted-foreground">
                      {when.format(new Date(entry.decidedAt))} · {entry.decidedBy ?? "—"}
                      {entry.reference ? ` · ${entry.reference}` : ""}
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={pending}>
            {tCommon("cancel")}
          </Button>
          <Button onClick={() => void save()} disabled={pending || tooLong} data-writes="DECIDES">
            {pending ? <Loader2 className="animate-spin" aria-hidden="true" /> : null}
            {pending ? t("delegationSaving") : t("delegationSave")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
