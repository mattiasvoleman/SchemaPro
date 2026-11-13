import { sittingHoldsDay, sittingMeetsWindow, windowOf } from './lunch-window';

describe('lunch-window', () => {
  const autumn = { startDate: null, endDate: '2026-12-20' };
  const spring = { startDate: '2027-01-11', endDate: null };
  const wholeYear = { startDate: null, endDate: null };
  const march = { startDate: '2027-03-01', endDate: '2027-03-07' };

  describe('windowOf', () => {
    it('reads a @db.Date column as the day it is, and no date as the läsår’s own bound', () => {
      expect(windowOf({ startDate: new Date('2026-08-17T00:00:00.000Z'), endDate: null })).toEqual({
        startDate: '2026-08-17',
        endDate: null,
      });
      expect(windowOf({})).toEqual({ startDate: null, endDate: null });
    });
  });

  describe('sittingHoldsDay', () => {
    it('holds every day when it has no dates, as every meal did before they existed', () => {
      expect(sittingHoldsDay(wholeYear, '2026-08-15')).toBe(true);
      expect(sittingHoldsDay({}, '2099-01-01')).toBe(true);
    });

    it('holds both of its own ends and nothing outside them', () => {
      expect(sittingHoldsDay(march, '2027-03-01')).toBe(true);
      expect(sittingHoldsDay(march, '2027-03-07')).toBe(true);
      expect(sittingHoldsDay(march, '2027-02-28')).toBe(false);
      expect(sittingHoldsDay(march, '2027-03-08')).toBe(false);
    });

    it('is open at the end a null stands for', () => {
      expect(sittingHoldsDay(autumn, '2026-08-15')).toBe(true);
      expect(sittingHoldsDay(autumn, '2026-12-20')).toBe(true);
      expect(sittingHoldsDay(autumn, '2026-12-21')).toBe(false);
      expect(sittingHoldsDay(spring, '2027-01-10')).toBe(false);
      expect(sittingHoldsDay(spring, '2027-06-30')).toBe(true);
    });

    it('is one meal and never two on a date for the autumn and the spring that meet', () => {
      for (const day of ['2026-12-20', '2026-12-21', '2027-01-10', '2027-01-11']) {
        expect([autumn, spring].filter((sitting) => sittingHoldsDay(sitting, day)).length).toBeLessThanOrEqual(1);
      }
    });
  });

  describe('sittingMeetsWindow', () => {
    it('meets every lesson that has no window: the stricter reading', () => {
      expect(sittingMeetsWindow(autumn, null)).toBe(true);
      expect(sittingMeetsWindow(march, undefined)).toBe(true);
      expect(sittingMeetsWindow(march, wholeYear)).toBe(true);
    });

    it('does not meet a lesson of the other part of the year', () => {
      expect(sittingMeetsWindow(spring, { startDate: '2026-08-17', endDate: '2026-12-18' })).toBe(false);
      expect(sittingMeetsWindow(autumn, { startDate: '2027-01-11', endDate: '2027-06-11' })).toBe(false);
    });

    it('meets a lesson that shares one day with it, at either end', () => {
      expect(sittingMeetsWindow(autumn, { startDate: '2026-12-20', endDate: '2027-01-31' })).toBe(true);
      expect(sittingMeetsWindow(spring, { startDate: '2026-09-01', endDate: '2027-01-11' })).toBe(true);
    });

    it('meets a lesson that has only one bound as far as that bound reaches', () => {
      expect(sittingMeetsWindow(march, { startDate: '2027-03-08', endDate: null })).toBe(false);
      expect(sittingMeetsWindow(march, { startDate: null, endDate: '2027-02-28' })).toBe(false);
      expect(sittingMeetsWindow(march, { startDate: '2027-03-05', endDate: null })).toBe(true);
      expect(sittingMeetsWindow(march, { startDate: null, endDate: '2027-03-01' })).toBe(true);
    });

    it('is symmetric: the lesson is clear of the meal exactly when the meal is clear of the lesson', () => {
      const windows = [wholeYear, autumn, spring, march, { startDate: '2026-10-05', endDate: '2026-10-11' }];
      for (const a of windows) {
        for (const b of windows) {
          expect(sittingMeetsWindow(a, b)).toBe(sittingMeetsWindow(b, a));
        }
      }
    });
  });
});
