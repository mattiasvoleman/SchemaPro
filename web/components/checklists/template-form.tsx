"use client";

import { useState } from "react";
import { toast } from "sonner";
import { useChecklistActions, useSubjectChoices } from "@/lib/checklists-queries";
import {
  DESCRIPTION_MAX,
  TITLE_MAX,
  emptyTemplateForm,
  formOfTemplate,
  templateCreateBody,
  templatePatch,
  templateProblems,
  type TemplateForm,
  type TemplateProblem,
  type TemplateView,
} from "@/lib/checklists";
import { Button } from "@/components/ui/button";
import { FormField } from "@/components/ui/form-field";
import { Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/ui/native-select";
import { Notice } from "@/components/ui/notice";
import { Textarea } from "@/components/ui/textarea";
import { useChecklistsText } from "./use-checklists-text";

const FIELD_OF: Record<TemplateProblem, string> = {
  title: "template-title",
  titleLong: "template-title",
  descriptionLong: "template-description",
};

/**
 * A template (a mall): the moment pupils are to have had instruction in, with
 * the subject it belongs to when it belongs to one. Made, or changed in place.
 *
 * A subject is optional (a school-wide moment such as brandövning has none), and
 * a moment is one per subject: a second "Maskinerna" in Slöjd is refused, said
 * here with the form left as it was. A change that changes nothing sends nothing.
 */
export function TemplateFormBody({ template, onDone, onCancel }: { template: TemplateView | null; onDone: () => void; onCancel: () => void }) {
  const { t, tCommon, refusal } = useChecklistsText();
  const subjects = useSubjectChoices(true);
  const { createTemplate, updateTemplate } = useChecklistActions();
  const [form, setForm] = useState<TemplateForm>(() => (template ? formOfTemplate(template) : emptyTemplateForm()));
  const [tried, setTried] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const pending = createTemplate.isPending || updateTemplate.isPending;
  const problems = templateProblems(form);

  const set = <K extends keyof TemplateForm>(key: K, value: TemplateForm[K]) => {
    setForm((current) => ({ ...current, [key]: value }));
    setProblem(null);
  };
  const fieldError = (...which: TemplateProblem[]): string | undefined => {
    const found = tried ? problems.find((one) => which.includes(one)) : undefined;
    return found ? t(`templates.problem.${found}`, { max: found === "titleLong" ? TITLE_MAX : DESCRIPTION_MAX }) : undefined;
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
      if (template) {
        const patch = templatePatch(template, form);
        if (patch) await updateTemplate.mutateAsync({ id: template.id, patch });
      } else {
        await createTemplate.mutateAsync(templateCreateBody(form));
      }
      toast.success(t(template ? "templates.saved" : "templates.created"));
      onDone();
    } catch (error) {
      setProblem(refusal(error));
    }
  };

  // The subject the template has, also when the list of subjects is not (yet) read: the select must hold its value.
  const known = subjects.data ?? [];
  const missingSubject = template?.subjectId && !known.some((subject) => subject.id === template.subjectId);

  return (
    <form onSubmit={submit} noValidate className="space-y-4 rounded-md border p-3" aria-busy={pending || undefined}>
      <h3 className="text-sm font-semibold">{t(template ? "templates.editTitle" : "templates.newTitle")}</h3>
      <div className="grid gap-4 sm:grid-cols-2 [&>*]:min-w-0">
        <FormField
          id="template-title"
          label={t("templates.titleLabel")}
          hint={`${t("templates.titleHint")} ${t("counter", { count: form.title.trim().length, max: TITLE_MAX })}`}
          error={fieldError("title", "titleLong")}
        >
          <Input value={form.title} onChange={(event) => set("title", event.target.value)} autoComplete="off" disabled={pending} />
        </FormField>
        <FormField id="template-subject" label={t("templates.subjectLabel")} optional hint={t("templates.subjectHint")}>
          <NativeSelect value={form.subjectId} onChange={(event) => set("subjectId", event.target.value)} disabled={pending}>
            <option value="">{t("templates.noSubject")}</option>
            {missingSubject ? <option value={template.subjectId!}>{template.subjectName ?? template.subjectId}</option> : null}
            {known.map((subject) => (
              <option key={subject.id} value={subject.id}>
                {subject.name}
              </option>
            ))}
          </NativeSelect>
        </FormField>
      </div>
      <FormField
        id="template-description"
        label={t("templates.descriptionLabel")}
        optional
        hint={`${t("templates.descriptionHint")} ${t("counter", { count: form.description.trim().length, max: DESCRIPTION_MAX })}`}
        error={fieldError("descriptionLong")}
      >
        <Textarea rows={3} value={form.description} onChange={(event) => set("description", event.target.value)} disabled={pending} />
      </FormField>
      {subjects.isError ? <Notice tone="warning">{t("templates.subjectsFailed")}</Notice> : null}
      {problem ? (
        <Notice tone="destructive" title={t("templates.failed")}>
          {problem}
        </Notice>
      ) : null}
      <div className="flex flex-wrap gap-2">
        <Button type="submit" disabled={pending}>
          {pending ? t("templates.saving") : t(template ? "templates.save" : "templates.create")}
        </Button>
        <Button type="button" variant="outline" onClick={onCancel} disabled={pending}>
          {tCommon("cancel")}
        </Button>
      </div>
    </form>
  );
}
