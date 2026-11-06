import { zonedTimeToUtc } from '../common/utils/time';
import type { PersonDay } from '../cover/cover-rules';
import { clipToDay, ROOM_RULES, roomFindings, TEACHER_RULES, teacherFreedom, wallClockMinutes, type RoomDay } from './school-day-rules';

const TZ = 'Europe/Stockholm';
const at = (time: string, date = '2027-03-29') => zonedTimeToUtc(date, time, TZ).getTime();
const span = (from: string, to: string, date?: string) => ({ start: at(from, date), end: at(to, date) });

const room = (overrides: Partial<RoomDay> = {}): RoomDay => ({ roomId: 'r', lessons: [], bookings: [], closures: [], ...overrides });
const person = (overrides: Partial<PersonDay> = {}): PersonDay => ({
  userId: 't',
  isActiveTeacher: true,
  lessons: [],
  closures: [],
  preferredFree: [],
  bookings: [],
  absences: [],
  lunch: null,
  minDailyRestMinutes: null,
  pool: { member: false, hasEmployment: false, windows: [] },
  ...overrides,
});

describe('roomFindings', () => {
  const lesson = (status: 'SCHEDULED' | 'CANCELLED' | 'COMPLETED' | 'RESCHEDULED', from = '10:00', to = '11:00') => ({ id: 'l', ...span(from, to), status });

  it('is free when nothing uses, holds or closes it, and touching is free', () => {
    expect(roomFindings(room(), span('10:00', '11:00'))).toEqual([]);
    expect(roomFindings(room({ lessons: [lesson('SCHEDULED', '09:00', '10:00')] }), span('10:00', '11:00'))).toEqual([]);
    expect(roomFindings(room({ bookings: [span('11:00', '12:00')] }), span('10:00', '11:00'))).toEqual([]);
  });

  it('is in use by a lesson that holds its time, but not by a cancelled or moved one', () => {
    expect(roomFindings(room({ lessons: [lesson('SCHEDULED')] }), span('10:30', '10:45'))).toEqual(['ROOM_IN_USE']);
    expect(roomFindings(room({ lessons: [lesson('COMPLETED')] }), span('10:30', '10:45'))).toEqual(['ROOM_IN_USE']);
    expect(roomFindings(room({ lessons: [lesson('CANCELLED')] }), span('10:30', '10:45'))).toEqual([]);
    expect(roomFindings(room({ lessons: [lesson('RESCHEDULED')] }), span('10:30', '10:45'))).toEqual([]);
  });

  it('names each reason once, in the order of the header', () => {
    const busy = room({ lessons: [lesson('SCHEDULED'), lesson('SCHEDULED')], bookings: [span('10:00', '12:00'), span('10:15', '10:30')], closures: [span('09:00', '12:00')] });
    expect(roomFindings(busy, span('10:00', '11:00'))).toEqual(['ROOM_IN_USE', 'ROOM_BOOKED', 'ROOM_CLOSED']);
    expect(ROOM_RULES).toEqual(['ROOM_IN_USE', 'ROOM_BOOKED', 'ROOM_CLOSED']);
  });
});

describe('teacherFreedom', () => {
  it('is free when no rule of occupied finds anything', () => {
    expect(teacherFreedom(person(), span('10:00', '11:00'))).toEqual({ free: true, reasons: [] });
  });

  it('names the Vikarietavla rule that says not free', () => {
    expect(teacherFreedom(person({ absences: [span('08:00', '17:00')] }), span('10:00', '11:00'))).toEqual({ free: false, reasons: ['ABSENT'] });
    expect(teacherFreedom(person({ closures: [{ span: span('10:30', '12:00'), kind: 'DUTY', label: 'Mentor' }] }), span('10:00', '11:00'))).toEqual({
      free: false,
      reasons: ['BUSY_DUTY'],
    });
    expect(teacherFreedom(person({ bookings: [span('10:00', '11:00')] }), span('10:00', '11:00')).reasons).toEqual(['BOOKED_ROOM']);
  });

  it('leaves out a pool member who has no declared window over the interval, and takes one who has', () => {
    const member = (windows: Array<{ start: number; end: number }>) => person({ pool: { member: true, hasEmployment: false, windows } });
    expect(teacherFreedom(member([]), span('10:00', '11:00'))).toEqual({ free: false, reasons: ['POOL_NOT_DECLARED'] });
    expect(teacherFreedom(member([span('09:00', '12:00')]), span('10:00', '11:00'))).toEqual({ free: true, reasons: [] });
  });

  it('keeps a pool reason beside another, and lists the rules in the order they are asked', () => {
    const both = person({ absences: [span('08:00', '17:00')], pool: { member: true, hasEmployment: false, windows: [] } });
    expect(teacherFreedom(both, span('10:00', '11:00')).reasons).toEqual(['ABSENT', 'POOL_NOT_DECLARED']);
    expect(TEACHER_RULES).toEqual(['ABSENT', 'BUSY_LESSON', 'BUSY_SUPERVISION', 'BUSY_DUTY', 'UNAVAILABLE', 'BOOKED_ROOM', 'POOL_NOT_DECLARED']);
  });
});

describe('wallClockMinutes', () => {
  const clock = wallClockMinutes(TZ);

  it('reads 08:15 as 495 on both sides of the change to summer time', () => {
    // 2027-03-28 is the Sunday the clocks go forward: Monday 22 March is CET (UTC+1), Monday 29 is CEST (UTC+2).
    expect(clock(Date.parse('2027-03-22T07:15:00Z'))).toBe(495);
    expect(clock(Date.parse('2027-03-29T06:15:00Z'))).toBe(495);
    // And back: the clocks go back on Sunday 31 October, so Monday 25 October is still CEST and Monday 1 November CET.
    expect(clock(Date.parse('2027-10-25T06:15:00Z'))).toBe(495);
    expect(clock(Date.parse('2027-11-01T07:15:00Z'))).toBe(495);
  });

  it('reads midnight as 0 and caches by instant', () => {
    expect(clock(at('00:00', '2027-03-30'))).toBe(0);
    expect(clock(at('23:59', '2027-03-30'))).toBe(23 * 60 + 59);
    expect(clock(at('23:59', '2027-03-30'))).toBe(23 * 60 + 59);
  });
});

describe('clipToDay', () => {
  const clock = wallClockMinutes(TZ);
  const day = (date: string) => ({ start: at('00:00', date), end: at('00:00', nextDay(date)) });
  const nextDay = (date: string) => new Date(Date.parse(`${date}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);

  it('clips a span that runs over midnight to each day, and reads the next midnight as 24:00', () => {
    const night = { start: at('22:00', '2027-03-26'), end: at('08:30', '2027-03-27') };
    expect(clipToDay(night, day('2027-03-26'), clock)).toEqual({ start: 22 * 60, end: 1440 });
    expect(clipToDay(night, day('2027-03-27'), clock)).toEqual({ start: 0, end: 8 * 60 + 30 });
    expect(clipToDay(night, day('2027-03-28'), clock)).toBeNull();
  });

  it('draws an absence over the 23-hour Sunday of the clock change as the whole day', () => {
    const absence = { start: at('12:00', '2027-03-26'), end: at('10:00', '2027-03-29') };
    expect(clipToDay(absence, day('2027-03-28'), clock)).toEqual({ start: 0, end: 1440 });
    expect(clipToDay(absence, day('2027-03-29'), clock)).toEqual({ start: 0, end: 600 });
  });

  it('touching a day is not being in it', () => {
    expect(clipToDay({ start: at('00:00', '2027-03-30'), end: at('01:00', '2027-03-30') }, day('2027-03-29'), clock)).toBeNull();
  });
});
