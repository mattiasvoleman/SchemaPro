"use client";

import { Suspense, lazy, useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { SlidersHorizontal } from "lucide-react";
import { useSaveStaffingPolicy, useStaffingPolicy } from "@/lib/staffing-queries";
import {
  CHECK_MODES,
  DEFAULT_POLICY_DRAFT,
  GENERATION_MODES,
  LOAD_MODELS,
  SUGGESTED_FULL_TIME_MINUTES,
  TARGET_MINUTES_MAX,
  policyDraftToBody,
  policyToDraft,
  validatePolicyDraft,
  type PolicyDraft,
  type PolicyProblem,
} from "@/lib/staffing-forms";
import type { StaffingCheckMode, StaffingLoadModel, UnstaffedGenerationMode } from "@/lib/types";
import { Button } from "@/components/ui/button";
import { FormField } from "@/components/ui/form-field";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { LoadError } from "@/components/ui/load-error";
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

/**
 * "Faktor per ämne", shown only once the admin picks the Faktor model. Lazy
 * (React's, not next/dynamic — see the drawer on the page): a MINUTES school,
 * which is every school until one chooses otherwise, never loads it.
 */
const SubjectFactorsTable = lazy(() =>
  import("./subject-factors-table").then((module) => ({ default: module.SubjectFactorsTable })),
);

/**
 * Tjänstefördelningens inställningar: one row for the school.
 *
 * ON /admin/staffing, NOT ON /admin/constraints, although the lunch card it
 * is built like lives there. Tillgänglighet holds the rules the SOLVER reads —
 * lunch, room locks, closed hours — and refuses a week over. Nothing on this
 * card reaches the engine: the riktmärke is read by the matrix on this page,
 * the two check modes by every write that staffs a timplanspost (Fas 2: WARN
 * saves and says so, REFUSE does not save), and "Generering utan lärare" by
 * the generate step's pre-flight on the gateway, before the engine is asked.
 * Settings whose readers are the staffing writes belong beside the matrix,
 * where the empty-riktmärke notice can point at them without a page change.
 *
 * THE RIKTMÄRKE HAS NO DEFAULT, by design, and the card says so twice: the
 * field's placeholder reads "tomt = ingen jämförelse", and the suggestion is
 * a button that fills 1 080 with its source in the helper text — Vimmerby's
 * principer and the Sveriges Lärare survey — rather than a value quietly
 * waiting in the box. A number nobody chose would be the thing the
 * TeacherWorkRule header warns against.
 */
export function StaffingPolicyCard({ id = "staffing-policy" }: { id?: string }) {
  const t = useTranslations("staffing");
  const tCommon = useTranslations("common");
  const { data: policy, isSuccess, isError } = useStaffingPolicy();
  const save = useSaveStaffingPolicy();

  const [draft, setDraft] = useState<PolicyDraft>(DEFAULT_POLICY_DRAFT);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    // Only until the first fill: re-running on every render of the query would
    // throw away whatever the admin is in the middle of typing.
    if (!isSuccess || loaded) return;
    setLoaded(true);
    setDraft(policyToDraft(policy));
  }, [isSuccess, loaded, policy]);

  const patch = (change: Partial<PolicyDraft>) =>
    setDraft((previous) => ({ ...previous, ...change }));

  const problem: PolicyProblem | null = validatePolicyDraft(draft);
  const problemText = (p: PolicyProblem) => {
    const { reason, ...values } = p;
    return t(`problem_${reason}`, values as Record<string, number>);
  };

  const submit = async () => {
    if (problem) return;
    try {
      await save.mutateAsync(policyDraftToBody(draft));
      toast.success(t("policySaved"));
    } catch (error) {
      toast.error(error instanceof Error ? error.message : tCommon("error"));
    }
  };

  const showsRefuse = draft.qualificationMode === "REFUSE" || draft.overAllocationMode === "REFUSE";

  return (
    <SectionCard
      id={id}
      icon={SlidersHorizontal}
      title={t("policyTitle")}
      description={t("policyHint")}
      footer={
        // Not before the school's row has been read: until then the form
        // holds the table's defaults, and a Spara would write them over it.
        <Button
          onClick={() => void submit()}
          disabled={!loaded || problem !== null || save.isPending}
          data-writes="PLANERING"
        >
          {save.isPending ? tCommon("saving") : tCommon("save")}
        </Button>
      }
    >
      {isError && !loaded ? (
        <LoadError variant="inline" title={t("policyLoadFailed")} hint={t("policyLoadFailedHint")} />
      ) : null}
      <div className="space-y-4">
        <div className="space-y-1.5">
          <Label htmlFor={`${id}-riktmarke`}>{t("riktmarke")}</Label>
          <div className="flex flex-wrap items-center gap-2">
            <Input
              id={`${id}-riktmarke`}
              type="number"
              min={1}
              max={TARGET_MINUTES_MAX}
              step={5}
              className="max-w-40"
              placeholder={t("riktmarkeEmpty")}
              aria-describedby={`${id}-riktmarke-source`}
              value={draft.fullTimeTeachingMinutesPerWeek}
              onChange={(event) => patch({ fullTimeTeachingMinutesPerWeek: event.target.value })}
            />
            <Button
              variant="outline"
              size="sm"
              onClick={() =>
                patch({ fullTimeTeachingMinutesPerWeek: String(SUGGESTED_FULL_TIME_MINUTES) })
              }
            >
              {t("riktmarkeSuggest")}
            </Button>
          </div>
          {/* The source, in full: a number offered without its provenance is a
              number the school cannot defend at the samverkan table. */}
          <p id={`${id}-riktmarke-source`} className="text-xs text-foreground">
            {t("riktmarkeSource")}
          </p>
        </div>

        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <div className="space-y-1.5">
            <Label htmlFor={`${id}-regulated`}>{t("regulatedHours")}</Label>
            <Input
              id={`${id}-regulated`}
              type="number"
              min={1}
              max={2500}
              value={draft.fullTimeRegulatedHoursPerYear}
              onChange={(event) => patch({ fullTimeRegulatedHoursPerYear: event.target.value })}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor={`${id}-annual`}>{t("annualHours")}</Label>
            <Input
              id={`${id}-annual`}
              type="number"
              min={1}
              max={2500}
              value={draft.fullTimeAnnualHours}
              onChange={(event) => patch({ fullTimeAnnualHours: event.target.value })}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor={`${id}-workdays`}>{t("workDays")}</Label>
            <Input
              id={`${id}-workdays`}
              type="number"
              min={1}
              max={260}
              value={draft.workDaysPerYear}
              onChange={(event) => patch({ workDaysPerYear: event.target.value })}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor={`${id}-semester`}>{t("semesterHours")}</Label>
            <Input
              id={`${id}-semester`}
              inputMode="decimal"
              value={draft.semesterHoursPerWeek}
              onChange={(event) => patch({ semesterHoursPerWeek: event.target.value })}
            />
          </div>
        </div>

        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <FormField id={`${id}-qualification-mode`} label={t("qualificationMode")}>
            {(control) => (
              <Select
                value={draft.qualificationMode}
                onValueChange={(value) => patch({ qualificationMode: value as StaffingCheckMode })}
              >
                <SelectTrigger {...control}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {CHECK_MODES.map((mode) => (
                    <SelectItem key={mode} value={mode}>
                      {t(`mode${mode}`)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          </FormField>
          <FormField id={`${id}-over-allocation-mode`} label={t("overAllocationMode")}>
            {(control) => (
              <Select
                value={draft.overAllocationMode}
                onValueChange={(value) => patch({ overAllocationMode: value as StaffingCheckMode })}
              >
                <SelectTrigger {...control}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {CHECK_MODES.map((mode) => (
                    <SelectItem key={mode} value={mode}>
                      {t(`mode${mode}`)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          </FormField>
          <FormField id={`${id}-tolerance`} label={t("tolerance")} hint={t("toleranceHint")}>
            <Input
              type="number"
              min={0}
              max={50}
              value={draft.overAllocationTolerancePercent}
              onChange={(event) =>
                patch({ overAllocationTolerancePercent: event.target.value })
              }
            />
          </FormField>
          <FormField id={`${id}-load-model`} label={t("loadModel")} hint={t("modelHint")}>
            {(control) => (
              <Select
                value={draft.loadModel}
                onValueChange={(value) => patch({ loadModel: value as StaffingLoadModel })}
              >
                <SelectTrigger {...control}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {LOAD_MODELS.map((model) => (
                    <SelectItem key={model} value={model}>
                      {t(`model${model}`)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          </FormField>
        </div>

        {draft.loadModel === "FACTOR" ? (
          <Suspense fallback={null}>
            <SubjectFactorsTable />
          </Suspense>
        ) : null}

        {/* Staffing Fas 3: what /ss12000/v1/duties may say about a post. Off
            until the school says otherwise — the consumers of an integration
            key are often learning platforms that need no percentages. */}
        <div className="flex items-start justify-between gap-4 rounded-md border p-3">
          <div className="space-y-1">
            <Label htmlFor={`${id}-share`}>{t("shareWithIntegrations")}</Label>
            <p className="text-xs text-muted-foreground">{t("shareWithIntegrationsHint")}</p>
          </div>
          <Switch
            id={`${id}-share`}
            checked={draft.shareEmploymentWithIntegrations}
            onCheckedChange={(checked) => patch({ shareEmploymentWithIntegrations: checked })}
          />
        </div>

        <FormField
          id={`${id}-unstaffed-generation`}
          label={t("unstaffedGeneration")}
          hint={t("unstaffedGenerationHint")}
        >
          {(control) => (
            <Select
              value={draft.unstaffedGeneration}
              onValueChange={(value) => patch({ unstaffedGeneration: value as UnstaffedGenerationMode })}
            >
              <SelectTrigger className="max-w-56" {...control}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {GENERATION_MODES.map((mode) => (
                  <SelectItem key={mode} value={mode}>
                    {t(`generation${mode}`)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
        </FormField>

        {showsRefuse ? <p className="text-sm text-foreground">{t("refuseHint")}</p> : null}
        {problem ? <Notice tone="destructive">{problemText(problem)}</Notice> : null}
      </div>
    </SectionCard>
  );
}
