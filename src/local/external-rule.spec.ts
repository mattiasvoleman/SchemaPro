import { addDays, datesBetween, expandRule, isoWeekdayOf, mondayOf, ruleDates, weekdaysInWords } from './external-rule';

describe('the rule of a series', () => {
  const tuesdays = { weekdays: [2], intervalWeeks: 1, startDate: '2027-02-01', endDate: '2027-03-01', startTime: '18:00', endTime: '20:00' };

  it('reads the weekday of a date, Sunday as 7', () => {
    expect(isoWeekdayOf('2027-02-01')).toBe(1);
    expect(isoWeekdayOf('2027-02-07')).toBe(7);
    expect(isoWeekdayOf('2027-02-06')).toBe(6);
  });

  it('finds the Monday of a week and counts days across a month end and a leap day', () => {
    expect(mondayOf('2027-02-07')).toBe('2027-02-01');
    expect(mondayOf('2027-02-01')).toBe('2027-02-01');
    expect(addDays('2028-02-28', 1)).toBe('2028-02-29');
    expect(addDays('2027-12-31', 1)).toBe('2028-01-01');
    expect(datesBetween('2027-02-27', '2027-03-02')).toEqual(['2027-02-27', '2027-02-28', '2027-03-01', '2027-03-02']);
    expect(datesBetween('2027-03-02', '2027-02-27')).toEqual([]);
  });

  it('makes every Tuesday of the period, both ends inclusive', () => {
    expect(ruleDates(tuesdays)).toEqual(['2027-02-02', '2027-02-09', '2027-02-16', '2027-02-23']);
    expect(ruleDates({ ...tuesdays, startDate: '2027-02-02', endDate: '2027-02-23' })).toEqual(['2027-02-02', '2027-02-09', '2027-02-16', '2027-02-23']);
    expect(ruleDates({ ...tuesdays, endDate: '2027-02-22' })).toEqual(['2027-02-02', '2027-02-09', '2027-02-16']);
  });

  it('makes several weekdays in date order', () => {
    expect(ruleDates({ ...tuesdays, weekdays: [4, 2], endDate: '2027-02-12' })).toEqual(['2027-02-02', '2027-02-04', '2027-02-09', '2027-02-11']);
  });

  it('counts every other week from the week of the first date', () => {
    // 2027-02-03 is a Wednesday of the first week; the next date is two weeks on.
    const other = { ...tuesdays, weekdays: [3], intervalWeeks: 2, startDate: '2027-02-03', endDate: '2027-03-10' };
    expect(ruleDates(other)).toEqual(['2027-02-03', '2027-02-17', '2027-03-03']);
    // A Tuesday before the first date, in the first week, is not part of it; the Tuesdays of the later even weeks are.
    expect(ruleDates({ ...other, weekdays: [2, 3] })).toEqual(['2027-02-03', '2027-02-16', '2027-02-17', '2027-03-02', '2027-03-03']);
    expect(ruleDates({ ...other, intervalWeeks: 3, endDate: '2027-03-31' })).toEqual(['2027-02-03', '2027-02-24', '2027-03-17']);
  });

  it('gives a period with no matching weekday no days', () => {
    expect(ruleDates({ ...tuesdays, weekdays: [6], startDate: '2027-02-01', endDate: '2027-02-05' })).toEqual([]);
  });

  it('puts the instants on the school clock, on both sides of the change to summer time', () => {
    const days = expandRule(
      { ...tuesdays, weekdays: [2], startDate: '2027-03-23', endDate: '2027-04-06' },
      'Europe/Stockholm',
    );
    expect(days.map((day) => day.date)).toEqual(['2027-03-23', '2027-03-30', '2027-04-06']);
    // 2027-03-28 was the change: 18:00 is 17:00Z before it and 16:00Z after.
    expect(days[0].startsAt.toISOString()).toBe('2027-03-23T17:00:00.000Z');
    expect(days[0].endsAt.toISOString()).toBe('2027-03-23T19:00:00.000Z');
    expect(days[1].startsAt.toISOString()).toBe('2027-03-30T16:00:00.000Z');
    expect(days[1].endsAt.toISOString()).toBe('2027-03-30T18:00:00.000Z');
  });

  it('says the weekdays in words', () => {
    expect(weekdaysInWords([2])).toBe('tisdagar');
    expect(weekdaysInWords([3, 1])).toBe('måndagar och onsdagar');
    expect(weekdaysInWords([5, 1, 3])).toBe('måndagar, onsdagar och fredagar');
    expect(weekdaysInWords([])).toBe('');
  });
});
