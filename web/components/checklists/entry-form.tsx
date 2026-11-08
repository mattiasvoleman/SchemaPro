"use client";

import { useState } from "react";
import { useChecklistActions } from "@/lib/checklists-queries";
import {
  ENTRY_NOTE_MAX,
  GIVEN_BY_MAX,
  TICK_MAX,
  emptyEntryForm,
  entryBody,
  entryProblems,
  type ConsentKind,
  type EntryForm,
  type EntryProblem,
} from "@/lib/checklists";
import { toDateString } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { DateField } from "@/components/ui/date-field";
import { FormField } from "@/components/ui/form-field";
import { Input } from "@/components/ui/input";
import { Notice } from "@/components/ui/notice";
import { Textarea } from "@/components/ui/textarea";
import { useChecklistsText } from "./use-checklists-text";

/** The control that holds each problem, so the first one found can be focused. */
const FIELD_OF: Record<EntryProblem, string> = {
  pupils: "entry-date",
  pupilsMany: "entry-date",
  date: "entry-date",
  dateFuture: "entry-date",
  givenByLong: "entry-given-by",
  noteLong: "entry-note",
};

/**
 * Write down an answer for the chosen pupils: a consent given on paper or in a
 * call, a no, or a consent taken back. The kind is fixed by the button that
 * opened it. The date is the day on the paper or of the call (today unless
 * changed, never one that has not come), who gave it is the writer's own words,
 * and who wrote it down and when are the gateway's.
 *
 * A consent taken back is written as one more answer: the earlier ones stay in
 * the list's history, and the list shows the withdrawal at once.
 */
export function EntryForm({
  listId,
  kind,
  studentIds,
  onDone,
  onCancel,
}: {
  listId: string;
  kind: ConsentKind;
  studentIds: readonly string[];
  onDone: (written: number) => void;
  onCancel: () => void;
}) {
  const { t, tCommon, refusal } = useChecklistsText();
  const { record } = useChecklistActions();
  const [today] = useState(() => toDateString(new Date()));
  const [form, setForm] = useState<EntryForm>(() => emptyEntryForm(kind, today));
  const [tried, setTried] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const pending = record.isPending;
  const problems = entryProblems(form, studentIds, today);

  const set = <K extends keyof EntryForm>(key: K, value: EntryForm[K]) => {
    setForm((current) => ({ ...current, [key]: value }));
    setProblem(null);
  };
  const fieldError = (...which: EntryProblem[]): string | undefined => {
    const found = tried ? problems.find((one) => which.includes(one)) : undefined;
    return found ? t(`entry.problem.${found}`, { max: found === "givenByLong" ? GIVEN_BY_MAX : found === "noteLong" ? ENTRY_NOTE_MAX : TICK_MAX }) : undefined;
  };

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (pending) return;
    setTried(true);
    setProblem(null);
    if (problems.length > 0) {
      document.getElementById(FIELD_OF[problems[0]!])?.focus();
      return;
    }
    try {
      const done = await record.mutateAsync({ id: listId, body: entryBody(form, studentIds, today) });
      onDone(done.written);
    } catch (error) {
      setProblem(refusal(error));
    }
  };

  return (
    <form onSubmit={submit} noValidate className="space-y-4" aria-busy={pending || undefined}>
      <p className="text-sm font-medium" aria-live="polite">
        {t("entry.pupils", { count: studentIds.length })}
      </p>
      <FormField id="entry-date" label={t(`entry.dateLabel.${kind}`)} hint={t(`entry.dateHint.${kind}`)} error={fieldError("date", "dateFuture", "pupils", "pupilsMany")}>
        <DateField value={form.givenOn} onChange={(value) => set("givenOn", value)} max={today} label={t(`entry.dateLabel.${kind}`)} />
      </FormField>
      <FormField
        id="entry-given-by"
        label={t("entry.givenByLabel")}
        optional
        hint={`${t("entry.givenByHint")} ${t("counter", { count: form.givenBy.trim().length, max: GIVEN_BY_MAX })}`}
        error={fieldError("givenByLong")}
      >
        <Input value={form.givenBy} onChange={(event) => set("givenBy", event.target.value)} autoComplete="off" disabled={pending} />
      </FormField>
      <FormField
        id="entry-note"
        label={t("entry.noteLabel")}
        optional
        hint={t("counter", { count: form.note.trim().length, max: ENTRY_NOTE_MAX })}
        error={fieldError("noteLong")}
      >
        <Textarea rows={2} value={form.note} onChange={(event) => set("note", event.target.value)} disabled={pending} />
      </FormField>
      {kind === "WITHDRAWN" ? <Notice tone="neutral">{t("entry.withdrawnStays")}</Notice> : null}
      {problem ? (
        <Notice tone="destructive" title={t("entry.failed")}>
          {problem}
        </Notice>
      ) : null}
      <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
        <Button type="button" variant="outline" onClick={onCancel} disabled={pending}>
          {tCommon("cancel")}
        </Button>
        <Button type="submit" disabled={pending}>
          {pending ? t("entry.writing") : t(`entry.submit.${kind}`)}
        </Button>
      </div>
    </form>
  );
}
