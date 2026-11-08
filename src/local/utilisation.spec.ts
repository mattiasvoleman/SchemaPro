import { utilisation, type UtilisationTarget } from './utilisation';
import { minutesOfClock, type FrameLike } from './school-time';

const frames: FrameLike[] = [{ minGradeLevel: 0, maxGradeLevel: 12, dayOfWeek: null, start: minutesOfClock('08:00'), end: minutesOfClock('16:00') }];
const open = { start: minutesOfClock('07:00'), end: minutesOfClock('22:00') };
// Stockholm in February is UTC+1.
const held = (date: string, from: string, to: string, quantity = 1) => ({
  start: Date.parse(`${date}T${from}:00+01:00`),
  end: Date.parse(`${date}T${to}:00+01:00`),
  quantity,
});
const room = (heldList: ReturnType<typeof held>[], over: Partial<UtilisationTarget> = {}): UtilisationTarget => ({
  kind: 'ROOM',
  id: 'r1',
  name: 'Gymnastiksalen',
  capacity: 1,
  years: { min: null, max: null },
  held: heldList,
  ...over,
});
const run = (targets: UtilisationTarget[], over: object = {}) =>
  utilisation({ from: '2027-02-01', to: '2027-02-07', timeZone: 'Europe/Stockholm', frames, holidays: new Set(), open, targets, ...over });

describe('utilisation', () => {
  it('counts school time and the open hours outside it for a week, a room held for part of both', () => {
    const { rows, weekStarts } = run([
      room([held('2027-02-02', '09:00', '11:00'), held('2027-02-02', '18:00', '20:00'), held('2027-02-06', '10:00', '12:00')]),
    ]);
    expect(weekStarts).toEqual(['2027-02-01']);
    const total = rows[0].total;
    // Five teaching days of 8 hours; the open hours outside them are 3+3... : 07-08 and 16-22 on weekdays (7 h x 5), 15 h on Saturday and Sunday.
    expect(total.schoolMinutes).toBe(5 * 8 * 60);
    expect(total.bookedSchoolMinutes).toBe(120);
    expect(total.schoolShare).toBe(0.05);
    expect(total.outsideMinutes).toBe(5 * 7 * 60 + 2 * 15 * 60);
    expect(total.bookedOutsideMinutes).toBe(120 + 120);
    expect(total.outsideShare).toBeCloseTo(240 / (5 * 420 + 1800), 4);
    expect(rows[0].unit).toBe('MINUTES');
    expect(rows[0].weeks).toHaveLength(1);
    expect(rows[0].weeks[0]).toMatchObject({ weekStart: '2027-02-01', bookedSchoolMinutes: 120 });
  });

  it('counts a minute held by a lesson and a booking once, and a piece across the edge of school time in both', () => {
    const { rows } = run([room([held('2027-02-02', '09:00', '10:00'), held('2027-02-02', '09:30', '10:30'), held('2027-02-02', '15:00', '17:00')])]);
    expect(rows[0].total.bookedSchoolMinutes).toBe(90 + 60);
    expect(rows[0].total.bookedOutsideMinutes).toBe(60);
  });

  it('divides a period into weeks and cuts a week at the ends of the period', () => {
    const { rows, weekStarts } = run([room([held('2027-02-03', '09:00', '10:00'), held('2027-02-10', '09:00', '11:00')])], {
      from: '2027-02-03',
      to: '2027-02-12',
    });
    expect(weekStarts).toEqual(['2027-02-01', '2027-02-08']);
    // The first week holds Wednesday to Sunday of its week: three teaching days.
    expect(rows[0].weeks[0].schoolMinutes).toBe(3 * 8 * 60);
    expect(rows[0].weeks[0].bookedSchoolMinutes).toBe(60);
    expect(rows[0].weeks[1].schoolMinutes).toBe(5 * 8 * 60);
    expect(rows[0].weeks[1].bookedSchoolMinutes).toBe(120);
    expect(rows[0].total.bookedSchoolMinutes).toBe(180);
  });

  it('takes the frames off a lov for the whole school and counts the day as open hours', () => {
    const { rows } = run([room([held('2027-02-02', '09:00', '11:00')])], { holidays: new Set(['2027-02-02']) });
    expect(rows[0].total.schoolMinutes).toBe(4 * 8 * 60);
    expect(rows[0].total.bookedSchoolMinutes).toBe(0);
    expect(rows[0].total.bookedOutsideMinutes).toBe(120);
    expect(rows[0].total.outsideMinutes).toBe(4 * 7 * 60 + 15 * 60 + 2 * 15 * 60);
  });

  it('has no school share for a school with no frames', () => {
    const { rows } = run([room([held('2027-02-02', '09:00', '11:00')])], { frames: [] });
    expect(rows[0].total.schoolMinutes).toBe(0);
    expect(rows[0].total.schoolShare).toBeNull();
    expect(rows[0].total.bookedOutsideMinutes).toBe(120);
  });

  it('counts unit-minutes for a resource, capped at what there is', () => {
    const tablets = room([held('2027-02-02', '09:00', '10:00', 10), held('2027-02-02', '09:30', '10:00', 25)], { kind: 'RESOURCE', capacity: 30 });
    const { rows } = run([tablets]);
    expect(rows[0].unit).toBe('UNIT_MINUTES');
    expect(rows[0].total.schoolMinutes).toBe(5 * 8 * 60 * 30);
    // 30 minutes of 10, then 30 minutes of 35 capped at 30.
    expect(rows[0].total.bookedSchoolMinutes).toBe(30 * 10 + 30 * 30);
  });

  it('reads the clock of a day with a change of summer time through the zone', () => {
    // 2027-03-28 (a Sunday) is the change; the clock jumps from 02:00 to 03:00. 18:00-20:00 local is 16:00Z-18:00Z.
    const { rows } = run([room([{ start: Date.parse('2027-03-28T16:00:00Z'), end: Date.parse('2027-03-28T18:00:00Z'), quantity: 1 }])], {
      from: '2027-03-28',
      to: '2027-03-28',
    });
    expect(rows[0].total.bookedOutsideMinutes).toBe(120);
    expect(rows[0].total.outsideMinutes).toBe(15 * 60);
  });

  it('returns a row for a target that nothing holds', () => {
    const { rows } = run([room([])]);
    expect(rows[0].total.bookedSchoolMinutes).toBe(0);
    expect(rows[0].total.schoolShare).toBe(0);
  });

  it('handles a piece that spans midnight, once on each side', () => {
    const { rows } = run([room([{ start: Date.parse('2027-02-02T22:00:00+01:00'), end: Date.parse('2027-02-03T01:00:00+01:00'), quantity: 1 }])]);
    // 22:00-24:00 is after the open hours on the 2nd; 00:00-01:00 on the 3rd is before them: neither is counted.
    expect(rows[0].total.bookedOutsideMinutes).toBe(0);
  });
});
