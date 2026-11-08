"use client";

import { useState } from "react";
import { useChecklistActions, useChecklistGroups } from "@/lib/checklists-queries";
import {
  LIST_BODY_MAX,
  TITLE_MAX,
  classesForNewList,
  emptyListForm,
  listBody,
  listProblems,
  type ConsentListItem,
  type ListForm,
  type ListProblem,
} from "@/lib/checklists";
import { Button } from "@/components/ui/button";
import { FormField } from "@/components/ui/form-field";
import { Input } from "@/components/ui/input";
import { LoadError } from "@/components/ui/load-error";
import { NativeSelect } from "@/components/ui/native-select";
import { Notice } from "@/components/ui/notice";
import { SectionCard } from "@/components/ui/section-card";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import type { ChecklistAudience } from "./checklists";
import { useChecklistsText } from "./use-checklists-text";

const FIELD_OF: Record<ListProblem, string> = {
  class: "list-class",
  title: "list-title",
  titleLong: "list-title",
  body: "list-body",
  bodyLong: "list-body",
};

/**
 * A new consent list: a class, a title, and the text the guardians are asked to
 * consent to, in the words they will read. The list is the class's as it is
 * placed now; asking the guardians is done from the list, once it is made.
 *
 * A teacher makes a list for a class they mentor, which the gateway checks (the
 * class select offers the classes the teacher is given, and a class they do not
 * mentor is refused with a sentence). A class has one open list of a name.
 */
export function ConsentListForm({
  audience,
  onCancel,
  onCreated,
}: {
  audience: ChecklistAudience;
  onCancel: () => void;
  onCreated: (list: ConsentListItem) => void;
}) {
  const { t, tCommon, refusal } = useChecklistsText();
  const groups = useChecklistGroups();
  const { createList } = useChecklistActions();
  const [form, setForm] = useState<ListForm>(emptyListForm);
  const [tried, setTried] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const pending = createList.isPending;
  const classes = classesForNewList(groups.data ?? []);
  const problems = listProblems(form);

  const set = <K extends keyof ListForm>(key: K, value: ListForm[K]) => {
    setForm((current) => ({ ...current, [key]: value }));
    setProblem(null);
  };
  const fieldError = (...which: ListProblem[]): string | undefined => {
    const found = tried ? problems.find((one) => which.includes(one)) : undefined;
    return found ? t(`newList.problem.${found}`, { max: found.startsWith("title") ? TITLE_MAX : LIST_BODY_MAX }) : undefined;
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
      onCreated(await createList.mutateAsync(listBody(form)));
    } catch (error) {
      setProblem(refusal(error));
    }
  };

  const body = () => {
    if (groups.isLoading) {
      return (
        <div aria-busy="true">
          <Skeleton className="h-48 w-full" />
        </div>
      );
    }
    if (groups.isError || !groups.data) {
      return (
        <LoadError
          variant="inline"
          title={t("newList.loadFailed")}
          hint={t("newList.loadFailedHint")}
          action={
            <Button type="button" variant="outline" size="sm" onClick={() => void groups.refetch()}>
              {tCommon("retry")}
            </Button>
          }
        />
      );
    }
    if (classes.length === 0) {
      return (
        <Notice tone="neutral" title={t("newList.noClassesTitle")}>
          {t(`newList.noClasses.${audience}`)}
        </Notice>
      );
    }
    return (
      <form onSubmit={submit} noValidate className="space-y-4" aria-busy={pending || undefined}>
        <div className="grid gap-4 sm:grid-cols-2 [&>*]:min-w-0">
          <FormField id="list-class" label={t("newList.classLabel")} hint={t(`newList.classHint.${audience}`)} error={fieldError("class")}>
            <NativeSelect value={form.classId} onChange={(event) => set("classId", event.target.value)} disabled={pending}>
              <option value="">{t("newList.chooseClass")}</option>
              {classes.map((one) => (
                <option key={one.id} value={one.id}>
                  {one.name}
                </option>
              ))}
            </NativeSelect>
          </FormField>
          <FormField
            id="list-title"
            label={t("newList.titleLabel")}
            hint={`${t("newList.titleHint")} ${t("counter", { count: form.title.trim().length, max: TITLE_MAX })}`}
            error={fieldError("title", "titleLong")}
          >
            <Input value={form.title} onChange={(event) => set("title", event.target.value)} autoComplete="off" disabled={pending} />
          </FormField>
        </div>
        <FormField
          id="list-body"
          label={t("newList.bodyLabel")}
          hint={`${t("newList.bodyHint")} ${t("counter", { count: form.body.trim().length, max: LIST_BODY_MAX })}`}
          error={fieldError("body", "bodyLong")}
        >
          <Textarea rows={6} value={form.body} onChange={(event) => set("body", event.target.value)} disabled={pending} />
        </FormField>
        <p className="rounded-md bg-muted px-3 py-2 text-sm text-muted-foreground">{t("newList.footer")}</p>
        {problem ? (
          <Notice tone="destructive" title={t("newList.failed")}>
            {problem}
          </Notice>
        ) : null}
        <div className="flex flex-wrap gap-2">
          <Button type="submit" disabled={pending}>
            {pending ? t("newList.creating") : t("newList.submit")}
          </Button>
          <Button type="button" variant="outline" onClick={onCancel} disabled={pending}>
            {tCommon("cancel")}
          </Button>
        </div>
      </form>
    );
  };

  return (
    <SectionCard id="checklists-new-list" title={t("newList.title")} description={t("newList.description")}>
      {body()}
    </SectionCard>
  );
}
