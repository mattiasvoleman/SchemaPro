"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { Briefcase } from "lucide-react";
import { useAcademicYears } from "@/lib/queries";
import { useTeacherEmploymentActions } from "@/lib/staffing-queries";
import {
  EMPTY_EMPLOYMENT_DRAFT,
  NOTE_MAX,
  SIGNATURE_MAX,
  TARGET_MINUTES_MAX,
  employmentDraftToBody,
  employmentToDraft,
  parseDecimal,
  validateEmploymentDraft,
  type EmploymentDraft,
  type EmploymentProblem,
} from "@/lib/staffing-forms";
import {
  DEFAULT_LOAD_POLICY,
  regulatedHoursPerYear,
  targetMinutesPerWeek,
  type LoadPolicy,
} from "@/lib/teacher-load";
import { formatPercent } from "@/lib/staffing-view";
import type { StaffingPolicy, TeacherContractKind, TeacherEmployment } from "@/lib/types";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Notice } from "@/components/ui/notice";
import { SectionCard } from "@/components/ui/section-card";
import { Textarea } from "@/components/ui/textarea";
import { EmploymentPeriods } from "@/components/staffing/employment-periods";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

const CONTRACT_KINDS: TeacherContractKind[] = ["FERIE", "SEMESTER"];

export interface EmploymentCardProps {
  teacher: { id: string; firstName: string; lastName: string };
  academicYearId: string;
  academicYearName: string;
  /** The stored row, or null/undefined for a teacher without one — the normal case. */
  employment: TeacherEmployment | null | undefined;
  /** The school's policy, or null for a school that has saved none. */
  policy: StaffingPolicy | null | undefined;
}

/** The policy as the arithmetic reads it — the table's defaults when absent. */
function loadPolicyOf(policy: StaffingPolicy | null | undefined): LoadPolicy {
  if (!policy) return DEFAULT_LOAD_POLICY;
  return {
    fullTimeTeachingMinutesPerWeek: policy.fullTimeTeachingMinutesPerWeek,
    overAllocationTolerancePercent: policy.overAllocationTolerancePercent,
    fullTimeRegulatedHoursPerYear: policy.fullTimeRegulatedHoursPerYear,
    workDaysPerYear: policy.workDaysPerYear,
    qualificationMode: policy.qualificationMode,
  };
}

/**
 * What the draft WOULD derive to, computed with the same arithmetic the
 * report uses (lib/teacher-load.ts) so the figure promised while typing is
 * the figure the matrix shows after saving. Null while the percentages do not
 * parse — a half-typed field is not a post yet.
 */
function derived(
  draft: EmploymentDraft,
  policy: LoadPolicy,
): { target: number | null; override: boolean; regulated: number } | null {
  const percent = parseDecimal(draft.employmentPercent, 3);
  const reduction =
    draft.reductionPercent.trim() === "" ? 0 : parseDecimal(draft.reductionPercent, 3);
  if (percent === null || reduction === null) return null;
  const override = draft.teachingTargetMinutesPerWeek.trim() !== "";
  const own = override ? Number(draft.teachingTargetMinutesPerWeek) : null;
  return {
    target: targetMinutesPerWeek(
      {
        userId: "",
        employmentPercent: percent,
        reductionPercent: reduction,
        contractKind: draft.contractKind,
        teachingTargetMinutesPerWeek: Number.isInteger(own) ? own : null,
        signature: null,
      },
      policy,
    ),
    override,
    regulated: regulatedHoursPerYear(policy.fullTimeRegulatedHoursPerYear, percent, reduction),
  };
}

/**
 * A teacher's post for one läsår: tjänst, nedsättning, avtal, signatur, an
 * optional own riktmärke, and what the policy makes of them.
 *
 * SUMMARY FIRST, FORM ON REQUEST. The card sits in a drawer and on every
 * teacher's row under Personer, where most visits are to read, and six empty
 * inputs for a teacher who has no post would say "0 %" to every reader. The
 * summary says what the row says — including that there is none — and the
 * form opens on Ändra.
 *
 * THE WHOLE ROW IS SENT, every field, because PUT replaces it: a body that
 * carried only the fields the admin touched would clear the note on every
 * save. employmentDraftToBody keeps every key present.
 *
 * THE POST FROM A DATE (migration 20261022120000) is a timeline under the
 * summary — EmploymentPeriods — once there is a post to change: the base
 * row's figures above are the post where no period says otherwise.
 */
export function EmploymentCard({
  teacher,
  academicYearId,
  academicYearName,
  employment,
  policy,
}: EmploymentCardProps) {
  const t = useTranslations("staffing");
  const tCommon = useTranslations("common");
  const actions = useTeacherEmploymentActions();
  const [editing, setEditing] = useState(false);
  /** Ta bort tjänsten asks first: the post's figures are gone once it is deleted. */
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [draft, setDraft] = useState<EmploymentDraft>(EMPTY_EMPLOYMENT_DRAFT);
  const loadPolicy = loadPolicyOf(policy);
  // The year's bounds, for the periods' dates; the gateway measures the same.
  const { data: years } = useAcademicYears();
  const year = years?.find((candidate) => candidate.id === academicYearId) ?? null;

  const open = () => {
    setDraft(employmentToDraft(employment));
    setEditing(true);
  };
  const patch = (change: Partial<EmploymentDraft>) =>
    setDraft((previous) => ({ ...previous, ...change }));

  const problem: EmploymentProblem | null = validateEmploymentDraft(draft);
  const preview = derived(draft, loadPolicy);
  const problemText = (p: EmploymentProblem) => {
    const { reason, ...values } = p;
    return t(`problem_${reason}`, values as Record<string, number>);
  };

  const save = async () => {
    if (problem) return;
    try {
      await actions.save.mutateAsync({
        userId: teacher.id,
        academicYearId,
        ...employmentDraftToBody(draft),
      });
      toast.success(t("employmentSaved"));
      setEditing(false);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : tCommon("error"));
    }
  };

  const remove = async () => {
    try {
      await actions.remove.mutateAsync({ userId: teacher.id, academicYearId });
      toast.success(t("employmentRemoved"));
      setConfirmRemove(false);
      setEditing(false);
    } catch (error) {
      // The confirmation closes and the form stays as it was.
      setConfirmRemove(false);
      toast.error(error instanceof Error ? error.message : tCommon("error"));
    }
  };

  const stored = employment ?? null;
  const storedTarget = stored
    ? targetMinutesPerWeek(
        {
          userId: stored.userId,
          employmentPercent: stored.employmentPercent,
          reductionPercent: stored.reductionPercent,
          contractKind: stored.contractKind,
          teachingTargetMinutesPerWeek: stored.teachingTargetMinutesPerWeek,
          signature: stored.signature,
        },
        loadPolicy,
      )
    : null;

  return (
    <SectionCard
      id={`employment-${teacher.id}`}
      headingLevel={3}
      icon={Briefcase}
      title={t("employmentTitle")}
      description={t("employmentHint", { year: academicYearName })}
      action={
        !editing ? (
          <Button variant="outline" size="sm" onClick={open}>
            {stored ? t("editEmployment") : tCommon("add")}
          </Button>
        ) : null
      }
    >
      {!editing ? (
        stored ? (
          <div className="space-y-3">
          <ul className="space-y-0.5 text-sm">
            <li>
              {stored.reductionPercent > 0
                ? t("employmentSummaryReduction", {
                    percent: formatPercent(stored.employmentPercent),
                    reduction: formatPercent(stored.reductionPercent),
                    kind: t(`contract${stored.contractKind}`),
                  })
                : t("employmentSummary", {
                    percent: formatPercent(stored.employmentPercent),
                    kind: t(`contract${stored.contractKind}`),
                  })}
            </li>
            {stored.signature ? (
              <li>{t("employmentSummarySignature", { signature: stored.signature })}</li>
            ) : null}
            <li>
              {storedTarget === null
                ? t("derivedNoTarget")
                : stored.teachingTargetMinutesPerWeek !== null
                  ? t("derivedTargetOverride", { minutes: storedTarget })
                  : t("derivedTarget", { minutes: storedTarget })}
            </li>
            <li>
              {t("derivedRegulated", {
                hours: formatPercent(
                  regulatedHoursPerYear(
                    loadPolicy.fullTimeRegulatedHoursPerYear,
                    stored.employmentPercent,
                    stored.reductionPercent,
                  ),
                ),
                days: loadPolicy.workDaysPerYear,
              })}
            </li>
            {stored.note ? <li className="text-muted-foreground">{stored.note}</li> : null}
          </ul>
          <EmploymentPeriods
            teacher={teacher}
            academicYearId={academicYearId}
            year={year}
            employment={stored}
            policy={loadPolicy}
          />
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">{t("noEmployment")}</p>
        )
      ) : (
        <div className="space-y-3">
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor={`emp-percent-${teacher.id}`}>{t("employmentPercent")}</Label>
              <Input
                id={`emp-percent-${teacher.id}`}
                inputMode="decimal"
                value={draft.employmentPercent}
                onChange={(event) => patch({ employmentPercent: event.target.value })}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor={`emp-reduction-${teacher.id}`}>{t("reductionPercent")}</Label>
              <Input
                id={`emp-reduction-${teacher.id}`}
                inputMode="decimal"
                value={draft.reductionPercent}
                onChange={(event) => patch({ reductionPercent: event.target.value })}
              />
            </div>
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor={`emp-contract-${teacher.id}`}>{t("contractKind")}</Label>
              <Select
                value={draft.contractKind}
                onValueChange={(value) => patch({ contractKind: value as TeacherContractKind })}
              >
                <SelectTrigger id={`emp-contract-${teacher.id}`}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {CONTRACT_KINDS.map((kind) => (
                    <SelectItem key={kind} value={kind}>
                      {t(`contract${kind}`)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor={`emp-signature-${teacher.id}`}>{t("signature")}</Label>
              <Input
                id={`emp-signature-${teacher.id}`}
                maxLength={SIGNATURE_MAX}
                value={draft.signature}
                onChange={(event) => patch({ signature: event.target.value })}
              />
              <p className="text-xs text-muted-foreground">{t("signatureHint")}</p>
            </div>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor={`emp-target-${teacher.id}`}>{t("targetOverride")}</Label>
            <Input
              id={`emp-target-${teacher.id}`}
              type="number"
              min={0}
              max={TARGET_MINUTES_MAX}
              step={5}
              value={draft.teachingTargetMinutesPerWeek}
              onChange={(event) => patch({ teachingTargetMinutesPerWeek: event.target.value })}
            />
            <p className="text-xs text-muted-foreground">{t("targetOverrideHint")}</p>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor={`emp-note-${teacher.id}`}>
              {t("note")} <span className="text-muted-foreground">({tCommon("optional")})</span>
            </Label>
            <Textarea
              id={`emp-note-${teacher.id}`}
              maxLength={NOTE_MAX}
              value={draft.note}
              onChange={(event) => patch({ note: event.target.value })}
            />
          </div>

          {/*
            The derived figures, live. These are the two numbers an admin
            opens this card to learn, and they move as the fields do, so a
            60 % post with 10 % nedsättning reads "Mål: 540 min/v" before
            Spara is pressed rather than after a refetch.
          */}
          {preview ? (
            <p role="status" className="text-sm text-foreground">
              {preview.target === null
                ? t("derivedNoTarget")
                : preview.override
                  ? t("derivedTargetOverride", { minutes: preview.target })
                  : t("derivedTarget", { minutes: preview.target })}
              {" · "}
              {t("derivedRegulated", {
                hours: formatPercent(preview.regulated),
                days: loadPolicy.workDaysPerYear,
              })}
            </p>
          ) : null}
          {problem ? <Notice tone="destructive">{problemText(problem)}</Notice> : null}

          <div className="flex flex-wrap items-center justify-between gap-2">
            {stored ? (
              // A neutral trigger: the confirmation it opens carries the red.
              <Button
                variant="outline"
                size="sm"
                onClick={() => setConfirmRemove(true)}
                disabled={actions.remove.isPending}
              >
                {t("removeEmployment")}
              </Button>
            ) : (
              <span />
            )}
            <div className="flex gap-2">
              <Button variant="outline" size="sm" onClick={() => setEditing(false)}>
                {tCommon("cancel")}
              </Button>
              <Button
                size="sm"
                onClick={() => void save()}
                disabled={problem !== null || actions.save.isPending}
              >
                {actions.save.isPending ? tCommon("saving") : tCommon("save")}
              </Button>
            </div>
          </div>
        </div>
      )}

      <ConfirmDialog
        open={confirmRemove}
        onOpenChange={setConfirmRemove}
        title={t("removeEmploymentTitle", {
          name: `${teacher.firstName} ${teacher.lastName}`,
          year: academicYearName,
        })}
        description={t("removeEmploymentBody")}
        confirmLabel={t("removeEmployment")}
        loading={actions.remove.isPending}
        onConfirm={() => void remove()}
      />
    </SectionCard>
  );
}
