import { clockOf, passDates, passRunsOn, passSpan, spansMeet, type PassRule } from './pass-days';

const year = { startDate: '2026-08-17', endDate: '2027-06-11' };
const monday: PassRule = { dayOfWeek: 1, start: 600, end: 620, validFrom: null, validTo: null };
const lagstadiet = { minGradeLevel: 0, maxGradeLevel: 3 };

describe('the days a pass runs', () => {
  it('runs on its weekday across the window, inside the läsår', () => {
    expect(passDates(monday, lagstadiet, year, [], '2026-10-01', '2026-10-31')).toEqual([
      '2026-10-05',
      '2026-10-12',
      '2026-10-19',
      '2026-10-26',
    ]);
    // The year's first Monday is the 17th; a window before it holds none.
    expect(passDates(monday, lagstadiet, year, [], '2026-08-01', '2026-08-20')).toEqual(['2026-08-17']);
    expect(passDates(monday, lagstadiet, year, [], '2027-06-12', '2027-06-30')).toEqual([]);
  });

  it('keeps to its own Från and Till, inclusive', () => {
    const dated = { ...monday, validFrom: '2026-10-12', validTo: '2026-10-19' };
    expect(passDates(dated, lagstadiet, year, [], '2026-10-01', '2026-10-31')).toEqual(['2026-10-12', '2026-10-19']);
  });

  it('skips a lov that closes the whole school or every årskurs of the area, and not one that closes other grades', () => {
    const hostlov = { startDate: '2026-10-26', endDate: '2026-10-30' };
    expect(passDates(monday, lagstadiet, year, [hostlov], '2026-10-19', '2026-11-02')).toEqual(['2026-10-19', '2026-11-02']);
    const pra = { startDate: '2026-10-19', endDate: '2026-10-19', minGradeLevel: 8, maxGradeLevel: 9 };
    expect(passDates(monday, lagstadiet, year, [pra], '2026-10-19', '2026-10-19')).toEqual(['2026-10-19']);
    const lagLov = { startDate: '2026-10-19', endDate: '2026-10-19', minGradeLevel: 0, maxGradeLevel: 5 };
    expect(passDates(monday, lagstadiet, year, [lagLov], '2026-10-19', '2026-10-19')).toEqual([]);
    // An area of every stage is closed only by a lov of the whole school.
    expect(passDates(monday, { minGradeLevel: null, maxGradeLevel: null }, year, [lagLov], '2026-10-19', '2026-10-19')).toEqual([
      '2026-10-19',
    ]);
  });

  it('watches until the day before its teacher was deactivated', () => {
    const leaver = { ...monday, inactiveFrom: '2026-10-19' };
    expect(passDates(leaver, lagstadiet, year, [], '2026-10-01', '2026-10-31')).toEqual(['2026-10-05', '2026-10-12']);
    expect(passRunsOn(leaver, lagstadiet, year, [], '2026-10-19')).toBe(false);
    expect(passRunsOn(leaver, lagstadiet, year, [], '2026-10-12')).toBe(true);
  });

  it('runs on no other weekday', () => {
    expect(passRunsOn(monday, lagstadiet, year, [], '2026-10-13')).toBe(false);
  });

  it('is its clock on the school’s clock, summer time and winter time alike', () => {
    expect(clockOf(600)).toBe('10:00');
    expect(clockOf(65)).toBe('01:05');
    // CEST (+2) before 25 October 2026, CET (+1) after.
    expect(passSpan(monday, '2026-10-19', 'Europe/Stockholm')).toEqual({
      startsAt: new Date('2026-10-19T08:00:00.000Z'),
      endsAt: new Date('2026-10-19T08:20:00.000Z'),
    });
    expect(passSpan(monday, '2026-10-26', 'Europe/Stockholm')).toEqual({
      startsAt: new Date('2026-10-26T09:00:00.000Z'),
      endsAt: new Date('2026-10-26T09:20:00.000Z'),
    });
  });

  it('meets a span that shares an instant, and not one that only touches it', () => {
    const pass = { startsAt: new Date('2026-10-19T08:00:00Z'), endsAt: new Date('2026-10-19T08:20:00Z') };
    expect(spansMeet(pass, { startsAt: new Date('2026-10-19T08:19:00Z'), endsAt: new Date('2026-10-19T09:00:00Z') })).toBe(true);
    expect(spansMeet(pass, { startsAt: new Date('2026-10-19T08:20:00Z'), endsAt: new Date('2026-10-19T09:00:00Z') })).toBe(false);
    expect(spansMeet(pass, { startsAt: new Date('2026-10-18T22:00:00Z'), endsAt: new Date('2026-10-19T08:00:00Z') })).toBe(false);
  });
});
