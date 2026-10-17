"use client";

/*
 * Ny avbokning: name the day (Prao åk 9, Friluftsdag, Studiedag), pick the
 * days and who, preview, then cancel. Nothing is cancelled before the admin
 * has read the preview — which lessons, how many, and what is left alone and
 * why (begun, already cancelled, attendance taken) — and the create carries
 * the preview's digest, so a calendar that changed in between is refused
 * (CANCELLATION_STALE) rather than cancelled unseen.
 *
 * WHY A LESSON IS CANCELLED AND NOT REMOVED. A lov removes the lessons; an
 * avbokning keeps them, CANCELLED, with the note "Inställd: Prao åk 9" — so
 * the pupil, the guardian, the teacher and the app see why the hour is empty,
 * the absence and substitute flows see a lesson nobody holds, and a reversal
 * can put it back.
 *
 * WHO IS TOLD. Nobody, unless the admin ticks the digest in the preview: one
 * notice per pupil, guardian and teacher the batch touches, with how many of
 * their lessons and over which days, and another if it is taken back. The
 * preview says how many of each it would reach. Unticked by default, since
 * every cancelled lesson already carries the note.
 *
 * TIME. An EVENT avbokning counts as lost undervisningstid in Täckning (P3,
 * cancelledEvent) unless the school counts the day as teaching — the credit
 * below writes a TimplanCredit for each whole day after today. The two go
 * together, so the schedule gap is not flattered by the credit (the gateway
 * keeps a batch's credits out of it).
 */

import { useMemo, useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import { toast } from "sonner";
import { Eye, Loader2 } from "lucide-react";
import {
  createInputOf,
  EMPTY_CANCELLATION_FORM,
  formProblems,
  sameSelection,
  selectionOf,
  type CancellationForm,
} from "@/lib/cancellation-form";
import type { MessageLookup } from "@/lib/engine-message";
import { publicationErrorText } from "@/lib/publication-messages";
import type { BatchCause, BatchScope, CancellationSelection } from "@/lib/publication-types";
import type { AcademicYear, StudentGroup, Subject } from "@/lib/types";
import { Button } from "@/components/ui/button";
import { DateField } from "@/components/ui/date-field";
import { FormField } from "@/components/ui/form-field";
import { GradeSpanField } from "@/components/ui/grade-span-field";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Notice } from "@/components/ui/notice";
import { SectionCard } from "@/components/ui/section-card";
import { Switch } from "@/components/ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useCancellationPreview, useCreateCancellationBatch } from "./use-cancellation-batches";

const SCOPES: BatchScope[] = ["SCHOOL", "GRADES", "GROUPS"];
const CAUSES: BatchCause[] = ["EVENT", "MANUAL"];
const NO_SUBJECT = "none";

export function CancellationFormCard({
  year,
  groups,
  subjects,
}: {
  year: AcademicYear;
  groups: readonly StudentGroup[];
  subjects: readonly Subject[];
}) {
  const t = useTranslations("cancellations");
  const tErrors = useTranslations("publishing.errors") as unknown as MessageLookup;
  const tCommon = useTranslations("common");
  const locale = useLocale();
  const preview = useCancellationPreview();
  const create = useCreateCancellationBatch();
  const [form, setForm] = useState<CancellationForm>(EMPTY_CANCELLATION_FORM);
  const [previewed, setPreviewed] = useState<CancellationSelection | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  const yearGroups = useMemo(
    () =>
      groups
        .filter((group) => group.academicYearId === year.id)
        .sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name, "sv") : a.kind === "CLASS" ? -1 : 1)),
    [groups, year.id],
  );
  const problems = formProblems(form, year);
  const selection = selectionOf(form, year.id);
  const current = preview.data && sameSelection(previewed, selection) ? preview.data : null;
  const update = (patch: Partial<CancellationForm>) => setForm((previous) => ({ ...previous, ...patch }));
  // A preview's days are calendar days (yyyy-mm-dd), read at UTC midnight so
  // no time zone moves one to the day before.
  const dayFormat = useMemo(
    () => new Intl.DateTimeFormat(locale, { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" }),
    [locale],
  );
  const dayText = (date: string) => dayFormat.format(new Date(`${date}T00:00:00.000Z`));
  const clock = useMemo(
    () => new Intl.DateTimeFormat(locale, { hour: "2-digit", minute: "2-digit", hourCycle: "h23" }),
    [locale],
  );
  const timeText = (iso: string) => clock.format(new Date(iso));

  const doPreview = async () => {
    setProblem(null);
    try {
      await preview.mutateAsync(selection);
      setPreviewed(selection);
    } catch (error) {
      setPreviewed(null);
      setProblem(publicationErrorText(tErrors, error, tCommon("error")));
    }
  };

  const doCreate = async () => {
    if (!current) return;
    setProblem(null);
    try {
      const outcome = await create.mutateAsync(createInputOf(form, year.id, current.digest));
      toast.success(t("created", { count: outcome.cancelled, credits: outcome.credits }));
      setForm(EMPTY_CANCELLATION_FORM);
      setPreviewed(null);
      preview.reset();
    } catch (error) {
      setProblem(publicationErrorText(tErrors, error, tCommon("error")));
      // A stale or refused create leaves a preview nobody may act on.
      setPreviewed(null);
    }
  };

  return (
    // Every part of it is the new batch, Drift's: even its preview is a POST the gateway answers by area.
    <SectionCard id="cancel-form" title={t("formTitle")} data-writes="DRIFT">
      <div className="space-y-4 text-sm">
        <div className="grid gap-4 sm:grid-cols-2 [&>*]:min-w-0">
          <FormField id="cancel-name" label={t("name")}>
            <Input
              value={form.name}
              maxLength={120}
              placeholder={t("namePlaceholder")}
              onChange={(event) => update({ name: event.target.value })}
            />
          </FormField>
          <FormField id="cancel-cause" label={t("cause")}>
            {(control) => (
              <Select value={form.cause} onValueChange={(value) => update({ cause: value as BatchCause })}>
                <SelectTrigger {...control}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {CAUSES.map((cause) => (
                    <SelectItem key={cause} value={cause}>
                      {t(`causes.${cause}`)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          </FormField>
          <FormField id="cancel-from" label={t("fromDate")}>
            <DateField
              label={t("fromDate")}
              value={form.fromDate}
              min={year.startDate}
              max={year.endDate}
              onChange={(value) => update({ fromDate: value, toDate: form.toDate || value })}
            />
          </FormField>
          <FormField id="cancel-to" label={t("toDate")}>
            <DateField
              label={t("toDate")}
              value={form.toDate}
              min={form.fromDate || year.startDate}
              max={year.endDate}
              onChange={(value) => update({ toDate: value })}
            />
          </FormField>
          <FormField id="cancel-start" label={t("startTime")}>
            <Input
              type="time"
              aria-describedby="cancel-time-hint"
              value={form.startTime}
              onChange={(event) => update({ startTime: event.target.value })}
            />
          </FormField>
          <FormField id="cancel-end" label={t("endTime")}>
            <Input
              type="time"
              aria-describedby="cancel-time-hint"
              value={form.endTime}
              onChange={(event) => update({ endTime: event.target.value })}
            />
          </FormField>
        </div>
        <p id="cancel-time-hint" className="text-xs text-muted-foreground">
          {t("timeHint")}
        </p>

        <div className="grid gap-4 sm:grid-cols-2 [&>*]:min-w-0">
          <FormField id="cancel-scope" label={t("scope")}>
            {(control) => (
              <Select value={form.scope} onValueChange={(value) => update({ scope: value as BatchScope })}>
                <SelectTrigger {...control}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {SCOPES.map((scope) => (
                    <SelectItem key={scope} value={scope}>
                      {t(`scopes.${scope}`)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
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
        {form.scope === "GRADES" ? <p className="text-xs text-muted-foreground">{t("gradesHint")}</p> : null}
        {form.scope === "GROUPS" ? (
          <fieldset className="space-y-1.5">
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
                          : form.groupIds.filter((id) => id !== group.id),
                      })
                    }
                  />
                  {group.name}
                </label>
              ))}
            </div>
          </fieldset>
        ) : null}

        <div className="space-y-3 rounded-md border p-3">
          <div className="flex items-start justify-between gap-4">
            <div className="space-y-1">
              <Label htmlFor="cancel-credit">{t("credit")}</Label>
              <p id="cancel-credit-hint" className="text-xs text-muted-foreground">
                {t("creditHint")}
              </p>
            </div>
            <Switch
              id="cancel-credit"
              checked={form.credit}
              onCheckedChange={(checked) => update({ credit: checked })}
              aria-describedby="cancel-credit-hint"
            />
          </div>
          {form.credit ? (
            <div className="grid gap-4 sm:grid-cols-2 [&>*]:min-w-0">
              <FormField id="cancel-credit-minutes" label={t("creditMinutes")}>
                <Input
                  type="number"
                  min={1}
                  max={600}
                  value={form.creditMinutes}
                  onChange={(event) => update({ creditMinutes: event.target.value })}
                />
              </FormField>
              <FormField id="cancel-credit-subject" label={t("creditSubject")}>
                {(control) => (
                  <Select
                    value={form.creditSubjectId ?? NO_SUBJECT}
                    onValueChange={(value) => update({ creditSubjectId: value === NO_SUBJECT ? null : value })}
                  >
                    <SelectTrigger {...control}>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value={NO_SUBJECT}>{t("creditNoSubject")}</SelectItem>
                      {subjects.map((subject) => (
                        <SelectItem key={subject.id} value={subject.id}>
                          {subject.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
              </FormField>
            </div>
          ) : null}
        </div>

        {problems.length > 0 && (form.name || form.fromDate) ? (
          <ul className="list-disc space-y-0.5 pl-5" aria-live="polite">
            {problems.map((key) => (
              <li key={key}>{t(`problems.${key}`)}</li>
            ))}
          </ul>
        ) : null}

        <div className="flex flex-wrap gap-2">
          <Button variant="outline" onClick={doPreview} disabled={problems.length > 0 || preview.isPending}>
            {preview.isPending ? <Loader2 className="animate-spin" /> : <Eye />}
            {t("preview")}
          </Button>
          <Button
            onClick={doCreate}
            disabled={!current || current.matched === 0 || problems.length > 0 || create.isPending}
          >
            {create.isPending ? <Loader2 className="animate-spin" /> : null}
            {t("confirm", { count: current?.matched ?? 0 })}
          </Button>
        </div>
        {preview.data && !current ? <Notice tone="warning">{t("previewOutdated")}</Notice> : null}

        {current ? (
          <section aria-labelledby="cancel-preview-title" className="space-y-2 rounded-md border p-3">
            <h3 id="cancel-preview-title" className="text-sm font-semibold">
              {t("previewTitle", { count: current.matched })}
            </h3>
            <p>
              {t("excluded", {
                started: current.excluded.started,
                notScheduled: current.excluded.notScheduled,
                attendance: current.excluded.attendance,
              })}
            </p>
            {current.ungradedGroups.length > 0 ? (
              <p>{t("ungraded", { groups: current.ungradedGroups.join(", ") })}</p>
            ) : null}
            {form.credit ? (
              <p>
                {current.creditDates.length > 0
                  ? t("creditDates", { count: current.creditDates.length, dates: current.creditDates.map(dayText).join(", ") })
                  : t("creditNoDates")}
              </p>
            ) : null}
            <div className="flex items-start justify-between gap-4 rounded-md border p-3">
              <div className="space-y-1">
                <Label htmlFor="cancel-notify">{t("notify")}</Label>
                <p id="cancel-notify-hint" className="text-xs text-muted-foreground">
                  {current.audience ? t("notifyHint", current.audience) : t("notifyHintNoCount")}
                </p>
              </div>
              <Switch
                id="cancel-notify"
                checked={form.notify}
                onCheckedChange={(checked) => update({ notify: checked })}
                aria-describedby="cancel-notify-hint"
              />
            </div>
            {current.lessons.length > 0 ? (
              <ul className="max-h-64 space-y-0.5 overflow-y-auto rounded-md border p-2 text-xs">
                {current.lessons.map((lesson) => (
                  <li key={lesson.id} className="tabular-nums">
                    {dayText(lesson.date)} {timeText(lesson.startsAt)}–{timeText(lesson.endsAt)} · {lesson.subjectName} ·{" "}
                    {lesson.groupName}
                  </li>
                ))}
                {current.matched > current.lessons.length ? (
                  <li>{t("andMore", { count: current.matched - current.lessons.length })}</li>
                ) : null}
              </ul>
            ) : null}
          </section>
        ) : null}

        {problem ? <Notice tone="destructive">{problem}</Notice> : null}
      </div>
    </SectionCard>
  );
}
