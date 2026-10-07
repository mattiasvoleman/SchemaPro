"use client";

import { useTranslations } from "next-intl";
import { usePeople } from "@/lib/queries";
import type { RolloverPreview } from "@/lib/types";
import { Badge } from "@/components/ui/badge";

const OUTCOMES = ["PROMOTE", "CARRY", "INTAKE", "GRADUATE", "SKIP"] as const;

/** dayOfWeek 1 = Monday, as in AvailabilityConstraints. */
const DAYS = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"] as const;

/**
 * The old year's own record — its dated calendar, attendance, saved versions,
 * change log and generation runs — summed up in one sentence rather than ten:
 * none of it is a starting point for the new year, and none of it is lost.
 */
const HISTORY = new Set([
  "MasterLessonGroup",
  "MasterLessonStudent",
  "CalendarLesson",
  "CalendarLessonGroup",
  "CalendarLessonStudent",
  "CalendarLessonTeacher",
  "AttendanceRecord",
  "CalendarRast",
  "CalendarLunch",
  "ScheduleVersion",
  "ScheduleChangeLog",
  "OptimizationJob",
]);

/**
 * Steg 4, Granska: everything the rollover will write and everything it
 * leaves behind, before "Skapa läsåret".
 *
 * Timplan per årskurs is listed per grade with why it follows that plan
 * (carried with its cohort, the default for a grade no cohort moves into, or
 * kept as this year's when no decided plan covers it), and a draft says so —
 * the "utkast — inte beslutad" every P2 reader shows. A later-decided plan
 * the default skipped, because its lydelse applies only to later cohorts, is
 * named under the line.
 *
 * Teachers are named from usePeople — the preview sends ids only. The list of
 * what is NOT carried is the gateway's registry (every table with a läsår has
 * a written decision there, and a test that fails without one), rendered in
 * the reader's language where the web has a sentence for it and in the
 * registry's own words where it does not yet.
 */
export function RolloverReview({
  plan,
  graduatingGrade,
}: {
  plan: RolloverPreview;
  graduatingGrade: number | null;
}) {
  const t = useTranslations("years");
  const tCommon = useTranslations("common");
  const { data: people } = usePeople();
  const teacherName = (id: string) => {
    const person = people?.find((candidate) => candidate.id === id);
    return person ? `${person.firstName} ${person.lastName}` : t("unknownTeacher");
  };
  const byOutcome = new Map<string, number>();
  for (const group of plan.groups) {
    byOutcome.set(group.outcome, (byOutcome.get(group.outcome) ?? 0) + 1);
  }
  const members = plan.groups.reduce((sum, group) => sum + group.membersCopied, 0);
  // The classes' pupils who leave with no class at the activation.
  const classPupils = (keep: (group: RolloverPreview["groups"][number]) => boolean) =>
    plan.groups.filter((group) => group.kind === "CLASS" && keep(group)).reduce((sum, group) => sum + group.homePupils, 0);
  const graduating = classPupils(
    (group) => group.outcome === "GRADUATE" || (group.outcome === "INTAKE" && group.targetName === null),
  );
  const unplaced = classPupils((group) => group.outcome === "SKIP");
  const selectedBreaks = plan.breaks.filter((lov) => lov.selected);
  const { requirements } = plan;

  return (
    <div className="space-y-6 text-sm">
      <section aria-labelledby="review-year" className="space-y-1">
        <h3 id="review-year" className="font-medium">
          {t("reviewYear", { name: plan.target.name, start: plan.target.startDate, end: plan.target.endDate })}
        </h3>
        <p className="text-muted-foreground">
          {graduatingGrade !== null ? t("reviewGraduating", { grade: graduatingGrade }) : t("graduatingGradePlaceholder")}
        </p>
      </section>

      <section aria-labelledby="review-groups">
        <h3 id="review-groups" className="mb-1 font-medium">
          {t("reviewGroups")}
        </h3>
        <ul className="flex flex-wrap gap-1.5">
          {OUTCOMES.filter((outcome) => byOutcome.has(outcome)).map((outcome) => (
            <li key={outcome}>
              <Badge variant="secondary">
                {t(`outcomeCount.${outcome}`, { count: byOutcome.get(outcome)! })}
              </Badge>
            </li>
          ))}
        </ul>
        {members > 0 ? <p className="mt-1 text-muted-foreground">{t("reviewMembers", { count: members })}</p> : null}
        {graduating + unplaced > 0 ? (
          <p className="mt-1 text-muted-foreground">{t("reviewLeaving", { graduating, unplaced })}</p>
        ) : null}
      </section>

      <section aria-labelledby="review-requirements" className="space-y-1">
        <h3 id="review-requirements" className="font-medium">
          {t("reviewRequirements")}
        </h3>
        <p>
          {t("reviewRequirementsCounts", {
            carried: requirements.carried,
            notCarried: requirements.notCarried,
            shifted: requirements.periodShifted,
            anchored: requirements.periodBoundAnchored,
          })}
        </p>
        {requirements.periodDropped.length > 0 ? (
          <div>
            <p className="text-warning-foreground dark:text-warning">
              {t("reviewDropped", { count: requirements.periodDropped.length })}
            </p>
            <ul className="ml-4 list-disc text-muted-foreground">
              {requirements.periodDropped.map((row) => (
                <li key={row.sourceRequirementId}>
                  {t("droppedLine", {
                    subject: row.subjectName,
                    group: row.groupName,
                    start: row.startDate ?? "—",
                    end: row.endDate ?? "—",
                  })}
                </li>
              ))}
            </ul>
          </div>
        ) : null}
        {requirements.teachersCleared.length > 0 ? (
          <div>
            <p className="text-warning-foreground dark:text-warning">
              {t("reviewCleared", { count: requirements.teachersCleared.length })}
            </p>
            <ul className="ml-4 list-disc text-muted-foreground">
              {requirements.teachersCleared.map((row) => (
                <li key={`${row.sourceRequirementId}-${row.role}`}>
                  {t("clearedLine", {
                    teacher: teacherName(row.teacherId),
                    subject: row.subjectName,
                    group: row.groupName,
                    reason: t(`clearReason.${row.reason}`),
                  })}
                </li>
              ))}
            </ul>
          </div>
        ) : null}
        {requirements.qualificationWarnings.length > 0 ? (
          <div>
            <p>{t("reviewQualification", { count: requirements.qualificationWarnings.length })}</p>
            <ul className="ml-4 list-disc text-muted-foreground">
              {requirements.qualificationWarnings.map((row) => (
                <li key={`${row.sourceRequirementId}-${row.role}`}>
                  {t("qualificationLine", {
                    teacher: teacherName(row.teacherId),
                    subject: row.subjectName,
                    group: row.groupName,
                    grades: row.grades,
                  })}
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </section>

      <section aria-labelledby="review-timplans" className="space-y-1">
        <h3 id="review-timplans" className="font-medium">
          {t("reviewTimplans")}
        </h3>
        {plan.timplans.length === 0 ? (
          <p className="text-muted-foreground">{t("reviewTimplansNone")}</p>
        ) : (
          <>
            <ul className="ml-4 list-disc text-muted-foreground">
              {plan.timplans.map((row) => (
                <li key={row.gradeLevel}>
                  {t(`timplanLine.${row.reason}`, {
                    grade: row.gradeLevel,
                    plan: row.planName,
                    from: row.fromGradeLevel ?? 0,
                  })}
                  {row.planStatus === "DRAFT" ? (
                    <Badge variant="warning" className="ml-2 text-[10px]">
                      {t("timplanDraft")}
                    </Badge>
                  ) : null}
                  {row.laterPlan ? (
                    <span className="block text-xs">
                      {t("timplanLaterPlan", {
                        plan: row.laterPlan.name,
                        term: row.laterPlan.appliesFromCohortTerm,
                      })}
                    </span>
                  ) : null}
                </li>
              ))}
            </ul>
            <p className="text-muted-foreground">{t("reviewTimplansHint")}</p>
          </>
        )}
      </section>

      <section aria-labelledby="review-rules" className="space-y-1">
        <h3 id="review-rules" className="font-medium">
          {t("reviewClassRules", { count: plan.classRules.length })}
        </h3>
        {plan.classRules.length > 0 ? (
          <ul className="ml-4 list-disc text-muted-foreground">
            {plan.classRules.map((rule) => (
              <li key={rule.sourceConstraintId}>
                {t("classRuleLine", {
                  from: rule.sourceGroupName,
                  to: rule.targetGroupName,
                  day: DAYS[rule.dayOfWeek - 1] ? tCommon(DAYS[rule.dayOfWeek - 1]!) : rule.dayOfWeek,
                  start: rule.startTime,
                  end: rule.endTime,
                })}
                {rule.stageChange ? (
                  <Badge variant="warning" className="ml-2 text-[10px]">
                    {t("flag.stageChange")}
                  </Badge>
                ) : null}
              </li>
            ))}
          </ul>
        ) : null}
      </section>

      <section aria-labelledby="review-breaks" className="space-y-1">
        <h3 id="review-breaks" className="font-medium">
          {t("reviewBreaks", { count: selectedBreaks.length })}
        </h3>
        {selectedBreaks.length > 0 ? (
          <ul className="ml-4 list-disc text-muted-foreground">
            {selectedBreaks.map((lov) => (
              <li key={lov.sourceBreakId}>
                {t("breakLine", {
                  name: lov.name,
                  start: lov.startDateToWrite ?? "—",
                  end: lov.endDateToWrite ?? "—",
                })}
              </li>
            ))}
          </ul>
        ) : null}
      </section>

      <section aria-labelledby="review-left" className="space-y-1">
        <h3 id="review-left" className="font-medium">
          {t("reviewLeftOut")}
        </h3>
        <ul className="ml-4 list-disc text-muted-foreground">
          {plan.skipped
            .filter((entry) => t.has(`skipped.${entry.model}`))
            .map((entry) => (
              <li key={entry.model}>
                {t(`skipped.${entry.model}`, { count: entry.count ?? 0 })}
              </li>
            ))}
          {plan.skipped
            .filter((entry) => !t.has(`skipped.${entry.model}`) && !HISTORY.has(entry.model))
            .map((entry) => (
              <li key={entry.model}>
                {entry.model}: {entry.reason}
                {entry.count !== null ? ` (${entry.count})` : ""}
              </li>
            ))}
          <li>{t("skippedHistory")}</li>
        </ul>
        <p className="text-muted-foreground">{t("sharedSettings")}</p>
      </section>
    </div>
  );
}
