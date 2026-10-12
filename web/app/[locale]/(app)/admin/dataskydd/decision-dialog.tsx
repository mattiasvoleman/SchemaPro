"use client";

/*
 * One kind's decision: ej beslutat, bevaras, or a period, with an optional
 * reference to the dokumenthanteringsplan. The dialog counts what the chosen
 * period would take today before anything is saved (app.gallring_preview,
 * the same predicate the night reads), and says plainly that a purge cannot
 * be undone. Saving records a decision; it removes nothing. A period that
 * gallrar more than the one in force waits a day (the page then says which
 * night), one that gallrar less applies at once.
 */

import { useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";
import type { MessageLookup } from "@/lib/engine-message";
import {
  formatRetentionDay,
  PERIOD_CHOICES,
  type RetentionDecisionKind,
  type RetentionKind,
} from "@/lib/retention-types";
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
import { Notice } from "@/components/ui/notice";
import { periodLabel } from "./period";
import { retentionErrorText, useRecordDecision, useRetentionPreview } from "./use-retention";

type Choice = "UNDECIDED" | "KEEP" | `${number}`;

function choiceOf(kind: RetentionKind): Choice {
  const current = kind.current;
  if (!current || current.decision === "UNDECIDED") return "UNDECIDED";
  if (current.decision === "KEEP") return "KEEP";
  return `${current.months ?? 12}`;
}

export function DecisionDialog({
  kind,
  open,
  onOpenChange,
}: {
  kind: RetentionKind;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const t = useTranslations("dataProtection");
  const tErrors = useTranslations("dataProtection.errors") as unknown as MessageLookup;
  const tCommon = useTranslations("common");
  const locale = useLocale();
  const record = useRecordDecision();
  const initial = choiceOf(kind);
  const [choice, setChoice] = useState<Choice>(initial);
  const [reference, setReference] = useState(kind.current?.reference ?? "");
  const [problem, setProblem] = useState<string | null>(null);

  const months = choice === "UNDECIDED" || choice === "KEEP" ? null : Number(choice);
  const preview = useRetentionPreview(kind.dataType, months);
  const people = kind.dataType === "DEPARTED_PEOPLE";
  const name = t(`kind.${kind.dataType}.name`);
  const periods = [...new Set([...PERIOD_CHOICES, ...(months !== null ? [months] : [])])].sort((a, b) => a - b);
  const unchanged = choice === initial && reference.trim() === (kind.current?.reference ?? "");
  const willTake = months !== null && (preview.data?.due ?? 0) > 0;

  const save = async () => {
    setProblem(null);
    const decision: RetentionDecisionKind = months !== null ? "PURGE_AFTER" : (choice as RetentionDecisionKind);
    try {
      await record.mutateAsync({
        dataType: kind.dataType,
        decision,
        ...(months !== null ? { months } : {}),
        ...(reference.trim() ? { reference: reference.trim() } : {}),
      });
      toast.success(t("saved"));
      onOpenChange(false);
    } catch (error) {
      setProblem(retentionErrorText(tErrors, error, tCommon("error")));
    }
  };

  return (
    <Dialog open={open} onOpenChange={(next) => (record.isPending ? undefined : onOpenChange(next))}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{t("dialogTitle", { kind: name })}</DialogTitle>
          <DialogDescription>{t(`kind.${kind.dataType}.body`)}</DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <FormField id="retention-choice" label={t("choiceLabel")}>
            <NativeSelect value={choice} onChange={(event) => setChoice(event.target.value as Choice)}>
              <option value="UNDECIDED">{t("undecided")}</option>
              <option value="KEEP">{t("choiceKeep")}</option>
              {periods.map((value) => (
                <option key={value} value={String(value)}>
                  {t(people ? "choicePeriodPeople" : "choicePeriod", {
                    period: periodLabel(value, (key, values) => t(key, values)),
                  })}
                </option>
              ))}
            </NativeSelect>
          </FormField>
          <FormField id="retention-reference" label={t("referenceLabel")} hint={t("referenceHint")} optional>
            <Input value={reference} maxLength={200} onChange={(event) => setReference(event.target.value)} />
          </FormField>

          <div aria-live="polite" className="min-h-10 text-sm">
            {months === null ? (
              <p className="text-muted-foreground">{t(choice === "KEEP" ? "previewKeep" : "previewUndecided")}</p>
            ) : preview.isError ? (
              <p className="text-muted-foreground">{t("previewFailed")}</p>
            ) : !preview.data ? (
              <p className="text-muted-foreground">{t("previewLoading")}</p>
            ) : (
              <div className={preview.isFetching ? "space-y-1 opacity-60" : "space-y-1"}>
                <p>
                  {t(people ? "previewPeople" : "previewRows", {
                    count: preview.data.due,
                    date: formatRetentionDay(preview.data.cutoff, locale),
                  })}
                </p>
                {people && preview.data.held > 0 ? (
                  <p className="text-muted-foreground">{t("previewHeld", { count: preview.data.held })}</p>
                ) : null}
              </div>
            )}
          </div>

          {willTake ? (
            <Notice tone="warning" title={t("dialogWarningTitle")}>
              {t("dialogWarning")}
            </Notice>
          ) : null}
          {problem ? <Notice tone="destructive">{problem}</Notice> : null}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={record.isPending}>
            {tCommon("cancel")}
          </Button>
          <Button variant={willTake ? "destructive" : "default"} onClick={save} disabled={record.isPending || unchanged}>
            {record.isPending ? <Loader2 className="size-4 animate-spin" aria-hidden /> : null}
            {record.isPending ? tCommon("saving") : t("save")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
