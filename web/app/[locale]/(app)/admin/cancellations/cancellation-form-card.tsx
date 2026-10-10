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
 * TIME. An EVENT avbokning counts as lost undervisningstid in Täckning (P3,
 * cancelledEvent) unless the school counts the day as teaching — the credit
 * below writes a TimplanCredit for each whole day after today. The two go
 * together, so the schedule gap is not flattered by the credit (the gateway
 * keeps a batch's credits out of it).
 */

import { useMemo, useState } from "react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
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
import { formatTime } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { DateField } from "@/components/ui/date-field";
import { GradeSpanField } from "@/components/ui/grade-span-field";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
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
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{t("formTitle")}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4 text-sm">
        <div className="grid gap-4 sm:grid-cols-2 [&>*]:min-w-0">
          <div className="space-y-1">
            <Label htmlFor="cancel-name">{t("name")}</Label>
            <Input
              id="cancel-name"
              value={form.name}
              maxLength={120}
              placeholder={t("namePlaceholder")}
              onChange={(event) => update({ name: event.target.value })}
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="cancel-cause">{t("cause")}</Label>
            <Select value={form.cause} onValueChange={(value) => update({ cause: value as BatchCause })}>
              <SelectTrigger id="cancel-cause" aria-label={t("cause")}>
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
          </div>
          <div className="space-y-1">
            <Label htmlFor="cancel-from">{t("fromDate")}</Label>
            <DateField
              id="cancel-from"
              label={t("fromDate")}
              value={form.fromDate}
              min={year.startDate}
              max={year.endDate}
              onChange={(value) => update({ fromDate: value, toDate: form.toDate || value })}
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="cancel-to">{t("toDate")}</Label>
            <DateField
              id="cancel-to"
              label={t("toDate")}
              value={form.toDate}
              min={form.fromDate || year.startDate}
              max={year.endDate}
              onChange={(value) => update({ toDate: value })}
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="cancel-start">{t("startTime")}</Label>
            <Input
              id="cancel-start"
              type="time"
              value={form.startTime}
              onChange={(event) => update({ startTime: event.target.value })}
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="cancel-end">{t("endTime")}</Label>
            <Input
              id="cancel-end"
              type="time"
              value={form.endTime}
              onChange={(event) => update({ endTime: event.target.value })}
            />
          </div>
        </div>
        <p className="text-xs">{t("timeHint")}</p>

        <div className="grid gap-4 sm:grid-cols-2 [&>*]:min-w-0">
          <div className="space-y-1">
            <Label htmlFor="cancel-scope">{t("scope")}</Label>
            <Select value={form.scope} onValueChange={(value) => update({ scope: value as BatchScope })}>
              <SelectTrigger id="cancel-scope" aria-label={t("scope")}>
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
          </div>
          {form.scope === "GRADES" ? (
            <GradeSpanField
              label={t("grades")}
              min={form.minGradeLevel}
              max={form.maxGradeLevel}
              onChange={(span) => update({ minGradeLevel: span.min, maxGradeLevel: span.max })}
            />
          ) : null}
        </div>
        {form.scope === "GRADES" ? <p className="text-xs">{t("gradesHint")}</p> : null}
        {form.scope === "GROUPS" ? (
          <fieldset className="space-y-1">
            <legend className="font-medium">{t("groups")}</legend>
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

        <div className="space-y-2 rounded-md border p-3">
          <div className="flex items-start gap-3">
            <Switch
              id="cancel-credit"
              checked={form.credit}
              onCheckedChange={(checked) => update({ credit: checked })}
              aria-describedby="cancel-credit-hint"
            />
            <span>
              <Label htmlFor="cancel-credit">{t("credit")}</Label>
              <span id="cancel-credit-hint" className="block text-xs">
                {t("creditHint")}
              </span>
            </span>
          </div>
          {form.credit ? (
            <div className="grid gap-3 sm:grid-cols-2 [&>*]:min-w-0">
              <div className="space-y-1">
                <Label htmlFor="cancel-credit-minutes">{t("creditMinutes")}</Label>
                <Input
                  id="cancel-credit-minutes"
                  type="number"
                  min={1}
                  max={600}
                  value={form.creditMinutes}
                  onChange={(event) => update({ creditMinutes: event.target.value })}
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor="cancel-credit-subject">{t("creditSubject")}</Label>
                <Select
                  value={form.creditSubjectId ?? NO_SUBJECT}
                  onValueChange={(value) => update({ creditSubjectId: value === NO_SUBJECT ? null : value })}
                >
                  <SelectTrigger id="cancel-credit-subject" aria-label={t("creditSubject")}>
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
              </div>
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
            {t("preview")}
          </Button>
          <Button
            onClick={doCreate}
            disabled={!current || current.matched === 0 || problems.length > 0 || create.isPending}
          >
            {t("confirm", { count: current?.matched ?? 0 })}
          </Button>
        </div>
        {preview.data && !current ? <p>{t("previewOutdated")}</p> : null}

        {current ? (
          <section aria-labelledby="cancel-preview-title" className="space-y-2">
            <h3 id="cancel-preview-title" className="font-semibold">
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
                  ? t("creditDates", { count: current.creditDates.length, dates: current.creditDates.join(", ") })
                  : t("creditNoDates")}
              </p>
            ) : null}
            {current.lessons.length > 0 ? (
              <ul className="max-h-64 space-y-0.5 overflow-y-auto rounded-md border p-2 text-xs">
                {current.lessons.map((lesson) => (
                  <li key={lesson.id} className="tabular-nums">
                    {lesson.date} {formatTime(lesson.startsAt)}–{formatTime(lesson.endsAt)} · {lesson.subjectName} ·{" "}
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

        {problem ? (
          <p role="alert" className="font-medium">
            {problem}
          </p>
        ) : null}
      </CardContent>
    </Card>
  );
}
