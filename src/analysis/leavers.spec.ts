import type { LoadDuty } from '../staffing/teacher-load';
import { coverStands, cutDuties, leaversOf, leftBy, lessonDays, type Leaver } from './leavers';

const STOCKHOLM = (at: Date): string =>
  new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Stockholm', year: 'numeric', month: '2-digit', day: '2-digit' }).format(at);

const anna = (isoUtc: string): Leaver => ({ userId: 'anna', at: new Date(isoUtc), day: STOCKHOLM(new Date(isoUtc)) });

describe('leaversOf', () => {
  it('takes the people with a stamp, dated by the school\'s day, and nobody without one', () => {
    const found = leaversOf(
      [
        { id: 'a', deactivatedAt: new Date('2026-10-15T10:00:00.000Z') },
        { id: 'b', deactivatedAt: null },
        { id: 'c', deactivatedAt: new Date('2026-10-15T22:30:00.000Z') },
      ],
      STOCKHOLM,
    );
    expect([...found.keys()]).toEqual(['a', 'c']);
    expect(found.get('a')).toEqual({ userId: 'a', at: new Date('2026-10-15T10:00:00.000Z'), day: '2026-10-15' });
    // 00:30 on the 16th in Stockholm: the school's day, not UTC's.
    expect(found.get('c')!.day).toBe('2026-10-16');
  });
});

describe('leftBy and lessonDays', () => {
  const leaver = anna('2026-10-15T10:00:00.000Z');

  it('reaches a period that ends on or after the day they left, and not one that ends before', () => {
    expect(leftBy(leaver, '2026-10-14')).toBe(false);
    expect(leftBy(leaver, '2026-10-15')).toBe(true);
    expect(leftBy(leaver, '2026-10-23')).toBe(true);
  });

  it('asks for the days up to and including the day they left, and for none when they left before the period', () => {
    expect(lessonDays(leaver, '2026-10-12', '2026-10-23')).toEqual({ from: '2026-10-12', to: '2026-10-15' });
    expect(lessonDays(leaver, '2026-10-12', '2026-10-15')).toEqual({ from: '2026-10-12', to: '2026-10-15' });
    expect(lessonDays(leaver, '2026-10-15', '2026-10-23')).toEqual({ from: '2026-10-15', to: '2026-10-15' });
    expect(lessonDays(leaver, '2026-10-16', '2026-10-23')).toBeNull();
  });
});

describe('cutDuties', () => {
  const leavers = new Map([['anna', anna('2026-10-15T10:00:00.000Z')]]);
  const duty = (overrides: Partial<LoadDuty> = {}): LoadDuty => ({ userId: 'anna', minutesPerWeek: 60, countsAsTeaching: false, ...overrides });

  it('ends a leaver\'s uppdrag the day before the day they left, whether it had an end or not', () => {
    expect(cutDuties([duty()], leavers, '2027-06-11')).toEqual([duty({ validTo: '2026-10-14' })]);
    expect(cutDuties([duty({ validTo: '2027-01-31' })], leavers, '2027-06-11')).toEqual([duty({ validTo: '2026-10-14' })]);
  });

  it('keeps an uppdrag that already ended earlier, someone else\'s, and a rastvakt cut the same day', () => {
    const earlier = duty({ validTo: '2026-09-30' });
    const sameDay = duty({ validTo: '2026-10-14' });
    const other = duty({ userId: 'bo' });
    const result = cutDuties([earlier, sameDay, other], leavers, '2027-06-11');
    expect(result).toEqual([earlier, sameDay, other]);
    expect(result[2]).toBe(other);
  });

  it('does not touch the list for a school where nobody has left', () => {
    const duties = [duty(), duty({ userId: 'bo' })];
    expect(cutDuties(duties, new Map(), '2027-06-11')).toEqual(duties);
  });
});

describe('coverStands', () => {
  const leavers = new Map([['dan', anna('2026-10-15T10:00:00.000Z')]]);

  it('counts a cover over by the stamp, to the millisecond, and drops one that ended after it', () => {
    expect(coverStands({ userId: 'dan', endsAt: '2026-10-15T09:00:00.000Z' }, leavers)).toBe(true);
    expect(coverStands({ userId: 'dan', endsAt: '2026-10-15T10:00:00.000Z' }, leavers)).toBe(true);
    expect(coverStands({ userId: 'dan', endsAt: '2026-10-15T10:00:00.001Z' }, leavers)).toBe(false);
    expect(coverStands({ userId: 'dan', endsAt: '2026-10-19T09:00:00.000Z' }, leavers)).toBe(false);
  });

  it('counts everyone else\'s', () => {
    expect(coverStands({ userId: 'cy', endsAt: '2026-10-19T09:00:00.000Z' }, leavers)).toBe(true);
  });
});
