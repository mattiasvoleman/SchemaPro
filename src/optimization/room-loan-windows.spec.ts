import { borrowedReservations, lentReservations, type ApprovedWindow } from './room-loan-windows';

/**
 * Salslån as the room reservations the engine keeps: the owner's room
 * closed in the approved windows, rounded out to the grid; the borrower's
 * own room open only where the approved loans together cover every date of
 * the weekday in the year, rounded in, and closed everywhere else; nothing
 * on a weekend.
 */

const HALL = 'a0000000-0000-4000-8000-000000000001';
const LOCAL = 'b0000000-0000-4000-8000-000000000002';

// The year the loans run: every Tuesday of it is a date of the loan.
const FROM = '2030-08-19';
const TO = '2031-06-13';

const window = (patch: Partial<ApprovedWindow>): ApprovedWindow => ({
  roomId: HALL,
  dayOfWeek: 2,
  startTime: '10:00',
  endTime: '11:30',
  startDate: '2030-08-19',
  endDate: '2031-06-13',
  ...patch,
});

describe('lentReservations', () => {
  it('closes the owner’s room in each approved window that meets the year', () => {
    expect(lentReservations([window({}), window({ dayOfWeek: 4, startTime: '13:00', endTime: '14:00' })], '2030-08-01', '2031-07-31')).toEqual([
      { roomId: HALL, dayOfWeek: 2, startTime: '10:00:00', endTime: '11:30:00' },
      { roomId: HALL, dayOfWeek: 4, startTime: '13:00:00', endTime: '14:00:00' },
    ]);
  });

  it('leaves out a loan of another year, and a window on a weekend', () => {
    expect(lentReservations([window({ startDate: '2031-08-18', endDate: '2032-06-11' })], '2030-08-01', '2031-07-31')).toEqual([]);
    expect(lentReservations([window({ dayOfWeek: 6 })], '2030-08-01', '2031-07-31')).toEqual([]);
  });

  it('closes a window off the grid out to it, so no lesson starts in its last minutes', () => {
    expect(lentReservations([window({ startTime: '10:07', endTime: '11:22' })], FROM, TO)).toEqual([
      { roomId: HALL, dayOfWeek: 2, startTime: '10:05:00', endTime: '11:25:00' },
    ]);
    expect(lentReservations([window({ startTime: '23:00', endTime: '23:58' })], FROM, TO)[0]?.endTime).toBe('23:59:00');
  });
});

describe('borrowedReservations', () => {
  it('closes the borrower’s room around the window, and every other school day whole', () => {
    const rows = borrowedReservations([LOCAL], [window({ roomId: LOCAL })], FROM, TO);
    expect(rows).toEqual([
      { roomId: LOCAL, dayOfWeek: 1, startTime: '00:00:00', endTime: '23:59:00' },
      { roomId: LOCAL, dayOfWeek: 2, startTime: '00:00:00', endTime: '10:00:00' },
      { roomId: LOCAL, dayOfWeek: 2, startTime: '11:30:00', endTime: '23:59:00' },
      { roomId: LOCAL, dayOfWeek: 3, startTime: '00:00:00', endTime: '23:59:00' },
      { roomId: LOCAL, dayOfWeek: 4, startTime: '00:00:00', endTime: '23:59:00' },
      { roomId: LOCAL, dayOfWeek: 5, startTime: '00:00:00', endTime: '23:59:00' },
    ]);
  });

  it('leaves the gap between two windows of a day closed, and windows that meet open', () => {
    const rows = borrowedReservations(
      [LOCAL],
      [
        window({ roomId: LOCAL, startTime: '08:00', endTime: '09:00' }),
        window({ roomId: LOCAL, startTime: '09:00', endTime: '10:00' }),
        window({ roomId: LOCAL, startTime: '13:00', endTime: '14:00' }),
      ],
      FROM,
      TO,
    ).filter((row) => row.dayOfWeek === 2);
    expect(rows.map((row) => `${row.startTime}-${row.endTime}`)).toEqual(['00:00:00-08:00:00', '10:00:00-13:00:00', '14:00:00-23:59:00']);
  });

  it('closes a room with no approved window of the year all week', () => {
    const rows = borrowedReservations([LOCAL], [window({ roomId: LOCAL, startDate: '2029-08-20', endDate: '2030-06-14' })], '2030-08-01', '2031-07-31');
    expect(rows).toHaveLength(5);
    expect(rows.every((row) => row.startTime === '00:00:00' && row.endTime === '23:59:00')).toBe(true);
  });

  it('reads only the room’s own windows', () => {
    const rows = borrowedReservations([LOCAL], [window({})], FROM, TO);
    expect(rows).toHaveLength(5);
  });

  const tuesday = (rows: ReturnType<typeof borrowedReservations>) =>
    rows.filter((row) => row.dayOfWeek === 2).map((row) => `${row.startTime}-${row.endTime}`);

  it('opens nothing for a loan of the spring alone: the plan holds the lesson all year', () => {
    expect(tuesday(borrowedReservations([LOCAL], [window({ roomId: LOCAL, startDate: '2031-01-07' })], FROM, TO))).toEqual([
      '00:00:00-23:59:00',
    ]);
    // Nor for a year that starts a Tuesday before the loan does.
    expect(tuesday(borrowedReservations([LOCAL], [window({ roomId: LOCAL })], '2030-08-12', TO))).toEqual(['00:00:00-23:59:00']);
  });

  it('opens a window an autumn loan and a spring loan cover together, and two windows side by side as one', () => {
    const terms = [
      window({ roomId: LOCAL, endDate: '2030-12-20' }),
      window({ roomId: LOCAL, startDate: '2030-12-21' }),
    ];
    expect(tuesday(borrowedReservations([LOCAL], terms, FROM, TO))).toEqual(['00:00:00-10:00:00', '11:30:00-23:59:00']);
    // A gap of a week between the terms closes it.
    const gap = [window({ roomId: LOCAL, endDate: '2030-12-20' }), window({ roomId: LOCAL, startDate: '2031-01-08' })];
    expect(tuesday(borrowedReservations([LOCAL], gap, FROM, TO))).toEqual(['00:00:00-23:59:00']);
    // The autumn 10–11, the spring 10–12: 10–11 is covered every week.
    const narrower = [
      window({ roomId: LOCAL, endTime: '11:00', endDate: '2030-12-20' }),
      window({ roomId: LOCAL, endTime: '12:00', startDate: '2030-12-21' }),
    ];
    expect(tuesday(borrowedReservations([LOCAL], narrower, FROM, TO))).toEqual(['00:00:00-10:00:00', '11:00:00-23:59:00']);
  });

  it('opens a window off the grid in to it, so no lesson starts or ends outside the loan', () => {
    expect(tuesday(borrowedReservations([LOCAL], [window({ roomId: LOCAL, startTime: '10:07', endTime: '11:22' })], FROM, TO))).toEqual([
      '00:00:00-10:10:00',
      '11:20:00-23:59:00',
    ]);
  });
});
