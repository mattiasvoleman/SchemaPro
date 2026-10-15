import { changesDuringYear, postOfWeek, postOn, postStretches, type LoadPeriod } from './employment-periods';

const YEAR = { startDate: '2026-08-17', endDate: '2027-06-11' };

const base = { employmentPercent: 100, reductionPercent: 0, teachingTargetMinutesPerWeek: null };
const period = (overrides: Partial<LoadPeriod>): LoadPeriod => ({
  validFrom: '2026-11-01',
  validTo: null,
  employmentPercent: 80,
  reductionPercent: 0,
  teachingTargetMinutesPerWeek: null,
  ...overrides,
});

describe('postOn: the post on a date', () => {
  const post = {
    ...base,
    contractKind: 'FERIE',
    periods: [period({ validTo: '2027-01-31' }), period({ validFrom: '2027-04-01', employmentPercent: 50 })],
  };

  it('is the base row on a day no period covers, and a period on each of its days, both bounds included', () => {
    expect(postOn(post, '2026-10-31').employmentPercent).toBe(100);
    expect(postOn(post, '2026-11-01').employmentPercent).toBe(80);
    expect(postOn(post, '2027-01-31').employmentPercent).toBe(80);
    expect(postOn(post, '2027-02-01').employmentPercent).toBe(100);
    // An open Till runs to the end of the year.
    expect(postOn(post, '2027-06-11').employmentPercent).toBe(50);
  });

  it('changes the three figures a period states and nothing else of the post', () => {
    const on = postOn({ ...post, teachingTargetMinutesPerWeek: 900, reductionPercent: 10 }, '2026-12-01');
    expect(on).toMatchObject({ employmentPercent: 80, reductionPercent: 0, teachingTargetMinutesPerWeek: null, contractKind: 'FERIE' });
  });
});

describe('postOfWeek: the post one week is judged by', () => {
  const post = { ...base, contractKind: 'FERIE', periods: [period({ validFrom: '2026-11-04' })] };

  it('is the post in force on the week’s Monday, so a period from a Wednesday holds from the next week', () => {
    // Monday 2 November is before the period: that week is the post's own, Wednesday or not.
    expect(postOfWeek(post, '2026-11-06', YEAR).employmentPercent).toBe(100);
    expect(postOfWeek(post, '2026-11-09', YEAR).employmentPercent).toBe(80);
    expect(postOfWeek({ ...post, periods: [period({ validFrom: '2026-11-02' })] }, '2026-11-04', YEAR).employmentPercent).toBe(80);
  });

  it('judges a first week that starts before the läsår by the läsår’s first day', () => {
    const year = { startDate: '2026-08-19', endDate: '2027-06-11' };
    const fromTheStart = { ...post, periods: [period({ validFrom: '2026-08-19', validTo: '2026-08-30' })] };
    expect(postOfWeek(fromTheStart, '2026-08-21', year).employmentPercent).toBe(80);
    // Without the year, the Monday before it: no period covers that day.
    expect(postOfWeek(fromTheStart, '2026-08-21', null).employmentPercent).toBe(100);
  });
});

describe('postStretches: the year cut into whole weeks', () => {
  it('is the year itself for a post without periods', () => {
    expect(postStretches(base, YEAR)).toEqual([
      { from: '2026-08-17', to: '2027-06-11', kind: 'BASE', figures: base, window: YEAR },
    ]);
    expect(changesDuringYear({ periods: [] }, YEAR)).toBe(false);
    expect(changesDuringYear(null, YEAR)).toBe(false);
  });

  it('gives a period from Sunday 1 november the week of Monday 2 november, and the base row the week before', () => {
    const stretches = postStretches({ ...base, periods: [period({})] }, YEAR);
    expect(stretches.map(({ from, to, kind, window }) => ({ from, to, kind, window }))).toEqual([
      { from: '2026-08-17', to: '2026-10-31', kind: 'BASE', window: { startDate: '2026-08-17', endDate: '2026-11-01' } },
      { from: '2026-11-01', to: '2027-06-11', kind: 'PERIOD', window: { startDate: '2026-11-02', endDate: '2027-06-11' } },
    ]);
    expect(stretches[1]!.figures.employmentPercent).toBe(80);
  });

  it('starts a period from a Wednesday the next Monday, and gives the base row back after its Till', () => {
    const stretches = postStretches({ ...base, periods: [period({ validFrom: '2026-11-04', validTo: '2027-01-31' })] }, YEAR);
    expect(stretches.map(({ from, to, kind, window }) => [from, to, kind, window?.startDate, window?.endDate])).toEqual([
      ['2026-08-17', '2026-11-03', 'BASE', '2026-08-17', '2026-11-08'],
      ['2026-11-04', '2027-01-31', 'PERIOD', '2026-11-09', '2027-01-31'],
      ['2027-02-01', '2027-06-11', 'BASE', '2027-02-01', '2027-06-11'],
    ]);
  });

  it('gives a period that holds no Monday no week, and its weeks to the base row around it', () => {
    const stretches = postStretches({ ...base, periods: [period({ validFrom: '2026-11-10', validTo: '2026-11-13' })] }, YEAR);
    expect(stretches.map(({ kind, window }) => [kind, window?.startDate ?? null, window?.endDate ?? null])).toEqual([
      ['BASE', '2026-08-17', '2026-11-15'],
      ['PERIOD', null, null],
      ['BASE', '2026-11-16', '2027-06-11'],
    ]);
  });

  it('orders periods by Från, cuts them to the year and drops the ones outside it', () => {
    const stretches = postStretches(
      {
        ...base,
        periods: [
          period({ validFrom: '2027-03-01', validTo: null, employmentPercent: 60 }),
          period({ validFrom: '2026-06-01', validTo: '2026-09-06', employmentPercent: 90 }),
          period({ validFrom: '2027-08-01', validTo: null, employmentPercent: 10 }),
        ],
      },
      YEAR,
    );
    expect(stretches.map(({ from, to, kind, figures }) => [from, to, kind, figures.employmentPercent])).toEqual([
      ['2026-08-17', '2026-09-06', 'PERIOD', 90],
      ['2026-09-07', '2027-02-28', 'BASE', 100],
      ['2027-03-01', '2027-06-11', 'PERIOD', 60],
    ]);
  });

  it('reads a year that starts mid-week by its first day', () => {
    const year = { startDate: '2026-08-19', endDate: '2027-06-11' };
    const stretches = postStretches({ ...base, periods: [period({ validFrom: '2026-08-19', validTo: '2026-08-21' })] }, year);
    // The first week's Monday is before the year: the post in force on 19 August holds it.
    expect(stretches[0]).toMatchObject({ kind: 'PERIOD', window: { startDate: '2026-08-19', endDate: '2026-08-23' } });
    expect(stretches[1]).toMatchObject({ kind: 'BASE', window: { startDate: '2026-08-24', endDate: '2027-06-11' } });
  });

  it('covers every week of the year once, whatever the periods', () => {
    const stretches = postStretches(
      {
        ...base,
        periods: [
          period({ validFrom: '2026-09-02', validTo: '2026-09-03' }),
          period({ validFrom: '2026-10-14', validTo: '2026-12-22' }),
          period({ validFrom: '2027-02-17', validTo: '2027-02-17' }),
          period({ validFrom: '2027-05-30', validTo: null }),
        ],
      },
      YEAR,
    );
    const windows = stretches.flatMap((stretch) => (stretch.window ? [stretch.window] : []));
    expect(windows[0]!.startDate).toBe(YEAR.startDate);
    expect(windows[windows.length - 1]!.endDate).toBe(YEAR.endDate);
    for (let i = 1; i < windows.length; i += 1) {
      const dayAfter = new Date(Date.parse(`${windows[i - 1]!.endDate}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
      expect(windows[i]!.startDate).toBe(dayAfter);
      expect(new Date(`${windows[i]!.startDate}T00:00:00Z`).getUTCDay()).toBe(1);
    }
    // And the dates the school stated cover every day once.
    for (let i = 1; i < stretches.length; i += 1) {
      const dayAfter = new Date(Date.parse(`${stretches[i - 1]!.to}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
      expect(stretches[i]!.from).toBe(dayAfter);
    }
  });
});
