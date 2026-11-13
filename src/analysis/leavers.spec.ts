import type { LoadDuty } from '../staffing/teacher-load';
import { awayAllPeriod, awayAt, awayInstants, coverStands, cutDuties, leaversOf, touches, type Leaver } from './leavers';

const STOCKHOLM = (at: Date): string =>
  new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Stockholm', year: 'numeric', month: '2-digit', day: '2-digit' }).format(at);

const row = (userId: string, startsAt: string, endsAt: string | null) => ({
  userId,
  startsAt: new Date(startsAt),
  endsAt: endsAt === null ? null : new Date(endsAt),
});
const person = (userId: string, ...periods: [string, string | null][]): Leaver =>
  leaversOf(
    periods.map(([from, to]) => row(userId, from, to)),
    STOCKHOLM,
  ).get(userId)!;

/** Anna left 15 October 12:00 (Stockholm), and is still away. */
const LEFT = '2026-10-15T10:00:00.000Z';
/** Anna came back on 20 October at 08:00 (Stockholm). */
const BACK = '2026-10-20T06:00:00.000Z';

describe('leaversOf', () => {
  it('takes the people with a period, each period dated by the school\'s day, and nobody without one', () => {
    const found = leaversOf([row('a', LEFT, null), row('c', '2026-10-15T22:30:00.000Z', BACK)], STOCKHOLM);
    expect([...found.keys()]).toEqual(['a', 'c']);
    expect(found.get('a')).toEqual({
      userId: 'a',
      periods: [{ from: new Date(LEFT), to: null, fromDay: '2026-10-15', toDay: null }],
    });
    // 00:30 on the 16th in Stockholm: the school's day, not UTC's, and the same for the end of a period.
    expect(found.get('c')!.periods[0]).toMatchObject({ fromDay: '2026-10-16', toDay: '2026-10-20' });
    expect(found.get('nobody')).toBeUndefined();
  });

  it('puts a person\'s periods in order, whatever order the rows came in', () => {
    const found = leaversOf([row('a', '2026-11-02T09:00:00.000Z', null), row('a', LEFT, BACK)], STOCKHOLM);
    expect(found.get('a')!.periods.map((period) => period.fromDay)).toEqual(['2026-10-15', '2026-11-02']);
  });
});

describe('awayAt', () => {
  const anna = person('anna', [LEFT, BACK]);

  it('is true strictly inside a period, and false at the instant they left and at the instant they returned', () => {
    expect(awayAt(anna, new Date('2026-10-15T09:59:59.999Z'))).toBe(false);
    expect(awayAt(anna, new Date(LEFT))).toBe(false);
    expect(awayAt(anna, new Date('2026-10-15T10:00:00.001Z'))).toBe(true);
    expect(awayAt(anna, new Date('2026-10-18T09:00:00.000Z'))).toBe(true);
    expect(awayAt(anna, new Date('2026-10-20T05:59:59.999Z'))).toBe(true);
    expect(awayAt(anna, new Date(BACK))).toBe(false);
    expect(awayAt(anna, new Date('2026-10-20T09:00:00.000Z'))).toBe(false);
  });

  it('is true for ever after the start of a period with no end', () => {
    const gone = person('gone', [LEFT, null]);
    expect(awayAt(gone, new Date(LEFT))).toBe(false);
    expect(awayAt(gone, new Date('2027-05-01T09:00:00.000Z'))).toBe(true);
  });

  it('judges every period of a person who left twice', () => {
    const twice = person('twice', [LEFT, BACK], ['2026-11-02T09:00:00.000Z', null]);
    expect(awayAt(twice, new Date('2026-10-17T09:00:00.000Z'))).toBe(true);
    expect(awayAt(twice, new Date('2026-10-27T09:00:00.000Z'))).toBe(false);
    expect(awayAt(twice, new Date('2026-11-03T09:00:00.000Z'))).toBe(true);
  });
});

describe('touches and awayAllPeriod', () => {
  const left = person('anna', [LEFT, null]);
  const away = person('anna', [LEFT, BACK]);

  it('reaches a payroll period that ends on or after the day they left, and not one that ends before', () => {
    expect(touches(left, '2026-10-05', '2026-10-14')).toBe(false);
    expect(touches(left, '2026-10-05', '2026-10-15')).toBe(true);
    expect(touches(left, '2026-10-12', '2026-10-23')).toBe(true);
    expect(touches(left, '2027-01-01', '2027-01-31')).toBe(true);
  });

  it('reaches a person who came back only for the periods that hold a day of their time away', () => {
    expect(touches(away, '2026-10-05', '2026-10-14')).toBe(false);
    expect(touches(away, '2026-10-12', '2026-10-23')).toBe(true);
    expect(touches(away, '2026-10-17', '2026-10-18')).toBe(true);
    // The day they came back is a day of the period they were away.
    expect(touches(away, '2026-10-20', '2026-10-31')).toBe(true);
    // Counted as they always were: nothing of theirs is cut after the return.
    expect(touches(away, '2026-10-21', '2026-10-31')).toBe(false);
    expect(touches(away, '2026-11-01', '2026-11-30')).toBe(false);
  });

  it('says the whole payroll period is inside one period only when it starts after the day they left and ends before the day they came back', () => {
    expect(awayAllPeriod(left, '2026-10-16', '2026-10-23')).toBe(true);
    expect(awayAllPeriod(left, '2026-10-15', '2026-10-23')).toBe(false);
    expect(awayAllPeriod(away, '2026-10-16', '2026-10-19')).toBe(true);
    expect(awayAllPeriod(away, '2026-10-16', '2026-10-20')).toBe(false);
    expect(awayAllPeriod(away, '2026-10-12', '2026-10-23')).toBe(false);
  });

  it('hands statement E the instants and nothing else', () => {
    expect(awayInstants(person('anna', [LEFT, BACK], ['2026-11-02T09:00:00.000Z', null]))).toEqual([
      { from: new Date(LEFT), to: new Date(BACK) },
      { from: new Date('2026-11-02T09:00:00.000Z'), to: null },
    ]);
  });
});

describe('cutDuties', () => {
  const duty = (overrides: Partial<LoadDuty> = {}): LoadDuty => ({ userId: 'anna', minutesPerWeek: 60, countsAsTeaching: false, ...overrides });
  const leavers = (...periods: [string, string | null][]): Map<string, Leaver> => new Map([['anna', person('anna', ...periods)]]);

  it('ends the uppdrag of a person who is still away the day before the day they left, whether it had an end or not', () => {
    const gone = leavers([LEFT, null]);
    expect(cutDuties([duty()], gone, '2027-06-11')).toEqual([duty({ validTo: '2026-10-14' })]);
    expect(cutDuties([duty({ validTo: '2027-01-31' })], gone, '2027-06-11')).toEqual([duty({ validTo: '2026-10-14' })]);
  });

  it('keeps an uppdrag that already ended earlier, someone else\'s, and a rastvakt cut the same day', () => {
    const gone = leavers([LEFT, null]);
    const earlier = duty({ validTo: '2026-09-30' });
    const sameDay = duty({ validTo: '2026-10-14' });
    const other = duty({ userId: 'bo' });
    const result = cutDuties([earlier, sameDay, other], gone, '2027-06-11');
    expect(result).toEqual([earlier, sameDay, other]);
    expect(result[0]).toBe(earlier);
    expect(result[2]).toBe(other);
  });

  it('takes the days away out of the middle of an uppdrag, which becomes two with the same weekly minutes', () => {
    // Away from the 15th to the 20th: the 15th–19th are not charged, the 20th is (she is back by its end).
    const back = leavers([LEFT, BACK]);
    expect(cutDuties([duty()], back, '2027-06-11')).toEqual([duty({ validTo: '2026-10-14' }), duty({ validFrom: '2026-10-20' })]);
    expect(cutDuties([duty({ validFrom: '2026-08-17', validTo: '2027-01-31' })], back, '2027-06-11')).toEqual([
      duty({ validFrom: '2026-08-17', validTo: '2026-10-14' }),
      duty({ validFrom: '2026-10-20', validTo: '2027-01-31' }),
    ]);
  });

  it('cuts only the part of an uppdrag the days away reach', () => {
    const back = leavers([LEFT, BACK]);
    // Starts during the leave: the days before the return are not its, from the 20th it is.
    expect(cutDuties([duty({ validFrom: '2026-10-17' })], back, '2027-06-11')).toEqual([duty({ validFrom: '2026-10-20' })]);
    // Ends during the leave: it stops the day before.
    expect(cutDuties([duty({ validTo: '2026-10-17' })], back, '2027-06-11')).toEqual([duty({ validTo: '2026-10-14' })]);
    // Lies wholly inside the leave: nothing is charged, and the duty is gone.
    expect(cutDuties([duty({ validFrom: '2026-10-16', validTo: '2026-10-18' })], back, '2027-06-11')).toEqual([]);
    // Lies wholly after the return, or wholly before the leave: the object it was.
    const after = duty({ validFrom: '2026-10-21' });
    const before = duty({ validTo: '2026-10-14' });
    const kept = cutDuties([after, before], back, '2027-06-11');
    expect(kept[0]).toBe(after);
    expect(kept[1]).toBe(before);
  });

  it('charges a person who left and came back the same day for every day', () => {
    const sameDay = leavers(['2026-10-15T08:00:00.000Z', '2026-10-15T13:00:00.000Z']);
    const plain = duty();
    expect(cutDuties([plain], sameDay, '2027-06-11')[0]).toBe(plain);
  });

  it('cuts every period of a person who left twice', () => {
    const twice = leavers([LEFT, BACK], ['2026-11-02T09:00:00.000Z', null]);
    expect(cutDuties([duty()], twice, '2027-06-11')).toEqual([
      duty({ validTo: '2026-10-14' }),
      duty({ validFrom: '2026-10-20', validTo: '2026-11-01' }),
    ]);
  });

  it('does not touch the list for a school where nobody has left', () => {
    const duties = [duty(), duty({ userId: 'bo' })];
    expect(cutDuties(duties, new Map(), '2027-06-11')).toEqual(duties);
  });
});

describe('coverStands', () => {
  const leavers = new Map([['dan', person('dan', [LEFT, BACK])]]);
  const gone = new Map([['dan', person('dan', [LEFT, null])]]);

  it('counts a cover over by the stamp, to the millisecond, and drops one that ended after it', () => {
    expect(coverStands({ userId: 'dan', endsAt: '2026-10-15T09:00:00.000Z' }, gone)).toBe(true);
    expect(coverStands({ userId: 'dan', endsAt: '2026-10-15T10:00:00.000Z' }, gone)).toBe(true);
    expect(coverStands({ userId: 'dan', endsAt: '2026-10-15T10:00:00.001Z' }, gone)).toBe(false);
    expect(coverStands({ userId: 'dan', endsAt: '2026-10-19T09:00:00.000Z' }, gone)).toBe(false);
  });

  it('counts a cover over after the return, and drops the ones inside the leave', () => {
    expect(coverStands({ userId: 'dan', endsAt: '2026-10-19T09:00:00.000Z' }, leavers)).toBe(false);
    expect(coverStands({ userId: 'dan', endsAt: BACK }, leavers)).toBe(true);
    expect(coverStands({ userId: 'dan', endsAt: '2026-10-21T09:00:00.000Z' }, leavers)).toBe(true);
  });

  it('counts everyone else\'s', () => {
    expect(coverStands({ userId: 'cy', endsAt: '2026-10-19T09:00:00.000Z' }, gone)).toBe(true);
  });
});
