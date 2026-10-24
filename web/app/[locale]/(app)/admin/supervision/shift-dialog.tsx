"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { useTranslations } from "next-intl";
import { ApiError } from "@/lib/api";
import {
  FAULT_FIELD,
  clashOf,
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
  /** Who may be given a pass, by name; the edited pass's own teacher too, whatever they are now. */
  teachers: readonly { id: string; name: string }[];
  /** The läsår's passes, for the clash the gateway would refuse. */
  shifts: readonly SupervisionShift[];
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

type Field = (typeof FAULT_FIELD)[keyof typeof FAULT_FIELD];
const fieldId = (field: Field) => `supervision-shift-${field}`;

/**
 * Ett rastvaktspass: who watches which area, on which weekday, from when to
 * when, and between which dates. Each refusal the gateway would make is said
 * beside its field before the save (lib/supervision.ts shiftDraftFault), and
 * a save it would refuse moves focus to that field: the one-place-at-a-time
 * clash too, named from the schedule the page holds (clashOf). Only a clash
 * with a pass saved by someone else meanwhile comes back from the gateway,
 * as SUPERVISION_SHIFT_CLASH.
 */
export function ShiftDialog({
  open,
  onOpenChange,
  shift,
  seed,
  areas,
  teachers,
  shifts,
  weekdays,
  year,
  saving,
  onSave,
  onDelete,
}: ShiftDialogProps) {
  const t = useTranslations("supervision.shift");
  const tSupervision = useTranslations("supervision");
  const tCommon = useTranslations("common");
  const tDays = useTranslations("days");
  const [draft, setDraft] = useState<ShiftDraft>(BLANK);
  const [touched, setTouched] = useState(false);
  /** A date field the browser holds half-typed: it reports "", which is not "no date". */
  const [badDates, setBadDates] = useState<{ from: boolean; to: boolean }>({ from: false, to: false });
  const [error, setError] = useState<string | null>(null);
  const form = useRef<HTMLFormElement>(null);

  useEffect(() => {
    if (!open) return;
    setError(null);
    setTouched(false);
    setBadDates({ from: false, to: false });
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
  const clash = fault ? null : clashOf(draft, shifts, shift?.id ?? null);
  // A fault is said once the admin has tried to save, or where it is about
  // what they have filled in: an empty form is not wrong yet.
  const said = (key: string) => touched || !["areaMissing", "teacherMissing", "timeMissing"].includes(key);
  const errors: Partial<Record<Field, string>> = {};
  if (badDates.from) errors.from = t("faults.dateInvalid");
  if (badDates.to) errors.to = t("faults.dateInvalid");
  if (fault && said(fault)) {
    errors[FAULT_FIELD[fault]] ??=
      fault === "outsideYear" && year
        ? t("faults.outsideYear", { from: year.startDate, to: year.endDate })
        : t(`faults.${fault}`);
  }
  if (clash) {
    errors.teacher = t("faults.clash", {
      area: areas.find((area) => area.id === clash.areaId)?.name ?? "",
      day: tSupervision("dayName", { day: String(clash.dayOfWeek) }),
      start: clockOf(clash.startTime),
      end: clockOf(clash.endTime),
    });
  }
  const refused = fault !== null || clash !== null || badDates.from || badDates.to;

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setTouched(true);
    if (refused) {
      const first = (["area", "teacher", "start", "end", "from", "to", "note"] as const).find(
        (field) =>
          (fault && FAULT_FIELD[fault] === field) ||
          (clash && field === "teacher") ||
          (badDates.from && field === "from") ||
          (badDates.to && field === "to"),
      );
      if (first) form.current?.querySelector<HTMLElement>(`#${fieldId(first)}`)?.focus();
      return;
    }
    setError(null);
    try {
      await onSave(shiftBody(draft));
      onOpenChange(false);
    } catch (caught) {
      setError(
        caught instanceof ApiError && caught.code && t.has(`errors.${caught.code}`)
          ? t(`errors.${caught.code}`)
          : caught instanceof ApiError && caught.status === 404
            ? t("errors.notFound")
            : caught instanceof Error
              ? caught.message
              : tCommon("error"),
      );
    }
  };

  const dateChange = (key: "validFrom" | "validTo", flag: "from" | "to") => (event: React.ChangeEvent<HTMLInputElement>) => {
    const bad = event.target.validity.badInput;
    setBadDates((current) => ({ ...current, [flag]: bad }));
    setDraft({ ...draft, [key]: bad ? "" : event.target.value });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <form ref={form} onSubmit={submit} noValidate>
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
            <FormField id={fieldId("area")} label={t("area")} error={errors.area}>
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
            <FormField id={fieldId("teacher")} label={t("teacher")} error={errors.teacher}>
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
              <FormField id={fieldId("start")} label={t("start")} error={errors.start}>
                <Input
                  type="time"
                  value={draft.startTime}
                  onChange={(event) => setDraft({ ...draft, startTime: event.target.value })}
                />
              </FormField>
              <FormField id={fieldId("end")} label={t("end")} error={errors.end}>
                <Input
                  type="time"
                  value={draft.endTime}
                  onChange={(event) => setDraft({ ...draft, endTime: event.target.value })}
                />
              </FormField>
              <FormField id={fieldId("from")} label={t("validFrom")} optional error={errors.from}>
                <Input
                  type="date"
                  min={year?.startDate}
                  max={year?.endDate}
                  value={draft.validFrom}
                  onChange={dateChange("validFrom", "from")}
                />
              </FormField>
              <FormField id={fieldId("to")} label={t("validTo")} optional error={errors.to}>
                <Input
                  type="date"
                  min={year?.startDate}
                  max={year?.endDate}
                  value={draft.validTo}
                  onChange={dateChange("validTo", "to")}
                />
              </FormField>
            </div>
            <FormField id={fieldId("note")} label={t("note")} optional error={errors.note}>
              <Input
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
