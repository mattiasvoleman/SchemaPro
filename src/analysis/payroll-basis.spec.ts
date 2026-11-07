import type { SchoolPartView } from './analysis.types';
import { buildPayroll, shareOut, type PayrollInput } from './payroll-basis';

const YEAR = { startDate: '2026-08-17', endDate: '2027-06-11' };
const LOW: SchoolPartView = { id: 'low', name: 'Lågstadiet', account: '4010', gradeFrom: 0, gradeTo: 3 };
const HIGH: SchoolPartView = { id: 'high', name: 'Högstadiet', account: '4030', gradeFrom: 7, gradeTo: 9 };
const partByGroup: Record<string, SchoolPartView | null> = { g1: LOW, g7: HIGH, loose: null };

const payroll = (overrides: Partial<PayrollInput> = {}) =>
  buildPayroll({
    from: '2026-11-02',
    to: '2026-11-27',
    year: YEAR,
    teaching: [],
    substitutes: [],
    duties: [],
    closures: [],
    parts: [HIGH, LOW],
    partOfGroup: (groupId) => partByGroup[groupId] ?? null,
    kindOf: (userId) => (userId.startsWith('pool') ? 'POOL' : 'STAFF'),
    employmentPercentOf: (userId) => (userId === 'anna' ? 80 : null),
    ...overrides,
  });

describe('shareOut', () => {
  it('shares whole minutes by weight and always adds up', () => {
    expect(shareOut(10, [1, 1, 1])).toEqual([4, 3, 3]);
    expect(shareOut(100, [3, 1])).toEqual([75, 25]);
    for (const total of [1, 7, 99, 1000]) {
      for (const weights of [[1, 2, 3], [5, 5, 5, 5], [0.3, 0.3, 0.4], [1000, 1]]) {
        expect(shareOut(total, weights).reduce((a, b) => a + b, 0)).toBe(total);
      }
    }
  });

  it('gives the largest remainder the odd minute, the earlier of two equal ones first', () => {
    expect(shareOut(5, [1, 1])).toEqual([3, 2]);
    expect(shareOut(2, [10, 1, 1])).toEqual([2, 0, 0]);
  });

  it('shares nothing when there is nothing to share or no weight to share it by', () => {
    expect(shareOut(0, [1, 2])).toEqual([0, 0]);
    expect(shareOut(10, [0, 0])).toEqual([0, 0]);
    expect(shareOut(10, [])).toEqual([]);
  });
});

describe('buildPayroll: teaching and cover per skoldel', () => {
  it("books a person's held lessons on the skoldel of each group, in skoldel order, with its konto", () => {
    const result = payroll({
      teaching: [
        { userId: 'anna', studentGroupId: 'g7', minutes: 120 },
        { userId: 'anna', studentGroupId: 'g7', minutes: 60 },
        { userId: 'anna', studentGroupId: 'g1', minutes: 45 },
      ],
    });
    expect(result.lines).toEqual([
      { userId: 'anna', kind: 'STAFF', schoolPartId: 'low', account: '4010', teachingMinutes: 45, dutyMinutes: 0, substituteMinutes: 0 },
      { userId: 'anna', kind: 'STAFF', schoolPartId: 'high', account: '4030', teachingMinutes: 180, dutyMinutes: 0, substituteMinutes: 0 },
    ]);
    expect(result.people).toEqual([
      { userId: 'anna', kind: 'STAFF', teachingMinutes: 225, dutyMinutes: 0, substituteMinutes: 0, employmentPercent: 80 },
    ]);
  });

  it('books the vikariepass beside the teaching, and a pool member as POOL with no tjänstgöringsgrad', () => {
    const result = payroll({
      teaching: [{ userId: 'anna', studentGroupId: 'g7', minutes: 60 }],
      substitutes: [
        { userId: 'anna', studentGroupId: 'g7', minutes: 40 },
        { userId: 'pool-1', studentGroupId: 'g7', minutes: 80 },
        { userId: 'pool-1', studentGroupId: 'g1', minutes: 40 },
      ],
    });
    const anna = result.lines.find((line) => line.userId === 'anna')!;
    expect(anna).toMatchObject({ teachingMinutes: 60, substituteMinutes: 40 });
    const pool = result.people.find((person) => person.userId === 'pool-1')!;
    expect(pool).toMatchObject({ kind: 'POOL', substituteMinutes: 120, teachingMinutes: 0, employmentPercent: null });
    expect(result.lines.filter((line) => line.userId === 'pool-1').map((line) => line.schoolPartId)).toEqual(['low', 'high']);
  });

  it('puts a group no skoldel holds on the line with no skoldel and no konto', () => {
    const result = payroll({ teaching: [{ userId: 'anna', studentGroupId: 'loose', minutes: 30 }] });
    expect(result.lines).toEqual([
      { userId: 'anna', kind: 'STAFF', schoolPartId: null, account: null, teachingMinutes: 30, dutyMinutes: 0, substituteMinutes: 0 },
    ]);
  });

  it('is empty for a period nobody worked in', () => {
    expect(payroll()).toEqual({ people: [], lines: [], dutiesUnallocated: 0 });
  });
});

describe('buildPayroll: uppdrag', () => {
  // 2026-11-02 (Monday) to 2026-11-27 (Friday): four whole weeks, twenty teaching days.
  it('counts the minutes of the days the period holds, a fifth of a week for each, and nothing outside the uppdrag', () => {
    const whole = payroll({
      teaching: [{ userId: 'anna', studentGroupId: 'g7', minutes: 100 }],
      duties: [{ userId: 'anna', minutesPerWeek: 50, countsAsTeaching: false }],
    });
    expect(whole.people[0]!.dutyMinutes).toBe(200);
    const dated = payroll({
      teaching: [{ userId: 'anna', studentGroupId: 'g7', minutes: 100 }],
      duties: [{ userId: 'anna', minutesPerWeek: 50, countsAsTeaching: false, validFrom: '2026-11-16', validTo: '2026-11-20' }],
    });
    expect(dated.people[0]!.dutyMinutes).toBe(50);
    const before = payroll({
      teaching: [{ userId: 'anna', studentGroupId: 'g7', minutes: 100 }],
      duties: [{ userId: 'anna', minutesPerWeek: 50, countsAsTeaching: false, validTo: '2026-10-30' }],
    });
    expect(before.people[0]!.dutyMinutes).toBe(0);
  });

  it('leaves out the days a school-wide lov closes, and not a lov that only some årskurser have', () => {
    const duties = [{ userId: 'anna', minutesPerWeek: 50, countsAsTeaching: false }];
    const teaching = [{ userId: 'anna', studentGroupId: 'g7', minutes: 100 }];
    const lov = payroll({ teaching, duties, closures: [{ startDate: '2026-11-09', endDate: '2026-11-13' }] });
    expect(lov.people[0]!.dutyMinutes).toBe(150);
    const some = payroll({ teaching, duties, closures: [{ startDate: '2026-11-09', endDate: '2026-11-13', minGradeLevel: 7, maxGradeLevel: 9 }] });
    expect(some.people[0]!.dutyMinutes).toBe(200);
  });

  it("shares a person's uppdrag across their skoldelar in proportion to their other time, adding up to the total", () => {
    const result = payroll({
      teaching: [
        { userId: 'anna', studentGroupId: 'g7', minutes: 300 },
        { userId: 'anna', studentGroupId: 'g1', minutes: 100 },
      ],
      duties: [{ userId: 'anna', minutesPerWeek: 55, countsAsTeaching: false }],
    });
    const [low, high] = result.lines;
    expect(low!.schoolPartId).toBe('low');
    expect(low!.dutyMinutes + high!.dutyMinutes).toBe(220);
    expect(high!.dutyMinutes).toBe(165);
    expect(low!.dutyMinutes).toBe(55);
    expect(result.people[0]!.dutyMinutes).toBe(220);
    expect(result.dutiesUnallocated).toBe(0);
  });

  it('gives a person with nothing to follow a line of their own with no skoldel, and counts them', () => {
    const result = payroll({ duties: [{ userId: 'anna', minutesPerWeek: 50, countsAsTeaching: false }] });
    expect(result.lines).toEqual([
      { userId: 'anna', kind: 'STAFF', schoolPartId: null, account: null, teachingMinutes: 0, dutyMinutes: 200, substituteMinutes: 0 },
    ]);
    expect(result.dutiesUnallocated).toBe(1);
  });

  it('adds the uppdrag of several rows and passes of one person', () => {
    const result = payroll({
      teaching: [{ userId: 'anna', studentGroupId: 'g7', minutes: 100 }],
      duties: [
        { userId: 'anna', minutesPerWeek: 50, countsAsTeaching: false },
        { userId: 'anna', minutesPerWeek: 25, countsAsTeaching: true, validFrom: '2026-11-02', validTo: '2026-11-13' },
      ],
    });
    expect(result.people[0]!.dutyMinutes).toBe(200 + 50);
  });
});
