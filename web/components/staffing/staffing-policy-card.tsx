"use client";

import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { SlidersHorizontal } from "lucide-react";
import { useSaveStaffingPolicy, useStaffingPolicy } from "@/lib/staffing-queries";
import {
  CHECK_MODES,
  DEFAULT_POLICY_DRAFT,
  LOAD_MODELS,
  SUGGESTED_FULL_TIME_MINUTES,
  TARGET_MINUTES_MAX,
  policyDraftToBody,
  policyToDraft,
  validatePolicyDraft,
  type PolicyDraft,
  type PolicyProblem,
} from "@/lib/staffing-forms";
import type { StaffingCheckMode, StaffingLoadModel } from "@/lib/types";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

/**
 * Tjänstefördelningens inställningar: one row for the school.
 *
 * ON /admin/staffing, NOT ON /admin/constraints, although the lunch card it
 * is built like lives there. Tillgänglighet holds the rules the SOLVER reads —
 * lunch, room locks, closed hours — and refuses a week over. Nothing on this
 * card reaches the engine in this phase: the riktmärke is read by the matrix
 * on this page and by nothing else, and the two check modes only begin to
 * refuse at assignment time in Fas 2. A setting whose only reader is the
 * matrix belongs beside the matrix, where the empty-riktmärke notice can
 * point at it without a page change.
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
  const { data: policy, isSuccess } = useStaffingPolicy();
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
    <section id={id} className="rounded-lg border bg-card p-4" aria-labelledby={`${id}-title`}>
      <div className="mb-1 flex items-center gap-2">
        <SlidersHorizontal className="size-5 text-muted-foreground" />
        <h2 id={`${id}-title`} className="text-lg font-semibold">
          {t("policyTitle")}
        </h2>
      </div>
      <p className="mb-4 text-sm text-muted-foreground">{t("policyHint")}</p>

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
          <p className="text-xs text-foreground">{t("riktmarkeSource")}</p>
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
          <div className="space-y-1.5">
            <Label>{t("qualificationMode")}</Label>
            <Select
              value={draft.qualificationMode}
              onValueChange={(value) => patch({ qualificationMode: value as StaffingCheckMode })}
            >
              <SelectTrigger aria-label={t("qualificationMode")}>
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
          </div>
          <div className="space-y-1.5">
            <Label>{t("overAllocationMode")}</Label>
            <Select
              value={draft.overAllocationMode}
              onValueChange={(value) => patch({ overAllocationMode: value as StaffingCheckMode })}
            >
              <SelectTrigger aria-label={t("overAllocationMode")}>
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
          </div>
          <div className="space-y-1.5">
            <Label htmlFor={`${id}-tolerance`}>{t("tolerance")}</Label>
            <Input
              id={`${id}-tolerance`}
              type="number"
              min={0}
              max={50}
              value={draft.overAllocationTolerancePercent}
              onChange={(event) =>
                patch({ overAllocationTolerancePercent: event.target.value })
              }
            />
            <p className="text-xs text-muted-foreground">{t("toleranceHint")}</p>
          </div>
          <div className="space-y-1.5">
            <Label>{t("loadModel")}</Label>
            <Select
              value={draft.loadModel}
              onValueChange={(value) => patch({ loadModel: value as StaffingLoadModel })}
            >
              <SelectTrigger aria-label={t("loadModel")}>
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
            <p className="text-xs text-muted-foreground">{t("modelHint")}</p>
          </div>
        </div>

        {showsRefuse ? <p className="text-sm text-foreground">{t("refuseHint")}</p> : null}
        {problem ? (
          <p role="alert" className="text-sm text-destructive">
            {problemText(problem)}
          </p>
        ) : null}

        <Button onClick={() => void submit()} disabled={problem !== null || save.isPending}>
          {save.isPending ? tCommon("saving") : tCommon("save")}
        </Button>
      </div>
    </section>
  );
}
