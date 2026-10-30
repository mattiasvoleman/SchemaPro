import { loanBookingRefusal, wallPieces, type LoanRow } from './loan-holds';

/**
 * A booking of an hour against the loans of the room: refused where an
 * approved window lends the room to another school, and, for the school's
 * own room for a borrowed one, wherever no approved window holds it. Read in
 * the school's wall clock, day by day.
 */

const HALL = 'a0000000-0000-4000-8000-000000000001';
const LOCAL = 'b0000000-0000-4000-8000-000000000002';
const TZ = 'Europe/Stockholm';

const loan = (patch: Partial<LoanRow>): LoanRow => ({
  status: 'APPROVED',
  roomId: HALL,
  localRoomId: LOCAL,
  dayOfWeek: 2,
  startTime: '10:00',
  endTime: '11:30',
  startDate: '2030-08-19',
  endDate: '2031-06-13',
  ...patch,
});

// 2030-09-03 is a Tuesday; Stockholm is UTC+2 in September.
const at = (local: string) => new Date(`${local}+02:00`);

describe('wallPieces', () => {
  it('reads a booking in the school’s wall clock, and across midnight as two days', () => {
    expect(wallPieces(at('2030-09-03T10:00:00'), at('2030-09-03T11:00:00'), TZ)).toEqual([
      { date: '2030-09-03', weekday: 2, start: 600, end: 660 },
    ]);
    expect(wallPieces(at('2030-09-03T23:00:00'), at('2030-09-04T01:00:00'), TZ)).toEqual([
      { date: '2030-09-03', weekday: 2, start: 1380, end: 1440 },
      { date: '2030-09-04', weekday: 3, start: 0, end: 60 },
    ]);
  });
});

describe('loanBookingRefusal', () => {
  it('refuses the owner a booking that meets an approved window, and not beside it', () => {
    const loans = [loan({})];
    expect(loanBookingRefusal(loans, HALL, at('2030-09-03T11:00:00'), at('2030-09-03T12:00:00'), TZ)).toBe('ROOM_LENT');
    expect(loanBookingRefusal(loans, HALL, at('2030-09-03T11:30:00'), at('2030-09-03T12:30:00'), TZ)).toBeNull();
    // A Wednesday, a date after the loan, and a loan that is only asked for.
    expect(loanBookingRefusal(loans, HALL, at('2030-09-04T10:00:00'), at('2030-09-04T11:00:00'), TZ)).toBeNull();
    expect(loanBookingRefusal(loans, HALL, at('2031-06-17T10:00:00'), at('2031-06-17T11:00:00'), TZ)).toBeNull();
    expect(loanBookingRefusal([loan({ status: 'PENDING' })], HALL, at('2030-09-03T10:00:00'), at('2030-09-03T11:00:00'), TZ)).toBeNull();
  });

  it('lets the borrower book its room inside an approved window only', () => {
    const loans = [loan({})];
    expect(loanBookingRefusal(loans, LOCAL, at('2030-09-03T10:00:00'), at('2030-09-03T11:30:00'), TZ)).toBeNull();
    expect(loanBookingRefusal(loans, LOCAL, at('2030-09-03T09:45:00'), at('2030-09-03T11:00:00'), TZ)).toBe('ROOM_BORROWED_OUTSIDE_LOAN');
    expect(loanBookingRefusal(loans, LOCAL, at('2030-09-04T10:00:00'), at('2030-09-04T11:00:00'), TZ)).toBe('ROOM_BORROWED_OUTSIDE_LOAN');
    // Only a pending loan: the room holds nothing yet.
    expect(loanBookingRefusal([loan({ status: 'PENDING' })], LOCAL, at('2030-09-03T10:00:00'), at('2030-09-03T11:00:00'), TZ)).toBe(
      'ROOM_BORROWED_OUTSIDE_LOAN',
    );
  });

  it('refuses nothing in a room no loan names', () => {
    expect(loanBookingRefusal([loan({})], 'c0000000-0000-4000-8000-000000000003', at('2030-09-03T10:00:00'), at('2030-09-03T11:00:00'), TZ)).toBeNull();
    expect(loanBookingRefusal([], HALL, at('2030-09-03T10:00:00'), at('2030-09-03T11:00:00'), TZ)).toBeNull();
  });

  it('reads a request not yet approved, which has no room of the borrower\'s, as holding nothing', () => {
    const waiting = [loan({ status: 'PENDING', localRoomId: null })];
    expect(loanBookingRefusal(waiting, LOCAL, at('2030-09-04T10:00:00'), at('2030-09-04T11:00:00'), TZ)).toBeNull();
    expect(loanBookingRefusal(waiting, HALL, at('2030-09-03T10:00:00'), at('2030-09-03T11:00:00'), TZ)).toBeNull();
  });
});
