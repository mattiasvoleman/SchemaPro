"use client";

import { useTranslations } from "next-intl";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { DistributionFields, RequirementDistributionBreaches, useRuleSummary } from "@/components/timplan/distribution-fields";
import { effectiveDistribution, hasDistributionRule, type DistributionRule } from "@/lib/subject-distribution";
import type { Subject } from "@/lib/types";

/*
 * The rule a timplanspost's cell dialog holds its lessons to (Ämnesfördelning): the switch for "an own rule", its two fields and the list of what
 * the grundschema already breaks under it. Fetched with the dialog (React's lazy, as the recurrence fields are) and not with the route, which is
 * at its bundle budget: only the dialog draws it, and the Switch, the two fields, the list and the words that sum a rule up are about 2,9 KB
 * gzipped that the matrix never needs.
 */

/** What the dialog's form holds of the rule, and the part of it this section writes. */
export interface DistributionForm {
  ownDistribution: boolean;
  /** "" for no limit, or the count as typed. */
  maxLessonsPerDay: string;
  /** Null for no rule; 2 is "inte dagar i följd". */
  minDaysBetween: number | null;
}

export function CellDistribution({
  form,
  onChange,
  subject,
  subjectId,
  groupId,
  groupName,
  yearId,
  rule,
}: {
  form: DistributionForm;
  /** The fields this section changed; the dialog puts them on its form. */
  onChange: (next: Partial<DistributionForm>) => void;
  /** The subject the post is of, whose rule a post without its own is held to. */
  subject: Subject | undefined;
  subjectId: string;
  groupId: string;
  groupName: string;
  yearId: string | null;
  /** The rule the open post is held to as the dialog holds it, or null while the per-day field holds nothing the API takes. */
  rule: DistributionRule | null;
}) {
  const t = useTranslations("requirements");
  const tDistribution = useTranslations("distribution");
  const ruleSummary = useRuleSummary();
  const subjectName = subject?.name ?? "";
  return (
    <fieldset className="space-y-3 rounded-md border px-3 py-2">
      <legend className="px-1 text-sm font-medium">{tDistribution("title")}</legend>
      <div className="flex items-start justify-between gap-4">
        <div className="space-y-1">
          <Label htmlFor="req-own-distribution">{tDistribution("own")}</Label>
          <p id="req-own-distribution-hint" className="text-xs text-muted-foreground">
            {form.ownDistribution
              ? tDistribution("ownOn")
              : tDistribution("ownOff", {
                  subject: subjectName,
                  rule: ruleSummary(effectiveDistribution({}, subject)),
                })}
          </p>
        </div>
        <Switch
          id="req-own-distribution"
          aria-describedby="req-own-distribution-hint"
          checked={form.ownDistribution}
          onCheckedChange={(checked) => {
            // Switched on, the post starts from its subject's rule, so
            // an exception is one change away rather than a retyping.
            const subjectRule = effectiveDistribution({}, subject);
            onChange({
              ownDistribution: checked,
              maxLessonsPerDay: checked && subjectRule.maxLessonsPerDay !== null ? String(subjectRule.maxLessonsPerDay) : "",
              minDaysBetween: checked ? subjectRule.minDaysBetween : null,
            });
          }}
        />
      </div>
      {form.ownDistribution ? (
        <DistributionFields
          id="req-distribution"
          perDay={form.maxLessonsPerDay}
          apart={form.minDaysBetween}
          onPerDay={(value) => onChange({ maxLessonsPerDay: value })}
          onApart={(value) => onChange({ minDaysBetween: value })}
        />
      ) : null}
      {/*
        What the grundschema already breaks under the rule as the
        dialog holds it. Mounted only while there is a rule, so a
        post without one reads no timetable.
      */}
      {yearId && rule && hasDistributionRule(rule) ? (
        <RequirementDistributionBreaches
          yearId={yearId}
          groupId={groupId}
          subjectId={subjectId}
          label={t("cellLabel", { subject: subjectName, group: groupName })}
          rule={rule}
        />
      ) : null}
    </fieldset>
  );
}
