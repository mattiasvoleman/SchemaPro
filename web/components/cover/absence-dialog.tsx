"use client";

import { useEffect, useMemo, useState } from "react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { Loader2, ShieldCheck } from "lucide-react";
import type { MessageLookup } from "@/lib/engine-message";
import { useAbsenceActions, useAbsenceReasons } from "@/lib/cover-queries";
import type { Absence } from "@/lib/cover-types";
import {
  absenceBody,
  absenceFormError,
  absenceFormOf,
  absencePatch,
  emptyAbsenceForm,
  NO_REASON,
  type AbsenceForm,
} from "@/lib/cover-absence-form";
import { coverErrorText, errorCode, errorParams, reasonName } from "@/lib/cover-view";
import { toDateString } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { DateField } from "@/components/ui/date-field";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

// Radix Select forbids an empty item value; this stands for "Ange inte".
const NONE = "__none__";

export interface AbsenceDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** ADMIN registers and edits anybody's; TEACHER reports their own (school policy). */
  mode: "ADMIN" | "TEACHER";
  /** Editing: the absence as the register read it (admin only). */
  absence?: Absence | null;
  /** Registering: the teacher and dates the page had chosen. */
  initial?: Partial<AbsenceForm>;
  /** Admin: the active teachers to choose among. */
  teachers?: { id: string; name: string }[];
  onSaved?: (absence: Absence) => void;
}

/**
 * Registrera frånvaro / Ändra frånvaro / Anmäl frånvaro.
 *
 * A teacher, a period (whole days, or a time on the first and/or the last
 * day) and a category from the school's list, or none. NO FREE TEXT: the
 * category is all a school needs to plan cover, and a note would become a
 * sick-leave register (the review's amendment H; the DTO refuses one too).
 *
 * An edit that drops lessons which already have a decision asks before
 * undoing them (409 ABSENCE_HAS_DECISIONS → undoDecisionsOutside).
 */
export function AbsenceDialog({
  open,
  onOpenChange,
  mode,
  absence,
  initial,
  teachers = [],
  onSaved,
}: AbsenceDialogProps) {
  const t = useTranslations("absenceForm");
  const tReasons = useTranslations("absenceReasons");
  const tErrors = useTranslations("coverErrors") as unknown as MessageLookup;
  const tCommon = useTranslations("common");
  const today = toDateString(new Date());

  const [form, setForm] = useState<AbsenceForm>(() => emptyAbsenceForm(today));
  const [shown, setShown] = useState(false);
  const [askUndo, setAskUndo] = useState<number | null>(null);
  const { data: reasons } = useAbsenceReasons(open);
  const { create, update } = useAbsenceActions();

  useEffect(() => {
    if (!open) return;
    setForm(absence ? absenceFormOf(absence) : { ...emptyAbsenceForm(today), ...initial });
    setShown(false);
    setAskUndo(null);
    // Reset only when the dialog opens: the form is the reader's while it is open.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const patchForm = (patch: Partial<AbsenceForm>) => setForm((current) => ({ ...current, ...patch }));
  const editing = Boolean(absence);
  const problem = absenceFormError(form, today, mode, !editing);
  const pending = create.isPending || update.isPending;

  const choices = useMemo(
    () =>
      (reasons ?? [])
        .filter((reason) => !reason.archived || reason.id === form.reasonId)
        .sort((a, b) => a.sortOrder - b.sortOrder),
    [reasons, form.reasonId],
  );

  const save = async (undoDecisionsOutside = false) => {
    setShown(true);
    if (problem) return;
    try {
      const saved = absence
        ? await update.mutateAsync({
            id: absence.id,
            patch: { ...absencePatch(form), ...(undoDecisionsOutside ? { undoDecisionsOutside: true } : {}) },
          })
        : await create.mutateAsync(absenceBody(form));
      toast.success(absence ? t("saved") : t("created"));
      setAskUndo(null);
      onSaved?.(saved);
      onOpenChange(false);
    } catch (error) {
      if (errorCode(error) === "ABSENCE_HAS_DECISIONS" && absence && !undoDecisionsOutside) {
        const count = errorParams(error).count;
        setAskUndo(typeof count === "number" ? count : 1);
        return;
      }
      toast.error(coverErrorText(tErrors, error, tCommon("error")));
    }
  };

  const title = editing ? t("editTitle") : mode === "TEACHER" ? t("selfTitle") : t("createTitle");

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>{title}</DialogTitle>
            <DialogDescription>{mode === "TEACHER" ? t("selfBody") : t("body")}</DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            {mode === "ADMIN" ? (
              <div className="space-y-1.5">
                <Label>{t("teacher")}</Label>
                <Select
                  value={form.userId}
                  onValueChange={(userId) => patchForm({ userId })}
                  disabled={editing}
                >
                  <SelectTrigger aria-label={t("teacher")}>
                    <SelectValue placeholder={t("teacherPlaceholder")} />
                  </SelectTrigger>
                  <SelectContent>
                    {teachers.map((teacher) => (
                      <SelectItem key={teacher.id} value={teacher.id}>
                        {teacher.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            ) : null}
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label htmlFor="absence-from">{t("from")}</Label>
                <DateField
                  id="absence-from"
                  label={t("from")}
                  value={form.from}
                  min={mode === "TEACHER" ? today : undefined}
                  onChange={(from) => patchForm({ from, ...(from > form.to ? { to: from } : {}) })}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="absence-to">{t("to")}</Label>
                <DateField
                  id="absence-to"
                  label={t("to")}
                  value={form.to}
                  min={form.from || undefined}
                  onChange={(to) => patchForm({ to })}
                />
              </div>
            </div>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={form.partDay}
                onChange={(event) => patchForm({ partDay: event.target.checked })}
              />
              {t("partDay")}
            </label>
            {form.partDay ? (
              <div className="space-y-1.5">
                <div className="grid grid-cols-2 gap-3">
                  <div className="space-y-1.5">
                    <Label htmlFor="absence-start">{t("startTime")}</Label>
                    <Input
                      id="absence-start"
                      type="time"
                      value={form.startTime}
                      onChange={(event) => patchForm({ startTime: event.target.value })}
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="absence-end">{t("endTime")}</Label>
                    <Input
                      id="absence-end"
                      type="time"
                      value={form.endTime}
                      onChange={(event) => patchForm({ endTime: event.target.value })}
                    />
                  </div>
                </div>
                <p className="text-xs text-muted-foreground">{t("timeHint")}</p>
              </div>
            ) : null}
            <div className="space-y-1.5">
              <Label>{t("reason")}</Label>
              <Select
                value={form.reasonId || NONE}
                onValueChange={(value) => patchForm({ reasonId: value === NONE ? NO_REASON : value })}
              >
                <SelectTrigger aria-label={t("reason")}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={NONE}>{t("reasonNone")}</SelectItem>
                  {choices.map((reason) => (
                    <SelectItem key={reason.id} value={reason.id}>
                      {reasonName(tReasons, reason)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="flex items-start gap-1.5 text-xs text-muted-foreground">
                <ShieldCheck className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                {t("reasonPrivacy")}
              </p>
            </div>
            {shown && problem ? (
              <p role="alert" className="text-sm text-destructive">
                {t(`errors.${problem}`)}
              </p>
            ) : null}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => onOpenChange(false)} disabled={pending}>
              {tCommon("cancel")}
            </Button>
            <Button onClick={() => void save()} disabled={pending}>
              {pending ? <Loader2 className="animate-spin" /> : null}
              {editing ? t("save") : t("create")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <ConfirmDialog
        open={askUndo !== null}
        onOpenChange={(next) => !next && setAskUndo(null)}
        title={t("undoTitle")}
        description={t("undoBody", { count: askUndo ?? 0 })}
        confirmLabel={t("undoConfirm")}
        loading={pending}
        onConfirm={() => void save(true)}
      />
    </>
  );
}
