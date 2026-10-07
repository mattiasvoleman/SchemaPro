"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { CalendarClock, ClipboardList, Pencil, Plus, Trash2 } from "lucide-react";
import { useTeacherDuties, useTeacherDutyActions } from "@/lib/staffing-queries";
import {
  DUTY_KINDS,
  DUTY_LABEL_MAX,
  DUTY_MINUTES_MAX,
  DUTY_NOTE_MAX,
  EMPTY_DUTY_DRAFT,
  dutyDraftToBody,
  dutyToDraft,
  validateDutyDraft,
  type DutyDraft,
  type DutyProblem,
} from "@/lib/duty-forms";
import type { TeacherDuty, TeacherDutyKind } from "@/lib/types";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
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

/**
 * A teacher's övriga uppdrag for one läsår: mentorskap, ämnesansvar, APT,
 * rastvakt — and, for an uppdrag with a fixed time, the time it keeps free.
 *
 * THE BLOCKED TIME IS PART OF THE UPPDRAG, not a constraint the admin goes
 * and makes on tillgänglighet. "Blockera tid i schemat" writes one weekly
 * UNAVAILABLE constraint for this teacher in the same transaction as the
 * uppdrag (the gateway's TeacherDutiesService), moves it when the time
 * changes and deletes it with the uppdrag; the solver then keeps the slot
 * free through a rule it already has. The card never names the constraint.
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
  /** null: reading; "new": the add form; an id: that uppdrag's form. */
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState<DutyDraft>(EMPTY_DUTY_DRAFT);
  const [removing, setRemoving] = useState<TeacherDuty | null>(null);

  const patch = (change: Partial<DutyDraft>) => setDraft((previous) => ({ ...previous, ...change }));
  const problem: DutyProblem | null = editing ? validateDutyDraft(draft) : null;
  const problemText = (p: DutyProblem) => {
    const { reason, ...values } = p;
    return t(`problem_${reason}`, values as Record<string, string | number>);
  };

  const subjectName = (id: string | null) =>
    id ? (subjects.find((subject) => subject.id === id)?.name ?? null) : null;
  const groupName = (id: string | null) =>
    id ? (groups.find((group) => group.id === id)?.name ?? null) : null;
  const clock = (value: string) => value.slice(0, 5);

  const openNew = () => {
    setDraft(EMPTY_DUTY_DRAFT);
    setEditing("new");
  };
  const openEdit = (duty: TeacherDuty) => {
    setDraft(dutyToDraft(duty));
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
    <section className="rounded-lg border bg-card p-4" aria-labelledby={idFor("title")}>
      <div className="mb-1 flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <ClipboardList className="size-4 text-muted-foreground" />
          <h3 id={idFor("title")} className="font-semibold">
            {t("dutiesTitle")}
          </h3>
        </div>
        {editing === null ? (
          <Button variant="outline" size="sm" onClick={openNew}>
            <Plus />
            {t("addDuty")}
          </Button>
        ) : null}
      </div>
      <p className="mb-3 text-xs text-muted-foreground">
        {t("dutiesHint", { year: academicYearName })}
      </p>

      {isLoading ? (
        <Skeleton className="h-16 w-full" />
      ) : isError ? (
        <p className="text-sm text-destructive">{t("dutiesLoadFailed")}</p>
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
                      {duty.blockedSlot ? (
                        <p className="flex items-center gap-1 text-foreground">
                          <CalendarClock className="size-3.5 text-muted-foreground" aria-hidden="true" />
                          {t("dutyBlocks", {
                            day: tDays(String(duty.blockedSlot.dayOfWeek)),
                            start: clock(duty.blockedSlot.startTime),
                            end: clock(duty.blockedSlot.endTime),
                          })}
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
                        <Trash2 className="text-destructive" />
                      </Button>
                    </span>
                  </li>
                );
              })}
            </ul>
            <p className="mt-1 text-xs text-muted-foreground">
              {t("dutiesTotal", { minutes: total, count: (duties ?? []).length })}
            </p>
          </>
        )
      ) : (
        <div className="space-y-3">
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label>{t("dutyKind")}</Label>
              <Select
                value={draft.kind}
                onValueChange={(value) => patch({ kind: value as TeacherDutyKind })}
              >
                <SelectTrigger aria-label={t("dutyKind")}>
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
              <Label>
                {t("dutySubject")}{" "}
                <span className="text-muted-foreground">({tCommon("optional")})</span>
              </Label>
              <Select
                value={draft.subjectId === "" ? NONE : draft.subjectId}
                onValueChange={(value) => patch({ subjectId: value === NONE ? "" : value })}
              >
                <SelectTrigger aria-label={t("dutySubject")}>
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
              <Label>
                {t("dutyGroup")}{" "}
                <span className="text-muted-foreground">({tCommon("optional")})</span>
              </Label>
              <Select
                value={draft.studentGroupId === "" ? NONE : draft.studentGroupId}
                onValueChange={(value) => patch({ studentGroupId: value === NONE ? "" : value })}
              >
                <SelectTrigger aria-label={t("dutyGroup")}>
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
            {draft.blocks ? (
              <div className="grid gap-3 sm:grid-cols-3">
                <div className="space-y-1.5">
                  <Label>{t("dutyDay")}</Label>
                  <Select value={draft.dayOfWeek} onValueChange={(value) => patch({ dayOfWeek: value })}>
                    <SelectTrigger aria-label={t("dutyDay")}>
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
                  <Label htmlFor={idFor("start")}>{t("dutyStart")}</Label>
                  <Input
                    id={idFor("start")}
                    type="time"
                    step={300}
                    value={draft.startTime}
                    onChange={(event) => patch({ startTime: event.target.value })}
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor={idFor("end")}>{t("dutyEnd")}</Label>
                  <Input
                    id={idFor("end")}
                    type="time"
                    step={300}
                    value={draft.endTime}
                    onChange={(event) => patch({ endTime: event.target.value })}
                  />
                </div>
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

          {problem ? (
            <p role="alert" className="text-sm text-destructive">
              {problemText(problem)}
            </p>
          ) : null}

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
        description={removing?.blockedSlot ? t("removeDutyBodySlot") : t("removeDutyBody")}
        confirmLabel={tCommon("delete")}
        loading={actions.remove.isPending}
        onConfirm={() => void remove()}
      />
    </section>
  );
}
