"use client";

// Rulla vidare: next läsår from this one, in four steps and one write.
//
// WHAT IT DOES. The gateway creates next year beside this one: classes
// promoted (7A → 8A) and linked to the class they continue, teaching groups
// carried with their members, timplansposter carried BY COHORT with their
// teachers (7A's rows become 8A's — the cohort keeps its teachers), weekly
// class rules carried, and the lov the admin ticks with dates proposed for the
// new year. It only inserts; nothing in this year changes, and the pupils
// stay where they are until the new year is activated (/admin/years).
//
// HOW IT IS SHOWN. Every step reads one PREVIEW — the gateway's own plan,
// POST …/rollover/preview, written from the same code the execute runs —
// fetched again (debounced) whenever the form changes. Between a keystroke
// and the answer the mirror (lib/year-rollover.ts) already names the groups
// and marks the collisions, so typing "8A" twice turns red at once rather
// than 400 ms later. "Skapa läsåret" sends the preview's hash: if anything
// moved since (a group renamed, a pupil added), the gateway answers 409
// ROLLOVER_PREVIEW_STALE, writes nothing, and the preview is fetched again.
//
// WHAT IT DOES NOT DO is listed in the review step, in the gateway's words
// (its registry), so the admin knows what to set up again: the schedule
// itself, lunch sittings, tjänster and uppdrag, the old year's history.

import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { ArrowLeft, ArrowRight, CalendarRange, Check } from "lucide-react";
import { Link, useRouter } from "@/i18n/navigation";
import { ApiError } from "@/lib/api";
import { useAcademicYears, useGroups } from "@/lib/queries";
import type { MessageLookup } from "@/lib/engine-message";
import { groupsOfYear } from "@/lib/year-scope";
import {
  defaultTarget,
  rolloverOptions,
  type RolloverFormState,
} from "@/lib/year-rollover-form";
import { nameCollisions, resolveGroups, type GroupChoice } from "@/lib/year-rollover";
import { cn } from "@/lib/utils";
import { PageHeader } from "@/components/layout/page-header";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { Skeleton } from "@/components/ui/skeleton";
import { yearErrorText } from "../year-messages";
import { RolloverYearStep } from "./rollover-year-step";
import { RolloverGroupsStep } from "./rollover-groups-step";
import { RolloverBreaksStep } from "./rollover-breaks-step";
import { RolloverReview } from "./rollover-review";
import { ProblemList, problemsOfStep, type RolloverStep } from "./rollover-problems";
import { useDebouncedValue, useExecuteRollover, useRolloverPreview } from "./use-year-rollover";

const STEPS: RolloverStep[] = ["year", "groups", "breaks", "review"];

/** How long the form rests before it is previewed again. */
const PREVIEW_DEBOUNCE_MS = 400;

/**
 * How long Skapa stays disabled after the review step appears. "Nästa" on
 * the lov step and "Skapa" sit in the same place, so the second click of a
 * double click (or a second Enter) would otherwise create the year on a
 * review nobody saw. Distinct keys make React replace the button, but a real
 * second click lands on whatever is under the pointer — the new button.
 */
const REVIEW_ARMING_MS = 600;

function initialForm(source: { name: string; startDate: string; endDate: string }): RolloverFormState {
  return {
    ...defaultTarget(source),
    graduatingGradeLevel: null,
    groups: {},
    carryTeachingGroups: true,
    carryTeachingGroupMembers: true,
    keepTeachers: true,
    carryClassRules: true,
    breaks: {},
  };
}

export function RolloverWizard({ sourceYearId }: { sourceYearId: string | null }) {
  const t = useTranslations("years");
  const tCommon = useTranslations("common");
  const tErrors = useTranslations("years.errors") as unknown as MessageLookup;
  const router = useRouter();
  const { data: years, isLoading: yearsLoading } = useAcademicYears();
  const { data: groups } = useGroups();
  const source = years?.find((year) => year.id === sourceYearId) ?? null;

  const [edited, setEdited] = useState<RolloverFormState | null>(null);
  const [step, setStep] = useState<RolloverStep>("year");
  const [reviewArmed, setReviewArmed] = useState(false);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const firstStep = useRef(true);
  useEffect(() => {
    // Focus follows the step (and a screen reader hears its name); not on
    // the first render, which would pull focus from wherever the page put it.
    if (firstStep.current) firstStep.current = false;
    else headingRef.current?.focus();
    if (step !== "review") {
      setReviewArmed(false);
      return;
    }
    const timer = setTimeout(() => setReviewArmed(true), REVIEW_ARMING_MS);
    return () => clearTimeout(timer);
  }, [step]);
  const form = edited ?? (source ? initialForm(source) : null);
  const update = (patch: Partial<RolloverFormState>) => {
    if (form) setEdited({ ...form, ...patch });
  };

  // The options as a STRING through the debounce: an object rebuilt on every
  // render would restart the timer forever.
  const optionsKey = JSON.stringify(form ? rolloverOptions(form) : null);
  const settledKey = useDebouncedValue(optionsKey, PREVIEW_DEBOUNCE_MS);
  const settledOptions = useMemo(() => JSON.parse(settledKey) as ReturnType<typeof rolloverOptions>, [settledKey]);
  const preview = useRolloverPreview(source ? source.id : null, settledOptions);
  const execute = useExecuteRollover(source ? source.id : null);
  const plan = preview.data;
  /** The preview on screen answers the form as it is now, not as it was. */
  const current =
    plan !== undefined && !preview.isPlaceholderData && !preview.isFetching && settledKey === optionsKey;

  const graduatingGrade = form?.graduatingGradeLevel ?? plan?.graduatingGradeLevel ?? null;

  // The mirror: next year's names and collisions on the keystroke.
  const sourceGroups = useMemo(() => groupsOfYear(groups, sourceYearId), [groups, sourceYearId]);
  const choices = useMemo(() => {
    const map = new Map<string, GroupChoice>();
    for (const [id, choice] of Object.entries(form?.groups ?? {})) {
      map.set(id, { outcome: choice.outcome, name: choice.name?.trim() || undefined });
    }
    return map;
  }, [form?.groups]);
  const carryTeachingGroups = form?.carryTeachingGroups ?? true;
  const resolved = useMemo(
    () => resolveGroups(sourceGroups, graduatingGrade ?? 99, { carryTeachingGroups }, choices),
    [sourceGroups, graduatingGrade, carryTeachingGroups, choices],
  );
  const defaults = useMemo(
    () => resolveGroups(sourceGroups, graduatingGrade ?? 99, { carryTeachingGroups }),
    [sourceGroups, graduatingGrade, carryTeachingGroups],
  );
  const collisions = useMemo(() => nameCollisions(resolved), [resolved]);

  const create = async () => {
    if (!form || !plan || graduatingGrade === null) return;
    const options = rolloverOptions(form);
    if (!options) return;
    try {
      const result = await execute.mutateAsync({
        ...options,
        graduatingGradeLevel: graduatingGrade,
        planHash: plan.planHash,
      });
      toast.success(
        t("created", {
          name: result.academicYear.name,
          groups: result.counts.groups,
          requirements: result.counts.requirements,
        }),
      );
      router.push("/admin/years");
    } catch (error) {
      toast.error(yearErrorText(tErrors, error, tCommon("error")));
    }
  };

  if (sourceYearId === null || (!yearsLoading && !source)) {
    return (
      <div className="mx-auto max-w-3xl">
        <PageHeader title={t("rolloverTitle")} />
        <EmptyState
          icon={CalendarRange}
          title={t("noSourceTitle")}
          description={t("noSourceBody")}
          action={
            <Button asChild>
              <Link href="/admin/years">{t("backToYears")}</Link>
            </Button>
          }
        />
      </div>
    );
  }
  if (!source || !form) {
    return (
      <div className="mx-auto max-w-3xl space-y-2" aria-busy="true">
        <Skeleton className="h-8 w-1/2" />
        <Skeleton className="h-40 w-full" />
      </div>
    );
  }

  // A refusal of the whole rollover (already rolled, not yet activated, a
  // year RLS hides) leaves nothing to fill in; a 400 names a field and the
  // form stays.
  const refusal = preview.isError ? yearErrorText(tErrors, preview.error, tCommon("error")) : null;
  const refusedWhole = preview.error instanceof ApiError && [404, 409].includes(preview.error.status);
  const stepIndex = STEPS.indexOf(step);
  const stepProblems = plan ? problemsOfStep(plan.problems, step) : [];
  const canCreate =
    reviewArmed && current && plan !== undefined && !plan.blocking && graduatingGrade !== null && !execute.isPending;
  /** The form cannot be previewed at all: a blank name or a date that is not one. */
  const incomplete = rolloverOptions(form) === null;

  return (
    <div className="mx-auto max-w-5xl">
      <PageHeader
        title={t("rolloverTitle")}
        subtitle={t("rolloverSubtitle", {
          name: source.name,
          start: source.startDate,
          end: source.endDate,
        })}
        actions={
          <Button variant="ghost" asChild>
            <Link href="/admin/years">
              <ArrowLeft />
              {t("backToYears")}
            </Link>
          </Button>
        }
      />

      <ol className="mb-6 flex flex-wrap items-center gap-2" aria-label={t("stepsLabel")}>
        {STEPS.map((id, index) => (
          <li key={id} className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => setStep(id)}
              aria-current={step === id ? "step" : undefined}
              className={cn(
                "flex items-center gap-2 rounded-full border px-3 py-1.5 text-sm font-medium transition-colors",
                step === id
                  ? "border-primary bg-primary text-primary-foreground"
                  : index < stepIndex
                    ? "border-success/40 bg-success/10 text-success"
                    : "text-muted-foreground hover:bg-muted",
              )}
            >
              {index < stepIndex ? <Check className="h-3.5 w-3.5" aria-hidden /> : <span>{index + 1}</span>}
              {t(`step.${id}`)}
            </button>
            {index < STEPS.length - 1 ? (
              <ArrowRight className="h-3.5 w-3.5 text-muted-foreground/50" aria-hidden />
            ) : null}
          </li>
        ))}
      </ol>

      {refusal ? (
        <p role="alert" className="mb-4 rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive">
          {refusal}
        </p>
      ) : null}

      {refusedWhole ? null : (
        <Card>
          <CardContent className="space-y-6 pt-6">
            <h2 ref={headingRef} tabIndex={-1} className="sr-only">
              {t(`step.${step}`)}
            </h2>
            {step === "year" ? (
              <RolloverYearStep form={form} update={update} plan={plan} graduatingGrade={graduatingGrade} />
            ) : step === "groups" ? (
              <RolloverGroupsStep
                form={form}
                update={update}
                sourceGroups={sourceGroups}
                resolved={resolved}
                defaults={defaults}
                collisions={collisions}
                plan={plan}
              />
            ) : step === "breaks" ? (
              <RolloverBreaksStep form={form} update={update} plan={plan} />
            ) : plan ? (
              <RolloverReview plan={plan} graduatingGrade={graduatingGrade} />
            ) : (
              <Skeleton className="h-40 w-full" />
            )}

            {stepProblems.length > 0 ? <ProblemList problems={stepProblems} /> : null}

            <div className="flex flex-wrap items-center justify-between gap-2 border-t pt-4">
              <span
                className={cn("text-xs", incomplete ? "text-destructive" : "text-muted-foreground")}
                aria-live="polite"
              >
                {incomplete
                  ? t("previewNeedsInput")
                  : preview.isFetching || !current
                    ? t("previewUpdating")
                    : t("previewCurrent")}
              </span>
              <div className="flex gap-2">
                {stepIndex > 0 ? (
                  <Button variant="outline" onClick={() => setStep(STEPS[stepIndex - 1]!)}>
                    <ArrowLeft />
                    {tCommon("back")}
                  </Button>
                ) : null}
                {step !== "review" ? (
                  <Button key="next" onClick={() => setStep(STEPS[stepIndex + 1]!)}>
                    {tCommon("next")}
                    <ArrowRight />
                  </Button>
                ) : (
                  <Button key="create" onClick={() => void create()} disabled={!canCreate}>
                    {execute.isPending ? tCommon("saving") : t("createYear", { name: form.name.trim() })}
                  </Button>
                )}
              </div>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
