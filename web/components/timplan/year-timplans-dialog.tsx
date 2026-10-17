"use client";

// "Timplan per årskurs": which lokal timplan each årskurs follows in one
// läsår (AcademicYearTimplans, migration 20261007130000).
//
// WHAT THE ADMIN SEES. A row per årskurs, F–9 always and any further grade the
// year attaches or has a class in, each with the year's classes in it and a
// select of the school's plans — "Ingen timplan" first. A draft may be chosen
// (next year is planned in the spring, before the huvudman decides), and the
// row says "utkast — inte beslutad" beside it, as every reading surface does.
//
// WHAT IS SAVED. The whole mapping, through PUT /academic-years/:id/timplans:
// every listed grade is sent, with null for none, so nothing is emptied by
// being left out of the form and the gateway writes only the rows that
// changed. A new year already follows the newest decided plan for that plan's
// årskurser (AcademicYearsService.create); this is where that is changed.
//
// WHICH LYDELSE. Every option names its plan's lydelse, and a row whose plan
// its årskull cannot follow is marked (planFitsCohort): from HT 2028 a plan
// on the 2028 lydelse is the new åk 1's only, and every older årskull keeps
// an older one. A tioårig läsår lists åk 1–10 and no förskoleklass.
//
// Opened from Kom igång's läsår step and from Lokal timplan. It reads its own
// rows — the plans, the year's classes, the year's current mapping — so both
// pages open it with no more than the years and the one to start on.

import { useMemo, useState } from "react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { Link } from "@/i18n/navigation";
import { useReadOnly } from "@/components/profile-context";
import { lydelseIsTioarig } from "@/lib/grade-numbering";
import { useGroups, useNationalTimplans } from "@/lib/queries";
import { htOf, planFitsCohort } from "@/lib/timplan-cohorts";
import { useLocalTimplans } from "@/lib/timplan-queries";
import type { AcademicYear } from "@/lib/types";
import { useSaveYearTimplans, useYearTimplans } from "@/lib/year-timplan-queries";
import {
  dialogGrades,
  yearTimplansBody,
  yearTimplansChanged,
  type YearChoices,
} from "@/lib/year-timplan-view";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { FormField } from "@/components/ui/form-field";
import { LoadError } from "@/components/ui/load-error";
import { Notice } from "@/components/ui/notice";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

/** Radix Select refuses "" as an item value; this stands for "no plan". */
const NONE = "none";

export interface YearTimplansDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  years: readonly AcademicYear[];
  /** The year the dialog starts on; the active one when null. */
  initialYearId: string | null;
}

export function YearTimplansDialog({ open, onOpenChange, years, initialYearId }: YearTimplansDialogProps) {
  const t = useTranslations("timplan.yearTimplans");
  const tCommon = useTranslations("common");
  const tPlan = useTranslations("timplan");

  // The picked year is derived, not frozen at mount: the dialog can open
  // before the years have loaded, and a one-year school has no picker to
  // recover with (the coverage page's rule).
  const [chosenYearId, setYearId] = useState<string | null>(null);
  const yearId =
    chosenYearId ?? initialYearId ?? years.find((year) => year.isActive)?.id ?? years[0]?.id ?? null;
  const year = years.find((entry) => entry.id === yearId) ?? null;

  const plans = useLocalTimplans();
  const national = useNationalTimplans();
  const groups = useGroups();
  const saved = useYearTimplans(yearId);
  const save = useSaveYearTimplans();
  // A reader (Läsbehörighet) reads each årskurs's plan; the select does not open for it.
  const reader = useReadOnly();

  // The admin's choices for one year; dropped when another year is shown.
  const [edit, setEdit] = useState<{ yearId: string; choices: Map<number, string> } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const classes = useMemo(
    () =>
      (groups.data ?? []).filter((group) => group.academicYearId === yearId && group.kind === "CLASS"),
    [groups.data, yearId],
  );
  const grades = useMemo(
    () =>
      dialogGrades(
        (saved.data ?? []).map((row) => row.gradeLevel),
        classes.map((group) => group.gradeLevel),
        year?.gradeNumbering,
      ),
    [saved.data, classes, year?.gradeNumbering],
  );
  const savedChoices = useMemo<YearChoices>(
    () => new Map((saved.data ?? []).map((row) => [row.gradeLevel, row.localTimplanId])),
    [saved.data],
  );
  const choices: YearChoices = edit && edit.yearId === yearId ? edit.choices : savedChoices;
  const dirty = saved.data !== undefined && yearTimplansChanged(grades, choices, saved.data);

  const planList = plans.data ?? [];
  const planById = new Map(planList.map((plan) => [plan.id, plan]));
  // A row may point at a plan the list has not caught up with; it is still
  // offered, named from the year's own row, so the select never shows blank.
  const savedOnly = (saved.data ?? []).filter((row) => !planById.has(row.localTimplanId));

  const loading = plans.isLoading || saved.isLoading || groups.isLoading;
  const failed = plans.isError || saved.isError || groups.isError;

  const gradeName = (grade: number) => t("grade", { grade: String(grade) });
  // The lydelse a plan is on, by its national version; unknown while the
  // reference data loads, and then nothing is said or warned.
  const termOf = new Map((national.data?.versions ?? []).map((version) => [version.id, version.appliesFromCohortTerm]));
  const lydelseOf = (planId: string): string | null => {
    const term = termOf.get(planById.get(planId)?.nationalTimplanVersionId ?? "");
    return term === undefined ? null : t(lydelseIsTioarig(term) ? "lydelse2028" : "lydelseOlder");
  };
  // The autumn term the läsår belongs to, as the gateway's default reads it.
  const ht = year ? htOf(year.startDate) : 0;
  const misfits = (grade: number, planId: string): boolean => {
    const term = termOf.get(planById.get(planId)?.nationalTimplanVersionId ?? "");
    return term !== undefined && !planFitsCohort(term, ht, grade);
  };
  const statusOf = (planId: string): "DRAFT" | "DECIDED" | null =>
    planById.get(planId)?.status ?? savedOnly.find((row) => row.localTimplanId === planId)?.planStatus ?? null;

  const choose = (grade: number, value: string) => {
    if (!yearId) return;
    const next = new Map(choices);
    next.set(grade, value === NONE ? "" : value);
    setEdit({ yearId, choices: next });
    setError(null);
  };

  const close = (next: boolean) => {
    if (save.isPending) return;
    if (!next) {
      setEdit(null);
      setError(null);
    }
    onOpenChange(next);
  };

  const submit = async () => {
    if (!yearId || !dirty) return;
    try {
      await save.mutateAsync({ academicYearId: yearId, timplans: yearTimplansBody(grades, choices) });
      setEdit(null);
      toast.success(t("saved", { year: year?.name ?? "" }));
      onOpenChange(false);
    } catch (caught) {
      setError(caught instanceof Error && caught.message ? caught.message : tCommon("error"));
    }
  };

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>{t("title")}</DialogTitle>
          <DialogDescription>{t("body")}</DialogDescription>
          <p className="text-sm text-muted-foreground">{t("cohortNote")}</p>
        </DialogHeader>

        {years.length > 1 ? (
          <FormField id="year-timplans-year" label={t("yearLabel")} hint={dirty ? t("yearLocked") : undefined}>
            {(control) => (
              <Select
                value={yearId ?? undefined}
                onValueChange={(value) => {
                  setYearId(value);
                  setError(null);
                }}
                disabled={dirty || save.isPending}
              >
                <SelectTrigger className="w-60" {...control}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {years.map((entry) => (
                    <SelectItem key={entry.id} value={entry.id}>
                      {entry.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          </FormField>
        ) : null}

        {!year ? (
          <p className="text-sm text-foreground">{t("noYear")}</p>
        ) : loading ? (
          <Skeleton className="h-64 w-full" aria-busy="true" />
        ) : failed ? (
          <LoadError variant="inline" title={t("loadFailed")} />
        ) : planList.length === 0 && savedOnly.length === 0 ? (
          <Notice role={null}>
            {t("noPlans")}{" "}
            <Link href="/admin/timplan" className="font-medium underline underline-offset-2">
              {t("noPlansLink")}
            </Link>
          </Notice>
        ) : (
          <table className="w-full text-sm">
            <caption className="sr-only">{t("caption", { year: year.name })}</caption>
            <thead>
              <tr className="border-b text-left text-xs text-muted-foreground">
                <th scope="col" className="py-2 pr-3 font-medium">
                  {t("gradeColumn")}
                </th>
                <th scope="col" className="py-2 pr-3 font-medium">
                  {t("classesColumn")}
                </th>
                <th scope="col" className="py-2 font-medium">
                  {t("planColumn")}
                </th>
              </tr>
            </thead>
            <tbody>
              {grades.map((grade) => {
                const chosen = choices.get(grade) ?? "";
                const inGrade = classes.filter((group) => group.gradeLevel === grade);
                const status = chosen === "" ? null : statusOf(chosen);
                const misfit = chosen !== "" && misfits(grade, chosen);
                return (
                  <tr key={grade} className="border-b last:border-b-0">
                    <th scope="row" className="py-2 pr-3 text-left font-medium">
                      {gradeName(grade)}
                    </th>
                    <td className="py-2 pr-3 text-muted-foreground">
                      {inGrade.length > 0 ? inGrade.map((group) => group.name).join(", ") : t("noClasses")}
                    </td>
                    <td className="py-2">
                      <div className="flex flex-wrap items-center gap-2">
                        <Select
                          value={chosen === "" ? NONE : chosen}
                          onValueChange={(value) => choose(grade, value)}
                          disabled={reader || save.isPending}
                        >
                          {/* The chosen plan is the reading; choosing is planering's. */}
                          <SelectTrigger
                            data-writes-inert="PLANERING"
                            className="w-64"
                            aria-label={t("planFor", { grade: gradeName(grade) })}
                          >
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value={NONE}>{t("none")}</SelectItem>
                            {planList.map((plan) => {
                              const lydelse = lydelseOf(plan.id);
                              return (
                                <SelectItem key={plan.id} value={plan.id}>
                                  {plan.name}
                                  {" · "}
                                  {plan.status === "DECIDED" ? tPlan("statusDecided") : tPlan("statusDraft")}
                                  {lydelse ? ` · ${lydelse}` : null}
                                </SelectItem>
                              );
                            })}
                            {savedOnly.map((row) => (
                              <SelectItem key={row.localTimplanId} value={row.localTimplanId}>
                                {row.planName}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                        {status === "DRAFT" ? <Badge variant="warning">{t("draft")}</Badge> : null}
                        {misfit ? (
                          <Badge variant="warning">{t("notThisCohort", { grade: gradeName(grade) })}</Badge>
                        ) : null}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}

        {error ? <Notice tone="destructive">{error}</Notice> : null}

        <DialogFooter>
          <Button variant="outline" onClick={() => close(false)} disabled={save.isPending}>
            {tCommon("cancel")}
          </Button>
          <Button data-writes="PLANERING" onClick={() => void submit()} disabled={!dirty || save.isPending}>
            {save.isPending ? t("saving") : t("save")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
