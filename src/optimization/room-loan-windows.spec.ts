import { borrowedReservations, lentReservations, type ApprovedWindow } from './room-loan-windows';

/**
 * Salslån as the room reservations the engine keeps: the owner's room
 * closed in the approved windows, the borrower's own room closed around
 * them and on every school day none holds, and nothing on a weekend.
 */

const HALL = 'a0000000-0000-4000-8000-000000000001';
const LOCAL = 'b0000000-0000-4000-8000-000000000002';

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
});

describe('borrowedReservations', () => {
  it('closes the borrower’s room around the window, and every other school day whole', () => {
    const rows = borrowedReservations([LOCAL], [window({ roomId: LOCAL })], '2030-08-01', '2031-07-31');
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
      '2030-08-01',
      '2031-07-31',
    ).filter((row) => row.dayOfWeek === 2);
    expect(rows.map((row) => `${row.startTime}-${row.endTime}`)).toEqual(['00:00:00-08:00:00', '10:00:00-13:00:00', '14:00:00-23:59:00']);
  });

  it('closes a room with no approved window of the year all week', () => {
    const rows = borrowedReservations([LOCAL], [window({ roomId: LOCAL, startDate: '2029-08-20', endDate: '2030-06-14' })], '2030-08-01', '2031-07-31');
    expect(rows).toHaveLength(5);
    expect(rows.every((row) => row.startTime === '00:00:00' && row.endTime === '23:59:00')).toBe(true);
  });

  it('reads only the room’s own windows', () => {
    const rows = borrowedReservations([LOCAL], [window({})], '2030-08-01', '2031-07-31');
    expect(rows).toHaveLength(5);
  });
});
