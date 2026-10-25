import type { SupervisionCoverDecision } from '@prisma/client';
import { passDates, passSpan, spansMeet, type PassArea, type PassRule } from '../supervision/pass-days';
import type { ClosedRange, YearBounds } from '../staffing/teaching-weeks';

/**
 * THE BOARD'S PASSES (Rastvakt i vardagen, 20261210090000): every
 * (absence, pass on a date) pair, and what has been decided about it,
 * derived when asked — as cover-board.ts derives the lessons'.
 *
 * A pair is on the board when the pass RUNS on the date (pass-days.ts: its
 * weekday, its dates, no lov closing its area, its teacher not deactivated)
 * and its teacher has an ACTIVE absence sharing a minute with it there — or
 * when a decision exists for the pass on the date whose absence is ACTIVE (a
 * decision of a withdrawn absence is not read; the withdrawal settled it).
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
  /** The period of the decision's own absence (ACTIVE: the reader drops the rest). */
  absenceStartsAt: Date;
  absenceEndsAt: Date;
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
  areas: ReadonlyMap<string, PassArea>;
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

/** Every pair, earliest first. */
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

