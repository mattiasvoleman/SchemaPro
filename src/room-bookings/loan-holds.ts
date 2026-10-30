/**
 * Salslån and the school's own room bookings (Delade lokaler och lärare): a
 * loan holds a room at weekly times, and a booking of an hour must not take
 * what the loan gives another school, or what it does not give this one.
 *
 *   ROOM_LENT                     the room is lent to another school, and an
 *                                 approved window holds part of the booking;
 *   ROOM_BORROWED_OUTSIDE_LOAN    the room is the school's own for a
 *                                 borrowed one, and some part of the booking
 *                                 is outside every approved window.
 *
 * The windows are the school's wall clock (TIME and DATE columns), the
 * booking two instants: the booking is read in the school's time zone, day
 * by day, so a booking across midnight is judged on both days.
 *
 * PURE.
 */

export interface LoanRow {
  status: string;
  roomId: string;
  /** The borrower's room for the loan; none until the owner approves it. */
  localRoomId: string | null;
  dayOfWeek: number;
  /** 'HH:MM'. */
  startTime: string;
  endTime: string;
  /** 'YYYY-MM-DD', inclusive. */
  startDate: string;
  endDate: string;
}

export type LoanBookingRefusal = 'ROOM_LENT' | 'ROOM_BORROWED_OUTSIDE_LOAN';

interface WallPiece {
  date: string;
  weekday: number;
  start: number;
  end: number;
}

const WEEKDAYS: Record<string, number> = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };

function wall(instant: Date, timeZone: string): { date: string; weekday: number; minutes: number } {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-GB', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      weekday: 'short',
      hourCycle: 'h23',
    })
      .formatToParts(instant)
      .map((part) => [part.type, part.value]),
  );
  return {
    date: `${parts['year']}-${parts['month']}-${parts['day']}`,
    weekday: WEEKDAYS[parts['weekday'] ?? ''] ?? 0,
    minutes: Number(parts['hour']) * 60 + Number(parts['minute']),
  };
}

function nextDate(date: string): string {
  const next = new Date(`${date}T00:00:00Z`);
  next.setUTCDate(next.getUTCDate() + 1);
  return next.toISOString().slice(0, 10);
}

/** The booking as wall-clock pieces, one per date it touches. */
export function wallPieces(startsAt: Date, endsAt: Date, timeZone: string): WallPiece[] {
  const from = wall(startsAt, timeZone);
  const to = wall(endsAt, timeZone);
  const pieces: WallPiece[] = [];
  let date = from.date;
  let weekday = from.weekday;
  // At most a fortnight of pieces: a booking is hours, and this is no loop
  // a malformed pair may run away in.
  for (let i = 0; i < 15 && date <= to.date; i++) {
    const start = date === from.date ? from.minutes : 0;
    const end = date === to.date ? to.minutes : 24 * 60;
    if (end > start) pieces.push({ date, weekday, start, end });
    date = nextDate(date);
    weekday = (weekday % 7) + 1;
  }
  return pieces;
}

const minutesOf = (time: string): number => Number(time.slice(0, 2)) * 60 + Number(time.slice(3, 5));

export function loanBookingRefusal(
  loans: readonly LoanRow[],
  roomId: string,
  startsAt: Date,
  endsAt: Date,
  timeZone: string,
): LoanBookingRefusal | null {
  const pieces = wallPieces(startsAt, endsAt, timeZone);
  const approved = loans.filter((loan) => loan.status === 'APPROVED');
  const covers = (loan: LoanRow, piece: WallPiece) =>
    loan.dayOfWeek === piece.weekday && loan.startDate <= piece.date && piece.date <= loan.endDate;

  const lent = approved.filter((loan) => loan.roomId === roomId);
  for (const piece of pieces) {
    if (lent.some((loan) => covers(loan, piece) && minutesOf(loan.startTime) < piece.end && piece.start < minutesOf(loan.endTime))) {
      return 'ROOM_LENT';
    }
  }
  if (loans.some((loan) => loan.localRoomId === roomId)) {
    const held = approved.filter((loan) => loan.localRoomId === roomId);
    for (const piece of pieces) {
      if (!held.some((loan) => covers(loan, piece) && minutesOf(loan.startTime) <= piece.start && piece.end <= minutesOf(loan.endTime))) {
        return 'ROOM_BORROWED_OUTSIDE_LOAN';
      }
    }
  }
  return null;
}
