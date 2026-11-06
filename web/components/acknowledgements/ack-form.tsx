"use client";

import { useEffect, useMemo, useState } from "react";
import { ClipboardCheck } from "lucide-react";
import { useTranslations } from "next-intl";
import { ApiError } from "@/lib/api";
import { useAckActions, useAckPupils } from "@/lib/ack-queries";
import {
  ACK_RULES,
  ACK_UNKNOWN_PUPIL,
  BODY_MAX,
  CREATE_REFUSALS,
  PUPILS_MAX,
  TITLE_MAX,
  bodyOfForm,
  classesOf,
  emptyAckForm,
  formProblems,
  guardiansOf,
  namesOf,
  setChosen,
  shownPupils,
  withoutGuardianOf,
  type AckForm,
  type AckPupilChoice,
  type AckSent,
  type FormProblem,
} from "@/lib/ack";
import { Button } from "@/components/ui/button";
import { badgeVariants } from "@/components/ui/badge";
import { EmptyState } from "@/components/ui/empty-state";
import { FilterBar, FilterField } from "@/components/ui/filter-bar";
import { FormField } from "@/components/ui/form-field";
import { Input } from "@/components/ui/input";
import { LoadError } from "@/components/ui/load-error";
import { NativeSelect } from "@/components/ui/native-select";
import { Notice } from "@/components/ui/notice";
import { SearchField } from "@/components/ui/search-field";
import { SectionCard } from "@/components/ui/section-card";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { useAckText } from "./use-ack-text";

const NO_PUPILS: AckPupilChoice[] = [];
/** The names of the pupils left out that the warning spells out before it says "and n more". */
const NAMES_SHOWN = 8;

/**
 * Enter in a one-line field does not send: a request reaches every guardian it
 * names and cannot be taken back, so only the button sends it.
 */
const noEnter = (event: React.KeyboardEvent) => {
  if (event.key === "Enter") event.preventDefault();
};

/** The control that holds each problem, so the first one found can be focused. */
const FIELD_OF: Record<FormProblem, string> = {
  title: "ack-title",
  titleLong: "ack-title",
  body: "ack-body",
  bodyLong: "ack-body",
  pupils: "ack-pupil-search",
  pupilsMany: "ack-pupil-search",
  nobody: "ack-pupil-search",
};

/**
 * A new request: a title, the text, whether one guardian is enough or each must
 * confirm, and the pupils whose guardians are asked.
 *
 * The pupils are read when the form opens (the gateway records it in the
 * läslogg) and the list holds how many guardians each would ask, so the form
 * says before it sends how many people will get the question and which pupils
 * nobody can be asked about: those are left out by the gateway, and the sender
 * is told so rather than left to believe the whole class was asked. A sender who
 * has chosen only such pupils is stopped here, as the gateway would (422).
 *
 * A refusal from the gateway is said in the form, in the sender's language,
 * with everything typed and chosen still there.
 */
export function AckRequestForm({
  audience,
  onCancel,
  onSent,
}: {
  audience: "admin" | "teacher";
  onCancel: () => void;
  onSent: (sent: AckSent) => void;
}) {
  const { t, number, names } = useAckText();
  const tCommon = useTranslations("common");
  const pupilsQuery = useAckPupils();
  const { create } = useAckActions();
  const [form, setForm] = useState<AckForm>(emptyAckForm);
  const [search, setSearch] = useState("");
  const [className, setClassName] = useState("");
  const [tried, setTried] = useState(false);
  const [refusal, setRefusal] = useState<string | null>(null);
  const pending = create.isPending;
  const pupils = pupilsQuery.data ?? NO_PUPILS;

  // A pupil who left the list (the list was read again after a refusal) is not a choice any more.
  useEffect(() => {
    if (!pupilsQuery.data) return;
    const known = new Set(pupilsQuery.data.map((pupil) => pupil.id));
    setForm((current) =>
      current.studentIds.every((id) => known.has(id))
        ? current
        : { ...current, studentIds: current.studentIds.filter((id) => known.has(id)) },
    );
  }, [pupilsQuery.data]);

  const classes = useMemo(() => classesOf(pupils), [pupils]);
  const shown = useMemo(() => shownPupils(pupils, search, className), [pupils, search, className]);
  const chosen = useMemo(() => new Set(form.studentIds), [form.studentIds]);
  const problems = formProblems(form, pupils);
  const guardians = guardiansOf(pupils, form.studentIds);
  const without = withoutGuardianOf(pupils, form.studentIds);
  const allShownChosen = shown.length > 0 && shown.every((pupil) => chosen.has(pupil.id));
  const wholeClass = className !== "" && search.trim() === "";

  const set = <K extends keyof AckForm>(key: K, value: AckForm[K]) => {
    setForm((current) => ({ ...current, [key]: value }));
    setRefusal(null);
  };

  const problemText = (problem: FormProblem): string =>
    t(`form.problem.${problem}`, { max: problem.startsWith("title") ? TITLE_MAX : problem.startsWith("body") ? BODY_MAX : PUPILS_MAX });
  const fieldError = (...which: FormProblem[]): string | undefined => {
    const found = tried ? problems.find((problem) => which.includes(problem)) : undefined;
    return found ? problemText(found) : undefined;
  };

  const refusalText = (error: unknown): string => {
    if (error instanceof ApiError && error.code && (CREATE_REFUSALS as readonly string[]).includes(error.code)) {
      return t(`refusal.${error.code as (typeof CREATE_REFUSALS)[number]}`);
    }
    return error instanceof Error ? error.message : tCommon("error");
  };

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (pending) return;
    setTried(true);
    setRefusal(null);
    if (problems.length > 0) {
      document.getElementById(FIELD_OF[problems[0]!])?.focus();
      return;
    }
    try {
      const created = await create.mutateAsync(bodyOfForm(form));
      onSent({ created, withoutGuardianNames: namesOf(pupils, created.withoutGuardian) });
    } catch (error) {
      setRefusal(refusalText(error));
      // A pupil who has left: read the list again, so that the choice is made from what is there now.
      if (error instanceof ApiError && error.code === ACK_UNKNOWN_PUPIL) void pupilsQuery.refetch();
    }
  };

  const selectors = () => {
    if (pupilsQuery.isLoading) {
      return (
        <div aria-busy="true">
          <Skeleton className="h-48 w-full" />
        </div>
      );
    }
    if (pupilsQuery.isError || !pupilsQuery.data) {
      return (
        <LoadError
          variant="inline"
          title={t("form.loadFailed")}
          hint={t("form.loadFailedHint")}
          action={
            <Button type="button" variant="outline" size="sm" onClick={() => void pupilsQuery.refetch()}>
              {tCommon("retry")}
            </Button>
          }
        />
      );
    }
    if (pupils.length === 0) {
      return (
        <EmptyState
          icon={ClipboardCheck}
          headingLevel={3}
          title={t(`form.noPupilsTitle.${audience}`)}
          description={t(`form.noPupils.${audience}`)}
        />
      );
    }
    const toggleLabel = wholeClass
      ? t(allShownChosen ? "form.unselectClass" : "form.selectClass", { class: className })
      : t(allShownChosen ? "form.unselectShown" : "form.selectShown");
    return (
      <>
        <FilterBar>
          <SearchField
            id="ack-pupil-search"
            label={t("form.search")}
            value={search}
            onValueChange={setSearch}
            onKeyDown={noEnter}
          />
          {classes.length > 1 ? (
            <FilterField id="ack-class" label={t("form.classFilter")}>
              <NativeSelect id="ack-class" className="w-40" value={className} onChange={(event) => setClassName(event.target.value)}>
                <option value="">{t("form.allClasses")}</option>
                {classes.map((one) => (
                  <option key={one} value={one}>
                    {one}
                  </option>
                ))}
              </NativeSelect>
            </FilterField>
          ) : null}
          <div className="flex flex-wrap gap-2 pb-0.5">
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={shown.length === 0}
              onClick={() => set("studentIds", setChosen(form.studentIds, shown.map((pupil) => pupil.id), !allShownChosen))}
            >
              {toggleLabel}
            </Button>
            {form.studentIds.length > 0 ? (
              <Button type="button" variant="ghost" size="sm" onClick={() => set("studentIds", [])}>
                {t("form.clear")}
              </Button>
            ) : null}
          </div>
        </FilterBar>
        <p className="text-sm text-muted-foreground" aria-live="polite">
          {t("form.shown", { shown: shown.length, total: pupils.length })}
        </p>
        {shown.length === 0 ? (
          <p className="rounded-md border border-dashed px-3 py-6 text-center text-sm text-muted-foreground">{t("form.noMatch")}</p>
        ) : (
          <ul className="max-h-80 divide-y overflow-y-auto rounded-md border">
            {shown.map((pupil) => (
              <li key={pupil.id}>
                <label className="flex cursor-pointer items-center gap-3 px-3 py-2 text-sm hover:bg-accent/50">
                  <input
                    type="checkbox"
                    className="size-4 shrink-0 accent-primary"
                    checked={chosen.has(pupil.id)}
                    onChange={(event) => set("studentIds", setChosen(form.studentIds, [pupil.id], event.target.checked))}
                  />
                  <span className="min-w-0 flex-1">
                    <span className="font-medium">{pupil.name}</span>
                    {pupil.className ? <span className="text-muted-foreground"> · {pupil.className}</span> : null}
                  </span>
                  <span className={pupil.guardians === 0 ? badgeVariants({ variant: "warning" }) : "text-muted-foreground"}>
                    {t("form.guardians", { count: pupil.guardians })}
                  </span>
                </label>
              </li>
            ))}
          </ul>
        )}
      </>
    );
  };

  const pupilsError = fieldError("pupils", "pupilsMany", "nobody");

  return (
    <SectionCard id="ack-form" title={t("form.title")} description={t("form.description")}>
      <form onSubmit={submit} noValidate className="space-y-4" aria-busy={pending || undefined}>
        <fieldset disabled={pending} className="min-w-0 space-y-4">
          <FormField
            id="ack-title"
            label={t("form.titleLabel")}
            hint={`${t("form.titleHint")} ${t("form.counter", { count: form.title.trim().length, max: TITLE_MAX })}`}
            error={fieldError("title", "titleLong")}
          >
            <Input
              value={form.title}
              onChange={(event) => set("title", event.target.value)}
              onKeyDown={noEnter}
              autoComplete="off"
            />
          </FormField>
          <FormField
            id="ack-body"
            label={t("form.bodyLabel")}
            hint={`${t("form.bodyHint")} ${t("form.counter", { count: form.body.trim().length, max: BODY_MAX })}`}
            error={fieldError("body", "bodyLong")}
          >
            <Textarea rows={6} value={form.body} onChange={(event) => set("body", event.target.value)} />
          </FormField>

          <fieldset className="min-w-0 space-y-2">
            <legend className="text-sm font-medium">{t("form.ruleLegend")}</legend>
            {ACK_RULES.map((rule) => (
              <div key={rule} className="flex items-start gap-3 rounded-md border p-3">
                <input
                  id={`ack-rule-${rule}`}
                  type="radio"
                  name="ack-rule"
                  value={rule}
                  className="mt-0.5 size-4 shrink-0 accent-primary"
                  checked={form.rule === rule}
                  aria-describedby={`ack-rule-${rule}-hint`}
                  onChange={() => set("rule", rule)}
                />
                <div className="min-w-0 space-y-0.5">
                  <label htmlFor={`ack-rule-${rule}`} className="text-sm font-medium">
                    {t(`rule.${rule}.label`)}
                  </label>
                  <p id={`ack-rule-${rule}-hint`} className="text-xs text-muted-foreground">
                    {t(`rule.${rule}.hint`)}
                  </p>
                </div>
              </div>
            ))}
          </fieldset>

          <fieldset className="min-w-0 space-y-2" aria-describedby={pupilsError ? "ack-pupils-error" : undefined}>
            <legend className="text-sm font-medium">{t("form.pupilsLegend")}</legend>
            <p className="text-xs text-muted-foreground">{t("form.pupilsHint")}</p>
            {selectors()}
            {pupilsError ? (
              <p id="ack-pupils-error" className="text-xs text-destructive">
                {pupilsError}
              </p>
            ) : null}
          </fieldset>
        </fieldset>

        <div className="space-y-3 border-t pt-3">
          <p className="text-sm" aria-live="polite">
            {t("form.chosen", { pupils: form.studentIds.length })}. {t("form.willAsk", { guardians })}.
          </p>
          {without.length > 0 ? (
            <Notice tone="warning" title={t("form.withoutTitle", { count: without.length })}>
              {t("form.withoutBody", {
                names: names(
                  without.map((pupil) => pupil.name),
                  NAMES_SHOWN,
                  (count) => t("form.moreNames", { count: number(count) }),
                ),
              })}
            </Notice>
          ) : null}
          {refusal ? (
            <Notice tone="destructive" title={t("form.failed")}>
              {refusal}
            </Notice>
          ) : null}
          <div className="flex flex-wrap gap-2">
            <Button type="submit" disabled={pending}>
              {pending ? t("form.sending") : t("form.submit")}
            </Button>
            <Button type="button" variant="outline" onClick={onCancel} disabled={pending}>
              {tCommon("cancel")}
            </Button>
          </div>
        </div>
      </form>
    </SectionCard>
  );
}
