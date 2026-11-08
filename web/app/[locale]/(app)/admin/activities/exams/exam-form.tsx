"use client";

/*
 * The exam form, for a new exam and for a change of one. An exam is what the
 * school asks of the planner: its subject, the classes and groups that write
 * it, how long it is, how many write, and the time it wants. The time is
 * either a WINDOW the planner chooses in (up to a month, with an earliest start
 * and a latest end for any day of it) or FIXED (one day and one start: the
 * national tests). A change describes the whole exam again, as an activity's
 * does; an exam that is laid cannot be changed (EXAM_IS_PLANNED), so the list
 * offers Ändra only on one that is not.
 *
 * THE SUBJECT IS OFFERED ONLY AMONG SUBJECTS THAT COUNT toward the timplan:
 * the exam's minutes are credited to it, and one that did not count would
 * credit them to nobody (EXAM_SUBJECT).
 *
 * THE NUMBER OF WRITERS IS TYPED. The groups the page reads carry no pupil
 * counts, so there is nothing to suggest it from; the planner seats the
 * writers over the classes by their size.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { Loader2 } from "lucide-react";
import { Link } from "@/i18n/navigation";
import {
  EMPTY_EXAM_FORM,
  EXAM_LENGTH_MAX,
  EXAM_LENGTH_MIN,
  EXAM_NAME_MAX,
  examInput,
  examProblems,
  formOfExam,
  type ExamForm,
  type ExamProblem,
} from "@/lib/exam-form";
import type { Exam, ExamWindowKind } from "@/lib/exam-types";
import type { AcademicYear, StudentGroup, Subject } from "@/lib/types";
import { Button } from "@/components/ui/button";
import { DateField } from "@/components/ui/date-field";
import { FormField } from "@/components/ui/form-field";
import { Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/ui/native-select";
import { Notice } from "@/components/ui/notice";
import { useErrorText } from "./exam-format";
import { useChangeExam, useCreateExam } from "./use-exams";

const KINDS: ExamWindowKind[] = ["WEEK", "FIXED"];

export function ExamFormBody({
  year,
  groups,
  subjects,
  exam,
  idPrefix,
  onDone,
  onCancel,
  onBusyChange,
}: {
  year: AcademicYear;
  groups: readonly StudentGroup[];
  subjects: readonly Subject[];
  /** Set when a change of this exam is made, not a new one. */
  exam?: Exam;
  /** Keeps the ids of two forms on one page apart. */
  idPrefix: string;
  /** After the create or the change went through. */
  onDone?: () => void;
  onCancel?: () => void;
  /** While the create or the change runs: a dialog around the form is held open. */
  onBusyChange?: (busy: boolean) => void;
}) {
  const t = useTranslations("exams");
  const tCommon = useTranslations("common");
  const errorText = useErrorText();
  const create = useCreateExam();
  const change = useChangeExam();
  const yearGroups = useMemo(
    () =>
      groups
        .filter((group) => group.academicYearId === year.id)
        .sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name, "sv") : a.kind === "CLASS" ? -1 : 1)),
    [groups, year.id],
  );
  const yearGroupIds = useMemo(() => new Set(yearGroups.map((group) => group.id)), [yearGroups]);
  const examSubjects = useMemo(() => subjects.filter((subject) => subject.countsTowardTimplan), [subjects]);
  const [form, setForm] = useState<ExamForm>(() => (exam ? formOfExam(exam, yearGroupIds) : EMPTY_EXAM_FORM));
  const [problem, setProblem] = useState<string | null>(null);
  const nameField = useRef<HTMLInputElement>(null);
  const saving = create.isPending || change.isPending;

  useEffect(() => {
    onBusyChange?.(saving);
  }, [onBusyChange, saving]);

  const problems = examProblems(form, year, yearGroupIds);
  // A new form says nothing until something has been put in it.
  const touched = exam !== undefined || form.name !== "" || form.from !== "" || form.date !== "" || form.groupIds.length > 0;
  const has = (key: ExamProblem) => touched && problems.includes(key);
  const update = (patch: Partial<ExamForm>) => setForm((previous) => ({ ...previous, ...patch }));
  const id = (field: string) => `${idPrefix}-${field}`;
  const fixed = form.windowKind === "FIXED";
  // The date problems all belong to the pair; they are said once, on the last day.
  const dateError = (["dates", "order", "outsideYear", "tooLong"] as const).find(has);

  const submit = async () => {
    setProblem(null);
    const input = examInput(form);
    try {
      if (exam) {
        await change.mutateAsync({ id: exam.id, input });
        toast.success(t("changed"));
      } else {
        await create.mutateAsync({ academicYearId: year.id, ...input });
        toast.success(t("created"));
        setForm(EMPTY_EXAM_FORM);
        // The button that was pressed stays; focus starts the next exam.
        nameField.current?.focus();
      }
      onDone?.();
    } catch (error) {
      setProblem(errorText(error));
    }
  };

  return (
    <form
      className="space-y-4 text-sm"
      onSubmit={(event) => {
        event.preventDefault();
        if (problems.length === 0 && !saving) void submit();
      }}
    >
      <div className="grid gap-4 sm:grid-cols-2 [&>*]:min-w-0">
        <FormField
          id={id("name")}
          label={t("name")}
          hint={t("nameHint", { max: EXAM_NAME_MAX })}
          error={has("name") ? t("problems.name", { max: EXAM_NAME_MAX }) : undefined}
        >
          <Input
            ref={nameField}
            value={form.name}
            maxLength={EXAM_NAME_MAX}
            placeholder={t("namePlaceholder")}
            onChange={(event) => update({ name: event.target.value })}
          />
        </FormField>
        <FormField
          id={id("subject")}
          label={t("subject")}
          hint={t("subjectHint")}
          error={has("subject") ? t("problems.subject") : undefined}
        >
          <NativeSelect value={form.subjectId} onChange={(event) => update({ subjectId: event.target.value })}>
            <option value="">{t("subjectPlaceholder")}</option>
            {examSubjects.map((subject) => (
              <option key={subject.id} value={subject.id}>
                {subject.name}
              </option>
            ))}
          </NativeSelect>
        </FormField>
        <FormField
          id={id("length")}
          label={t("length")}
          error={has("length") ? t("problems.length", { min: EXAM_LENGTH_MIN, max: EXAM_LENGTH_MAX }) : undefined}
        >
          <Input
            type="number"
            inputMode="numeric"
            min={EXAM_LENGTH_MIN}
            max={EXAM_LENGTH_MAX}
            value={form.lengthMinutes}
            onChange={(event) => update({ lengthMinutes: event.target.value })}
          />
        </FormField>
        <FormField
          id={id("writers")}
          label={t("writers")}
          hint={t("writersHint")}
          error={has("writers") ? t("problems.writers") : undefined}
        >
          <Input
            type="number"
            inputMode="numeric"
            min={1}
            max={2000}
            value={form.writers}
            onChange={(event) => update({ writers: event.target.value })}
          />
        </FormField>
      </div>

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

      <div className="grid gap-4 sm:grid-cols-2 [&>*]:min-w-0">
        <FormField id={id("kind")} label={t("windowKind")} className="sm:col-span-2">
          <NativeSelect value={form.windowKind} onChange={(event) => update({ windowKind: event.target.value as ExamWindowKind })}>
            {KINDS.map((kind) => (
              <option key={kind} value={kind}>
                {t(`kinds.${kind}`)}
              </option>
            ))}
          </NativeSelect>
        </FormField>
        {fixed ? (
          <>
            <FormField id={id("date")} label={t("date")} error={dateError ? t(`problems.${dateError}`) : undefined}>
              <DateField
                label={t("date")}
                value={form.date}
                min={year.startDate}
                max={year.endDate}
                onChange={(value) => update({ date: value })}
              />
            </FormField>
            <FormField id={id("fixed-start")} label={t("fixedStart")} error={has("fixedStart") ? t("problems.fixedStart") : undefined}>
              <Input type="time" value={form.fixedStart} onChange={(event) => update({ fixedStart: event.target.value })} />
            </FormField>
          </>
        ) : (
          <>
            <FormField id={id("from")} label={t("from")}>
              <DateField
                label={t("from")}
                value={form.from}
                min={year.startDate}
                max={year.endDate}
                onChange={(value) => update({ from: value, to: form.to || value })}
              />
            </FormField>
            <FormField id={id("to")} label={t("to")} error={dateError ? t(`problems.${dateError}`) : undefined}>
              <DateField
                label={t("to")}
                value={form.to}
                min={form.from || year.startDate}
                max={year.endDate}
                onChange={(value) => update({ to: value })}
              />
            </FormField>
            <FormField id={id("earliest")} label={t("earliestStart")} optional>
              <Input type="time" value={form.earliestStart} onChange={(event) => update({ earliestStart: event.target.value })} />
            </FormField>
            <FormField id={id("latest")} label={t("latestEnd")} optional error={has("limits") ? t("problems.limits") : undefined}>
              <Input type="time" value={form.latestEnd} onChange={(event) => update({ latestEnd: event.target.value })} />
            </FormField>
          </>
        )}
      </div>
      <p className="text-xs text-muted-foreground">{fixed ? t("fixedHint") : t("windowHint")}</p>

      {examSubjects.length === 0 ? (
        <Notice tone="warning" role={null} title={t("noExamSubjectTitle")}>
          <p>{t("noExamSubjectBody")}</p>
          <p className="pt-1">
            <Link href="/admin/subjects" className="font-medium underline underline-offset-4">
              {t("goToSubjects")}
            </Link>
          </p>
        </Notice>
      ) : null}

      <div className="flex flex-wrap gap-2">
        <Button type="submit" data-writes="DRIFT" disabled={problems.length > 0 || saving}>
          {saving ? <Loader2 className="animate-spin" aria-hidden="true" /> : null}
          {exam ? tCommon("save") : t("create")}
        </Button>
        {onCancel ? (
          <Button type="button" variant="ghost" onClick={onCancel} disabled={saving}>
            {tCommon("cancel")}
          </Button>
        ) : null}
      </div>
      {problem ? <Notice tone="destructive">{problem}</Notice> : null}
    </form>
  );
}
