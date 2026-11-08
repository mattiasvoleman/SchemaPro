"use client";

/*
 * Inställningar: whether the planner is on, how many exams a class may have a
 * day and a week, how many writers one invigilator watches, the minutes a
 * room and an invigilator need between two exams, and the subject the
 * replacement lessons are held in.
 *
 * THE PLANNER IS OFF UNTIL THE SCHOOL TURNS IT ON, and the switch's hint says
 * what that means: exams can be entered and rooms marked either way, only
 * "Planera" is refused (EXAM_PLANNING_OFF). The planner card, where the button
 * is missing, says it again; it reads the saved settings, not this form: the
 * switch here is a wish until it is saved.
 *
 * THE REPLACEMENT SUBJECT IS OFFERED ONLY AMONG SUBJECTS THAT DO NOT COUNT
 * toward the timplan, as an activity's is: an exam's own minutes are credited
 * to the exam's subject, and a replacement lesson that counted would count
 * them twice (EXAM_REPLACEMENT_SUBJECT_COUNTS).
 */

import { useState } from "react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { Loader2 } from "lucide-react";
import { Link } from "@/i18n/navigation";
import { formOfSettings, settingsInput, settingsProblems, type SettingsForm } from "@/lib/exam-form";
import type { ExamSettings } from "@/lib/exam-types";
import type { Subject } from "@/lib/types";
import { useReadOnly } from "@/components/profile-context";
import { Button } from "@/components/ui/button";
import { FormField } from "@/components/ui/form-field";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { LoadError } from "@/components/ui/load-error";
import { NativeSelect } from "@/components/ui/native-select";
import { Notice } from "@/components/ui/notice";
import { SectionCard } from "@/components/ui/section-card";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { useErrorText } from "./exam-format";
import { useExamSettings, useSaveExamSettings } from "./use-exams";

export function ExamSettingsCard({ subjects }: { subjects: readonly Subject[] }) {
  const t = useTranslations("exams");
  const settings = useExamSettings();
  return (
    <SectionCard id="exam-settings" title={t("settingsTitle")} description={t("settingsIntro")}>
      {settings.isLoading ? (
        <div aria-busy="true">
          <Skeleton className="h-40 w-full" />
        </div>
      ) : settings.isError ? (
        <LoadError variant="inline" title={t("settingsLoadFailed")} hint={t("loadFailedHint")} />
      ) : settings.data ? (
        <SettingsBody settings={settings.data} subjects={subjects} />
      ) : null}
    </SectionCard>
  );
}

function SettingsBody({ settings, subjects }: { settings: ExamSettings; subjects: readonly Subject[] }) {
  const t = useTranslations("exams");
  const tCommon = useTranslations("common");
  const readOnly = useReadOnly();
  const errorText = useErrorText();
  const save = useSaveExamSettings();
  const saved = formOfSettings(settings);
  const [form, setForm] = useState<SettingsForm>(saved);
  const [problem, setProblem] = useState<string | null>(null);
  const update = (patch: Partial<SettingsForm>) => setForm((previous) => ({ ...previous, ...patch }));

  const problems = settingsProblems(form);
  const changed = (Object.keys(saved) as Array<keyof SettingsForm>).some((key) => form[key] !== saved[key]);
  const options = subjects.filter((subject) => !subject.countsTowardTimplan);
  // The subject the school chose stays on the list even when it has come to count, so the select does not show another.
  const chosen = settings.replacementSubject;
  if (chosen && !options.some((subject) => subject.id === chosen.id)) options.push({ id: chosen.id, name: chosen.name } as Subject);

  const submit = async () => {
    setProblem(null);
    try {
      await save.mutateAsync(settingsInput(form));
      toast.success(t("settingsSaved"));
    } catch (error) {
      setProblem(errorText(error));
    }
  };

  const numberField = (key: "maxPerClassPerDay" | "maxPerClassPerWeek" | "writersPerInvigilator" | "turnoverMinutes", min: number, max: number) => (
    <Input
      type="number"
      inputMode="numeric"
      min={min}
      max={max}
      value={form[key]}
      onChange={(event) => update({ [key]: event.target.value })}
    />
  );

  return (
    <form
      className="space-y-4"
      onSubmit={(event) => {
        event.preventDefault();
        if (!readOnly && changed && problems.length === 0) void submit();
      }}
    >
      {/* The reading is the same for everyone; a reader's fields take no input. */}
      <fieldset disabled={readOnly || save.isPending} className="space-y-4 border-0 p-0" data-writes-inert="DRIFT">
        <legend className="sr-only">{t("settingsTitle")}</legend>
        <div className="flex items-start justify-between gap-4 rounded-md border p-3">
          <div className="min-w-0 space-y-1">
            <Label htmlFor="exam-enabled">{t("enabled")}</Label>
            <p id="exam-enabled-hint" className="text-xs text-muted-foreground">
              {t("enabledHint")}
            </p>
          </div>
          <Switch
            id="exam-enabled"
            aria-describedby="exam-enabled-hint"
            checked={form.enabled}
            onCheckedChange={(enabled) => update({ enabled })}
          />
        </div>

        <div className="grid gap-4 sm:grid-cols-2 [&>*]:min-w-0">
          <FormField id="exam-max-day" label={t("maxDay")} error={problems.includes("day") ? t("settingsProblems.day") : undefined}>
            {numberField("maxPerClassPerDay", 1, 10)}
          </FormField>
          <FormField
            id="exam-max-week"
            label={t("maxWeek")}
            error={
              problems.includes("week")
                ? t("settingsProblems.week")
                : problems.includes("order")
                  ? t("settingsProblems.order")
                  : undefined
            }
          >
            {numberField("maxPerClassPerWeek", 1, 30)}
          </FormField>
          <FormField
            id="exam-ratio"
            label={t("ratio")}
            hint={t("ratioHint")}
            error={problems.includes("ratio") ? t("settingsProblems.ratio") : undefined}
          >
            {numberField("writersPerInvigilator", 1, 200)}
          </FormField>
          <FormField
            id="exam-turnover"
            label={t("turnover")}
            hint={t("turnoverHint")}
            error={problems.includes("turnover") ? t("settingsProblems.turnover") : undefined}
          >
            {numberField("turnoverMinutes", 0, 120)}
          </FormField>
        </div>

        {options.length === 0 ? (
          <Notice tone="warning" role={null} title={t("noReplacementSubjectTitle")}>
            <p>{t("noReplacementSubjectBody")}</p>
            <p className="pt-1">
              <Link href="/admin/subjects" className="font-medium underline underline-offset-4">
                {t("goToSubjects")}
              </Link>
            </p>
          </Notice>
        ) : (
          <FormField id="exam-replacement" label={t("replacementSubject")} hint={t("replacementSubjectHint")}>
            <NativeSelect
              value={form.replacementSubjectId}
              onChange={(event) => update({ replacementSubjectId: event.target.value })}
            >
              <option value="">{t("subjectPlaceholder")}</option>
              {options.map((subject) => (
                <option key={subject.id} value={subject.id}>
                  {subject.name}
                </option>
              ))}
            </NativeSelect>
          </FormField>
        )}
      </fieldset>

      {problem ? <Notice tone="destructive">{problem}</Notice> : null}
      {readOnly ? null : (
        <div className="flex justify-end gap-2 border-t pt-3">
          <Button type="submit" data-writes="DRIFT" disabled={!changed || problems.length > 0 || save.isPending}>
            {save.isPending ? <Loader2 className="animate-spin" aria-hidden="true" /> : null}
            {save.isPending ? tCommon("saving") : tCommon("save")}
          </Button>
        </div>
      )}
    </form>
  );
}
