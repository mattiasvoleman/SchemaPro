"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { useTranslations } from "next-intl";
import { ApiError } from "@/lib/api";
import {
  clashOf,
  clockOf,
  datesForNewWeekday,
  datesOnTheWeekday,
  faultFieldOf,
  shiftBody,
  shiftDraftFault,
  type LessonClash,
  type ShiftDraft,
  type ShiftField,
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
  /** A teacher's name alone, for a sentence that says their state itself. */
  plainName: (userId: string) => string;
  /** The läsår's passes, for the clash the gateway would refuse. */
  shifts: readonly SupervisionShift[];
  weekdays: readonly number[];
  year: { startDate: string; endDate: string } | null;
  saving: boolean;
  /** Saves the pass and answers it as the gateway stored it. */
  onSave: (body: ShiftBody) => Promise<SupervisionShift | undefined>;
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

const fieldId = (field: ShiftField) => `supervision-shift-${field}`;
const FIELD_ORDER: readonly ShiftField[] = ["area", "teacher", "start", "end", "from", "to", "note"];

/** A refusal's code, said at its field rather than above the form. */
const FIELD_OF_CODE: Readonly<Record<string, ShiftField>> = {
  SUPERVISION_SHIFT_CLASH: "teacher",
  SUPERVISION_TEACHER_INACTIVE: "teacher",
  SUPERVISION_AREA_NOT_FOUND: "area",
};
/** The gateway's 400 names its field first ("validTo: …"): the dialog's name for it. */
const FIELD_OF_PREFIX: Readonly<Record<string, ShiftField>> = {
  areaId: "area",
  userId: "teacher",
  startTime: "start",
  endTime: "end",
  validFrom: "from",
  validTo: "to",
  note: "note",
};

const draftOf = (shift: SupervisionShift | null, seed: ShiftSeed): ShiftDraft =>
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
    : { ...BLANK, ...seed };

/**
 * Ett rastvaktspass: who watches which area, on which weekday, from when to
 * when, and between which dates. Each refusal the gateway would make is said
 * beside its field before the save (lib/supervision.ts shiftDraftFault), and
 * a save it would refuse moves focus to that field once the error is drawn:
 * the one-place-at-a-time clash too, named from the schedule the page holds
 * (clashOf). What only the gateway can know — a clash with a pass saved by
 * someone else meanwhile, a teacher deactivated meanwhile — comes back as a
 * refusal and is said at its field the same way, while the page reads the
 * schedule again (use-supervision.ts).
 *
 * Dates are stored on the pass's weekday: a typed Från or Till that is not
 * says, beside the field, the day the pass first or last runs.
 *
 * A pass during the teacher's own lesson is saved, and the dialog stays open
 * to say so (the gateway's lessonClashes): the generator and the
 * vikarieförslag do not read passes yet. An existing pass that runs during
 * one says it on opening; so does a deactivated teacher's pass, which
 * watches until the day before they were deactivated.
 *
 * The form is mounted with each opening (Radix unmounts a closed dialog's
 * content), so the draft is the pass's, or the seed's, from its first render.
 */
export function ShiftDialog({ open, onOpenChange, ...rest }: ShiftDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <ShiftForm onOpenChange={onOpenChange} {...rest} />
      </DialogContent>
    </Dialog>
  );
}

function ShiftForm({
  onOpenChange,
  shift,
  seed,
  areas,
  teachers,
  plainName,
  shifts,
  weekdays,
  year,
  saving,
  onSave,
  onDelete,
}: Omit<ShiftDialogProps, "open">) {
  const t = useTranslations("supervision.shift");
  const tSupervision = useTranslations("supervision");
  const tCommon = useTranslations("common");
  const tDays = useTranslations("days");
  const [draft, setDraft] = useState<ShiftDraft>(() => draftOf(shift, seed));
  const [touched, setTouched] = useState(false);
  /** A date field the browser holds half-typed: it reports "", which is not "no date". */
  const [badDates, setBadDates] = useState<{ from: boolean; to: boolean }>({ from: false, to: false });
  /** A refusal the dialog could not foresee, above the form. */
  const [error, setError] = useState<string | null>(null);
  /** The gateway's refusal at its field, until the draft changes. */
  const [refusal, setRefusal] = useState<{ field: ShiftField; message: string } | null>(null);
  /** The pass as saved, when it runs during a lesson: the dialog says so before it closes. */
  const [saved, setSaved] = useState<SupervisionShift | null>(null);
  // A refused save focuses its field once the error is drawn beside it.
  const [focusRequest, setFocusRequest] = useState<{ field: ShiftField } | null>(null);
  const form = useRef<HTMLFormElement>(null);
  useEffect(() => {
    if (focusRequest) form.current?.querySelector<HTMLElement>(`#${fieldId(focusRequest.field)}`)?.focus();
  }, [focusRequest]);

  const change = (patch: Partial<ShiftDraft>) => {
    setRefusal(null);
    setDraft((current) => ({ ...current, ...patch }));
  };
  const dayName = (day: number) => tSupervision("dayName", { day: String(day) });

  const fault = shiftDraftFault(draft, year);
  const clash = fault ? null : clashOf(draft, shifts, shift?.id ?? null, year);
  // A fault is said once the admin has tried to save, or where it is about
  // what they have filled in: an empty form is not wrong yet.
  const said = (key: string) => touched || !["areaMissing", "teacherMissing", "startMissing", "endMissing"].includes(key);
  const errors: Partial<Record<ShiftField, string>> = {};
  if (badDates.from) errors.from = t("faults.dateInvalid");
  if (badDates.to) errors.to = t("faults.dateInvalid");
  if (fault && said(fault)) {
    const field = faultFieldOf(fault, draft);
    errors[field] ??=
      (fault === "fromOutsideYear" || fault === "toOutsideYear") && year
        ? t(`faults.${fault}`, { from: year.startDate, to: year.endDate })
        : fault === "noWeekday"
          ? t("faults.noWeekday", {
              day: dayName(draft.dayOfWeek),
              from: draft.validFrom || year?.startDate || "",
              to: draft.validTo || year?.endDate || "",
            })
          : t(`faults.${fault}`);
  }
  if (clash) {
    errors.teacher = t("faults.clash", {
      area: areas.find((area) => area.id === clash.areaId)?.name ?? "",
      day: dayName(clash.dayOfWeek),
      start: clockOf(clash.startTime),
      end: clockOf(clash.endTime),
    });
  } else if (refusal) {
    errors[refusal.field] ??= refusal.message;
  }
  const refused = fault !== null || clash !== null || badDates.from || badDates.to;

  // The day the pass first and last runs, where a typed date is not on its weekday.
  const stored = fault ? null : datesOnTheWeekday(draft, year);
  const firstRun = stored && draft.validFrom && stored.validFrom !== draft.validFrom ? stored.validFrom : null;
  const lastRun = stored && draft.validTo && stored.validTo !== draft.validTo ? stored.validTo : null;

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setTouched(true);
    if (refused) {
      const first = FIELD_ORDER.find(
        (field) =>
          (fault && faultFieldOf(fault, draft) === field) ||
          (clash && field === "teacher") ||
          (badDates.from && field === "from") ||
          (badDates.to && field === "to"),
      );
      if (first) setFocusRequest({ field: first });
      return;
    }
    setError(null);
    try {
      const answer = await onSave(shiftBody(draft, year));
      if (answer?.lessonClashes?.length) {
        setSaved(answer);
        return;
      }
      onOpenChange(false);
    } catch (caught) {
      if (caught instanceof ApiError) {
        const prefix = /^(\w+):\s*/.exec(caught.message);
        const field = (caught.code && FIELD_OF_CODE[caught.code]) || (prefix ? FIELD_OF_PREFIX[prefix[1]!] : undefined);
        if (field) {
          setRefusal({
            field,
            message:
              caught.code && t.has(`errors.${caught.code}`)
                ? (caught.params ? t(`errors.${caught.code}`, caught.params) : t(`errors.${caught.code}`))
                : prefix
                  ? caught.message.slice(prefix[0].length)
                  : caught.message,
          });
          setFocusRequest({ field });
          return;
        }
      }
      setError(
        caught instanceof ApiError && caught.code && t.has(`errors.${caught.code}`)
          ? (caught.params ? t(`errors.${caught.code}`, caught.params) : t(`errors.${caught.code}`))
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
    change({ [key]: bad ? "" : event.target.value });
  };

  // A deactivated teacher's pass: what it watches, by its own dates beside
  // the day they were deactivated. Nothing to say of a pass that ended before.
  const inactiveFrom = shift?.inactiveFrom ?? null;
  const inactiveNotice =
    shift && inactiveFrom && !(shift.validTo && shift.validTo < inactiveFrom)
      ? inactiveFrom <= (shift.validFrom ?? year?.startDate ?? "")
        ? t("inactiveNoticeNever", { name: plainName(shift.userId), date: inactiveFrom })
        : t("inactiveNotice", { name: plainName(shift.userId), date: inactiveFrom })
      : null;

  const lessonList = (lessons: readonly LessonClash[]) => (
    <ul className="mt-1 list-disc pl-5">
      {lessons.map((lesson) => (
        <li key={`${lesson.dayOfWeek}-${lesson.startTime}-${lesson.subject}-${lesson.group}`}>
          {t("lessonClashItem", {
            subject: lesson.subject,
            group: lesson.group,
            day: dayName(lesson.dayOfWeek),
            start: lesson.startTime,
            end: lesson.endTime,
          })}
        </li>
      ))}
    </ul>
  );

  if (saved) {
    return (
      <>
        <DialogHeader>
          <DialogTitle>{shift ? t("saved") : t("created")}</DialogTitle>
          <DialogDescription>{t("lessonClashSavedTitle")}</DialogDescription>
        </DialogHeader>
        <div className="py-4">
          <Notice tone="warning">
            {lessonList(saved.lessonClashes)}
            <p className="mt-2">{t("lessonClashBody")}</p>
          </Notice>
        </div>
        <DialogFooter>
          <Button type="button" autoFocus onClick={() => onOpenChange(false)}>
            {tCommon("close")}
          </Button>
        </DialogFooter>
      </>
    );
  }

  return (
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
        {inactiveNotice ? <Notice tone="warning">{inactiveNotice}</Notice> : null}
        {shift && shift.lessonClashes.length > 0 ? (
          <Notice tone="warning" title={t("lessonClashTitle")}>
            {lessonList(shift.lessonClashes)}
            <p className="mt-2">{t("lessonClashBody")}</p>
          </Notice>
        ) : null}
        <FormField id={fieldId("area")} label={t("area")} error={errors.area}>
          {(control) => (
            <Select value={draft.areaId} onValueChange={(value) => change({ areaId: value })}>
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
            <Select value={draft.userId} onValueChange={(value) => change({ userId: value })}>
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
              onValueChange={(value) => change({ dayOfWeek: Number(value), ...datesForNewWeekday(draft, Number(value)) })}
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
            <Input type="time" value={draft.startTime} onChange={(event) => change({ startTime: event.target.value })} />
          </FormField>
          <FormField id={fieldId("end")} label={t("end")} error={errors.end}>
            <Input type="time" value={draft.endTime} onChange={(event) => change({ endTime: event.target.value })} />
          </FormField>
          <FormField
            id={fieldId("from")}
            label={t("validFrom")}
            optional
            hint={firstRun ? t("firstRun", { date: firstRun }) : undefined}
            error={errors.from}
          >
            <Input
              type="date"
              min={year?.startDate}
              max={year?.endDate}
              value={draft.validFrom}
              onChange={dateChange("validFrom", "from")}
            />
          </FormField>
          <FormField
            id={fieldId("to")}
            label={t("validTo")}
            optional
            hint={lastRun ? t("lastRun", { date: lastRun }) : undefined}
            error={errors.to}
          >
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
          <Input placeholder={t("notePlaceholder")} value={draft.note} onChange={(event) => change({ note: event.target.value })} />
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
  );
}
