"use client";

import { useTranslations } from "next-intl";
import { formatPercent } from "@/lib/staffing-view";
import { hoursOver, type ScopeCardData } from "@/lib/assignment-scope";
import { SectionCard } from "@/components/ui/section-card";

export interface ScopeCardProps {
  data: ScopeCardData;
  /** "h2" on a page of its own, "h3" inside the drawer's cards. */
  headingLevel?: "h2" | "h3";
  /** A teacher's own page words it as theirs ("Din undervisningstid"); the drawer speaks about the teacher. */
  own?: boolean;
}

/**
 * Omfattning enligt förordningen (SFS 2026:1487): a teacher's teaching hours over the läsår beside the ordinance's
 * span for their stage, the floor for planning and follow-up, and what the span does and does not decide.
 *
 * EVERY FIGURE COMES FROM GET /staffing/load's `scope`, which the gateway computes (src/staffing/assignment-scope.ts):
 * the lessons' own time over the weeks they run, unweighted, never the riktmärke (the matrix's mål is the school's own
 * measure; this is the law's), and never an uppdrag. Nothing here computes.
 *
 * THE SPAN IS NOT A CAP (3 §, 8 §), and the card does not draw it as one. Only the upper edge is a limit: over it the
 * card says so and by how much. Between the edges it says INSIDE and what decides where in the span the teacher lies,
 * which is the rektor's call and not the product's. The part-time edge, the working time left and whether it holds
 * the floor are the post's percentage at one remove, so a reader without HR-läs gets the verdict without them.
 *
 * WHAT IT SAYS WHEN IT CANNOT JUDGE, in words, and never a silent blank: a ten-year grundskola (no figures until the
 * ordinance is changed for it), a teacher with no post (the span cannot be scaled), teaching only in förskoleklass (outside
 * the ordinance). A läsår the ordinance does not reach has no card at all (scopeCardOf): 2026/27 would otherwise say
 * "not in force" on every teacher.
 */
export function ScopeCard({ data, headingLevel = "h3", own = false }: ScopeCardProps) {
  const t = useTranslations("staffing.scope");
  const { teacher, version, yearReason, interpretations } = data;
  const hours = (value: number) => t("hours", { hours: formatPercent(value) });
  const judged = yearReason === null && teacher.verdict !== "NOT_JUDGED";
  const over = hoursOver(teacher);

  const rows: { label: string; value: string }[] = [
    { label: own ? t("teachingOwn") : t("teaching"), value: hours(teacher.teachingHours) },
  ];
  if (judged && teacher.highestHours !== null) {
    rows.push({ label: own ? t("highestOwn") : t("highest"), value: hours(teacher.highestHours) });
  }
  if (teacher.fullTimeHighestHours !== null && teacher.fullTimeLowestHours !== null && yearReason === null) {
    rows.push({
      label: t("spanFullTime"),
      value: t("span", { low: formatPercent(teacher.fullTimeLowestHours), high: formatPercent(teacher.fullTimeHighestHours) }),
    });
  }
  for (const stage of teacher.stages) {
    rows.push({
      label: t("stage", { from: stage.gradeFrom, to: stage.gradeTo }),
      value: hours(stage.hours),
    });
  }
  if (teacher.unregulatedHours > 0) rows.push({ label: t("unregulated"), value: hours(teacher.unregulatedHours) });
  if (teacher.unknownGradeHours > 0) rows.push({ label: t("unknownGrade"), value: hours(teacher.unknownGradeHours) });
  if (judged && teacher.planningFloorHours !== null) {
    rows.push({ label: t("planningFloor"), value: hours(teacher.planningFloorHours) });
  }
  if (judged && teacher.remainingHours !== null) {
    rows.push({ label: t("remaining"), value: hours(teacher.remainingHours) });
  }

  // The one sentence that is the answer, first under the heading: tone by the words themselves, never by colour alone.
  let verdict: string;
  if (yearReason === "NUMBERING_NOT_COVERED") verdict = t("verdictNumbering");
  else if (teacher.notJudged === "NO_POST") verdict = t("verdictNoPost");
  else if (teacher.notJudged === "NO_STAGE") {
    // None of the hours lies in a stage: förskoleklass, groups with no årskurs, or both. Say which, not förskoleklass for all.
    verdict =
      teacher.unknownGradeHours === 0
        ? t("verdictNoStage")
        : teacher.unregulatedHours === 0
          ? t("verdictNoStageUnknown")
          : t("verdictNoStageBoth");
  }
  else if (teacher.verdict === "OVER_MAX") verdict = over === null ? t("verdictOverMaxHidden") : t("verdictOverMax", { over: formatPercent(over) });
  else if (teacher.verdict === "OVER_OWN") verdict = over === null ? t("verdictOverOwnHidden") : t("verdictOverOwn", { over: formatPercent(over) });
  else if (teacher.verdict === "INSIDE") verdict = t("verdictInside");
  else verdict = t("verdictNone");
  const bad = teacher.verdict === "OVER_MAX" || teacher.verdict === "OVER_OWN";
  const blended = teacher.stages.length > 1;

  return (
    <SectionCard
      id="scope-card"
      headingLevel={headingLevel === "h2" ? 2 : 3}
      title={t("title")}
      className="break-inside-avoid"
    >
      <p className={bad ? "text-sm font-medium text-destructive" : "text-sm"}>{verdict}</p>
      <dl className="grid grid-cols-[1fr_auto] gap-x-4 gap-y-1 text-sm">
        {rows.map((row) => (
          <div key={row.label} className="contents">
            <dt>{row.label}</dt>
            <dd className="text-right tabular-nums">{row.value}</dd>
          </div>
        ))}
      </dl>
      {blended && judged ? <p className="text-xs text-muted-foreground">{t("blended")}</p> : null}
      {judged && teacher.planningFits !== null ? (
        <p className="text-xs text-muted-foreground">{teacher.planningFits ? t("fits") : t("doesNotFit")}</p>
      ) : null}
      {judged && teacher.planningFits === null ? (
        // Not a blank: whether the floor fits is worked out for a full ferietjänst only, and left out for a reader without HR-läs.
        <p className="text-xs text-muted-foreground">{t("fitsNotShown")}</p>
      ) : null}
      {teacher.unknownGradeHours > 0 ? (
        <p className="text-xs text-muted-foreground">{t("unknownGradeNote")}</p>
      ) : null}
      {interpretations.length > 0 && yearReason === null
        ? interpretations.map((one) => (
            <p key={one.section} className="text-xs text-muted-foreground">
              {t("interpretation", { section: one.section, note: one.note })}
            </p>
          ))
        : null}
      <p className="text-xs text-muted-foreground">{t("notAnnual")}</p>
      <p className="text-xs text-muted-foreground">
        {t("caption", { sfs: version.sfs, from: version.validFrom })}{" "}
        <a href={version.source} target="_blank" rel="noreferrer" className="underline">
          {t("source")}
          <span className="sr-only"> {t("opensInNewTab")}</span>
        </a>
      </p>
    </SectionCard>
  );
}
