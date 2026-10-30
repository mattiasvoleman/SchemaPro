/**
 * Salslån in the generator and the room optimisation (Delade lokaler och
 * lärare): the approved loans of a year as the room reservations the engine
 * already keeps (recurring UNAVAILABLE rows on a room).
 *
 *   lent      the owner's room is closed in each approved window that meets
 *             the year, the whole year, rounded out to the grid: the owner's
 *             lessons stay out of every minute another school holds it;
 *   borrowed  the borrower's own room for the borrowed one is open only
 *             where the approved loans together cover every date of the
 *             weekday in the year (src/sharing/loan-coverage.ts, the rule the
 *             publish check and the bookings read too), rounded in to the
 *             grid, and closed everywhere else; a loan for the spring alone
 *             opens nothing, and a room with no approved loan is closed all
 *             week.
 *
 * Both are the careful side: the engine has no weeks or dates, so a lesson
 * it places runs all year, and nothing it places can meet a loan the publish
 * check or a booking would refuse. The engine rounds a reservation's ends
 * down to its grid (TimeGrid.clamp_to_grid), so the gateway rounds them
 * itself, each the way that keeps the lessons out.
 *
 * Only the school week the engine plans (Monday to Friday): it refuses a
 * reservation on any other day as input, and a lesson there is no lesson it
 * places.
 *
 * PURE.
 */

import { SLOT_MINUTES } from '../common/solver-grid';
import { coveredOnEveryDate, minutesOfClock, type CoverLoan } from '../sharing/loan-coverage';

export interface ApprovedWindow {
  /** The owner's room (lent) or the borrower's own room for it (borrowed). */
  roomId: string;
  dayOfWeek: number;
  /** 'HH:MM'. */
  startTime: string;
  endTime: string;
  /** 'YYYY-MM-DD', inclusive. */
  startDate: string;
  endDate: string;
}

export interface RoomReservation {
  roomId: string;
  dayOfWeek: number;
  /** 'HH:MM:SS'. */
  startTime: string;
  endTime: string;
}

/** The days the engine plans (its SCHEDULE_DAYS default). */
export const SCHOOL_WEEK = [1, 2, 3, 4, 5] as const;

/** The engine reads 23:59 as the end of the day (TimeGrid.clamp_to_grid). */
const DAY_END = 24 * 60;
const clockOf = (minutes: number): string =>
  minutes >= DAY_END
    ? '23:59:00'
    : `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}:00`;
const down = (minutes: number): number => Math.floor(minutes / SLOT_MINUTES) * SLOT_MINUTES;
const up = (minutes: number): number => Math.ceil(minutes / SLOT_MINUTES) * SLOT_MINUTES;
const meets = (window: ApprovedWindow, from: string, to: string): boolean => window.startDate <= to && window.endDate >= from;
const coverLoan = (window: ApprovedWindow): CoverLoan => ({
  dayOfWeek: window.dayOfWeek,
  start: minutesOfClock(window.startTime),
  end: minutesOfClock(window.endTime),
  startDate: window.startDate,
  endDate: window.endDate,
});

/** The owner's rooms, closed in the approved windows of the loans that meet [from, to], rounded out to the grid. */
export function lentReservations(windows: readonly ApprovedWindow[], from: string, to: string): RoomReservation[] {
  return windows
    .filter((window) => meets(window, from, to) && (SCHOOL_WEEK as readonly number[]).includes(window.dayOfWeek))
    .map((window) => ({
      roomId: window.roomId,
      dayOfWeek: window.dayOfWeek,
      startTime: clockOf(down(minutesOfClock(window.startTime))),
      endTime: clockOf(up(minutesOfClock(window.endTime))),
    }))
    .sort(byRoomDayStart);
}

/**
 * The borrower's own rooms, closed outside what the approved loans together
 * cover on every date of the weekday in [from, to] (the open time rounded in
 * to the grid): the gaps of each school day around it, and the whole day
 * where nothing is covered every week.
 */
export function borrowedReservations(
  localRoomIds: readonly string[],
  windows: readonly ApprovedWindow[],
  from: string,
  to: string,
): RoomReservation[] {
  const out: RoomReservation[] = [];
  for (const roomId of [...new Set(localRoomIds)].sort()) {
    const loans = windows.filter((window) => window.roomId === roomId).map(coverLoan);
    for (const day of SCHOOL_WEEK) {
      const open = coveredOnEveryDate(loans, day, from, to)
        .map(([start, end]) => [up(start), down(end)] as const)
        .filter(([start, end]) => end > start);
      let cursor = 0;
      for (const [start, end] of open) {
        if (start > cursor) out.push({ roomId, dayOfWeek: day, startTime: clockOf(cursor), endTime: clockOf(start) });
        if (end > cursor) cursor = end;
      }
      if (cursor < DAY_END) out.push({ roomId, dayOfWeek: day, startTime: clockOf(cursor), endTime: clockOf(DAY_END) });
    }
  }
  return out;
}

function byRoomDayStart(a: RoomReservation, b: RoomReservation): number {
  return a.roomId.localeCompare(b.roomId) || a.dayOfWeek - b.dayOfWeek || a.startTime.localeCompare(b.startTime);
}
