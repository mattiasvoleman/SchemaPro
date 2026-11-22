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
  const overOnly = teacher.overOnlyWithUnregulated === true;

  const rows: { label: string; value: string }[] = [
    { label: own ? t("teachingOwn") : t("teaching"), value: hours(teacher.teachingHours) },
  ];
  // The row says "the ordinance's": the edge the verdict OVER_MAX is judged against. A level the rektor set lies lower (and is its own
  // row below), so the row never shows it under the ordinance's name (the review of #397, L-5 and L-9).
  const ordinanceEdge = teacher.ordinanceHighestHours ?? teacher.highestHours;
  if (judged && ordinanceEdge !== null) {
    rows.push({ label: own ? t("highestOwn") : t("highest"), value: hours(ordinanceEdge) });
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
  // Förskoleklass, and only that: in a läsår the lydelse has no band for (a ten-year grundskola) the gateway files EVERY hour as
  // unregulated (placeSpan with no bands), so the row would say a teacher in årskurs 5 teaches 645 h in förskoleklass.
  if (teacher.unregulatedHours > 0 && yearReason === null) rows.push({ label: t("unregulated"), value: hours(teacher.unregulatedHours) });
  if (teacher.unknownGradeHours > 0) rows.push({ label: t("unknownGrade"), value: hours(teacher.unknownGradeHours) });
  if (judged && teacher.planningFloorHours !== null) {
    rows.push({ label: t("planningFloor"), value: hours(teacher.planningFloorHours) });
  }
  if (judged && teacher.remainingHours !== null) {
    rows.push({ label: t("remaining"), value: hours(teacher.remainingHours) });
  }
  // The rektor's assessment (8 §, 11 §), as the gateway lets this reader read it: the level, or only the kind of exception.
  const assessment = teacher.assessment;
  if (assessment && assessment.levelHours !== null) {
    rows.push({ label: own ? t("assessmentLevelOwn") : t("assessmentLevel"), value: hours(assessment.levelHours) });
  }
  // What OVER_OWN is judged against: that level scaled by the post. Shown only where it is a figure of its own (a part-time post, or a level
  // above the ordinance's edge makes it the same as one of the rows above), so that "over by 45 h" can be checked against a row.
  if (
    judged &&
    teacher.highestHours !== null &&
    teacher.ordinanceHighestHours !== null &&
    teacher.highestHours < teacher.ordinanceHighestHours &&
    teacher.highestHours !== assessment?.levelHours
  ) {
    rows.push({ label: own ? t("assessmentHighestOwn") : t("assessmentHighest"), value: hours(teacher.highestHours) });
  }

  // The one sentence that is the answer, first under the heading: tone by the words themselves, never by colour alone.
  let verdict: string;
  if (yearReason === "NUMBERING_NOT_COVERED") verdict = t("verdictNumbering");
  else if (teacher.notJudged === "NO_POST") verdict = own ? t("own.verdictNoPost") : t("verdictNoPost");
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
  else if (teacher.verdict === "OVER_OWN") {
    verdict =
      over === null
        ? t("verdictOverOwnHidden")
        : own
          ? t("own.verdictOverOwn", { over: formatPercent(over) })
          : t("verdictOverOwn", { over: formatPercent(over) });
  }
  else if (teacher.verdict === "INSIDE") {
    // Past the edge only with the hours outside the stages (T7): "not over the highest level" would be said of someone whose total is over it,
    // so the sentence that is the answer says how it is, and the interpretation below it.
    verdict = overOnly
      ? own ? t("own.overOnlyWithUnregulated") : t("overOnlyWithUnregulated")
      : own ? t("own.verdictInside") : t("verdictInside");
  }
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
      {overOnly && teacher.verdict !== "INSIDE" ? (
        // Over the level the rektor set AND past the ordinance's edge only with the hours outside the stages: the verdict above is the first,
        // and this says the second (for INSIDE the verdict sentence itself says it).
        <p className="text-xs text-muted-foreground">{own ? t("own.overOnlyWithUnregulated") : t("overOnlyWithUnregulated")}</p>
      ) : null}
      {assessment?.exceptionKind ? (
        <p className="text-xs text-muted-foreground">
          {t("exceptionRegistered", { kind: own ? t(`own.exceptionKind${assessment.exceptionKind}`) : t(`exceptionKind${assessment.exceptionKind}`) })}
          {assessment.ownInitiativeOn ? ` ${assessment.ownInitiativeOn}.` : ""} {t("exceptionKeepsVerdict")}
        </p>
      ) : null}
      {assessment?.note ? <p className="text-xs text-muted-foreground">{t("assessmentNote", { note: assessment.note })}</p> : null}
      {blended && judged ? <p className="text-xs text-muted-foreground">{own ? t("own.blended") : t("blended")}</p> : null}
      {judged && teacher.planningFits !== null ? (
        <p className="text-xs text-muted-foreground">{teacher.planningFits ? t("fits") : t("doesNotFit")}</p>
      ) : null}
      {judged && teacher.planningFits === null ? (
        // Not a blank: whether the floor fits is worked out for a full ferietjänst only, and left out for a reader without HR-läs.
        <p className="text-xs text-muted-foreground">{own ? t("own.fitsNotShown") : t("fitsNotShown")}</p>
      ) : null}
      {teacher.unregulatedHours > 0 && yearReason === null ? (
        // "(omfattas inte)" beside a figure that is counted in the total reads as if it were not: say which it is.
        <p className="text-xs text-muted-foreground">{t("unregulatedNote")}</p>
      ) : null}
      {teacher.unknownGradeHours > 0 ? (
        <p className="text-xs text-muted-foreground">{t("unknownGradeNote")}</p>
      ) : null}
      {judged && teacher.planningFloorHours !== null && (teacher.unregulatedHours > 0 || teacher.unknownGradeHours > 0) ? (
        // The floor is worked out on the hours in the stages alone (the ordinance gives no level for the others, so there is no floor to count
        // them against), while the total and the working time left count every hour: beside the floor row, so that it is not read as the total's.
        <p className="text-xs text-muted-foreground">{t("planningFloorOnStages")}</p>
      ) : null}
      {interpretations.length > 0 && yearReason === null
        ? interpretations.map((one) => (
            <p key={`${one.section}-${one.cause ?? ""}`} className="text-xs text-muted-foreground">
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
