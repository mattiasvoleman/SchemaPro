"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { ApiError } from "@/lib/api";
import {
  ABSENCE_WATCH_BASES,
  ABSENCE_WATCH_GROUPS,
  ABSENCE_WATCH_KINDS,
  FIGURES_OF,
  LIMIT_EXISTS,
  boundsOf,
  emptyLimitForm,
  figureErrors,
  figuresOfForm,
  formOfLimit,
  type AbsenceWatchBasis,
  type AbsenceWatchGroup,
  type AbsenceWatchKind,
  type AbsenceWatchLimit,
  type FigureField,
  type LimitForm,
} from "@/lib/absence-watch";
import { useAbsenceWatchActions } from "@/lib/absence-watch-queries";
import { useAbsenceWatchText } from "@/components/absence-watch/use-absence-watch-text";
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

const FIGURE_LABEL: Record<FigureField, string> = {
  percent: "form.percent",
  windowDays: "form.windowDays",
  consecutiveDays: "form.consecutiveDays",
};

/**
 * Add a limit, or change the figures of one.
 *
 * A limit belongs to a group, a kind and a basis, and those three are what its
 * findings belong to: the form offers them when adding and shows them fixed
 * when changing ("another is a new limit", as the gateway puts it). The figure
 * fields are the kind's: a share has a percent and a window, a run its days.
 * A school has one limit per group, kind and basis, and a second is answered
 * 409 ABSENCE_WATCH_LIMIT_EXISTS: said here, in the dialog, with the dialog
 * left open, never swallowed.
 */
export function LimitDialog({
  limit,
  onClose,
  onSaved,
}: {
  /** The limit being changed; null adds one. */
  limit: AbsenceWatchLimit | null;
  onClose: () => void;
  onSaved: (message: string) => void;
}) {
  const { t, limitText } = useAbsenceWatchText();
  const tCommon = useTranslations("common");
  const { createLimit, updateLimit } = useAbsenceWatchActions();
  const [form, setForm] = useState<LimitForm>(() => (limit ? formOfLimit(limit) : emptyLimitForm()));
  const [tried, setTried] = useState(false);
  const [refusal, setRefusal] = useState<string | null>(null);
  const pending = createLimit.isPending || updateLimit.isPending;

  const wrong = figureErrors(form);
  const set = <K extends keyof LimitForm>(key: K, value: LimitForm[K]) => {
    setForm((current) => ({ ...current, [key]: value }));
    setRefusal(null);
  };

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setTried(true);
    if (pending || wrong.length > 0) return;
    const figures = figuresOfForm(form);
    try {
      if (limit) {
        await updateLimit.mutateAsync({ id: limit.id, ...figures });
        onSaved(t("limits.updated"));
      } else {
        await createLimit.mutateAsync({ recipientGroup: form.recipientGroup, kind: form.kind, basis: form.basis, ...figures });
        onSaved(t("limits.added"));
      }
    } catch (error) {
      setRefusal(
        error instanceof ApiError && error.code === LIMIT_EXISTS
          ? t("form.exists", { group: t(`group.${form.recipientGroup}`) })
          : error instanceof Error
            ? error.message
            : tCommon("error"),
      );
    }
  };

  const figureError = (field: FigureField) => {
    if (!tried || !wrong.includes(field)) return undefined;
    const { min, max } = boundsOf(field);
    return t("form.range", { min, max });
  };

  const preview =
    wrong.length > 0
      ? null
      : limitText(
          form.kind === "SHARE"
            ? { kind: "SHARE", basis: form.basis, percent: Number(form.percent), windowDays: Number(form.windowDays), consecutiveDays: null }
            : { kind: "CONSECUTIVE", basis: form.basis, percent: null, windowDays: null, consecutiveDays: Number(form.consecutiveDays) },
        );

  return (
    <Dialog open onOpenChange={(open) => (!open && !pending ? onClose() : undefined)}>
      <DialogContent className="max-w-lg" closeDisabled={pending}>
        <DialogHeader>
          <DialogTitle>{limit ? t("form.editTitle") : t("form.addTitle")}</DialogTitle>
          <DialogDescription>{limit ? t("form.editBody") : t("form.addBody")}</DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} noValidate className="space-y-4" id="absence-watch-limit-form">
          <div className="grid gap-4 sm:grid-cols-2 [&>*]:min-w-0">
            <FormField id="limit-group" label={t("form.group")}>
              <NativeSelect
                value={form.recipientGroup}
                disabled={limit !== null}
                onChange={(event) => set("recipientGroup", event.target.value as AbsenceWatchGroup)}
              >
                {ABSENCE_WATCH_GROUPS.map((one) => (
                  <option key={one} value={one}>
                    {t(`group.${one}`)}
                  </option>
                ))}
              </NativeSelect>
            </FormField>
            <FormField id="limit-kind" label={t("form.kind")}>
              <NativeSelect
                value={form.kind}
                disabled={limit !== null}
                onChange={(event) => set("kind", event.target.value as AbsenceWatchKind)}
              >
                {ABSENCE_WATCH_KINDS.map((one) => (
                  <option key={one} value={one}>
                    {t(`kind.${one}`)}
                  </option>
                ))}
              </NativeSelect>
            </FormField>
          </div>
          <FormField id="limit-basis" label={t("form.basis")} hint={limit ? t("form.fixedHint") : undefined}>
            <NativeSelect
              value={form.basis}
              disabled={limit !== null}
              onChange={(event) => set("basis", event.target.value as AbsenceWatchBasis)}
            >
              {ABSENCE_WATCH_BASES.map((one) => (
                <option key={one} value={one}>
                  {t(`basisOption.${one}`)}
                </option>
              ))}
            </NativeSelect>
          </FormField>
          <div className="grid gap-4 sm:grid-cols-2 [&>*]:min-w-0">
            {FIGURES_OF[form.kind].map((field) => {
              const { min, max } = boundsOf(field);
              return (
                <FormField
                  key={field}
                  id={`limit-${field}`}
                  label={t(FIGURE_LABEL[field])}
                  hint={t("form.rangeHint", { min, max })}
                  error={figureError(field)}
                >
                  <Input
                    type="number"
                    inputMode="numeric"
                    min={min}
                    max={max}
                    step={1}
                    value={form[field]}
                    onChange={(event) => set(field, event.target.value)}
                  />
                </FormField>
              );
            })}
          </div>
          {preview ? (
            <p className="rounded-md bg-muted px-3 py-2 text-sm" aria-live="polite">
              {t("form.preview", { limit: preview, group: t(`group.${form.recipientGroup}`) })}
            </p>
          ) : null}
          {refusal ? (
            <Notice tone="destructive" title={t("form.failed")}>
              {refusal}
            </Notice>
          ) : null}
        </form>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose} disabled={pending}>
            {tCommon("cancel")}
          </Button>
          <Button type="submit" form="absence-watch-limit-form" disabled={pending}>
            {pending ? tCommon("saving") : tCommon("save")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
