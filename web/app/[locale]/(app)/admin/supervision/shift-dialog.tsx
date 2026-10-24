"use client";

import { useEffect, useState, type FormEvent } from "react";
import { useTranslations } from "next-intl";
import { ApiError } from "@/lib/api";
import {
  clockOf,
  shiftBody,
  shiftDraftFault,
  type ShiftDraft,
  type SupervisionArea,
  type SupervisionShift,
} from "@/lib/supervision";
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
import { Notice } from "@/components/ui/notice";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import type { ShiftBody } from "./use-supervision";

/** What a new pass starts from: a break's area, day and time, and a gap's dates. */
export type ShiftSeed = Partial<Omit<ShiftDraft, "note">>;

export interface ShiftDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The pass edited; null adds one from `seed`. */
  shift: SupervisionShift | null;
  seed: ShiftSeed;
  areas: readonly SupervisionArea[];
  /** Active staff, by name: who may be given a pass. */
  teachers: readonly { id: string; name: string }[];
  weekdays: readonly number[];
  year: { startDate: string; endDate: string } | null;
  saving: boolean;
  onSave: (body: ShiftBody) => Promise<void>;
  /** Present for an existing pass: removes it. */
  onDelete?: () => void;
}

const BLANK: ShiftDraft = {
  areaId: "",
  userId: "",
  dayOfWeek: 1,
  startTime: "",
  endTime: "",
  validFrom: "",
  validTo: "",
  note: "",
};

/**
 * Ett rastvaktspass: who watches which area, on which weekday, from when to
 * when, and between which dates. The dialog says what the gateway would
 * refuse before it is asked (lib/supervision.ts shiftDraftFault); the one
 * thing only the gateway knows is a clash with the teacher's other passes,
 * which comes back as SUPERVISION_SHIFT_CLASH naming the other one.
 */
export function ShiftDialog({
  open,
  onOpenChange,
  shift,
  seed,
  areas,
  teachers,
  weekdays,
  year,
  saving,
  onSave,
  onDelete,
}: ShiftDialogProps) {
  const t = useTranslations("supervision.shift");
  const tCommon = useTranslations("common");
  const tDays = useTranslations("days");
  const [draft, setDraft] = useState<ShiftDraft>(BLANK);
  const [touched, setTouched] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setError(null);
    setTouched(false);
    setDraft(
      shift
        ? {
            areaId: shift.areaId,
            userId: shift.userId,
            dayOfWeek: shift.dayOfWeek,
            startTime: clockOf(shift.startTime),
            endTime: clockOf(shift.endTime),
            validFrom: shift.validFrom ?? "",
            validTo: shift.validTo ?? "",
            note: shift.note ?? "",
          }
        : { ...BLANK, ...seed },
    );
    // The seed is read when the dialog opens, not on every render of the page.
  }, [open, shift]);

  const fault = shiftDraftFault(draft, year);
  const faultText =
    fault === "outsideYear" && year
      ? t("faults.outsideYear", { from: year.startDate, to: year.endDate })
      : fault
        ? t(`faults.${fault}`)
        : null;
  // A fault is said once the admin has tried to save, or where it is about
  // a field they have filled in: an empty form is not wrong yet.
  const shown = touched || (fault !== null && !["areaMissing", "teacherMissing", "timeMissing"].includes(fault));

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setTouched(true);
    if (fault) return;
    setError(null);
    try {
      await onSave(shiftBody(draft));
      onOpenChange(false);
    } catch (caught) {
      setError(
        caught instanceof ApiError && caught.code && t.has(`errors.${caught.code}`)
          ? t(`errors.${caught.code}`)
          : caught instanceof Error
            ? caught.message
            : tCommon("error"),
      );
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <form onSubmit={submit} noValidate>
          <DialogHeader>
            <DialogTitle>{shift ? t("editTitle") : t("addTitle")}</DialogTitle>
            <DialogDescription>{t("dialogHint")}</DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-4">
            {error ? (
              <Notice tone="destructive" title={t("saveFailed")}>
                {error}
              </Notice>
            ) : null}
            {shown && faultText ? (
              <Notice tone="warning" role={null}>
                {faultText}
              </Notice>
            ) : null}
            <FormField id="supervision-shift-area" label={t("area")}>
              {(control) => (
                <Select value={draft.areaId || undefined} onValueChange={(value) => setDraft({ ...draft, areaId: value })}>
                  <SelectTrigger {...control}>
                    <SelectValue placeholder={tCommon("select")} />
                  </SelectTrigger>
                  <SelectContent>
                    {areas.map((area) => (
                      <SelectItem key={area.id} value={area.id}>
                        {area.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
            </FormField>
            <FormField id="supervision-shift-teacher" label={t("teacher")}>
              {(control) => (
                <Select value={draft.userId || undefined} onValueChange={(value) => setDraft({ ...draft, userId: value })}>
                  <SelectTrigger {...control}>
                    <SelectValue placeholder={tCommon("select")} />
                  </SelectTrigger>
                  <SelectContent>
                    {teachers.map((teacher) => (
                      <SelectItem key={teacher.id} value={teacher.id}>
                        {teacher.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
            </FormField>
            <FormField id="supervision-shift-day" label={t("day")}>
              {(control) => (
                <Select
                  value={String(draft.dayOfWeek)}
                  onValueChange={(value) => setDraft({ ...draft, dayOfWeek: Number(value) })}
                >
                  <SelectTrigger {...control}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {weekdays.map((day) => (
                      <SelectItem key={day} value={String(day)}>
                        {tDays(String(day))}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
            </FormField>
            <div className="grid gap-4 sm:grid-cols-2 [&>*]:min-w-0">
              <FormField id="supervision-shift-start" label={t("start")}>
                <Input
                  type="time"
                  value={draft.startTime}
                  onChange={(event) => setDraft({ ...draft, startTime: event.target.value })}
                />
              </FormField>
              <FormField id="supervision-shift-end" label={t("end")}>
                <Input
                  type="time"
                  value={draft.endTime}
                  onChange={(event) => setDraft({ ...draft, endTime: event.target.value })}
                />
              </FormField>
              <FormField id="supervision-shift-from" label={t("validFrom")} optional>
                <Input
                  type="date"
                  min={year?.startDate}
                  max={year?.endDate}
                  value={draft.validFrom}
                  onChange={(event) => setDraft({ ...draft, validFrom: event.target.value })}
                />
              </FormField>
              <FormField id="supervision-shift-to" label={t("validTo")} optional>
                <Input
                  type="date"
                  min={year?.startDate}
                  max={year?.endDate}
                  value={draft.validTo}
                  onChange={(event) => setDraft({ ...draft, validTo: event.target.value })}
                />
              </FormField>
            </div>
            <FormField id="supervision-shift-note" label={t("note")} optional>
              <Input
                maxLength={200}
                placeholder={t("notePlaceholder")}
                value={draft.note}
                onChange={(event) => setDraft({ ...draft, note: event.target.value })}
              />
            </FormField>
          </div>
          <DialogFooter className="gap-2 sm:justify-between">
            {onDelete ? (
              <Button type="button" variant="outline" onClick={onDelete}>
                {t("delete")}
              </Button>
            ) : (
              <span />
            )}
            <div className="flex gap-2">
              <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
                {tCommon("cancel")}
              </Button>
              <Button type="submit" disabled={saving}>
                {saving ? tCommon("saving") : tCommon("save")}
              </Button>
            </div>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
