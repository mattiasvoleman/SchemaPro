/**
 * Salslån in the generator and the room optimisation (Delade lokaler och
 * lärare): the approved loans of a year as the room reservations the engine
 * already keeps (recurring UNAVAILABLE rows on a room).
 *
 *   lent      the owner's room is closed in each approved window that meets
 *             the year, so its own lessons stay out of the times another
 *             school holds it;
 *   borrowed  the borrower's own room for the borrowed one is closed outside
 *             the approved windows that meet the year, and every school day
 *             no window holds, so its lessons go only where the loan reaches.
 *             A room with no approved window is closed all week.
 *
 * Only the school week the engine plans (Monday to Friday): it refuses a
 * reservation on any other day as input, and a lesson there is no lesson it
 * places. The engine has no weeks: a window that holds the room from January
 * holds it for the whole year in the plan, conservatively, as a locked lesson
 * does; the publish check (PUB_OTHER_SCHOOL) reads the dates.
 *
 * PURE.
 */

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

const DAY_START = '00:00:00';
/** The engine reads 23:59 as the end of the day (TimeGrid.clamp_to_grid). */
const DAY_END = '23:59:00';
const clock = (time: string): string => (time.length === 5 ? `${time}:00` : time);
const meets = (window: ApprovedWindow, from: string, to: string): boolean => window.startDate <= to && window.endDate >= from;

/** The owner's rooms, closed in the approved windows of the loans that meet [from, to]. */
export function lentReservations(windows: readonly ApprovedWindow[], from: string, to: string): RoomReservation[] {
  return windows
    .filter((window) => meets(window, from, to) && (SCHOOL_WEEK as readonly number[]).includes(window.dayOfWeek))
    .map((window) => ({ roomId: window.roomId, dayOfWeek: window.dayOfWeek, startTime: clock(window.startTime), endTime: clock(window.endTime) }))
    .sort(byRoomDayStart);
}

/**
 * The borrower's own rooms, closed outside the approved windows that meet
 * [from, to]: the gaps of each school day around the windows, merged where
 * they overlap, and the whole day where none is.
 */
export function borrowedReservations(
  localRoomIds: readonly string[],
  windows: readonly ApprovedWindow[],
  from: string,
  to: string,
): RoomReservation[] {
  const out: RoomReservation[] = [];
  for (const roomId of [...new Set(localRoomIds)].sort()) {
    for (const day of SCHOOL_WEEK) {
      const open = windows
        .filter((window) => window.roomId === roomId && window.dayOfWeek === day && meets(window, from, to))
        .map((window) => [clock(window.startTime), clock(window.endTime)] as const)
        .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
      let cursor = DAY_START;
      for (const [start, end] of open) {
        if (start > cursor) out.push({ roomId, dayOfWeek: day, startTime: cursor, endTime: start });
        if (end > cursor) cursor = end;
      }
      if (cursor < DAY_END) out.push({ roomId, dayOfWeek: day, startTime: cursor, endTime: DAY_END });
    }
  }
  return out;
}

function byRoomDayStart(a: RoomReservation, b: RoomReservation): number {
  return a.roomId.localeCompare(b.roomId) || a.dayOfWeek - b.dayOfWeek || a.startTime.localeCompare(b.startTime);
}
