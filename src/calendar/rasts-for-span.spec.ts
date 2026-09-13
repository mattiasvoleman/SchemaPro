import { rastsForSpan, type RastRow } from './rasts-for-span';

/**
 * The rule publish dates a class's rasts by, on its own.
 *
 * CalendarService.publish reaches it through one fixture per case, so what it
 * pins there is that a weekday row replaces an every-day row it overlaps. The
 * edges of that overlap, the edges of a span of years and the order a pupil
 * reads the day in are this function's, and web/lib/rasts.ts and the engine's
 * rasts.py must give the same answer at every one of them.
 */

const MONDAY = 1;
const TUESDAY = 2;

/** A rast row as Prisma hands it back: `@db.Time` values on the epoch day. */
const rast = (
  name: string,
  start: string,
  end: string,
  overrides: Partial<RastRow> = {},
): RastRow => ({
  name,
  minGradeLevel: 4,
  maxGradeLevel: 6,
  dayOfWeek: null,
  startTime: new Date(`1970-01-01T${start}:00.000Z`),
  endTime: new Date(`1970-01-01T${end}:00.000Z`),
  ...overrides,
});

const names = (rows: RastRow[]) => rows.map((row) => row.name);

describe('rastsForSpan', () => {
  describe('the years a rast reaches', () => {
    // Both ends of the span are inclusive: a rast declared for åk 4–6 is åk 4's
    // and åk 6's. A class is one year, so it is the same overlap test the web
    // preview runs on a span, with min equal to max.
    it.each([
      ['the lowest year of its span', 4, ['Förmiddag']],
      ['the highest year of its span', 6, ['Förmiddag']],
      ['no year above it', 7, []],
      ['no year below it', 3, []],
    ])('reaches %s', (_label, grade, expected) => {
      const rows = [rast('Förmiddag', '09:40', '10:00')];

      expect(names(rastsForSpan(rows, grade, MONDAY))).toEqual(expected);
    });
  });

  describe('a row for one weekday', () => {
    it('belongs to that weekday only', () => {
      // Not an every-day row with a note on it: on a Monday a Tuesday row is
      // simply not there, whether or not anything overlaps it.
      const rows = [rast('Tisdagsrast', '09:30', '09:50', { dayOfWeek: TUESDAY })];

      expect(names(rastsForSpan(rows, 5, MONDAY))).toEqual([]);
      expect(names(rastsForSpan(rows, 5, TUESDAY))).toEqual(['Tisdagsrast']);
    });

    it('replaces an every-day row it overlaps', () => {
      const rows = [
        rast('Varje dag', '09:40', '10:00'),
        rast('Måndag', '09:30', '09:50', { dayOfWeek: MONDAY }),
      ];

      expect(names(rastsForSpan(rows, 5, MONDAY))).toEqual(['Måndag']);
    });

    /*
     * Overlap is strict at both ends, as a lesson's is: a rast that ends at
     * 09:30 and one that starts at 09:30 are back to back, and both happen.
     * Reading a touch as an overlap deletes a stage's break from the day for
     * every pupil in it.
     */
    it.each([
      ['ends as the weekday row begins', '09:15', '09:30', ['Varje dag', 'Måndag']],
      ['is over before the weekday row begins', '09:00', '09:15', ['Varje dag', 'Måndag']],
      ['begins as the weekday row ends', '09:50', '10:10', ['Måndag', 'Varje dag']],
      ['begins after the weekday row is over', '13:00', '13:15', ['Måndag', 'Varje dag']],
    ])('leaves an every-day row that %s', (_label, start, end, expected) => {
      const rows = [
        rast('Varje dag', start, end),
        rast('Måndag', '09:30', '09:50', { dayOfWeek: MONDAY }),
      ];

      expect(names(rastsForSpan(rows, 5, MONDAY))).toEqual(expected);
    });
  });

  it('lists the day in the order its rasts happen', () => {
    // Publish writes them in this order and a pupil reads them in it. Handed
    // back as the rows came — the weekday row first, then the every-day rows as
    // stored — a Monday would open on its last break.
    const rows = [
      rast('Eftermiddag', '13:00', '13:15'),
      rast('Lunchrast', '11:30', '12:00'),
      rast('Sista rasten', '14:30', '14:45', { dayOfWeek: MONDAY }),
      rast('Förmiddag', '09:40', '10:00'),
    ];

    expect(names(rastsForSpan(rows, 5, MONDAY))).toEqual([
      'Förmiddag',
      'Lunchrast',
      'Eftermiddag',
      'Sista rasten',
    ]);
  });
});
