"use client";

import { useTranslations } from "next-intl";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Notice } from "@/components/ui/notice";
import { FormField } from "@/components/ui/form-field";
import { Switch } from "@/components/ui/switch";
import { useActiveYear, useGroups, useMasterLessons, useRequirements } from "@/lib/queries";
import {
  distributionBreaches,
  hasDistributionRule,
  perDayInRange,
  type DistributionBreach,
  type DistributionRule,
} from "@/lib/subject-distribution";
import type { MasterLesson } from "@/lib/types";

/*
 * Ämnesfördelning in the two dialogs that write it: the subject's default and
 * a timplanspost's own rule. One set of controls, so "högst 1 per dag" and
 * "inte dagar i följd" read the same on both, and one list of what the
 * grundschema already breaks — a hand edit may, and is warned when it is
 * saved; the dialog is where a school sees the lot before it changes the rule.
 */

/*
 * `perDayInRange` and `perDayValue` are in lib/subject-distribution.ts (what the two dialogs that write the rule read the field with),
 * and re-exported: the timplan's dialog needs them without the controls, which it fetches with the dialog.
 */
export { perDayInRange, perDayValue } from "@/lib/subject-distribution";

export interface DistributionFieldsProps {
  /** Prefix for the controls' ids, unique on the page. */
  id: string;
  /** "" for no limit, or the count as typed. */
  perDay: string;
  /** Null for no rule; 2 is "inte dagar i följd"; 3..6 a wider rule, kept as written. */
  apart: number | null;
  onPerDay: (value: string) => void;
  onApart: (value: number | null) => void;
}

export function DistributionFields({ id, perDay, apart, onPerDay, onApart }: DistributionFieldsProps) {
  const t = useTranslations("distribution");
  const valid = perDayInRange(perDay);
  return (
    <div className="grid gap-4 sm:grid-cols-2 [&>*]:min-w-0">
      <FormField
        id={`${id}-per-day`}
        label={t("perDay")}
        optional
        hint={valid ? t("perDayHint") : undefined}
        error={valid ? undefined : t("perDayInvalid")}
      >
        <Input
          inputMode="numeric"
          className="max-w-28"
          value={perDay}
          onChange={(event) => onPerDay(event.target.value)}
        />
      </FormField>
      <div className="flex items-start justify-between gap-4 rounded-md border p-3">
        <div className="space-y-1">
          <Label htmlFor={`${id}-apart`}>{t("notConsecutive")}</Label>
          <p id={`${id}-apart-hint`} className="text-xs text-muted-foreground">
            {apart !== null && apart > 2 ? t("widerHint", { days: apart }) : t("notConsecutiveHint")}
          </p>
        </div>
        <Switch
          id={`${id}-apart`}
          aria-describedby={`${id}-apart-hint`}
          checked={apart !== null}
          // Off clears the rule; on is "inte dagar i följd" unless the row
          // already holds a wider one, which a switch must not narrow by itself.
          onCheckedChange={(checked) => onApart(checked ? Math.max(apart ?? 2, 2) : null)}
        />
      </div>
    </div>
  );
}

/** A rule in a few words: "högst 1 per dag · inte dagar i följd", or "ingen regel". */
export function useRuleSummary(): (rule: DistributionRule) => string {
  const t = useTranslations("distribution");
  return (rule) => {
    const parts: string[] = [];
    if (rule.maxLessonsPerDay !== null) parts.push(t("rulePerDay", { count: rule.maxLessonsPerDay }));
    if (rule.minDaysBetween !== null) {
      parts.push(
        rule.minDaysBetween === 2 ? t("ruleNotConsecutive") : t("ruleApart", { days: rule.minDaysBetween }),
      );
    }
    return parts.length > 0 ? parts.join(" · ") : t("ruleNone");
  };
}

interface NamedBreach {
  key: string;
  label: string;
  breach: DistributionBreach;
}

/** What the grundschema already breaks, as one warning; nothing when it breaks nothing. */
function BreachList({ breaches }: { breaches: NamedBreach[] }) {
  const t = useTranslations("distribution");
  if (breaches.length === 0) return null;
  return (
    <Notice tone="warning" title={t("breachesTitle")}>
      <p>{t("breachesHint")}</p>
      <ul className="mt-1 list-disc space-y-0.5 pl-5">
        {breaches.map(({ key, label, breach }) => (
          <li key={key}>
            {breach.kind === "PER_DAY"
              ? t("breachPerDay", { requirement: label, count: breach.count, day: breach.dayOfWeek })
              : t("breachApart", { requirement: label, firstDay: breach.firstDay, secondDay: breach.secondDay })}
          </li>
        ))}
      </ul>
    </Notice>
  );
}

/** A timplanspost's lessons in the grundschema, as the rule reads them: placed, not parked. */
function weekOf(lessons: MasterLesson[], groupId: string, subjectId: string) {
  return lessons
    .filter((lesson) => lesson.studentGroupId === groupId && lesson.subjectId === subjectId && !lesson.isParked)
    .map((lesson) => ({
      id: lesson.id,
      dayOfWeek: lesson.dayOfWeek,
      recurrence: lesson.recurrence,
      startDate: lesson.startDate,
      endDate: lesson.endDate,
    }));
}

/**
 * Every breach the subject's rule — as the dialog holds it, unsaved — finds in
 * the active year's grundschema, over the posts that follow the subject. A
 * post with its own rule is held to that one and is not listed here. Mounted
 * only while the dialog is open on a rule, so the subjects page reads no
 * timetable until someone asks.
 */
export function SubjectDistributionBreaches({
  subjectId,
  subjectName,
  rule,
}: {
  subjectId: string;
  subjectName: string;
  rule: DistributionRule;
}) {
  const tRequirements = useTranslations("requirements");
  const { activeYear } = useActiveYear();
  const yearId = activeYear?.id ?? null;
  const requirements = useRequirements(yearId);
  const lessons = useMasterLessons(yearId);
  const groups = useGroups();
  if (!requirements.data || !lessons.data) return null;
  const groupName = new Map((groups.data ?? []).map((group) => [group.id, group.name]));
  const breaches = requirements.data
    .filter((requirement) => requirement.subjectId === subjectId && !requirement.ownDistribution)
    .flatMap((requirement) =>
      distributionBreaches(rule, weekOf(lessons.data, requirement.studentGroupId, subjectId)).map(
        (breach, index) => ({
          key: `${requirement.id}:${index}`,
          // The cell's own name on the Timplan page, and the gateway's for the
          // same post in a refusal (requirementName).
          label: tRequirements("cellLabel", {
            subject: subjectName,
            group: groupName.get(requirement.studentGroupId) ?? "",
          }),
          breach,
        }),
      ),
    );
  return <BreachList breaches={breaches} />;
}

/**
 * The breaches one timplanspost's rule — its own as the dialog holds it, or
 * its subject's — finds in that year's grundschema.
 */
export function RequirementDistributionBreaches({
  yearId,
  groupId,
  subjectId,
  label,
  rule,
}: {
  yearId: string;
  groupId: string;
  subjectId: string;
  label: string;
  rule: DistributionRule;
}) {
  const lessons = useMasterLessons(yearId);
  if (!lessons.data || !hasDistributionRule(rule)) return null;
  const breaches = distributionBreaches(rule, weekOf(lessons.data, groupId, subjectId)).map(
    (breach, index) => ({ key: String(index), label, breach }),
  );
  return <BreachList breaches={breaches} />;
}
