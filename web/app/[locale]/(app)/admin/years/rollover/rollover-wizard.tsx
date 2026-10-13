"use client";

// Rulla vidare: next läsår from this one, in four steps and one write.
//
// WHAT IT DOES. The gateway creates next year beside this one: classes
// promoted (7A → 8A) and linked to the class they continue, teaching groups
// carried with their members, timplansposter carried BY COHORT with their
// teachers (7A's rows become 8A's — the cohort keeps its teachers), weekly
// class rules carried, tjänster and uppdrag carried for the active staff (a
// mentorskap follows its class, a blocked slot becomes a new one; staffing
// Fas 5, on by default), and the lov the admin ticks with dates proposed for
// the new year. It only inserts; nothing in this year changes, and the pupils
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
// itself, lunch sittings, the old year's history — and tjänster and uppdrag
// when the switch is off, which /admin/staffing can still carry afterwards.

import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { ArrowLeft, ArrowRight, CalendarRange } from "lucide-react";
import { Link, useRouter } from "@/i18n/navigation";
import { ApiError } from "@/lib/api";
import { useAcademicYears, useGroups } from "@/lib/queries";
import { profileDecides } from "@/lib/admin-areas";
import { useProfile } from "@/components/profile-context";
import type { MessageLookup } from "@/lib/engine-message";
import { groupsOfYear } from "@/lib/year-scope";
import {
  defaultTarget,
  rolloverOptions,
  type RolloverFormState,
} from "@/lib/year-rollover-form";
import { nameCollisions, resolveGroups, type GroupChoice } from "@/lib/year-rollover";
import { cn } from "@/lib/utils";
import { Page } from "@/components/layout/page";
import { PageHeader } from "@/components/layout/page-header";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { LoadError } from "@/components/ui/load-error";
import { Notice } from "@/components/ui/notice";
import { SectionCard } from "@/components/ui/section-card";
import { Skeleton } from "@/components/ui/skeleton";
import { Stepper } from "@/components/ui/stepper";
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

/**
 * The step card's heading: SectionCard titles its section `${id}-title`, and
 * focus moves there on every step change.
 */
const STEP_CARD_ID = "rollover-step";

/**
 * `decides`: whether the reader may carry tjänster (Roller i skolan: rektor or
 * a full administrator). Anybody else rolls the year without them, which the
 * gateway would otherwise refuse at the first preview.
 */
function initialForm(source: { name: string; startDate: string; endDate: string }, decides: boolean): RolloverFormState {
  return {
    ...defaultTarget(source),
    graduatingGradeLevel: null,
    groups: {},
    carryTeachingGroups: true,
    carryTeachingGroupMembers: true,
    keepTeachers: true,
    carryClassRules: true,
    carryStaffing: decides,
    breaks: {},
  };
}

export function RolloverWizard({ sourceYearId }: { sourceYearId: string | null }) {
  const t = useTranslations("years");
  const tCommon = useTranslations("common");
  const tErrors = useTranslations("years.errors") as unknown as MessageLookup;
  const router = useRouter();
  const { data: years, isLoading: yearsLoading, isError: yearsFailed } = useAcademicYears();
  const { data: groups, isLoading: groupsLoading, isError: groupsFailed } = useGroups();
  const source = years?.find((year) => year.id === sourceYearId) ?? null;

  const [edited, setEdited] = useState<RolloverFormState | null>(null);
  const [step, setStep] = useState<RolloverStep>("year");
  const [reviewArmed, setReviewArmed] = useState(false);
  const firstStep = useRef(true);
  useEffect(() => {
    // Focus follows the step (and a screen reader hears its name); not on
    // the first render, which would pull focus from wherever the page put it.
    // The heading is SectionCard's own, so it is made focusable here rather
    // than through a ref the card does not take.
    if (firstStep.current) firstStep.current = false;
    else {
      const heading = document.getElementById(`${STEP_CARD_ID}-title`);
      if (heading) {
        heading.tabIndex = -1;
        heading.focus();
      }
    }
    if (step !== "review") {
      setReviewArmed(false);
      return;
    }
    const timer = setTimeout(() => setReviewArmed(true), REVIEW_ARMING_MS);
    return () => clearTimeout(timer);
  }, [step]);
  const me = useProfile().profile;
  const decides = profileDecides(me?.adminProfile === undefined ? "FULL" : me.adminProfile);
  const form = edited ?? (source ? initialForm(source, decides) : null);
  const update = (patch: Partial<RolloverFormState>) => {
    if (form) setEdited({ ...form, ...patch });
  };

  // The options as a STRING through the debounce: an object rebuilt on every
  // render would restart the timer forever.
  const optionsKey = JSON.stringify(form ? rolloverOptions(form) : null);
  const settledKey = useDebouncedValue(optionsKey, PREVIEW_DEBOUNCE_MS);
  const settledOptions = useMemo(() => JSON.parse(settledKey) as ReturnType<typeof rolloverOptions>, [settledKey]);
  const execute = useExecuteRollover(source ? source.id : null);
  // Not after "Skapa" succeeded: the year has a successor now (see the hook).
  const preview = useRolloverPreview(source ? source.id : null, settledOptions, execute.isSuccess);
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
        // The switch is on by default, so a school without tjänster gets
        // staffing {0, 0, 0}: the plain sentence, not "0 tjänster och 0 uppdrag".
        result.staffing && result.staffing.employments + result.staffing.duties > 0
          ? t("createdWithStaffing", {
              name: result.academicYear.name,
              groups: result.counts.groups,
              requirements: result.counts.requirements,
              employments: result.staffing.employments,
              duties: result.staffing.duties,
            })
          : t("created", {
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

  const back = { href: "/admin/years", label: t("backToYears") };
  // Until the source year is known (loading, failed, none given) the header
  // says what the page does; the wizard itself names the year it rolls.
  const header = <PageHeader title={t("rolloverTitle")} subtitle={t("rolloverAbout")} back={back} />;

  // A year list or a group list that failed is not an empty one: without it
  // the wizard would say there is no year to roll, or that the year has no
  // groups. Nothing is created from here until both have been read.
  if (yearsFailed || groupsFailed) {
    return (
      <Page width="wide">
        {header}
        <LoadError title={t("rolloverLoadFailed")} hint={t("rolloverLoadFailedHint")} headingLevel={2} />
      </Page>
    );
  }
  if (sourceYearId === null || (!yearsLoading && !source)) {
    // The same header as every other branch, back link included, so the
    // page does not change shape; the empty state's button names the task
    // ("Välj läsår") rather than repeating the back link's "Till läsåren".
    return (
      <Page width="wide">
        {header}
        <EmptyState
          icon={CalendarRange}
          title={t("noSourceTitle")}
          description={t("noSourceBody")}
          headingLevel={2}
          action={
            <Button asChild>
              <Link href="/admin/years">{t("noSourceAction")}</Link>
            </Button>
          }
        />
      </Page>
    );
  }
  // The groups too: until they have arrived the groups step would say the
  // year has none.
  if (!source || !form || groupsLoading) {
    return (
      <Page width="wide">
        {header}
        <div aria-busy="true">
          <Skeleton className="h-64 w-full" />
        </div>
      </Page>
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
    <Page width="wide">
      <PageHeader
        title={t("rolloverTitle")}
        subtitle={t("rolloverSubtitle", {
          name: source.name,
          start: source.startDate,
          end: source.endDate,
        })}
        back={back}
      />

      <Stepper
        steps={STEPS.map((id, index) => ({ id, label: t(`step.${id}`), done: index < stepIndex }))}
        current={step}
        label={t("stepsLabel")}
        onSelect={(id) => setStep(id as RolloverStep)}
      />

      {refusal ? <Notice tone="destructive">{refusal}</Notice> : null}

      {refusedWhole ? null : (
        <SectionCard
          id={STEP_CARD_ID}
          title={t(`step.${step}`)}
          footer={
            <div className="flex flex-1 flex-wrap items-center justify-between gap-2">
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
                    <ArrowLeft aria-hidden="true" />
                    {tCommon("back")}
                  </Button>
                ) : null}
                {step !== "review" ? (
                  <Button key="next" onClick={() => setStep(STEPS[stepIndex + 1]!)}>
                    {tCommon("next")}
                    <ArrowRight aria-hidden="true" />
                  </Button>
                ) : (
                  <Button key="create" onClick={() => void create()} disabled={!canCreate}>
                    {execute.isPending ? tCommon("saving") : t("createYear", { name: form.name.trim() })}
                  </Button>
                )}
              </div>
            </div>
          }
        >
          <div className="space-y-6">
            {step === "year" ? (
              <RolloverYearStep form={form} update={update} plan={plan} graduatingGrade={graduatingGrade} />
            ) : step === "groups" ? (
              <RolloverGroupsStep
                form={form}
                update={update}
                sourceGroups={sourceGroups}
                sourceName={source.name}
                resolved={resolved}
                defaults={defaults}
                collisions={collisions}
                plan={plan}
                decides={decides}
              />
            ) : step === "breaks" ? (
              <RolloverBreaksStep form={form} update={update} plan={plan} />
            ) : plan ? (
              <RolloverReview plan={plan} graduatingGrade={graduatingGrade} />
            ) : (
              <Skeleton className="h-40 w-full" />
            )}

            {stepProblems.length > 0 ? <ProblemList problems={stepProblems} /> : null}
          </div>
        </SectionCard>
      )}
    </Page>
  );
}
