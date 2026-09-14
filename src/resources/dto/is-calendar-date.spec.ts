import { validate } from 'class-validator';
import { isCalendarDate } from './is-calendar-date';
import { CreateTeachingRequirementDto } from './teaching-requirement.dto';

const YEAR_ID = '99999999-9999-4999-8999-999999999999';
const SUBJECT_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const GROUP_ID = '66666666-6666-4666-8666-666666666666';

describe('isCalendarDate', () => {
  it('accepts a date that exists', () => {
    for (const value of ['2026-08-17', '2027-06-11', '2024-02-29']) {
      expect(isCalendarDate(value)).toBe(true);
    }
  });

  it('rejects a day the month does not have', () => {
    // The whole point: every one of these passes /^\d{4}-\d{2}-\d{2}$/, and
    // `new Date(...)` answers with the day it rolled over to rather than an
    // error. 2026 is not a leap year, so the 29th of February is in the list.
    for (const value of [
      '2026-02-29',
      '2026-02-30',
      '2026-04-31',
      '2026-06-31',
      '2026-11-31',
    ]) {
      expect(isCalendarDate(value)).toBe(false);
    }
  });

  it('rejects an impossible month or day field', () => {
    for (const value of ['2026-13-01', '2026-00-10', '2026-01-00', '2026-01-32']) {
      expect(isCalendarDate(value)).toBe(false);
    }
  });

  it('rejects anything that is not a plain YYYY-MM-DD string', () => {
    for (const value of [
      '2026-8-17',
      '26-08-17',
      '2026-08-17T00:00:00.000Z',
      '2026-08-17 ',
      '',
      17,
      null,
      undefined,
      new Date('2026-08-17'),
    ]) {
      expect(isCalendarDate(value)).toBe(false);
    }
  });
});

describe('CreateTeachingRequirementDto period validation', () => {
  const dto = (overrides: Partial<CreateTeachingRequirementDto> = {}) =>
    Object.assign(new CreateTeachingRequirementDto(), {
      academicYearId: YEAR_ID,
      subjectId: SUBJECT_ID,
      studentGroupId: GROUP_ID,
      ...overrides,
    });

  it('rejects the 30th of February instead of silently reading it as 2 March', async () => {
    const errors = await validate(dto({ startDate: '2026-02-30' }));

    expect(errors).toHaveLength(1);
    expect(errors[0]?.property).toBe('startDate');
    expect(Object.values(errors[0]?.constraints ?? {})).toEqual([
      'startDate must be a real date in YYYY-MM-DD form.',
    ]);
  });

  it('names the field it rejected, so a two-date form says which one', async () => {
    const errors = await validate(
      dto({ startDate: '2026-08-17', endDate: '2026-11-31' }),
    );

    expect(errors.map((error) => error.property)).toEqual(['endDate']);
  });

  it('still accepts a real period, and an omitted one', async () => {
    await expect(
      validate(dto({ startDate: '2027-01-11', endDate: '2027-06-11' })),
    ).resolves.toEqual([]);
    await expect(validate(dto())).resolves.toEqual([]);
    // Null is "no bound", not a malformed date — @IsOptional() lets it past.
    await expect(
      validate(dto({ startDate: null, endDate: null })),
    ).resolves.toEqual([]);
  });
});
