import {
  MIN_GROUP,
  addFigures,
  buildClasses,
  buildPatterns,
  buildPupilMonths,
  buildSeries,
  figuresOf,
  mergeMonth,
  monthEnd,
  monthStart,
  monthsBetween,
  pct,
  reportingOf,
  shiftMonth,
  totalOf,
  NO_FIGURES,
  type PatternRow,
  type RawFigures,
  type SeriesRow,
} from './absence-stats';

const raw = (recordedMinutes: number, validMinutes = 0, absentMinutes = 0, lateMinutes = 0, lateCount = 0): RawFigures => ({
  recordedMinutes,
  validMinutes,
  absentMinutes,
  lateMinutes,
  lateCount,
});

const row = (month: string, over: Partial<SeriesRow> = {}): SeriesRow => ({
  month,
  throughDay: monthEnd(month),
  classId: 'c1',
  className: '8A',
  pupils: 24,
  pupilsRegistered: 24,
  figures: raw(1000, 50, 20, 10, 1),
  lessonsHeld: 100,
  lessonsReported: 90,
  ...over,
});

describe('the smallest group', () => {
  it('is five, the number the database holds the stored rows to', () => {
    expect(MIN_GROUP).toBe(5);
  });
});

describe('pct', () => {
  it.each([
    [1, 3, 33.3],
    [2, 3, 66.7],
    [1, 8, 12.5],
    [0, 7, 0],
    [7, 7, 100],
    [1, 1000, 0.1],
    [1, 2000, 0.1],
    [1, 3000, 0],
  ])('%i of %i is %f', (part, whole, expected) => {
    expect(pct(part, whole)).toBe(expected);
  });

  it('is nothing with nothing to divide by', () => {
    expect(pct(0, 0)).toBeNull();
    expect(pct(5, 0)).toBeNull();
    expect(pct(5, -3)).toBeNull();
  });
});

describe('figuresOf', () => {
  it('adds ABSENT and LATE into ogiltig and divides each kind by the recorded minutes', () => {
    expect(figuresOf(raw(1000, 50, 20, 10, 2))).toEqual({
      recordedMinutes: 1000,
      validMinutes: 50,
      absentMinutes: 20,
      lateMinutes: 10,
      lateCount: 2,
      invalidMinutes: 30,
      validPct: 5,
      invalidPct: 3,
      totalPct: 8,
    });
  });

  it('has no share when nothing was recorded, and keeps the minutes', () => {
    expect(figuresOf(NO_FIGURES)).toEqual({ ...NO_FIGURES, invalidMinutes: 0, validPct: null, invalidPct: null, totalPct: null });
  });
});

describe('reportingOf', () => {
  it('is the reported lessons of the held, and nothing when none was held', () => {
    expect(reportingOf(40, 30)).toEqual({ held: 40, reported: 30, ratePct: 75 });
    expect(reportingOf(0, 0)).toEqual({ held: 0, reported: 0, ratePct: null });
  });
});

describe('addFigures', () => {
  it('adds each kind', () => {
    expect(addFigures(raw(10, 1, 2, 3, 4), raw(20, 2, 3, 4, 5))).toEqual(raw(30, 3, 5, 7, 9));
  });
});

describe('months', () => {
  it.each([
    ['2026-10-17', 0, '2026-10-01'],
    ['2026-10-17', 1, '2026-11-01'],
    ['2026-12-31', 1, '2027-01-01'],
    ['2026-01-05', -1, '2025-12-01'],
    ['2026-10-31', -12, '2025-10-01'],
    ['2026-03-31', -1, '2026-02-01'],
    ['2026-10-17', 14, '2027-12-01'],
  ])('%s shifted %i months is %s', (day, delta, expected) => {
    expect(shiftMonth(day, delta)).toBe(expected);
  });

  it('starts a month on its first day and ends it on its last, a leap february too', () => {
    expect(monthStart('2026-10-17')).toBe('2026-10-01');
    expect(monthEnd('2026-10-17')).toBe('2026-10-31');
    expect(monthEnd('2026-02-03')).toBe('2026-02-28');
    expect(monthEnd('2028-02-03')).toBe('2028-02-29');
    expect(monthEnd('2026-12-31')).toBe('2026-12-31');
  });

  it('counts the months between two days, both months included', () => {
    expect(monthsBetween('2026-10-17', '2026-12-02')).toEqual(['2026-10-01', '2026-11-01', '2026-12-01']);
    expect(monthsBetween('2026-10-01', '2026-10-31')).toEqual(['2026-10-01']);
    expect(monthsBetween('2026-12-02', '2026-10-17')).toEqual([]);
  });
});

describe('mergeMonth', () => {
  it('returns a single row as it is', () => {
    const only = row('2026-08-01');
    expect(mergeMonth([only])).toBe(only);
  });

  it('adds a class and its predecessor in the month of the handover, with both names and the latest day', () => {
    const merged = mergeMonth([
      row('2026-08-01', { classId: 'c7', className: '7A', throughDay: '2026-08-14', pupils: 20, pupilsRegistered: 18, figures: raw(100, 10, 5, 3, 1), lessonsHeld: 10, lessonsReported: 8 }),
      row('2026-08-01', { classId: 'c8', className: '8A', throughDay: '2026-08-31', pupils: 22, pupilsRegistered: 20, figures: raw(300, 30, 15, 6, 2), lessonsHeld: 30, lessonsReported: 29 }),
    ]);
    expect(merged).toEqual({
      month: '2026-08-01',
      throughDay: '2026-08-31',
      classId: null,
      className: '7A, 8A',
      pupils: 42,
      pupilsRegistered: 38,
      figures: raw(400, 40, 20, 9, 3),
      lessonsHeld: 40,
      lessonsReported: 37,
    });
  });

  it('has no figures if either part has none: a part that is missing is not zero', () => {
    const merged = mergeMonth([row('2026-08-01', { figures: null }), row('2026-08-01', { figures: raw(300, 30, 15, 6, 2) })]);
    expect(merged.figures).toBeNull();
    expect(mergeMonth([row('2026-08-01', { className: null }), row('2026-08-01', { className: null })]).className).toBeNull();
  });
});

describe('buildSeries', () => {
  it('is month by month in order, each with its shares and its reporting rate', () => {
    const series = buildSeries([row('2026-10-01'), row('2026-09-01', { lessonsHeld: 50, lessonsReported: 25 })]);
    expect(series.map((month) => month.month)).toEqual(['2026-09-01', '2026-10-01']);
    expect(series[0]).toMatchObject({
      partial: false,
      classNames: ['8A'],
      pupils: 24,
      pupilsRegistered: 24,
      reporting: { held: 50, reported: 25, ratePct: 50 },
      figures: { recordedMinutes: 1000, invalidMinutes: 30, totalPct: 8 },
      previousYear: null,
    });
  });

  it('compares a month with the same month a year before, when the series has it', () => {
    const series = buildSeries([
      row('2025-10-01', { figures: raw(1000, 0, 100, 0, 0), lessonsHeld: 10, lessonsReported: 5 }),
      row('2026-09-01'),
      row('2026-10-01', { figures: raw(1000, 0, 40, 0, 0) }),
    ]);
    const october = series.find((month) => month.month === '2026-10-01');
    expect(october?.previousYear).toMatchObject({
      month: '2025-10-01',
      figures: { invalidPct: 10 },
      reporting: { held: 10, reported: 5, ratePct: 50 },
    });
    expect(series.find((month) => month.month === '2026-09-01')?.previousYear).toBeNull();
    expect(series[0]?.previousYear).toBeNull();
  });

  it('keeps a month that has no figure, without a share, beside its lessons', () => {
    const series = buildSeries([row('2026-10-01', { figures: null, pupilsRegistered: 3 })]);
    expect(series[0]).toMatchObject({ figures: null, pupilsRegistered: 3, reporting: { ratePct: 90 } });
  });

  it('calls a month partial while its last day counted is before the month’s end', () => {
    const series = buildSeries([row('2026-11-01', { throughDay: '2026-11-06' }), row('2026-10-01')]);
    expect(series.map((month) => month.partial)).toEqual([false, true]);
  });

  it('names no class for the school, and every class of a merged month', () => {
    expect(buildSeries([row('2026-10-01', { classId: null, className: null })])[0]?.classNames).toEqual([]);
    expect(
      buildSeries([
        row('2026-08-01', { className: '7A', throughDay: '2026-08-20' }),
        row('2026-08-01', { className: '8A' }),
      ])[0]?.classNames,
    ).toEqual(['7A', '8A']);
  });
});

describe('buildClasses', () => {
  it('shapes each class with its figures and its rate, a class with no figure as none', () => {
    const [a, b] = buildClasses([
      { classId: 'c1', className: '8A', yearName: '2026/27', monthsCounted: 3, pupils: 24, pupilsRegistered: 24, figures: raw(1000, 50, 20, 10, 1), lessonsHeld: 100, lessonsReported: 80 },
      { classId: 'c2', className: '8B', yearName: null, monthsCounted: 0, pupils: 6, pupilsRegistered: 2, figures: null, lessonsHeld: 0, lessonsReported: 0 },
    ]);
    expect(a).toMatchObject({ classId: 'c1', className: '8A', yearName: '2026/27', monthsCounted: 3, figures: { totalPct: 8 }, reporting: { ratePct: 80 } });
    expect(b).toEqual({
      classId: 'c2',
      className: '8B',
      yearName: null,
      monthsCounted: 0,
      pupils: 6,
      pupilsRegistered: 2,
      figures: null,
      reporting: { held: 0, reported: 0, ratePct: null },
    });
  });
});

describe('buildPatterns', () => {
  const cell = (dimension: PatternRow['dimension'], key: string, label: string, figures: RawFigures | null, over: Partial<PatternRow> = {}): PatternRow => ({
    dimension,
    key,
    label,
    groupSize: 24,
    suppressed: false,
    figures,
    ...over,
  });

  it('puts the weekdays and the passes in order and the subjects by the share of absence, most first', () => {
    const view = buildPatterns([
      cell('WEEKDAY', '5', '', raw(100, 0, 10)),
      cell('WEEKDAY', '1', '', raw(100, 0, 20)),
      cell('SLOT', '10:00', '', raw(100, 0, 10)),
      cell('SLOT', '08:00', '', raw(100, 0, 30)),
      cell('SUBJECT', 's1', 'Svenska', raw(100, 0, 5)),
      cell('SUBJECT', 's2', 'Idrott', raw(100, 0, 25)),
      cell('SUBJECT', 's3', 'Bild', raw(200, 0, 50)),
      cell('SUBJECT', 's4', 'Matte', raw(50, 0, 12.5 as number)),
    ]);
    expect(view.weekdays.map((entry) => entry.key)).toEqual(['1', '5']);
    expect(view.slots.map((entry) => entry.key)).toEqual(['08:00', '10:00']);
    // Idrott, Bild and Matte share 25 %: the bigger base (Bild) first, then by name.
    expect(view.subjects.map((entry) => entry.label)).toEqual(['Bild', 'Idrott', 'Matte', 'Svenska']);
    expect(view.groupSize).toBe(24);
    expect(view.suppressed).toBe(false);
  });

  it('gives the key as the label where there is none', () => {
    expect(buildPatterns([cell('WEEKDAY', '3', '', raw(10))]).weekdays[0]).toMatchObject({ key: '3', label: '3' });
  });

  it('breaks a tie of share and base by the name in Swedish order, and then by the key', () => {
    const view = buildPatterns([
      cell('SUBJECT', 'b', 'Östasiatiska', raw(100, 0, 10)),
      cell('SUBJECT', 'a', 'Zebra', raw(100, 0, 10)),
      cell('SUBJECT', 'd', 'Zebra', raw(100, 0, 10)),
      cell('SUBJECT', 'c', 'Zebra', raw(100, 0, 10)),
    ]);
    expect(view.subjects.map((entry) => entry.key)).toEqual(['a', 'c', 'd', 'b']);
  });

  it('puts a cell with nothing recorded last', () => {
    const view = buildPatterns([cell('SUBJECT', 'x', 'Tom', raw(0)), cell('SUBJECT', 'y', 'Full', raw(100, 0, 1))]);
    expect(view.subjects.map((entry) => entry.label)).toEqual(['Full', 'Tom']);
  });

  it('is suppressed for a class of fewer than five, with no cells', () => {
    const view = buildPatterns([cell('ALL', '', '', null, { groupSize: 3, suppressed: true })]);
    expect(view).toEqual({ groupSize: 3, suppressed: true, weekdays: [], slots: [], subjects: [] });
  });

  it('is empty when there is no mark', () => {
    expect(buildPatterns([])).toEqual({ groupSize: 0, suppressed: false, weekdays: [], slots: [], subjects: [] });
  });
});

describe('a pupil’s months', () => {
  const months = ['2025-09-01', '2025-10-01', '2026-09-01', '2026-10-01'];

  it('has every month asked for, a month without a mark as none, and the same month a year before', () => {
    const view = buildPupilMonths(
      [
        { month: '2025-10-01', figures: raw(500, 0, 50, 0, 0), lessons: 10 },
        { month: '2026-10-01', figures: raw(500, 25, 0, 0, 0), lessons: 11 },
      ],
      months,
    );
    expect(view.map((month) => [month.month, month.figures?.totalPct ?? null, month.lessons])).toEqual([
      ['2025-09-01', null, 0],
      ['2025-10-01', 10, 10],
      ['2026-09-01', null, 0],
      ['2026-10-01', 5, 11],
    ]);
    expect(view[0]?.previousYear).toBeNull();
    expect(view[1]?.previousYear).toBeNull();
    expect(view[2]?.previousYear).toEqual({ month: '2025-09-01', figures: null });
    expect(view[3]?.previousYear).toMatchObject({ month: '2025-10-01', figures: { invalidPct: 10 } });
  });

  it('adds the months into a total, and has none for a pupil with no mark', () => {
    expect(totalOf([])).toBeNull();
    expect(
      totalOf([
        { month: '2025-10-01', figures: raw(500, 0, 50, 0, 0), lessons: 10 },
        { month: '2026-10-01', figures: raw(500, 25, 0, 10, 1), lessons: 11 },
      ]),
    ).toMatchObject({ recordedMinutes: 1000, validMinutes: 25, absentMinutes: 50, lateMinutes: 10, lateCount: 1, invalidMinutes: 60, totalPct: 8.5 });
  });
});
