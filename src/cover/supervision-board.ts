import type { SupervisionCoverDecision } from '@prisma/client';
import { passDates, passRunsOn, passSpan, spansMeet, type PassArea, type PassRule } from '../supervision/pass-days';
import type { ClosedRange, YearBounds } from '../staffing/teaching-weeks';

/**
 * THE BOARD'S PASSES (Rastvakt i vardagen, 20261210090000): every
 * (absence, pass on a date) pair, and what has been decided about it,
 * derived when asked — as cover-board.ts derives the lessons'.
 *
 * A pair is on the board when the pass RUNS on the date (pass-days.ts: its
 * weekday, its dates, no lov closing its area, its teacher not deactivated)
 * and its teacher has an ACTIVE absence sharing a minute with it there — or
 * when a decision exists for the pass on the date. A withdrawal settles its
 * decisions in its own transaction, so a decision whose absence is no longer
 * ACTIVE is one an API from before this release left behind (a rollback, or
 * old and new containers side by side in a deploy): it is on the board with
 * `absenceActive` false and Ångra alone, never stuck where nobody sees it.
 *
 * Its status comes from the decision:
 *
 *   COVERED   SUBSTITUTE, and the vikarie is active and has no ACTIVE
 *             absence sharing a minute with the pass
 *   HANDLED   NO_COVER: left without a vikarie, on purpose
 *   OPEN      no decision — or a SUBSTITUTE whose vikarie is away or gone
 *             (`decisionStale`): a new decision replaces it in place
 *   passed    overlaid when the pass has ended: nothing can be decided
 *
 * `outsideAbsence`: a decision whose pass no longer shares a minute with its
 * own absence (the period was shortened past it, a pass already lived).
 * `runs` false: a decision on a day its pass no longer runs — a lov added
 * since, the area's årskurser changed, its teacher deactivated or the läsår
 * shortened. Nothing refuses those writes, so the board says it, and Ångra
 * tells the vikarie the pass is off. `areaName` is the area's name, read with
 * the board, so the board never needs a read of its own for it.
 *
 * The time and the area are the pass's on the date; a decision without a
 * live pair shows the occurrence it stored. No row carries a reason, a note
 * or the pass's note. PURE: the service reads the rows.
 */

export type PassStatus = 'OPEN' | 'COVERED' | 'HANDLED';

export interface PassBoardItem {
  shiftId: string;
  date: string;
  absenceId: string;
  absentTeacherId: string;
  areaId: string;
  areaName: string;
  startsAt: string;
  endsAt: string;
  decision: SupervisionCoverDecision | null;
  decidedAt: string | null;
  /** The vikarie the decision names; null without one. */
  substituteId: string | null;
  status: PassStatus;
  decisionStale: boolean;
  passed: boolean;
  outsideAbsence: boolean;
  /** Whether the pass runs on the date (its weekday, dates, lov, teacher); false only for a decision left on a day it no longer runs. */
  runs: boolean;
  /** False only for a decision whose absence is no longer ACTIVE (left by an older API): Ångra alone. */
  absenceActive: boolean;
}

export interface PassSummary {
  open: number;
  covered: number;
  handled: number;
  passedOpen: number;
}

export interface BoardAbsence {
  id: string;
  userId: string;
  startsAt: Date;
  endsAt: Date;
}

export interface BoardShift extends PassRule {
  id: string;
  academicYearId: string;
  areaId: string;
  userId: string;
}

export interface BoardCover {
  shiftId: string;
  date: string;
  areaId: string;
  startsAt: Date;
  endsAt: Date;
  absenceId: string;
  absentTeacherId: string;
  /** The period of the decision's own absence. */
  absenceStartsAt: Date;
  absenceEndsAt: Date;
  /** False when that absence is no longer ACTIVE; absent means it is. */
  absenceActive?: boolean;
  decision: SupervisionCoverDecision;
  substituteId: string | null;
  decidedAt: Date;
}

export interface PassBoardInput {
  /**
   * The dates looked at: the board's window, or null to look at each
   * absence's own days (the register's counts).
   */
  window: { from: string; to: string } | null;
  timezone: string;
  /** ACTIVE absences. */
  absences: readonly BoardAbsence[];
  /** The absent teachers' passes, and the passes the decisions name. */
  shifts: readonly BoardShift[];
  areas: ReadonlyMap<string, PassArea & { name?: string }>;
  years: ReadonlyMap<string, YearBounds>;
  /** Each year's lov, in NIOARIG. */
  closures: ReadonlyMap<string, readonly ClosedRange[]>;
  /** Decisions whose absence is ACTIVE, in the window or of the absences. */
  covers: readonly BoardCover[];
  /** Whether a vikarie is away or gone over [startsAt, endsAt). */
  vikarieAway: (substituteId: string, span: { startsAt: Date; endsAt: Date }) => boolean;
  now: Date;
}

/** The school-local dates an absence touches, first and last. */
export function absenceDates(absence: { startsAt: Date; endsAt: Date }, timezone: string): { from: string; to: string } {
  const day = (instant: Date) =>
    new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(instant);
  return { from: day(absence.startsAt), to: day(new Date(Math.max(absence.startsAt.getTime(), absence.endsAt.getTime() - 1))) };
}

const keyOf = (shiftId: string, date: string) => `${shiftId}:${date}`;

/**
 * Every pair, earliest first. One item per pass and date: two adjacent
 * absences of one teacher (one ends 10:10, the next starts there) both touch
 * a 10:00–10:20 pass, and the pair is the earlier one's; a decision keeps the
 * absence it was made under, which then names the item.
 */
export function passBoardItems(input: PassBoardInput): PassBoardItem[] {
  const live = new Map<string, { absence: BoardAbsence; shift: BoardShift; date: string; span: { startsAt: Date; endsAt: Date } }>();
  const byTeacher = new Map<string, BoardShift[]>();
  for (const shift of input.shifts) byTeacher.set(shift.userId, [...(byTeacher.get(shift.userId) ?? []), shift]);
  const absences = [...input.absences].sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime() || a.id.localeCompare(b.id));
  for (const absence of absences) {
    const days = input.window ?? absenceDates(absence, input.timezone);
    for (const shift of byTeacher.get(absence.userId) ?? []) {
      const year = input.years.get(shift.academicYearId);
      const area = input.areas.get(shift.areaId);
      if (!year || !area) continue;
      for (const date of passDates(shift, area, year, input.closures.get(shift.academicYearId) ?? [], days.from, days.to)) {
        const key = keyOf(shift.id, date);
        if (live.has(key)) continue;
        const span = passSpan(shift, date, input.timezone);
        if (spansMeet(span, absence)) live.set(key, { absence, shift, date, span });
      }
    }
  }
  const decided = new Map(input.covers.map((cover) => [keyOf(cover.shiftId, cover.date), cover]));
  const shiftById = new Map(input.shifts.map((shift) => [shift.id, shift]));
  /** A decision without a live pair: does its pass still run that day? */
  const stillRuns = (cover: BoardCover): boolean => {
    const shift = shiftById.get(cover.shiftId);
    const year = shift ? input.years.get(shift.academicYearId) : undefined;
    const area = shift ? input.areas.get(shift.areaId) : undefined;
    return Boolean(
      shift && year && area && passRunsOn(shift, area, year, input.closures.get(shift.academicYearId) ?? [], cover.date),
    );
  };
  const keys = [...new Set([...live.keys(), ...decided.keys()])];
  const items = keys.map((key): PassBoardItem => {
    const pair = live.get(key);
    const cover = decided.get(key);
    const span = pair?.span ?? { startsAt: cover!.startsAt, endsAt: cover!.endsAt };
    const stale =
      cover?.decision === 'SUBSTITUTE' && (cover.substituteId === null || input.vikarieAway(cover.substituteId, span));
    const status: PassStatus = !cover || stale ? 'OPEN' : cover.decision === 'SUBSTITUTE' ? 'COVERED' : 'HANDLED';
    return {
      shiftId: pair?.shift.id ?? cover!.shiftId,
      date: pair?.date ?? cover!.date,
      absenceId: cover?.absenceId ?? pair!.absence.id,
      absentTeacherId: cover?.absentTeacherId ?? pair!.absence.userId,
      areaId: pair?.shift.areaId ?? cover!.areaId,
      areaName: input.areas.get(pair?.shift.areaId ?? cover!.areaId)?.name ?? '',
      startsAt: span.startsAt.toISOString(),
      endsAt: span.endsAt.toISOString(),
      decision: cover?.decision ?? null,
      decidedAt: cover ? cover.decidedAt.toISOString() : null,
      substituteId: cover?.substituteId ?? null,
      status,
      decisionStale: Boolean(stale),
      passed: span.endsAt.getTime() <= input.now.getTime(),
      outsideAbsence:
        cover !== undefined && !spansMeet(span, { startsAt: cover.absenceStartsAt, endsAt: cover.absenceEndsAt }),
      runs: pair !== undefined || stillRuns(cover!),
      absenceActive: cover?.absenceActive !== false,
    };
  });
  return items.sort(
    (a, b) =>
      a.startsAt.localeCompare(b.startsAt) || a.shiftId.localeCompare(b.shiftId) || a.absentTeacherId.localeCompare(b.absentTeacherId),
  );
}

export function passSummaryOf(items: readonly PassBoardItem[]): PassSummary {
  const summary: PassSummary = { open: 0, covered: 0, handled: 0, passedOpen: 0 };
  for (const item of items) {
    if (item.status === 'OPEN') {
      if (item.passed) summary.passedOpen++;
      else summary.open++;
    } else if (item.status === 'COVERED') summary.covered++;
    else summary.handled++;
  }
  return summary;
}

