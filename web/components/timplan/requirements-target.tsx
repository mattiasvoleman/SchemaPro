"use client";

// Mål mode on the Timplansposter matrix — the code that only runs once the
// admin presses "Mål", fetched then and not with the page.
//
// WHY A MODULE OF ITS OWN, AND WHY IT IS IMPORTED BY HAND. /admin/requirements
// sat at 187.1 KB of its 190 KB budget before this mode existed, and the mode
// needs lib/timplan-planned.ts (the gateway's layer-1 arithmetic, with
// teacher-load's standardvecka weight and the alternative codes of
// lib/timplan-coverage.ts), the year's plans and their entries, and the
// rendering below. The page loads this file with a bare `import()` the first
// time the toggle is pressed and keeps the namespace in state: React.lazy
// would cover one component, and next/dynamic costs 1.4 KB of loader of its
// own (see components/import/lazy-csv-import-dialog.tsx). The bundle gate
// counts only what the route's manifest names, so none of this is on it.
// Measured 2026-10-07 with `npm run build` and scripts/bench/bundle-size.mjs:
// the route went 187.1 → 188.1 KB for the toggle, the wiring and the dialog
// line; this module and the arithmetic it pulls in are an 8.9 KB chunk
// fetched on the first press. Its reads avoid useQueries for the reason
// given at useLocalTimplanDetails.
//
// WHAT IT READS. Everything the matrix already holds (requirements, groups,
// subjects, lov, roster, memberships) is handed in; the two things it does not
// hold — which plan each årskurs follows this year, and those plans' entries —
// are read through lib/year-timplan-queries.ts, under the keys the timplan
// page and the year dialog write, so a save on either refreshes this too.
//
// HOW IT TALKS BACK. TargetHost computes the coverage and hands the page a
// TargetState through `onState`; the matrix cells, the row pills, the total
// column and row and the dialog's hint are this module's components, which the
// page renders from that state. Nothing here owns a cell's click or the
// dialog: those stay the page's, so Mål mode cannot change what a cell does.
//
// TONE AND CONTRAST, measured from app/globals.css as the page's header does
// (light / dark), on the card the matrix is painted on:
//
//   accent-fg on accent/70             10.21 /  7.82  AAA — met, over, none
//   warning-fg on warning/15 (light)   12.06          AAA — under mål
//   warning on warning/15 (dark)               7.12   AAA — under mål
//   destructive on card                 4.80 /  4.59  AA  — inga poster
//   foreground on muted                17.00 / 13.19  AAA — läses i grupp
//   foreground on card                 18.69 / 15.43  AAA — totals, pills
//
// The red is AA and not AAA: no red token reaches 7:1 on this card, and a red
// fill under foreground text would stop reading as red at all. The border is
// the same token, a graphical object over its 3:1 floor, and the word is in
// the cell's accessible name — the colour never carries it alone.

import { useEffect, useMemo } from "react";
import { useTranslations } from "next-intl";
import { Link } from "@/i18n/navigation";
import {
  buildTargetView,
  draftHint,
  targetInput,
  type DraftFields,
  type TargetCellView,
  type TargetSources,
  type TargetTone,
  type TargetTotal,
  type TargetView,
} from "@/lib/requirements-target";
import { formatHours } from "@/lib/teaching-hours";
import {
  computePlannedCoverage,
  type PlannedCoverageInput,
  type PlannedGroupSummary,
} from "@/lib/timplan-planned";
import { useLocalTimplanDetails, useYearTimplans } from "@/lib/year-timplan-queries";
import { cn } from "@/lib/utils";

export type TargetState =
  | { status: "loading" }
  | { status: "failed" }
  | {
      status: "ready";
      view: TargetView;
      input: PlannedCoverageInput;
    };

/** Hours as the matrix prints them: decimal comma, "h". */
const h = (hours: number): string => formatHours(hours * 60);
/** A signed difference with a real minus sign, as the timplan page writes one. */
const signed = (value: number): string => (value > 0 ? `+${value}` : value < 0 ? `−${-value}` : "0");

export interface TargetHostProps {
  academicYearId: string;
  /**
   * What the matrix has loaded, or null while something it needs has not
   * answered — the roster above all, which the page deliberately keeps out of
   * its own loading gate, and without which every class reads as having no
   * pupils and "covered" would be judged on the class's own posts alone.
   */
  sources: Omit<TargetSources, "attachments" | "plans"> | null;
  onState: (state: TargetState) => void;
}

/**
 * Reads the year's plans, computes the coverage, hands it to the page and
 * renders the sentences above the matrix that belong to the whole year: what
 * a cell's two numbers are, which årskurser follow no plan, which follow a
 * draft, and the classes' total.
 */
export function TargetHost({ academicYearId, sources, onState }: TargetHostProps) {
  const t = useTranslations("requirements");
  const attachments = useYearTimplans(academicYearId);
  const planIds = useMemo(
    () => [...new Set((attachments.data ?? []).map((row) => row.localTimplanId))].sort(),
    [attachments.data],
  );
  // Asked once the year has said which plans it follows, not before.
  const plans = useLocalTimplanDetails(planIds, attachments.data !== undefined);

  const grade = (gradeLevel: number) => t("target.grade", { grade: String(gradeLevel) });

  const state = useMemo<TargetState>(() => {
    if (attachments.isError || plans.isError) return { status: "failed" };
    if (!attachments.data || !plans.data || !sources) return { status: "loading" };
    const planned = plans.data.map((plan) => ({
      id: plan.id,
      name: plan.name,
      status: plan.status,
      entries: plan.entries.map((entry) => ({
        subjectId: entry.subjectId,
        gradeLevel: entry.gradeLevel,
        minutesPerWeek: entry.minutesPerWeek,
      })),
    }));
    const input = targetInput({ ...sources, attachments: attachments.data, plans: planned });
    const view = buildTargetView(computePlannedCoverage(input), planned);
    return { status: "ready", view, input };
    // Not keyed on the translator: the state is figures, and the words are
    // put on them where they are painted (cellSentence, the components below).
  }, [attachments.data, attachments.isError, plans.data, plans.isError, sources]);

  useEffect(() => onState(state), [state, onState]);

  if (state.status === "loading") {
    return (
      <p role="status" className="mb-3 text-sm text-foreground">
        {t("target.loading")}
      </p>
    );
  }
  if (state.status === "failed") {
    return (
      <p role="alert" className="mb-3 rounded-md bg-muted px-3 py-2 text-sm text-foreground">
        {t("target.failed")}
      </p>
    );
  }
  const { view } = state;
  return (
    <div className="mb-3 space-y-1 text-sm text-foreground">
      <p>{t("target.legend")}</p>
      {view.unattachedGrades.length > 0 ? (
        <p className="rounded-md bg-muted px-3 py-2">
          {t("target.unattached", { grades: view.unattachedGrades.map(grade).join(", ") })}
        </p>
      ) : null}
      {view.draftPlans.map((plan) => (
        <p key={plan.id} className="rounded-md bg-muted px-3 py-2">
          {t("target.draft", { name: plan.name, grades: plan.gradeLevels.map(grade).join(", ") })}
        </p>
      ))}
      <p role="status" aria-live="polite" aria-atomic="true" className="font-medium">
        {view.total.target === null
          ? t("target.totalNoTarget", {
              planned: view.total.planned,
              plannedHours: h(view.total.plannedHours),
            })
          : t("target.total", {
              planned: view.total.planned,
              target: view.total.target,
              plannedHours: h(view.total.plannedHours),
              targetHours: h(view.total.targetHours ?? 0),
            })}
      </p>
    </div>
  );
}

/** A translator for the `requirements` namespace, as the page holds one. */
type Translate = (key: string, values?: Record<string, string | number>) => string;

/**
 * The sentence a cell's accessible name gains in Mål mode, after the one
 * that names the cell — an aria-label replaces the cell's contents, so the
 * two numbers and their verdict have to be said here or to nobody.
 */
export function cellSentence(t: Translate, cell: TargetCellView, input: PlannedCoverageInput): string {
  const values = {
    planned: cell.planned,
    target: cell.target ?? 0,
    deficit: cell.delta === null ? 0 : -cell.delta,
    surplus: cell.delta ?? 0,
  };
  const main = (() => {
    switch (cell.tone) {
      case "unplanned":
        return t("target.cellUnplanned", values);
      case "under":
        return t("target.cellUnder", values);
      case "pupils":
        return t("target.cellPupils", values);
      case "met":
        return t("target.cellMet", values);
      case "over":
        return t("target.cellOver", values);
      case "none":
        return t("target.cellNoTarget", values);
    }
  })();
  if (cell.partnerSubjectIds.length === 0) return main;
  const subjects = cell.partnerSubjectIds
    .map((id) => input.subjects.find((subject) => subject.id === id)?.name ?? "")
    .join(", ");
  return `${main} ${t("target.cellTogether", { subjects })}`;
}

const TONE: Record<TargetTone, string> = {
  unplanned: "border border-destructive text-destructive hover:bg-muted",
  under:
    "bg-warning/15 text-warning-foreground hover:bg-warning/25 dark:text-warning",
  pupils: "bg-muted text-foreground hover:bg-accent hover:text-accent-foreground",
  met: "bg-accent/70 text-accent-foreground hover:bg-accent",
  over: "bg-accent/70 text-accent-foreground hover:bg-accent",
  none: "bg-accent/70 text-accent-foreground hover:bg-accent",
};

/** The cell button's classes in Mål mode; the shape is the page's filled cell. */
export function targetCellClass(tone: TargetTone): string {
  return cn(
    "mx-auto flex min-h-10 w-full min-w-16 flex-col items-center justify-center rounded-md transition-colors",
    TONE[tone],
  );
}

/**
 * "160 / 180" over "−20": planned and target in min/vecka, then the line's
 * difference when there is one. A line on target prints no second row, so the
 * eye finds the cells that differ. An alternative's cell and a class taught
 * in groups say so in words instead, since their own two numbers are not the
 * whole story.
 */
export function TargetCellBody({ cell }: { cell: TargetCellView }) {
  const t = useTranslations("requirements");
  const note =
    cell.tone === "pupils"
      ? t("target.tagPupils")
      : cell.alternative && cell.tone !== "under" && cell.tone !== "unplanned"
        ? t("target.tagAlternative")
        : cell.delta !== null && cell.delta !== 0
          ? signed(cell.delta)
          : null;
  return (
    <>
      <span className="text-sm font-semibold tabular-nums">
        {cell.planned} / {cell.target ?? "–"}
      </span>
      {note ? (
        <span className="text-[10px] font-semibold leading-tight tabular-nums">{note}</span>
      ) : null}
    </>
  );
}

/**
 * The row header's Täckning pill: how many of the class's timplan lines every
 * pupil reaches, linking to the coverage page for the class. Amber while any
 * line is short; "utkast" when the class follows a plan not yet decided.
 */
export function CoveragePill({
  summary,
  academicYearId,
  groupName,
}: {
  summary: PlannedGroupSummary;
  academicYearId: string;
  groupName: string;
}) {
  const t = useTranslations("requirements");
  if (summary.localTimplanId === null) {
    return (
      <span className="ml-2 text-xs font-normal text-muted-foreground">{t("target.pillNoPlan")}</span>
    );
  }
  const short = summary.linesCovered < summary.linesWithTarget;
  const draft = summary.planStatus === "DRAFT";
  return (
    <Link
      href={`/admin/timplan/tackning?year=${encodeURIComponent(academicYearId)}&group=${encodeURIComponent(summary.studentGroupId)}`}
      aria-label={t(draft ? "target.pillLabelDraft" : "target.pillLabel", {
        group: groupName,
        covered: summary.linesCovered,
        total: summary.linesWithTarget,
      })}
      className={cn(
        "ml-2 inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-[11px] font-medium tabular-nums underline-offset-2 hover:underline",
        short
          ? "border-transparent bg-warning/15 text-warning-foreground dark:text-warning"
          : "text-foreground",
      )}
    >
      {summary.linesCovered}/{summary.linesWithTarget}
      {draft ? <span>· {t("target.pillDraft")}</span> : null}
    </Link>
  );
}

/**
 * The group-total column: a class's whole week and year against its plan, or
 * — in the totals row — every class together (`total`). A teaching group has
 * neither and prints a dash.
 */
export function GroupTotalCell({
  summary,
  total,
}: {
  summary: PlannedGroupSummary | null;
  total?: TargetTotal;
}) {
  const figures: TargetTotal | null = total
    ? total
    : summary
      ? {
          planned: summary.plannedMinutesPerWeek,
          target: summary.localTimplanId === null ? null : summary.targetMinutesPerWeek,
          plannedHours: summary.plannedHours,
          targetHours: summary.localTimplanId === null ? null : summary.targetHours,
        }
      : null;
  if (!figures) return <span aria-hidden="true">–</span>;
  return (
    <span className="flex flex-col items-end">
      <span>
        {figures.planned} / {figures.target ?? "–"}
      </span>
      <span className="text-xs font-normal">
        {h(figures.plannedHours)} / {figures.targetHours === null ? "–" : h(figures.targetHours)}
      </span>
    </span>
  );
}

/** One column's total over the classes, as the totals row prints it. */
export function SubjectTotalCell({ total }: { total: TargetTotal | undefined }) {
  if (!total) return null;
  return (
    <span className="flex flex-col items-center tabular-nums">
      <span className="font-semibold">
        {total.planned} / {total.target ?? "–"}
      </span>
      <span className="text-[10px] leading-tight">
        {h(total.plannedHours)} / {total.targetHours === null ? "–" : h(total.targetHours)}
      </span>
    </span>
  );
}

/**
 * The cell dialog's line: what the timplan asks of this class in this
 * subject, and what the post as typed gives — "Timplanen säger 180
 * min/vecka för åk 7; 3 × 60 täcker det." Recomputed on every change of the
 * fields, from the same module the matrix uses, for the one class only.
 */
export function TargetHint({
  input,
  groupId,
  subjectId,
  fields,
}: {
  input: PlannedCoverageInput;
  groupId: string;
  subjectId: string;
  fields: DraftFields;
}) {
  const t = useTranslations("requirements");
  const hint = useMemo(
    () => draftHint(input, groupId, subjectId, fields),
    [input, groupId, subjectId, fields],
  );
  if (!hint) return null;
  const grade = (gradeLevel: number) => t("target.grade", { grade: String(gradeLevel) });
  const sentences: string[] = [];
  switch (hint.kind) {
    case "teachingGroup":
      sentences.push(t("target.hintTeachingGroup"));
      break;
    case "noGrade":
      sentences.push(t("target.hintNoGrade"));
      break;
    case "noPlan":
      sentences.push(t("target.hintNoPlan", { grade: grade(hint.gradeLevel) }));
      break;
    case "notCounted":
      sentences.push(t("target.hintNotCounted"));
      break;
    case "noTarget":
      sentences.push(t("target.hintNoTarget", { grade: grade(hint.gradeLevel) }));
      break;
    case "target": {
      const values = {
        target: hint.target,
        grade: grade(hint.gradeLevel),
        lessons: hint.lessonsPerWeek,
        minutes: hint.minutesPerLesson,
        planned: hint.planned ?? 0,
        deficit: hint.delta === null ? 0 : -hint.delta,
        surplus: hint.delta ?? 0,
      };
      sentences.push(
        hint.status === null
          ? t("target.hintTarget", values)
          : hint.status === "MET"
            ? t("target.hintMet", values)
            : hint.status === "OVER"
              ? t("target.hintOver", values)
              : t("target.hintUnder", values),
      );
      if (
        hint.status !== null &&
        (fields.recurrence !== "ALL_WEEKS" || fields.startDate !== "" || fields.endDate !== "")
      ) {
        sentences.push(t("target.hintWeighted"));
      }
      if (hint.partnerSubjectIds.length > 0) {
        const names = new Map(input.subjects.map((subject) => [subject.id, subject.name]));
        sentences.push(
          t("target.hintTogether", {
            subjects: hint.partnerSubjectIds.map((id) => names.get(id) ?? "").join(", "),
          }),
        );
      }
      break;
    }
  }
  if ((hint.kind === "target" || hint.kind === "noTarget" || hint.kind === "notCounted") && hint.draft) {
    sentences.push(t("target.hintDraft"));
  }
  return (
    <p role="status" aria-live="polite" className="rounded-md bg-muted px-3 py-2 text-sm text-foreground">
      {sentences.join(" ")}
    </p>
  );
}
