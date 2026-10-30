import { coverOn, coveredEveryRun, coveredOnEveryDate, coversSpan, datesOf, intersectSpans, mergeSpans, type CoverLoan } from './loan-coverage';

/**
 * The one rule for what a borrowed room's approved loans cover, read by the
 * generator, the publish check and the bookings: the union of the loans of a
 * date, and for a weekly lesson every date it runs.
 */

// Tuesdays, 10:00–11:30, the school year 2030/31.
const loan = (patch: Partial<CoverLoan>): CoverLoan => ({
  dayOfWeek: 2,
  start: 600,
  end: 690,
  startDate: '2030-08-19',
  endDate: '2031-06-13',
  ...patch,
});

describe('loan coverage', () => {
  it('merges spans that overlap or touch, and holds a span only whole', () => {
    expect(mergeSpans([[660, 720], [600, 660], [800, 810], [805, 830], [900, 900]])).toEqual([
      [600, 720],
      [800, 830],
    ]);
    expect(coversSpan([[600, 720]], 630, 690)).toBe(true);
    expect(coversSpan([[600, 660], [670, 720]], 630, 690)).toBe(false);
    expect(intersectSpans([[600, 720]], [[650, 800]])).toEqual([[650, 720]]);
  });

  it('reads the loans of a date and its weekday', () => {
    const loans = [loan({ end: 660 }), loan({ start: 660, end: 720 }), loan({ dayOfWeek: 3 }), loan({ startDate: '2031-01-07', start: 800, end: 860 })];
    expect(coverOn(loans, '2030-09-03', 2)).toEqual([[600, 720]]);
    expect(coverOn(loans, '2031-01-14', 2)).toEqual([
      [600, 720],
      [800, 860],
    ]);
  });

  it('lists the dates of a weekday in a period, those a lesson runs', () => {
    expect(datesOf(2, '2030-09-02', '2030-09-20')).toEqual(['2030-09-03', '2030-09-10', '2030-09-17']);
    expect(datesOf(2, '2030-09-02', '2030-09-20', (date) => date !== '2030-09-10')).toEqual(['2030-09-03', '2030-09-17']);
    expect(datesOf(2, '2030-09-04', '2030-09-09')).toEqual([]);
  });

  it('opens for the plan only what is covered every week of the period', () => {
    expect(coveredOnEveryDate([loan({})], 2, '2030-08-19', '2031-06-13')).toEqual([[600, 690]]);
    // The spring alone covers nothing every week of the year.
    expect(coveredOnEveryDate([loan({ startDate: '2031-01-07' })], 2, '2030-08-19', '2031-06-13')).toEqual([]);
    // Autumn and spring together do; autumn 10–11 and spring 10–12, 10–11.
    expect(
      coveredOnEveryDate([loan({ end: 660, endDate: '2030-12-20' }), loan({ end: 720, startDate: '2030-12-21' })], 2, '2030-08-19', '2031-06-13'),
    ).toEqual([[600, 660]]);
    // A jullov between the terms is no date that counts: they cover the year.
    const aroundJul = [loan({ endDate: '2030-12-20' }), loan({ startDate: '2031-01-08' })];
    expect(coveredOnEveryDate(aroundJul, 2, '2030-08-19', '2031-06-13')).toEqual([]);
    const jul = new Set(['2030-12-24', '2030-12-31', '2031-01-07']);
    expect(coveredOnEveryDate(aroundJul, 2, '2030-08-19', '2031-06-13', (date) => !jul.has(date))).toEqual([[600, 690]]);
    // No date of the weekday in the period: nothing.
    expect(coveredOnEveryDate([loan({})], 2, '2030-09-04', '2030-09-09')).toEqual([]);
  });

  it('holds a weekly lesson only when every date it runs is covered', () => {
    const terms = [loan({ endDate: '2030-12-20' }), loan({ startDate: '2031-01-08' })];
    expect(coveredEveryRun(terms, 2, 600, 660, '2030-08-19', '2030-12-20')).toBe(true);
    expect(coveredEveryRun(terms, 2, 600, 660, '2030-08-19', '2031-06-13')).toBe(false);
    // The two uncovered Tuesdays skipped: the lesson does not run then.
    expect(coveredEveryRun(terms, 2, 600, 660, '2030-08-19', '2031-06-13', (date) => !['2030-12-24', '2030-12-31', '2031-01-07'].includes(date))).toBe(true);
  });
});
