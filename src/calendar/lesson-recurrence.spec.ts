import { isoWeekNumber, runsOn, weeksCanOverlap } from './lesson-recurrence';

const date = (iso: string) => new Date(`${iso}T00:00:00.000Z`);

const window = (overrides: Partial<Parameters<typeof runsOn>[0]> = {}) => ({
  recurrence: 'ALL_WEEKS' as const,
  startDate: null,
  endDate: null,
  ...overrides,
});

describe('isoWeekNumber', () => {
  it('matches the week numbers a Swedish school reads off its calendar', () => {
    expect(isoWeekNumber(date('2026-08-17'))).toBe(34);
    expect(isoWeekNumber(date('2026-08-24'))).toBe(35);
    expect(isoWeekNumber(date('2026-06-11'))).toBe(24);
  });

  it('handles the year boundary the way ISO-8601 defines it', () => {
    // The week belongs to the year holding its Thursday, so a late-December
    // date can be week 1 and an early-January date can be week 53. Getting
    // this wrong flips the parity of the whole spring term.
    expect(isoWeekNumber(date('2025-12-29'))).toBe(1); // Monday of 2026 w1
    expect(isoWeekNumber(date('2027-01-01'))).toBe(53); // still 2026 w53
    expect(isoWeekNumber(date('2026-01-01'))).toBe(1);
  });

  it('anchors on the first Thursday in a year whose 4 January is not a Sunday', () => {
    // 2026 opens on a Thursday, so its 4 January is a Sunday — and every date
    // above resolves its week in 2026, where an anchor that always assumed a
    // Sunday gets the right answer by accident. 2027's 4 January is a Monday:
    // assume Sunday there and every week of the spring term is numbered one
    // too high, which flips the parity of each alternating lesson in it.
    expect(isoWeekNumber(date('2027-01-11'))).toBe(2);
    expect(isoWeekNumber(date('2027-06-14'))).toBe(24);
  });

  it('gives every day of one week the same number', () => {
    const numbers = [
      '2026-08-17',
      '2026-08-18',
      '2026-08-19',
      '2026-08-20',
      '2026-08-21',
      '2026-08-22',
      '2026-08-23',
    ].map((iso) => isoWeekNumber(date(iso)));

    expect(new Set(numbers)).toEqual(new Set([34]));
  });
});

describe('runsOn', () => {
  it('runs every week by default', () => {
    expect(runsOn(window(), date('2026-08-17'))).toBe(true);
    expect(runsOn(window(), date('2026-08-24'))).toBe(true);
  });

  it('runs only on odd weeks when asked to', () => {
    expect(runsOn(window({ recurrence: 'ODD_WEEKS' }), date('2026-08-17'))).toBe(false); // w34
    expect(runsOn(window({ recurrence: 'ODD_WEEKS' }), date('2026-08-24'))).toBe(true); // w35
  });

  it('runs only on even weeks when asked to', () => {
    expect(runsOn(window({ recurrence: 'EVEN_WEEKS' }), date('2026-08-17'))).toBe(true);
    expect(runsOn(window({ recurrence: 'EVEN_WEEKS' }), date('2026-08-24'))).toBe(false);
  });

  it('stops after the end date — the half-term case', () => {
    const halfTerm = window({ endDate: date('2026-10-30') });

    expect(runsOn(halfTerm, date('2026-10-30'))).toBe(true); // inclusive
    expect(runsOn(halfTerm, date('2026-10-31'))).toBe(false);
  });

  it('does not start before the start date', () => {
    const springOnly = window({ startDate: date('2027-01-11') });

    expect(runsOn(springOnly, date('2027-01-10'))).toBe(false);
    expect(runsOn(springOnly, date('2027-01-11'))).toBe(true);
  });

  it('applies parity and period together', () => {
    const oddUntilAutumn = window({
      recurrence: 'ODD_WEEKS',
      endDate: date('2026-10-30'),
    });

    expect(runsOn(oddUntilAutumn, date('2026-08-24'))).toBe(true); // odd, in period
    expect(runsOn(oddUntilAutumn, date('2026-08-17'))).toBe(false); // even week
    expect(runsOn(oddUntilAutumn, date('2026-11-02'))).toBe(false); // past the end
  });
});

describe('a missing recurrence', () => {
  it('is read as every week, not as a parity nobody matches', () => {
    // Only reachable if a query forgets the column. Every week is the old
    // behaviour; guessing a parity would drop half a school's lessons and
    // look like data loss.
    const noField = { startDate: null, endDate: null };

    expect(runsOn(noField, date('2026-08-17'))).toBe(true);
    expect(runsOn(noField, date('2026-08-24'))).toBe(true);
  });

  it('still clashes with everything in the conflict checker', () => {
    expect(
      weeksCanOverlap({ startDate: null, endDate: null }, window({ recurrence: 'ODD_WEEKS' })),
    ).toBe(true);
  });
});

describe('weeksCanOverlap', () => {
  it('lets opposite parities share a slot', () => {
    // The whole point: slöjd on odd weeks and hemkunskap on even weeks may sit
    // in the same time, room and teacher.
    expect(
      weeksCanOverlap(
        window({ recurrence: 'ODD_WEEKS' }),
        window({ recurrence: 'EVEN_WEEKS' }),
      ),
    ).toBe(false);
  });

  it('still clashes when one of them runs every week', () => {
    expect(
      weeksCanOverlap(window(), window({ recurrence: 'ODD_WEEKS' })),
    ).toBe(true);
  });

  it('clashes when both are on the same parity', () => {
    expect(
      weeksCanOverlap(
        window({ recurrence: 'ODD_WEEKS' }),
        window({ recurrence: 'ODD_WEEKS' }),
      ),
    ).toBe(true);
  });

  it('lets consecutive half-terms share a slot', () => {
    const autumn = window({ endDate: date('2026-10-30') });
    const winter = window({ startDate: date('2026-11-02') });

    expect(weeksCanOverlap(autumn, winter)).toBe(false);
    expect(weeksCanOverlap(winter, autumn)).toBe(false); // order must not matter
  });

  it('clashes when the periods touch on a single day', () => {
    const first = window({ endDate: date('2026-10-30') });
    const second = window({ startDate: date('2026-10-30') });

    expect(weeksCanOverlap(first, second)).toBe(true);
    // Order must not matter here either: each order is checked by its own
    // comparison, and a touch is a clash in both.
    expect(weeksCanOverlap(second, first)).toBe(true);
  });

  it('clashes when either period is open-ended', () => {
    // Unsure means clash: a false alarm is an annoyance, a missed one puts two
    // classes in the same room.
    expect(weeksCanOverlap(window({ endDate: date('2026-10-30') }), window())).toBe(
      true,
    );
  });
});
