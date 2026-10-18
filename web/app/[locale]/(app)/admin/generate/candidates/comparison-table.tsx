"use client";

import { useMemo } from "react";
import { useLocale, useTranslations } from "next-intl";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import type { IdleComparison, IdleSummary } from "@/lib/candidates/idle";
import { isApplicable, signed, solverKey, variantLabel } from "@/lib/candidates/labels";
import type { CandidateView, CandidatesUnplaced, PublishMode } from "@/lib/candidates/types";

/** Where the håltimmar stand: being computed, impossible (a read failed), or measured. */
export type IdleState = { status: "loading" } | { status: "failed" } | ({ status: "ready" } & IdleComparison);

export interface ComparisonTableProps {
  candidates: readonly CandidateView[];
  /** The mode /check reported: it names the current column. Null until it has answered. */
  mode: PublishMode | null;
  unplaced: CandidatesUnplaced | null;
  idle: IdleState;
  /** Candidates whose lessons could not be read: their håltimmar cannot be measured. */
  lessonsFailed: ReadonlySet<string>;
  appliedId: string | null;
  /** Why no candidate can be applied right now, by the id of the sentence that says so. */
  applyBlockedBy: string | null;
  onApply: (candidate: CandidateView) => void;
}

/** One line of a cell: the figure, or (muted) what it is made of and how it compares. */
function Line({ children, muted = false }: { children: React.ReactNode; muted?: boolean }) {
  return <span className={muted ? "block text-xs text-muted-foreground" : "block tabular-nums"}>{children}</span>;
}

/*
 * The comparison: the current grundschema, then each candidate by its name,
 * one row per measure. A real table — headers on both axes, so a screen
 * reader names the candidate and the measure of every cell it reads — and
 * every difference is written in characters ("+30 min mot nuvarande"), so
 * nothing depends on colour.
 */
export function ComparisonTable({
  candidates,
  mode,
  unplaced,
  idle,
  lessonsFailed,
  appliedId,
  applyBlockedBy,
  onApply,
}: ComparisonTableProps) {
  const t = useTranslations("scheduleCandidates");
  const locale = useLocale();
  const tag = locale === "en" ? "en-GB" : "sv-SE";
  const whole = useMemo(() => new Intl.NumberFormat(tag, { maximumFractionDigits: 0 }), [tag]);
  const tenth = useMemo(() => new Intl.NumberFormat(tag, { maximumFractionDigits: 1 }), [tag]);
  const minutes = (value: number) => t("cell.minutes", { minutes: whole.format(value) });
  const pupilMinutes = (value: number) => t("cell.minutes", { minutes: tenth.format(value) });

  const currentLabel =
    mode === "DRAFT" ? t("table.currentDraft") : mode === "DIRECT" ? t("table.currentSchedule") : t("table.current");

  /** The current column's cell for a measure that is a difference against itself. */
  const notMeasured = (
    <>
      <span aria-hidden="true">—</span>
      <span className="sr-only">{t("cell.notApplicable")}</span>
    </>
  );
  const notApplicable = <span className="text-muted-foreground">{t("cell.notApplicable")}</span>;

  const idleOf = (candidate: CandidateView | null): IdleSummary | "loading" | "failed" | null => {
    if (candidate && !isApplicable(candidate)) return null;
    if (candidate && lessonsFailed.has(candidate.id)) return "failed";
    if (idle.status !== "ready") return idle.status;
    return candidate ? (idle.byCandidate.get(candidate.id) ?? "loading") : idle.current;
  };

  const idleCell = (candidate: CandidateView | null, render: (summary: IdleSummary, current: IdleSummary | null) => React.ReactNode) => {
    const summary = idleOf(candidate);
    if (summary === null) return notApplicable;
    if (summary === "failed") return <span className="text-muted-foreground">{t("cell.failed")}</span>;
    if (summary === "loading") {
      return (
        <div aria-busy="true">
          <Skeleton className="h-4 w-24" />
          <span className="sr-only">{t("cell.computing")}</span>
        </div>
      );
    }
    return render(summary, candidate && idle.status === "ready" ? idle.current : null);
  };

  const teachers = (summary: IdleSummary, current: IdleSummary | null) => (
    <>
      <Line>{minutes(summary.teachers.minutes)}</Line>
      <Line muted>{t("cell.teachersDetail", { count: summary.teachers.count, worst: whole.format(summary.teachers.worst) })}</Line>
      {current ? (
        <Line muted>{t("cell.delta", { delta: signed(summary.teachers.minutes - current.teachers.minutes, minutes) })}</Line>
      ) : null}
    </>
  );

  const pupils = (summary: IdleSummary, current: IdleSummary | null) => (
    <>
      <Line>{t("cell.perPupil", { minutes: tenth.format(summary.pupils.minutesPerPupil) })}</Line>
      <Line muted>{t("cell.pupilsDetail", { count: summary.pupils.classes, worst: whole.format(summary.pupils.worst) })}</Line>
      {current ? (
        <Line muted>
          {t("cell.delta", { delta: signed(summary.pupils.minutesPerPupil - current.pupils.minutesPerPupil, pupilMinutes) })}
        </Line>
      ) : null}
    </>
  );

  const head = "h-auto py-2 align-bottom";
  const rowHead = "h-auto py-2.5 align-top font-medium text-foreground";

  return (
    <Table>
      <caption className="caption-top pb-2 text-left text-sm text-muted-foreground">{t("table.caption")}</caption>
      <TableHeader>
        <TableRow className="hover:bg-transparent">
          <TableHead scope="col" className={head}>
            {t("table.measure")}
          </TableHead>
          <TableHead scope="col" className={head}>
            <span className="block font-semibold text-foreground">{currentLabel}</span>
          </TableHead>
          {candidates.map((candidate) => (
            <TableHead key={candidate.id} scope="col" className={head}>
              <span className="block font-semibold text-foreground">{t("table.candidate", { ordinal: candidate.ordinal })}</span>
              <span className="block text-foreground">{variantLabel(t, candidate)}</span>
              {candidate.metrics?.sameAs ? (
                <span className="block text-xs">{t("table.sameAs", { ordinal: candidate.metrics.sameAs })}</span>
              ) : null}
              {isApplicable(candidate) ? null : <span className="block text-xs">{t(solverKey(candidate.solverStatus))}</span>}
              {candidate.id === appliedId ? (
                <Badge variant="success" className="mt-1">
                  {t("table.applied")}
                </Badge>
              ) : null}
            </TableHead>
          ))}
        </TableRow>
      </TableHeader>
      <TableBody>
        <TableRow>
          <TableHead scope="row" className={rowHead}>
            {t("row.unplaced")}
            <Line muted>{t("row.unplacedHint")}</Line>
          </TableHead>
          {unplaced ? (
            <>
              <TableCell className="align-top">
                <Line>{t("cell.unplaced", { lines: unplaced.draftLines, minutes: whole.format(unplaced.draftMinutes) })}</Line>
              </TableCell>
              {/* Once for the run: equal across the feasible candidates in practice (design §5). */}
              <TableCell className="align-top" colSpan={candidates.length}>
                <Line>{t("cell.unplaced", { lines: unplaced.lines, minutes: whole.format(unplaced.minutes) })}</Line>
                <Line muted>
                  {t("cell.delta", {
                    delta: signed(unplaced.lines - unplaced.draftLines, (value) => t("cell.lines", { count: value })),
                  })}
                </Line>
              </TableCell>
            </>
          ) : (
            <>
              <TableCell className="align-top">{notMeasured}</TableCell>
              <TableCell className="align-top" colSpan={candidates.length}>
                {notApplicable}
              </TableCell>
            </>
          )}
        </TableRow>
        <TableRow>
          <TableHead scope="row" className={rowHead}>
            {t("row.moved")}
            <Line muted>{t("row.movedHint")}</Line>
          </TableHead>
          <TableCell className="align-top">{notMeasured}</TableCell>
          {candidates.map((candidate) => (
            <TableCell key={candidate.id} className="align-top">
              {candidate.metrics ? (
                <Line>{t("cell.movedOf", { moved: candidate.metrics.moved, of: candidate.metrics.movedOf })}</Line>
              ) : (
                notApplicable
              )}
            </TableCell>
          ))}
        </TableRow>
        <TableRow>
          <TableHead scope="row" className={rowHead}>
            {t("row.rooms")}
            <Line muted>{t("row.roomsHint")}</Line>
          </TableHead>
          <TableCell className="align-top">{notMeasured}</TableCell>
          {candidates.map((candidate) => (
            <TableCell key={candidate.id} className="align-top">
              {candidate.metrics ? <Line>{whole.format(candidate.metrics.roomChanges)}</Line> : notApplicable}
            </TableCell>
          ))}
        </TableRow>
        <TableRow>
          <TableHead scope="row" className={rowHead}>
            {t("row.teachers")}
            <Line muted>{t("row.teachersHint")}</Line>
          </TableHead>
          <TableCell className="align-top">{idleCell(null, teachers)}</TableCell>
          {candidates.map((candidate) => (
            <TableCell key={candidate.id} className="align-top">
              {idleCell(candidate, teachers)}
            </TableCell>
          ))}
        </TableRow>
        <TableRow>
          <TableHead scope="row" className={rowHead}>
            {t("row.pupils")}
            <Line muted>{t("row.pupilsHint")}</Line>
          </TableHead>
          <TableCell className="align-top">{idleCell(null, pupils)}</TableCell>
          {candidates.map((candidate) => (
            <TableCell key={candidate.id} className="align-top">
              {idleCell(candidate, pupils)}
            </TableCell>
          ))}
        </TableRow>
        <TableRow className="hover:bg-transparent">
          <TableHead scope="row" className={rowHead}>
            <span className="sr-only">{t("row.apply")}</span>
          </TableHead>
          <TableCell />
          {candidates.map((candidate) => (
            <TableCell key={candidate.id}>
              {isApplicable(candidate) ? (
                <Button
                  size="sm"
                  variant="outline"
                  disabled={applyBlockedBy !== null}
                  aria-describedby={applyBlockedBy ?? undefined}
                  aria-label={t("apply.buttonLabel", { ordinal: candidate.ordinal, label: variantLabel(t, candidate) })}
                  onClick={() => onApply(candidate)}
                >
                  {t("apply.button")}
                </Button>
              ) : null}
            </TableCell>
          ))}
        </TableRow>
      </TableBody>
    </Table>
  );
}
