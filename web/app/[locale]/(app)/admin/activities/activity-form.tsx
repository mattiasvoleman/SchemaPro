"use client";

/*
 * The activity form, for a new activity and for a change of one: name the day,
 * pick the days and who, pick the subject the replacement lesson is held in,
 * preview, then create. Nothing is cancelled before the admin has read the
 * preview, and the create carries its digest, so a calendar that moved in
 * between is refused (CANCELLATION_STALE) rather than cancelled unseen.
 *
 * WHAT AN ACTIVITY IS, AGAINST AN AVBOKNING. An avbokning cancels lessons and
 * leaves the hour empty. An activity cancels them the same way (it owns one,
 * cause EVENT) and puts one lesson in their place per class and day, which
 * carries the attendance, with the teachers responsible. Its minutes count
 * as undervisningstid as credits on named subjects; the replacement lesson's
 * own subject counts for nothing, so the day is not counted twice.
 *
 * THE REPLACEMENT SUBJECT IS OFFERED ONLY AMONG SUBJECTS THAT DO NOT COUNT.
 * The gateway refuses one that does (ACTIVITY_SUBJECT_COUNTS); a select that
 * offers it would make that the first thing the admin learns. With none to
 * offer, the form says how to make one and links to Ämnen.
 *
 * A CHANGE SENDS THE WHOLE DESCRIPTION AGAIN, and writes the credits ahead
 * anew from the lines it is sent: credit lines left out are taken away. The
 * activity's view carries them (creditLines), and the form opens on them.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { Eye, Loader2, Plus } from "lucide-react";
import { Link } from "@/i18n/navigation";
import {
  ACTIVITY_CREDITS_MAX,
  ACTIVITY_DESCRIPTION_MAX,
  ACTIVITY_NAME_MAX,
  EMPTY_ACTIVITY_FORM,
  activityProblems,
  formOfActivity,
  hasCreditsAhead,
  inputOf,
  previewState,
  selectionOf,
  validMinutes,
  type ActivityForm,
  type ActivityProblem,
} from "@/lib/schedule-activity-form";
import type { BatchScope } from "@/lib/publication-types";
import type { ActivityCreditLine, ActivitySelection, ScheduleActivity } from "@/lib/schedule-activity-types";
import type { AcademicYear, Person, StudentGroup, Subject } from "@/lib/types";
import { toDateString } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { DateField } from "@/components/ui/date-field";
import { FormField } from "@/components/ui/form-field";
import { GradeSpanField } from "@/components/ui/grade-span-field";
import { Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/ui/native-select";
import { Notice } from "@/components/ui/notice";
import { Textarea } from "@/components/ui/textarea";
import { personName, useErrorText } from "./activity-format";
import { ActivityPreviewView } from "./activity-preview";
import { useActivityPreview, useChangeActivity, useCreateActivity } from "./use-schedule-activities";

const SCOPES: BatchScope[] = ["SCHOOL", "GRADES", "GROUPS"];

export function ActivityFormBody({
  year,
  groups,
  subjects,
  people,
  activity,
  creditLines,
  idPrefix,
  onDone,
  onCancel,
  onBusyChange,
}: {
  year: AcademicYear;
  groups: readonly StudentGroup[];
  subjects: readonly Subject[];
  people: readonly Person[];
  /** Set when a change of this activity is made, not a new one. */
  activity?: ScheduleActivity;
  /** On a change: the credit lines read back from Tillgodoräknad tid. */
  creditLines?: readonly ActivityCreditLine[];
  /** Keeps the ids of two forms on one page apart. */
  idPrefix: string;
  /** After the create or the change went through. */
  onDone?: () => void;
  onCancel?: () => void;
  /** While the create or the change runs: a dialog around the form is held open. */
  onBusyChange?: (busy: boolean) => void;
}) {
  const t = useTranslations("scheduleActivities");
  const tCommon = useTranslations("common");
  const errorText = useErrorText();
  const preview = useActivityPreview();
  const create = useCreateActivity();
  const change = useChangeActivity();
  const [form, setForm] = useState<ActivityForm>(() =>
    activity ? formOfActivity(activity, creditLines ?? [], 0) : EMPTY_ACTIVITY_FORM,
  );
  const [previewed, setPreviewed] = useState<ActivitySelection | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const nextCreditId = useRef(form.credits.length);
  const nameField = useRef<HTMLInputElement>(null);
  const addCredit = useRef<HTMLButtonElement>(null);
  const saving = create.isPending || change.isPending;

  useEffect(() => {
    onBusyChange?.(saving);
  }, [onBusyChange, saving]);

  const yearGroups = useMemo(
    () =>
      groups
        .filter((group) => group.academicYearId === year.id)
        .sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name, "sv") : a.kind === "CLASS" ? -1 : 1)),
    [groups, year.id],
  );
  const replacementSubjects = useMemo(() => subjects.filter((subject) => !subject.countsTowardTimplan), [subjects]);
  const creditSubjects = useMemo(() => subjects.filter((subject) => subject.countsTowardTimplan), [subjects]);
  const teachers = useMemo(
    () => people.filter((person) => person.role === "TEACHER" && person.isActive),
    [people],
  );
  const peopleById = useMemo(() => new Map(people.map((person) => [person.id, person])), [people]);
  const nameOf = (teacherId: string): string => {
    const person = peopleById.get(teacherId);
    return person ? personName(person) : t("teacherUnknown");
  };

  const problems = activityProblems(form, year);
  const selection = selectionOf(form, year.id, yearGroups);
  const state = preview.data ? previewState(previewed, selection) : "stale";
  const shown = preview.data && state !== "stale" ? preview.data : null;
  const touched = form.name !== "" || form.fromDate !== "" || form.credits.length > 0;
  const has = (key: ActivityProblem) => touched && problems.includes(key);
  const update = (patch: Partial<ActivityForm>) => setForm((previous) => ({ ...previous, ...patch }));
  const id = (field: string) => `${idPrefix}-${field}`;

  const doPreview = async () => {
    setProblem(null);
    try {
      await preview.mutateAsync({ activityId: activity?.id ?? null, selection });
      setPreviewed(selection);
    } catch (error) {
      setPreviewed(null);
      setProblem(errorText(error));
    }
  };

  const doSave = async () => {
    if (!preview.data || state !== "current") return;
    setProblem(null);
    const input = inputOf(form, year.id, yearGroups, preview.data.digest);
    try {
      if (activity) {
        const outcome = await change.mutateAsync({ id: activity.id, input });
        toast.success(t("changed", { taken: outcome.taken, released: outcome.released }));
      } else {
        const outcome = await create.mutateAsync(input);
        toast.success(
          t(outcome.credits > 0 ? "createdWithCredits" : "created", {
            cancelled: outcome.cancelled,
            replacements: outcome.replacementLessons,
            credits: outcome.credits,
          }),
        );
        setForm(EMPTY_ACTIVITY_FORM);
        nextCreditId.current = 0;
        preview.reset();
        // The button that was pressed is gone with the preview: focus starts the next one.
        nameField.current?.focus();
      }
      setPreviewed(null);
      onDone?.();
    } catch (error) {
      // A stale or refused create leaves a preview nobody may act on.
      setPreviewed(null);
      setProblem(errorText(error));
    }
  };

  const setCredit = (rowId: number, patch: Partial<ActivityForm["credits"][number]>) =>
    update({ credits: form.credits.map((row) => (row.id === rowId ? { ...row, ...patch } : row)) });

  // The date problems all belong to the pair; they are said once, on the last day.
  const dateError = (["dates", "order", "outsideYear", "tooLong"] as const).find(has);
  const creditErrors = (["creditCount", "creditSubject", "creditDuplicate", "creditMinutes", "creditPartialDay"] as const).filter(has);

  return (
    <div className="space-y-4 text-sm">
      {/* A live region that is always there: its text changes when the preview arrives. */}
      <p role="status" className="sr-only">
        {shown && state === "current"
          ? t("previewReady", { cancelled: shown.matched, replacements: shown.replacementLessons })
          : ""}
      </p>

      <div className="grid gap-4 sm:grid-cols-2 [&>*]:min-w-0">
        <FormField
          id={id("name")}
          label={t("name")}
          hint={t("nameHint")}
          error={has("name") ? t("problems.name") : undefined}
          className="sm:col-span-2"
        >
          <Input
            ref={nameField}
            value={form.name}
            maxLength={ACTIVITY_NAME_MAX}
            placeholder={t("namePlaceholder")}
            onChange={(event) => update({ name: event.target.value })}
          />
        </FormField>
        <FormField id={id("from")} label={t("fromDate")}>
          <DateField
            label={t("fromDate")}
            value={form.fromDate}
            min={year.startDate}
            max={year.endDate}
            onChange={(value) => update({ fromDate: value, toDate: form.toDate || value })}
          />
        </FormField>
        <FormField id={id("to")} label={t("toDate")} error={dateError ? t(`problems.${dateError}`) : undefined}>
          <DateField
            label={t("toDate")}
            value={form.toDate}
            min={form.fromDate || year.startDate}
            max={year.endDate}
            onChange={(value) => update({ toDate: value })}
          />
        </FormField>
        <FormField id={id("start")} label={t("startTime")} optional>
          <Input
            type="time"
            aria-describedby={id("time-hint")}
            value={form.startTime}
            onChange={(event) => update({ startTime: event.target.value })}
          />
        </FormField>
        <FormField id={id("end")} label={t("endTime")} optional error={has("time") ? t("problems.time") : undefined}>
          <Input
            type="time"
            aria-describedby={id("time-hint")}
            value={form.endTime}
            onChange={(event) => update({ endTime: event.target.value })}
          />
        </FormField>
      </div>
      <p id={id("time-hint")} className="text-xs text-muted-foreground">
        {t("timeHint")}
      </p>

      <div className="grid gap-4 sm:grid-cols-2 [&>*]:min-w-0">
        <FormField id={id("scope")} label={t("scope")}>
          <NativeSelect value={form.scope} onChange={(event) => update({ scope: event.target.value as BatchScope })}>
            {SCOPES.map((scope) => (
              <option key={scope} value={scope}>
                {t(`scopes.${scope}`)}
              </option>
            ))}
          </NativeSelect>
        </FormField>
        {form.scope === "GRADES" ? (
          <GradeSpanField
            label={t("grades")}
            min={form.minGradeLevel}
            max={form.maxGradeLevel}
            onChange={(span) => update({ minGradeLevel: span.min, maxGradeLevel: span.max })}
          />
        ) : null}
      </div>
      {form.scope === "GRADES" ? (
        <p className="text-xs text-muted-foreground">{t("gradesHint")}</p>
      ) : null}
      {has("grades") ? <p className="text-xs text-destructive">{t("problems.grades")}</p> : null}
      {form.scope === "GROUPS" ? (
        <fieldset
          className="space-y-1.5"
          aria-describedby={[id("groups-hint"), has("groups") ? id("groups-error") : null].filter(Boolean).join(" ")}
        >
          <legend className="text-sm font-medium">{t("groups")}</legend>
          <div className="grid max-h-48 grid-cols-2 gap-1 overflow-y-auto rounded-md border p-2 sm:grid-cols-4">
            {yearGroups.map((group) => (
              <label key={group.id} className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={form.groupIds.includes(group.id)}
                  onChange={(event) =>
                    update({
                      groupIds: event.target.checked
                        ? [...form.groupIds, group.id]
                        : form.groupIds.filter((groupId) => groupId !== group.id),
                    })
                  }
                />
                {group.name}
              </label>
            ))}
          </div>
          <p id={id("groups-hint")} className="text-xs text-muted-foreground">
            {t("groupsHint")}
          </p>
          {has("groups") ? (
            <p id={id("groups-error")} className="text-xs text-destructive">
              {t("problems.groups")}
            </p>
          ) : null}
        </fieldset>
      ) : null}

      {replacementSubjects.length === 0 ? (
        <Notice tone="warning" role={null} title={t("noReplacementSubjectTitle")}>
          <p>{t("noReplacementSubjectBody")}</p>
          <p className="pt-1">
            <Link href="/admin/subjects" className="font-medium underline underline-offset-4">
              {t("goToSubjects")}
            </Link>
          </p>
        </Notice>
      ) : (
        <FormField
          id={id("subject")}
          label={t("replacementSubject")}
          hint={t("replacementSubjectHint")}
          error={has("subject") ? t("problems.subject") : undefined}
        >
          <NativeSelect
            value={form.replacementSubjectId}
            onChange={(event) => update({ replacementSubjectId: event.target.value })}
          >
            <option value="">{t("subjectPlaceholder")}</option>
            {replacementSubjects.map((subject) => (
              <option key={subject.id} value={subject.id}>
                {subject.name}
              </option>
            ))}
          </NativeSelect>
        </FormField>
      )}

      <FormField
        id={id("description")}
        label={t("description")}
        optional
        hint={t("descriptionHint", { max: ACTIVITY_DESCRIPTION_MAX })}
        error={has("description") ? t("problems.description", { max: ACTIVITY_DESCRIPTION_MAX }) : undefined}
      >
        <Textarea
          rows={3}
          maxLength={ACTIVITY_DESCRIPTION_MAX}
          value={form.description}
          onChange={(event) => update({ description: event.target.value })}
        />
      </FormField>

      <fieldset
        className="space-y-3 rounded-md border p-3"
        aria-describedby={[id("credits-hint"), creditErrors.length > 0 ? id("credits-error") : null]
          .filter(Boolean)
          .join(" ")}
      >
        <legend className="px-1 text-sm font-medium">{t("creditsLegend")}</legend>
        <p id={id("credits-hint")} className="text-xs text-muted-foreground">
          {t("creditsHint")}
        </p>
        {creditSubjects.length === 0 ? (
          <p className="text-xs text-muted-foreground">{t("creditNoSubjects")}</p>
        ) : null}
        {activity && hasCreditsAhead(activity, toDateString(new Date())) ? (
          <Notice tone="warning" role={null}>
            {form.credits.length > 0 ? t("creditsChangeRewritten") : t("creditsChangeMissing")}
          </Notice>
        ) : null}
        {form.credits.length > 0 ? (
          <ul className="space-y-3">
            {form.credits.map((row, index) => {
              const own = subjects.find((subject) => subject.id === row.subjectId);
              const options = own && !own.countsTowardTimplan ? [...creditSubjects, own] : creditSubjects;
              const minutesWrong = has("creditMinutes") && !validMinutes(row.minutes);
              return (
                <li key={row.id}>
                  <div
                    role="group"
                    aria-label={t("creditRow", { n: index + 1 })}
                    className="grid gap-3 sm:grid-cols-[1fr_10rem_auto] sm:items-end [&>*]:min-w-0"
                  >
                    <FormField id={id(`credit-${row.id}-subject`)} label={t("creditSubject")}>
                      <NativeSelect
                        value={row.subjectId}
                        onChange={(event) => setCredit(row.id, { subjectId: event.target.value })}
                      >
                        <option value="">{t("subjectPlaceholder")}</option>
                        {options.map((subject) => (
                          <option key={subject.id} value={subject.id}>
                            {subject.name}
                          </option>
                        ))}
                      </NativeSelect>
                    </FormField>
                    <FormField id={id(`credit-${row.id}-minutes`)} label={t("creditMinutes")}>
                      <Input
                        type="number"
                        inputMode="numeric"
                        min={1}
                        max={600}
                        value={row.minutes}
                        aria-invalid={minutesWrong || undefined}
                        onChange={(event) => setCredit(row.id, { minutes: event.target.value })}
                      />
                    </FormField>
                    <Button
                      variant="outline"
                      size="sm"
                      aria-label={t("creditRemove", { n: index + 1 })}
                      onClick={() => {
                        update({ credits: form.credits.filter((other) => other.id !== row.id) });
                        addCredit.current?.focus();
                      }}
                    >
                      {tCommon("delete")}
                    </Button>
                  </div>
                </li>
              );
            })}
          </ul>
        ) : null}
        {creditErrors.length > 0 ? (
          <ul id={id("credits-error")} className="list-disc space-y-0.5 pl-5 text-xs text-destructive">
            {creditErrors.map((key) => (
              <li key={key}>{t(`problems.${key}`, { max: ACTIVITY_CREDITS_MAX })}</li>
            ))}
          </ul>
        ) : null}
        <Button
          ref={addCredit}
          variant="outline"
          size="sm"
          disabled={form.credits.length >= ACTIVITY_CREDITS_MAX || creditSubjects.length === 0}
          onClick={() => {
            update({ credits: [...form.credits, { id: nextCreditId.current++, subjectId: "", minutes: "" }] });
          }}
        >
          <Plus aria-hidden="true" />
          {t("creditAdd")}
        </Button>
      </fieldset>

      <div className="flex flex-wrap gap-2">
        <Button variant="outline" onClick={() => void doPreview()} disabled={problems.length > 0 || preview.isPending}>
          {preview.isPending ? <Loader2 className="animate-spin" /> : <Eye />}
          {t("preview")}
        </Button>
        {onCancel ? (
          <Button variant="ghost" onClick={onCancel} disabled={saving}>
            {tCommon("cancel")}
          </Button>
        ) : null}
      </div>
      {preview.data && state === "stale" ? <Notice tone="warning">{t("previewOutdated")}</Notice> : null}

      {shown && (state === "current" || state === "adjusted") ? (
        <ActivityPreviewView
          preview={shown}
          state={state}
          form={form}
          changing={activity !== undefined}
          teachers={teachers}
          nameOf={nameOf}
          idPrefix={idPrefix}
          onPick={(groupId, teacherIds) => update({ teachers: { ...form.teachers, [groupId]: teacherIds } })}
          onNotify={(notify) => update({ notify })}
          adjustedAction={
            <Button variant="outline" size="sm" onClick={() => void doPreview()} disabled={problems.length > 0 || preview.isPending}>
              {preview.isPending ? <Loader2 className="animate-spin" /> : null}
              {t("previewAgain")}
            </Button>
          }
          footer={
            <Button
              onClick={() => void doSave()}
              // A new activity that cancels nothing is refused (CANCELLATION_SCOPE); a change may leave
              // the lessons it already holds, and be only a new name or a new teacher.
              disabled={state !== "current" || (!activity && shown.matched === 0) || problems.length > 0 || saving}
            >
              {saving ? <Loader2 className="animate-spin" /> : null}
              {activity ? t("save") : t("create")}
            </Button>
          }
        />
      ) : null}

      {problem ? <Notice tone="destructive">{problem}</Notice> : null}
    </div>
  );
}
