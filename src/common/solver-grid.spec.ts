import { SLOT_MINUTES, fitsTheGrid, minutesOf } from './solver-grid';

/**
 * The grid is the engine's, restated here so the API can refuse a length while
 * it is being typed. What these pin is the refusal, not the constants: a lesson
 * length the engine cannot turn into whole slots must be refused here, because
 * the engine refuses it only after somebody has pressed "generera".
 */
describe('solver grid', () => {
  describe('fitsTheGrid', () => {
    it.each([40, 45, 50, 60, 5])('accepts a %i-minute lesson, which is whole slots', (minutes) => {
      expect(fitsTheGrid(minutes)).toBe(true);
    });

    it('refuses a length that leaves a remainder on the grid', () => {
      // An integer, and a positive one: only the slot arithmetic can refuse it.
      expect(fitsTheGrid(42)).toBe(false);
    });

    it.each([
      ['a lesson of no minutes', 0],
      ['a negative length', -45],
    ])('refuses %s, although it divides evenly into slots', (_label, minutes) => {
      // 0 and -45 both leave no remainder. A lesson still has to take up time,
      // or the engine is asked to place something that occupies no slot.
      expect(minutes % SLOT_MINUTES === 0).toBe(true);
      expect(fitsTheGrid(minutes)).toBe(false);
    });

    it('refuses a length that is not a whole number of minutes', () => {
      expect(fitsTheGrid(42.5)).toBe(false);
    });
  });

  describe('minutesOf', () => {
    it.each([
      ['08:00', 480],
      ['08:05:00', 485],
      ['17:55', 17 * 60 + 55],
    ])('reads %s as minutes past midnight', (time, minutes) => {
      expect(minutesOf(time)).toBe(minutes);
    });

    it('reads a bare hour as the top of that hour', () => {
      expect(minutesOf('9')).toBe(540);
    });
  });
});
