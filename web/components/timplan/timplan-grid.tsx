"use client";

import { useTranslations } from "next-intl";
import type { BaseStage, TimplanCheck } from "@/lib/timplan-coverage";
import {
  cellFor,
  cellKey,
  formatH,
  hasAlternatives,
  parseMinutes,
  pupilGradeMinutes,
  rowTone,
  stageHours,
  type DraftCells,
  type GridColumn,
  type Highlight,
  type Tone,
} from "@/lib/timplan-view";
import type { Subject } from "@/lib/types";
import { cn } from "@/lib/utils";

/*
 * Tone fills, each with foreground text on a tint of the status colour, so the
 * figure stays legible in both themes; the tone is ALSO spelled out in a
 * visually hidden label and carried as data-tone, because a colour alone tells
 * a colour-blind reader nothing. Red is the destructive tint with a left rule
 * rather than red text: "under mål" is a warning about a plan, not an error
 * in it, and it must not read like a failed form field.
 */
const TONE_CLASS: Record<Tone, string> = {
  met: "bg-success/15",
  below: "bg-warning/25",
  under: "bg-destructive/15 border-l-2 border-l-destructive",
  none: "",
};

export interface TimplanGridProps {
  /** The school's subjects, already in Swedish order. */
  subjects: Subject[];
  /** National code → its ämnesgrupp (KE → NO), null for a top-level code. */
  parentOf: ReadonlyMap<string, string | null>;
  columns: GridColumn[];
  stageGrades: Record<BaseStage, number[]>;
  draft: DraftCells;
  notes: ReadonlyMap<string, string | null>;
  check: TimplanCheck;
  weeksTenths: number;
  readOnly: boolean;
  highlight: Highlight | null;
  onCellChange: (key: string, text: string) => void;
}

/**
 * The lokal timplan as a grid: school subjects down, årskurser across, one
 * integer "min/vecka" per cell, and after each stadium's årskurser that
 * stadium's sum in hours beside the national figure, coloured by the verdict
 * of the national cell the subject feeds.
 *
 * Counted subjects come first; subjects that do not count as undervisningstid
 * (Mentorstid, Resurs) follow under their own heading, still editable — the
 * school may plan them here — but with no sums and no colour, so they cannot
 * be mistaken for part of the total.
 */
export function TimplanGrid({
  subjects,
  parentOf,
  columns,
  stageGrades,
  draft,
  notes,
  check,
  weeksTenths,
  readOnly,
  highlight,
  onCellChange,
}: TimplanGridProps) {
  const t = useTranslations("timplan");
  const counted = subjects.filter((subject) => subject.countsTowardTimplan);
  const notCounted = subjects.filter((subject) => !subject.countsTowardTimplan);
  const gradeLabel = (grade: number) => t("gradeAria", { grade });
  const topOf = (code: string | null) => (code === null ? null : (parentOf.get(code) ?? code));

  const lit = (subjectId: string, grade: number | null, stage: BaseStage | null): boolean => {
    if (!highlight || !highlight.subjectIds?.has(subjectId)) return false;
    if (stage !== null) return highlight.stages.has(stage) || highlight.grades === null;
    return highlight.grades === null || (grade !== null && highlight.grades.has(grade));
  };

  const renderRow = (subject: Subject, countsToward: boolean) => {
    const top = topOf(subject.nationalCode);
    const badge = check.unmapped.some((entry) => entry.subjectId === subject.id)
      ? poolPrinted
        ? "skolansValBadge"
        : "ownTimeBadge"
      : "uncodedBadge";
    return (
      <tr key={subject.id} className="border-b" data-subject-id={subject.id}>
        <th
          scope="row"
          className="sticky left-0 z-10 bg-card px-3 py-1.5 text-left text-sm font-medium"
        >
          <span className="flex items-center gap-2">
            <span className="truncate">{subject.name}</span>
            {countsToward && subject.nationalCode ? (
              <span className="rounded border px-1 text-[10px] font-normal text-muted-foreground">
                {subject.nationalCode}
              </span>
            ) : null}
            {countsToward && !subject.nationalCode ? (
              // What the badge names is where the subject's minutes GO, so a
              // subject with none in the stages (the check lists only uncoded
              // subjects with time there; förskoleklass minutes count toward
              // nothing, hence the hint's wording) is just "no code": calling an empty row
              // "skolans val" told a school starting its first plan that its
              // Matematik was pool time. With minutes: skolans val only where
              // the bilaga prints a pool; ämnesområden and an unpublished
              // lydelse print none, and the minutes are the school's own time.
              <span
                className="rounded bg-muted px-1 text-[10px] font-normal text-foreground"
                title={t(`${badge}Hint`)}
              >
                {t(badge)}
              </span>
            ) : null}
          </span>
        </th>
        {columns.map((column) => {
          if (column.kind === "grade") {
            const key = cellKey(subject.id, column.grade);
            const text = draft.get(key) ?? "";
            const invalid = text.trim() !== "" && parseMinutes(text) === null;
            const note = notes.get(key) ?? null;
            const highlighted = lit(subject.id, column.grade, null);
            return (
              <td
                key={`g${column.grade}`}
                className={cn("px-1 py-1 text-center", column.stage === null && "bg-muted/40")}
              >
                <span className="relative inline-block">
                  <input
                    inputMode="numeric"
                    aria-label={t("cellAria", { subject: subject.name, grade: gradeLabel(column.grade) })}
                    aria-invalid={invalid || undefined}
                    readOnly={readOnly}
                    aria-readonly={readOnly || undefined}
                    data-highlighted={highlighted || undefined}
                    title={invalid ? t("cellInvalid") : note ? t("cellNote", { note }) : undefined}
                    value={text}
                    onChange={(event) => onCellChange(key, event.target.value)}
                    className={cn(
                      "h-8 w-14 rounded-md border border-input bg-background px-1.5 text-right text-sm tabular-nums",
                      "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                      readOnly && "border-transparent bg-transparent",
                      invalid && "border-destructive",
                      highlighted && "ring-2 ring-primary",
                    )}
                  />
                  {note ? (
                    <span
                      aria-hidden
                      className="absolute right-0.5 top-0.5 h-1.5 w-1.5 rounded-full bg-primary"
                    />
                  ) : null}
                </span>
              </td>
            );
          }

          if (!countsToward) return <td key={`s${column.stage}`} className="px-2" />;
          const grades = stageGrades[column.stage];
          const tone = rowTone(check, subject.nationalCode, top, column.stage);
          const hours = stageHours(draft, subject.id, grades, weeksTenths, tone === "below" || tone === "under");
          const cell = top ? cellFor(check, top, column.stage) : undefined;
          const child =
            cell && subject.nationalCode !== top
              ? cell.children?.find((entry) => entry.subjectCode === subject.nationalCode)
              : undefined;
          const highlighted = lit(subject.id, null, column.stage);
          return (
            <td
              key={`s${column.stage}`}
              data-tone={tone}
              data-stage={column.stage}
              data-highlighted={highlighted || undefined}
              className={cn(
                "whitespace-nowrap px-2 py-1 text-right text-sm tabular-nums",
                TONE_CLASS[tone],
                highlighted && "outline outline-2 -outline-offset-2 outline-primary",
              )}
            >
              <span className="block font-medium">{hours === 0 && tone === "none" ? "–" : formatH(hours)}</span>
              {child ? (
                <span className="block text-[11px] text-foreground/80">
                  {t("stageCellChild", { minimum: formatH(child.minimumHours) })}
                </span>
              ) : cell && cell.nationalHours > 0 ? (
                <span className="block text-[11px] text-foreground/80">
                  {t(cell.stage === "LAG_MELLAN" ? "stageCellMerged" : "stageCellNational", {
                    planned: formatH(cell.plannedHours),
                    national: formatH(cell.nationalHours),
                  })}
                </span>
              ) : null}
              <span className="sr-only">{t(`tones.${tone}`)}</span>
            </td>
          );
        })}
      </tr>
    );
  };

  // Column sums over the COUNTED subjects only, as a pupil has them —
  // alternatives (Svenska/SvA, språkval) once, at the longest — and in
  // minute-tenths so the stage figure is the same arithmetic as the check's.
  const gradeSum = (grade: number) => pupilGradeMinutes(draft, counted, grade, parentOf);
  const stageSum = (stage: BaseStage) =>
    Math.round(
      stageGrades[stage].reduce((sum, grade) => sum + gradeSum(grade) * weeksTenths, 0) / 60,
    ) / 10;
  const alternatives = hasAlternatives(counted, parentOf);
  const poolPrinted = check.skolansVal.availableHours !== null;
  // An empty plan "takes" every national hour from the subjects: true
  // arithmetic, but "6890 av 600 h tagna" reads as a fault, not a start.
  // Stage time only (förskoleklass is outside), and with or without a pool:
  // the sentence says neither "nothing at all" nor "skolans val".
  const nothingPlanned = !check.total.plannedHours;
  const poolShown = poolPrinted && !nothingPlanned;

  const totalUnder = check.verdicts.some((v) => v.code === "TIMPLAN_TOTAL_BELOW_GUARANTEE");
  const poolOverspent = check.verdicts.some((v) => v.code === "TIMPLAN_SKOLANS_VAL_OVERSPENT");
  const footerLit = highlight?.footer === true;
  const span = columns.length;

  return (
    <div className="overflow-x-auto rounded-lg border bg-card">
      <table className="w-full border-collapse text-sm">
        <caption className="sr-only">{t("legend")}</caption>
        <thead>
          <tr className="border-b">
            <th scope="col" className="sticky left-0 z-10 bg-card px-3 py-2 text-left font-medium text-muted-foreground">
              {t("subjectColumn")}
            </th>
            {columns.map((column) =>
              column.kind === "grade" ? (
                <th
                  key={`g${column.grade}`}
                  scope="col"
                  className={cn(
                    "px-1 py-2 text-center font-medium text-muted-foreground",
                    column.stage === null && "bg-muted/40",
                  )}
                  title={column.stage === null ? t("outsideStagesHint") : undefined}
                >
                  <abbr title={gradeLabel(column.grade)} className="no-underline">
                    {t("gradeColumn", { grade: column.grade })}
                  </abbr>
                </th>
              ) : (
                <th
                  key={`s${column.stage}`}
                  scope="col"
                  className="whitespace-nowrap px-2 py-2 text-right font-medium text-foreground"
                  title={t(`stages.${column.stage}`)}
                >
                  {t("stageSumColumn", { stage: t(`stagesShort.${column.stage}`) })}
                </th>
              ),
            )}
          </tr>
        </thead>
        <tbody>
          {counted.length > 0 ? (
            <tr className="bg-muted/30">
              <th colSpan={span + 1} scope="rowgroup" className="px-3 py-1 text-left text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                {t("countedHeading")}
              </th>
            </tr>
          ) : null}
          {counted.map((subject) => renderRow(subject, true))}
        </tbody>
        {notCounted.length > 0 ? (
          <tbody>
            <tr className="bg-muted/30">
              <th colSpan={span + 1} scope="rowgroup" className="px-3 py-1 text-left text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                {t("notCountedHeading")}
                <span className="ml-2 font-normal normal-case tracking-normal">{t("notCountedHint")}</span>
              </th>
            </tr>
            {notCounted.map((subject) => renderRow(subject, false))}
          </tbody>
        ) : null}
        <tfoot data-highlighted={footerLit || undefined} className={cn(footerLit && "outline outline-2 -outline-offset-2 outline-primary")}>
          <tr className="border-t-2">
            <th scope="row" className="sticky left-0 z-10 bg-card px-3 py-1.5 text-left font-medium">
              {t("footerColumnSum")}
              {alternatives ? (
                <span className="block text-[11px] font-normal text-muted-foreground">
                  {t("footerColumnSumAlternatives")}
                </span>
              ) : null}
            </th>
            {columns.map((column) =>
              column.kind === "grade" ? (
                <td key={`g${column.grade}`} className="px-1 py-1.5 text-right tabular-nums text-muted-foreground">
                  {gradeSum(column.grade)}
                </td>
              ) : (
                <td key={`s${column.stage}`} className="px-2 py-1.5 text-right font-medium tabular-nums">
                  {formatH(stageSum(column.stage))}
                </td>
              ),
            )}
          </tr>
          <tr className="border-t">
            <th scope="row" className="sticky left-0 z-10 bg-card px-3 py-1.5 text-left font-medium">
              {t("footerTotal")}
            </th>
            <td
              colSpan={span}
              data-tone={totalUnder ? "under" : "met"}
              className={cn("px-3 py-1.5 tabular-nums", TONE_CLASS[totalUnder ? "under" : "met"])}
            >
              {t("footerTotalValue", {
                planned: formatH(check.total.plannedHours),
                guaranteed: formatH(check.total.guaranteedHours),
              })}
              <span className="sr-only"> {t(`tones.${totalUnder ? "under" : "met"}`)}</span>
            </td>
          </tr>
          <tr className="border-t">
            <th scope="row" className="sticky left-0 z-10 bg-card px-3 py-1.5 text-left font-medium">
              {t("footerSkolansVal")}
            </th>
            <td
              colSpan={span}
              data-tone={poolShown ? (poolOverspent ? "under" : "met") : "none"}
              className={cn("px-3 py-1.5 tabular-nums", poolShown && TONE_CLASS[poolOverspent ? "under" : "met"])}
            >
              {nothingPlanned
                ? t("footerSkolansValEmpty")
                : check.skolansVal.availableHours === null
                  ? t("footerSkolansValNone", { placed: formatH(check.skolansVal.placedHours) })
                  : t("footerSkolansValValue", {
                      taken: formatH(check.skolansVal.takenHours),
                      available: formatH(check.skolansVal.availableHours),
                      placed: formatH(check.skolansVal.placedHours),
                    })}
            </td>
          </tr>
        </tfoot>
      </table>
    </div>
  );
}
