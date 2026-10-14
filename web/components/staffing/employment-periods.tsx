"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { CalendarRange, Pencil, Plus, Trash2 } from "lucide-react";
import { useTeacherEmploymentActions } from "@/lib/staffing-queries";
import {
  EMPTY_PERIOD_DRAFT,
  periodDraftToBody,
  periodToDraft,
  validatePeriodDraft,
  type PeriodDraft,
  type PeriodProblem,
} from "@/lib/employment-period-forms";
import { postStretches } from "@/lib/employment-periods";
import { PERCENT_DECIMALS, TARGET_MINUTES_MAX, parseDecimal } from "@/lib/staffing-forms";
import { formatPercent } from "@/lib/staffing-view";
import { targetMinutesPerWeek, type LoadPolicy } from "@/lib/teacher-load";
import type { TeacherEmployment, TeacherEmploymentPeriod } from "@/lib/types";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Notice } from "@/components/ui/notice";

export interface EmploymentPeriodsProps {
  teacher: { id: string };
  academicYearId: string;
  /** The läsår's bounds; null while they load — the list then shows the periods alone. */
  year: { startDate: string; endDate: string } | null;
  employment: TeacherEmployment;
  policy: LoadPolicy;
}

const later = (a: string, b: string): string => (a > b ? a : b);

/**
 * The post over the läsår, and the periods that change it from a date
 * (migration 20261022120000): "80 % från 1 november".
 *
 * A TIMELINE, NOT A LIST OF EXCEPTIONS. The post is read as the year it
 * covers: the base row's stretches between and around the periods, each with
 * its dates, its figures and the target they derive to — the same stretches
 * the load report judges (lib/employment-periods.ts postStretches), so what
 * the card shows is what the matrix counts. A period that holds no whole week
 * says so: a week is the post in force on its Monday, and such a period
 * changes no target.
 *
 * ONE FORM, OPENED ON REQUEST, as the post's own. A period states all three
 * figures for its dates, so the form starts from the post's own when it is
 * new. The rules that need the other periods and the year — inside the läsår,
 * a whole week, no overlap — are said beside the fields before Spara
 * (validatePeriodDraft), and the gateway holds them.
 */
export function EmploymentPeriods({ teacher, academicYearId, year, employment, policy }: EmploymentPeriodsProps) {
  const t = useTranslations("staffing");
  const tCommon = useTranslations("common");
  const actions = useTeacherEmploymentActions();
  const periods = [...(employment.periods ?? [])].sort((a, b) => a.validFrom.localeCompare(b.validFrom));
  /** null: reading; "new": the add form; an id: that period's form. */
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState<PeriodDraft>(EMPTY_PERIOD_DRAFT);
  const [touched, setTouched] = useState(false);
  const [removing, setRemoving] = useState<TeacherEmploymentPeriod | null>(null);

  // A year whose bounds have not come with it reads as one not loaded yet.
  const bounds =
    year?.startDate && year?.endDate
      ? { startDate: year.startDate.slice(0, 10), endDate: year.endDate.slice(0, 10) }
      : null;
  const problem: PeriodProblem | null = editing ? validatePeriodDraft(draft, bounds, periods, editing === "new" ? null : editing) : null;
  const problemText = (p: PeriodProblem) => {
    const { reason, ...values } = p;
    return t(`problem_${reason}`, values as Record<string, string | number>);
  };
  const patch = (change: Partial<PeriodDraft>) => {
    setDraft((previous) => ({ ...previous, ...change }));
    setTouched(true);
  };
  const id = (field: string) => `period-${teacher.id}-${field}`;

  const targetOf = (figures: {
    employmentPercent: number;
    reductionPercent: number;
    teachingTargetMinutesPerWeek: number | null;
  }) => targetMinutesPerWeek({ ...employment, userId: employment.userId, ...figures }, policy);
  const targetText = (figures: Parameters<typeof targetOf>[0]) => {
    const target = targetOf(figures);
    if (target === null) return t("derivedNoTarget");
    return figures.teachingTargetMinutesPerWeek !== null
      ? t("derivedTargetOverride", { minutes: target })
      : t("derivedTarget", { minutes: target });
  };
  const figuresText = (figures: { employmentPercent: number; reductionPercent: number }) =>
    figures.reductionPercent > 0
      ? t("periodFiguresReduction", {
          percent: formatPercent(figures.employmentPercent),
          reduction: formatPercent(figures.reductionPercent),
        })
      : t("periodFigures", { percent: formatPercent(figures.employmentPercent) });

  const openNew = () => {
    setDraft({
      ...EMPTY_PERIOD_DRAFT,
      employmentPercent: String(employment.employmentPercent),
      reductionPercent: employment.reductionPercent > 0 ? String(employment.reductionPercent) : "",
    });
    setTouched(false);
    setEditing("new");
  };
  const openEdit = (period: TeacherEmploymentPeriod) => {
    setDraft(periodToDraft(period));
    setTouched(false);
    setEditing(period.id);
  };

  const save = async () => {
    if (problem || !editing) return;
    const body = periodDraftToBody(draft);
    try {
      if (editing === "new") {
        await actions.createPeriod.mutateAsync({ userId: teacher.id, academicYearId, ...body });
      } else {
        await actions.updatePeriod.mutateAsync({ id: editing, ...body });
      }
      toast.success(t("periodSaved"));
      setEditing(null);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : tCommon("error"));
    }
  };

  const remove = async () => {
    if (!removing) return;
    try {
      await actions.removePeriod.mutateAsync(removing.id);
      toast.success(t("periodRemoved"));
    } catch (error) {
      toast.error(error instanceof Error ? error.message : tCommon("error"));
    } finally {
      setRemoving(null);
    }
  };

  // The year as the report cuts it, once the bounds are known.
  const stretches = bounds && periods.length > 0 ? postStretches({ ...employment, periods }, bounds) : null;
  const periodOf = (from: string) =>
    periods.find((period) => (bounds ? later(period.validFrom, bounds.startDate) : period.validFrom) === from) ?? null;

  const preview = (() => {
    const percent = parseDecimal(draft.employmentPercent, PERCENT_DECIMALS);
    const reduction = draft.reductionPercent.trim() === "" ? 0 : parseDecimal(draft.reductionPercent, PERCENT_DECIMALS);
    if (percent === null || reduction === null) return null;
    const own = draft.teachingTargetMinutesPerWeek.trim() === "" ? null : Number(draft.teachingTargetMinutesPerWeek);
    return targetText({
      employmentPercent: percent,
      reductionPercent: reduction,
      teachingTargetMinutesPerWeek: Number.isInteger(own) ? own : null,
    });
  })();

  const pending = actions.createPeriod.isPending || actions.updatePeriod.isPending;

  return (
    <section aria-labelledby={id("title")} className="space-y-2 border-t pt-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h4 id={id("title")} className="flex items-center gap-1.5 text-sm font-medium">
          <CalendarRange className="size-4 text-muted-foreground" aria-hidden="true" />
          {t("periodsTitle")}
        </h4>
        {editing === null ? (
          <Button variant="outline" size="sm" onClick={openNew}>
            <Plus />
            {t("addPeriod")}
          </Button>
        ) : null}
      </div>
      <p className="text-xs text-muted-foreground">{t("periodsHint")}</p>

      {periods.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t("noPeriods")}</p>
      ) : stretches ? (
        <ol aria-label={t("periodsTimeline")} className="divide-y text-sm">
          {stretches.map((stretch) => {
            const period = stretch.kind === "PERIOD" ? periodOf(stretch.from) : null;
            return (
              <li key={`${stretch.kind}-${stretch.from}`} className="flex items-start justify-between gap-2 py-1.5">
                <div className="min-w-0 space-y-0.5">
                  <p>
                    <span className="font-medium">{t("periodDates", { from: stretch.from, to: stretch.to })}</span>
                    {" · "}
                    {stretch.kind === "BASE" ? t("periodBase") : t("periodKindLabel")}
                  </p>
                  <p className="text-foreground">
                    {figuresText(stretch.figures)}
                    {" · "}
                    {targetText(stretch.figures)}
                  </p>
                  {stretch.window === null ? <p className="text-muted-foreground">{t("periodNoWeek")}</p> : null}
                </div>
                {period ? (
                  <span className="flex shrink-0 gap-1">
                    <Button
                      variant="ghost"
                      size="icon"
                      onClick={() => openEdit(period)}
                      aria-label={t("editPeriod", { from: period.validFrom })}
                      disabled={editing !== null}
                    >
                      <Pencil />
                    </Button>
                    {/* Like the pencil, closed while a form is open: a period
                        removed under its own form would leave one that saves
                        to a deleted id. */}
                    <Button
                      variant="ghost"
                      size="icon"
                      onClick={() => setRemoving(period)}
                      aria-label={t("removePeriod", { from: period.validFrom })}
                      disabled={editing !== null}
                    >
                      <Trash2 aria-hidden="true" />
                    </Button>
                  </span>
                ) : null}
              </li>
            );
          })}
        </ol>
      ) : (
        <ul className="divide-y text-sm">
          {periods.map((period) => (
            <li key={period.id} className="py-1.5">
              {t("periodDates", { from: period.validFrom, to: period.validTo ?? "…" })}
              {" · "}
              {figuresText(period)}
            </li>
          ))}
        </ul>
      )}

      {editing !== null ? (
        <div className="space-y-3 rounded-md border p-3">
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor={id("from")}>{t("periodFrom")}</Label>
              <Input
                id={id("from")}
                type="date"
                min={bounds?.startDate}
                max={bounds?.endDate}
                value={draft.validFrom}
                onChange={(event) => patch({ validFrom: event.target.value })}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor={id("to")}>
                {t("periodTo")} <span className="text-muted-foreground">({tCommon("optional")})</span>
              </Label>
              <Input
                id={id("to")}
                type="date"
                min={bounds?.startDate}
                max={bounds?.endDate}
                value={draft.validTo}
                aria-describedby={id("to-hint")}
                onChange={(event) => patch({ validTo: event.target.value })}
              />
              <p id={id("to-hint")} className="text-xs text-muted-foreground">
                {t("periodToHint")}
              </p>
            </div>
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor={id("percent")}>{t("employmentPercent")}</Label>
              <Input
                id={id("percent")}
                inputMode="decimal"
                value={draft.employmentPercent}
                onChange={(event) => patch({ employmentPercent: event.target.value })}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor={id("reduction")}>{t("reductionPercent")}</Label>
              <Input
                id={id("reduction")}
                inputMode="decimal"
                value={draft.reductionPercent}
                onChange={(event) => patch({ reductionPercent: event.target.value })}
              />
            </div>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor={id("target")}>{t("targetOverride")}</Label>
            <Input
              id={id("target")}
              type="number"
              min={0}
              max={TARGET_MINUTES_MAX}
              step={5}
              value={draft.teachingTargetMinutesPerWeek}
              onChange={(event) => patch({ teachingTargetMinutesPerWeek: event.target.value })}
            />
          </div>
          {preview ? (
            <p role="status" className="text-sm text-foreground">
              {preview}
            </p>
          ) : null}
          {problem && touched ? <Notice tone="destructive">{problemText(problem)}</Notice> : null}
          <div className="flex justify-end gap-2">
            <Button variant="outline" size="sm" onClick={() => setEditing(null)}>
              {tCommon("cancel")}
            </Button>
            <Button size="sm" onClick={() => void save()} disabled={problem !== null || pending}>
              {pending ? tCommon("saving") : tCommon("save")}
            </Button>
          </div>
        </div>
      ) : null}

      <ConfirmDialog
        open={removing !== null}
        onOpenChange={(open) => (open ? null : setRemoving(null))}
        title={t("removePeriodTitle", { from: removing?.validFrom ?? "" })}
        description={t("removePeriodBody")}
        confirmLabel={t("removePeriodConfirm")}
        loading={actions.removePeriod.isPending}
        onConfirm={() => void remove()}
      />
    </section>
  );
}
