"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { CalendarClock, CalendarRange, ClipboardList, Info, Pencil, Plus, Trash2, X } from "lucide-react";
import { dutyPeriodLine, dutySlotsLine, keepsTimesAllYear } from "@/lib/duty-lines";
import { useAcademicYears } from "@/lib/queries";
import { useTeacherDuties, useTeacherDutyActions } from "@/lib/staffing-queries";
import {
  DUTY_KINDS,
  DUTY_LABEL_MAX,
  DUTY_MINUTES_MAX,
  DUTY_NOTE_MAX,
  DUTY_SLOTS_MAX,
  EMPTY_DUTY_DRAFT,
  EMPTY_SLOT_DRAFT,
  dutyDraftToBody,
  dutyToDraft,
  validateDutyDraft,
  type DutyDraft,
  type DutyProblem,
  type SlotDraft,
} from "@/lib/duty-forms";
import type { TeacherDuty, TeacherDutyKind } from "@/lib/types";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { LoadError } from "@/components/ui/load-error";
import { Notice } from "@/components/ui/notice";
import { SectionCard } from "@/components/ui/section-card";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

/** Radix Select cannot hold "": the "none" choice of the two optional pickers. */
const NONE = "__none__";
const WEEKDAYS = ["1", "2", "3", "4", "5", "6", "7"] as const;

export interface DutiesCardProps {
  teacher: { id: string; firstName: string; lastName: string };
  academicYearId: string;
  academicYearName: string;
  /** For ämnesansvar: the subject the uppdrag is about. */
  subjects: { id: string; name: string; code: string | null }[];
  /** For mentorskap: the year's groups, by name. */
  groups: { id: string; name: string }[];
}

/** Which fields a problem is about: it is said once one of them is touched. */
const PROBLEM_FIELDS: Record<DutyProblem["reason"], (keyof DutyDraft)[]> = {
  dutyLabelRequired: ["label"],
  dutyLabelTooLong: ["label"],
  dutyMinutesOutOfRange: ["minutesPerWeek"],
  dutyNoteTooLong: ["note"],
  dutyDatesReversed: ["validFrom", "validTo"],
  dutyDateOutsideYear: ["validFrom", "validTo"],
  slotTimeRequired: ["slots"],
  slotOffGrid: ["slots"],
  slotReversed: ["slots"],
  slotsOverlap: ["slots"],
  slotsTooMany: ["slots"],
};

/**
 * A teacher's övriga uppdrag for one läsår: mentorskap, ämnesansvar, APT,
 * rastvakt — and, for an uppdrag with a fixed time, the time it keeps free.
 *
 * THE BLOCKED TIMES ARE PART OF THE UPPDRAG, not constraints the admin goes
 * and makes on tillgänglighet. "Blockera tid i schemat" writes one weekly
 * UNAVAILABLE constraint per time for this teacher in the same transaction
 * as the uppdrag (the gateway's TeacherDutiesService), moves them when the
 * times change and deletes them with the uppdrag; the solver then keeps the
 * slots free through a rule it already has. A rastvakt on Monday, Wednesday
 * and Friday is one uppdrag with three times. The card never names a
 * constraint.
 *
 * DATES ARE THE UPPDRAG'S. Från and Till, empty for the läsår's own bound,
 * say which weeks it runs: the load counts only those, and the vikarietavla
 * keeps the teacher busy only on them. A mentor change at jul is two
 * uppdrag, each with its dates. The weekly master holds the times all year,
 * and the card says so where it applies (keepsTimesAllYear): on a listed
 * uppdrag with dates and times, and in the form once both are filled in.
 *
 * COUNTED OR NOT. "Räknas som undervisning" is the school's choice for
 * resurstid and pedagogisk lunch; off (the default), the minutes are drawn in
 * the bar as uppdrag beside the target and do not consume it — see
 * loadBarSegments.
 *
 * Self-fetching, unlike the two Fas 1 cards: the drawer and the people page
 * would otherwise both need a school-wide duties query for a card that shows
 * one person's, and the people page would pay for it on every visit.
 */
export function DutiesCard({
  teacher,
  academicYearId,
  academicYearName,
  subjects,
  groups,
}: DutiesCardProps) {
  const t = useTranslations("staffing");
  const tCommon = useTranslations("common");
  const tDays = useTranslations("days");
  const { data: duties, isLoading, isError } = useTeacherDuties(academicYearId, teacher.id);
  const actions = useTeacherDutyActions();
  // The year's bounds, for the date fields' min/max and the form's own check;
  // the gateway measures the same, so a year not loaded yet only defers the
  // sentence to the save.
  const { data: years } = useAcademicYears();
  const year = years?.find((candidate) => candidate.id === academicYearId) ?? null;
  /** null: reading; "new": the add form; an id: that uppdrag's form. */
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState<DutyDraft>(EMPTY_DUTY_DRAFT);
  const [removing, setRemoving] = useState<TeacherDuty | null>(null);

  /**
   * The fields the admin has changed since the form opened. The draft is
   * validated whole (Save stays off until it is), but a problem is SAID only
   * for a field already touched: an empty add form used to open with a
   * role="alert" for the label, and the minutes' error the moment the label
   * was typed — an announcement for every field nobody had reached yet.
   */
  const [touched, setTouched] = useState<ReadonlySet<keyof DutyDraft>>(new Set());
  const patch = (change: Partial<DutyDraft>) => {
    setDraft((previous) => ({ ...previous, ...change }));
    setTouched((previous) => new Set([...previous, ...(Object.keys(change) as (keyof DutyDraft)[])]));
  };
  const problem: DutyProblem | null = editing ? validateDutyDraft(draft, year) : null;
  const patchSlot = (index: number, change: Partial<SlotDraft>) =>
    patch({ slots: draft.slots.map((slot, at) => (at === index ? { ...slot, ...change } : slot)) });
  const shownProblem = problem && PROBLEM_FIELDS[problem.reason].some((field) => touched.has(field)) ? problem : null;
  const problemText = (p: DutyProblem) => {
    const { reason, ...values } = p;
    return t(`problem_${reason}`, values as Record<string, string | number>);
  };

  const subjectName = (id: string | null) =>
    id ? (subjects.find((subject) => subject.id === id)?.name ?? null) : null;
  const groupName = (id: string | null) =>
    id ? (groups.find((group) => group.id === id)?.name ?? null) : null;

  const openNew = () => {
    setDraft(EMPTY_DUTY_DRAFT);
    setTouched(new Set());
    setEditing("new");
  };
  const openEdit = (duty: TeacherDuty) => {
    setDraft(dutyToDraft(duty));
    setTouched(new Set());
    setEditing(duty.id);
  };

  const save = async () => {
    if (problem || !editing) return;
    const body = dutyDraftToBody(draft);
    try {
      if (editing === "new") {
        await actions.create.mutateAsync({ userId: teacher.id, academicYearId, ...body });
      } else {
        await actions.update.mutateAsync({ id: editing, ...body });
      }
      toast.success(t("dutySaved"));
      setEditing(null);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : tCommon("error"));
    }
  };

  const remove = async () => {
    if (!removing) return;
    try {
      await actions.remove.mutateAsync(removing.id);
      toast.success(t("dutyRemoved"));
      setRemoving(null);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : tCommon("error"));
    }
  };

  const pending = actions.create.isPending || actions.update.isPending;
  const total = (duties ?? []).reduce((sum, duty) => sum + duty.minutesPerWeek, 0);
  const idFor = (field: string) => `duty-${teacher.id}-${field}`;

  return (
    <SectionCard
      id={idFor("card")}
      headingLevel={3}
      icon={ClipboardList}
      title={t("dutiesTitle")}
      description={t("dutiesHint", { year: academicYearName })}
      action={
        editing === null ? (
          <Button variant="outline" size="sm" onClick={openNew}>
            <Plus />
            {t("addDuty")}
          </Button>
        ) : null
      }
    >
      {isLoading ? (
        <Skeleton className="h-16 w-full" aria-busy="true" />
      ) : isError ? (
        <LoadError variant="inline" title={t("dutiesLoadFailed")} hint={t("dutiesLoadFailedHint")} />
      ) : editing === null ? (
        (duties ?? []).length === 0 ? (
          <p className="text-sm text-muted-foreground">{t("noDuties")}</p>
        ) : (
          <>
            <ul className="divide-y text-sm">
              {(duties ?? []).map((duty) => {
                const about = [subjectName(duty.subjectId), groupName(duty.studentGroupId)].filter(
                  (part): part is string => part !== null,
                );
                return (
                  <li key={duty.id} className="flex items-start justify-between gap-2 py-2">
                    <div className="min-w-0 space-y-0.5">
                      <p className="flex flex-wrap items-center gap-1.5">
                        <span className="font-medium">{duty.label}</span>
                        <Badge variant="outline">{t(`dutyKind${duty.kind}`)}</Badge>
                      </p>
                      <p className="text-foreground">
                        {duty.countsAsTeaching
                          ? t("dutyMinutesCounted", { minutes: duty.minutesPerWeek })
                          : t("dutyMinutes", { minutes: duty.minutesPerWeek })}
                        {about.length > 0 ? ` · ${about.join(" · ")}` : ""}
                      </p>
                      {dutyPeriodLine(t, duty) ? (
                        <p className="flex items-center gap-1 text-foreground">
                          <CalendarRange className="size-3.5 text-muted-foreground" aria-hidden="true" />
                          {dutyPeriodLine(t, duty)}
                        </p>
                      ) : null}
                      {dutySlotsLine(t, tDays, duty.slots) ? (
                        <p className="flex items-start gap-1 text-foreground">
                          <CalendarClock className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
                          {dutySlotsLine(t, tDays, duty.slots)}
                        </p>
                      ) : null}
                      {keepsTimesAllYear(duty, year) ? (
                        <p className="flex items-start gap-1 text-muted-foreground">
                          <Info className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
                          {t("dutyTimesAllYear")}
                        </p>
                      ) : null}
                      {duty.note ? <p className="text-muted-foreground">{duty.note}</p> : null}
                    </div>
                    <span className="flex shrink-0 gap-1">
                      <Button
                        variant="ghost"
                        size="icon"
                        onClick={() => openEdit(duty)}
                        aria-label={t("editDuty", { label: duty.label })}
                      >
                        <Pencil />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        onClick={() => setRemoving(duty)}
                        aria-label={t("removeDuty", { label: duty.label })}
                      >
                        <Trash2 aria-hidden="true" />
                      </Button>
                    </span>
                  </li>
                );
              })}
            </ul>
            <p className="text-xs text-muted-foreground">
              {t("dutiesTotal", { minutes: total, count: (duties ?? []).length })}
            </p>
          </>
        )
      ) : (
        <div className="space-y-3">
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor={idFor("kind")}>{t("dutyKind")}</Label>
              <Select
                value={draft.kind}
                onValueChange={(value) => patch({ kind: value as TeacherDutyKind })}
              >
                <SelectTrigger id={idFor("kind")}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {DUTY_KINDS.map((kind) => (
                    <SelectItem key={kind} value={kind}>
                      {t(`dutyKind${kind}`)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor={idFor("label")}>{t("dutyLabel")}</Label>
              <Input
                id={idFor("label")}
                maxLength={DUTY_LABEL_MAX}
                placeholder={t("dutyLabelPlaceholder")}
                value={draft.label}
                onChange={(event) => patch({ label: event.target.value })}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor={idFor("minutes")}>{t("dutyMinutesLabel")}</Label>
              <Input
                id={idFor("minutes")}
                type="number"
                min={1}
                max={DUTY_MINUTES_MAX}
                step={5}
                value={draft.minutesPerWeek}
                onChange={(event) => patch({ minutesPerWeek: event.target.value })}
              />
            </div>
            <div className="flex items-center gap-2 self-end pb-2">
              <Switch
                id={idFor("counts")}
                checked={draft.countsAsTeaching}
                onCheckedChange={(checked) => patch({ countsAsTeaching: checked })}
              />
              <Label htmlFor={idFor("counts")}>{t("dutyCountsAsTeaching")}</Label>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor={idFor("subject")}>
                {t("dutySubject")}{" "}
                <span className="text-muted-foreground">({tCommon("optional")})</span>
              </Label>
              <Select
                value={draft.subjectId === "" ? NONE : draft.subjectId}
                onValueChange={(value) => patch({ subjectId: value === NONE ? "" : value })}
              >
                <SelectTrigger id={idFor("subject")} aria-label={t("dutySubject")}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={NONE}>{tCommon("none")}</SelectItem>
                  {subjects.map((subject) => (
                    <SelectItem key={subject.id} value={subject.id}>
                      {subject.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor={idFor("group")}>
                {t("dutyGroup")}{" "}
                <span className="text-muted-foreground">({tCommon("optional")})</span>
              </Label>
              <Select
                value={draft.studentGroupId === "" ? NONE : draft.studentGroupId}
                onValueChange={(value) => patch({ studentGroupId: value === NONE ? "" : value })}
              >
                <SelectTrigger id={idFor("group")} aria-label={t("dutyGroup")}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={NONE}>{tCommon("none")}</SelectItem>
                  {groups.map((group) => (
                    <SelectItem key={group.id} value={group.id}>
                      {group.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          <fieldset className="space-y-2 rounded-md border p-3">
            <legend className="px-1 text-sm font-medium">{t("dutyPeriodLegend")}</legend>
            <p className="text-xs text-muted-foreground">{t("dutyPeriodHint")}</p>
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor={idFor("validFrom")}>
                  {t("dutyValidFrom")}{" "}
                  <span className="text-muted-foreground">({tCommon("optional")})</span>
                </Label>
                <Input
                  id={idFor("validFrom")}
                  type="date"
                  min={year?.startDate}
                  max={year?.endDate}
                  value={draft.validFrom}
                  onChange={(event) => patch({ validFrom: event.target.value })}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor={idFor("validTo")}>
                  {t("dutyValidTo")}{" "}
                  <span className="text-muted-foreground">({tCommon("optional")})</span>
                </Label>
                <Input
                  id={idFor("validTo")}
                  type="date"
                  min={year?.startDate}
                  max={year?.endDate}
                  value={draft.validTo}
                  onChange={(event) => patch({ validTo: event.target.value })}
                />
              </div>
            </div>
          </fieldset>

          <div className="space-y-2 rounded-md border p-3">
            <div className="flex items-center gap-2">
              <Switch
                id={idFor("blocks")}
                checked={draft.blocks}
                onCheckedChange={(checked) => patch({ blocks: checked })}
              />
              <Label htmlFor={idFor("blocks")}>{t("dutyBlockTime")}</Label>
            </div>
            <p className="text-xs text-muted-foreground">{t("dutyBlockTimeHint")}</p>
            {draft.blocks &&
            keepsTimesAllYear(
              { validFrom: draft.validFrom || null, validTo: draft.validTo || null, slots: draft.slots },
              year,
            ) ? (
              <Notice>{t("dutyTimesAllYearNotice")}</Notice>
            ) : null}
            {draft.blocks ? (
              <div className="space-y-3">
                {draft.slots.map((slot, index) => (
                  <fieldset key={index} className="grid gap-3 sm:grid-cols-[1fr_1fr_1fr_auto] sm:items-end">
                    <legend className="sr-only">{t("dutySlotLegend", { index: index + 1 })}</legend>
                    <div className="space-y-1.5">
                      <Label htmlFor={idFor(`day-${index}`)}>{t("dutyDay")}</Label>
                      <Select value={slot.dayOfWeek} onValueChange={(value) => patchSlot(index, { dayOfWeek: value })}>
                        <SelectTrigger id={idFor(`day-${index}`)}>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {WEEKDAYS.map((day) => (
                            <SelectItem key={day} value={day}>
                              {tDays(day)}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                    <div className="space-y-1.5">
                      <Label htmlFor={idFor(`start-${index}`)}>{t("dutyStart")}</Label>
                      <Input
                        id={idFor(`start-${index}`)}
                        type="time"
                        step={300}
                        value={slot.startTime}
                        onChange={(event) => patchSlot(index, { startTime: event.target.value })}
                      />
                    </div>
                    <div className="space-y-1.5">
                      <Label htmlFor={idFor(`end-${index}`)}>{t("dutyEnd")}</Label>
                      <Input
                        id={idFor(`end-${index}`)}
                        type="time"
                        step={300}
                        value={slot.endTime}
                        onChange={(event) => patchSlot(index, { endTime: event.target.value })}
                      />
                    </div>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="justify-self-end"
                      disabled={draft.slots.length === 1}
                      onClick={() => patch({ slots: draft.slots.filter((_, at) => at !== index) })}
                      aria-label={t("dutyRemoveSlot", { index: index + 1 })}
                    >
                      <X aria-hidden="true" />
                    </Button>
                  </fieldset>
                ))}
                <Button
                  variant="outline"
                  size="sm"
                  disabled={draft.slots.length >= DUTY_SLOTS_MAX}
                  onClick={() => {
                    const last = draft.slots[draft.slots.length - 1] ?? EMPTY_SLOT_DRAFT;
                    // The next weekday at the same time: the rastvakt on
                    // Monday, Wednesday and Friday is two clicks and two days.
                    const next = String(Math.min(7, Number(last.dayOfWeek) + 1));
                    patch({ slots: [...draft.slots, { ...last, dayOfWeek: next }] });
                  }}
                >
                  <Plus />
                  {t("dutyAddSlot")}
                </Button>
              </div>
            ) : null}
          </div>

          <div className="space-y-1.5">
            <Label htmlFor={idFor("note")}>
              {t("note")} <span className="text-muted-foreground">({tCommon("optional")})</span>
            </Label>
            <Textarea
              id={idFor("note")}
              maxLength={DUTY_NOTE_MAX}
              rows={2}
              value={draft.note}
              onChange={(event) => patch({ note: event.target.value })}
            />
          </div>

          {shownProblem ? <Notice tone="destructive">{problemText(shownProblem)}</Notice> : null}

          <div className="flex justify-end gap-2">
            <Button variant="outline" size="sm" onClick={() => setEditing(null)}>
              {tCommon("cancel")}
            </Button>
            <Button size="sm" onClick={() => void save()} disabled={problem !== null || pending}>
              {pending ? tCommon("saving") : tCommon("save")}
            </Button>
          </div>
        </div>
      )}

      <ConfirmDialog
        open={removing !== null}
        onOpenChange={(open) => !open && setRemoving(null)}
        title={t("removeDutyTitle", { label: removing?.label ?? "" })}
        description={(removing?.slots.length ?? 0) > 0 ? t("removeDutyBodySlot") : t("removeDutyBody")}
        confirmLabel={tCommon("delete")}
        loading={actions.remove.isPending}
        onConfirm={() => void remove()}
      />
    </SectionCard>
  );
}
