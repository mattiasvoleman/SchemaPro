import { HARD_OFFERED, offeredMode } from './placement-modes';

describe('placement-modes', () => {
  it('offers rule 3 hard and neither of the other two', () => {
    expect(HARD_OFFERED).toEqual({ edge: false, places: false, shared: true });
  });

  it('reads a HARD that is not offered as SOFT, and everything else as stored', () => {
    expect(offeredMode('edge', 'HARD')).toBe('SOFT');
    expect(offeredMode('places', 'HARD')).toBe('SOFT');
    expect(offeredMode('shared', 'HARD')).toBe('HARD');
    for (const rule of ['edge', 'places', 'shared'] as const) {
      expect(offeredMode(rule, 'OFF')).toBe('OFF');
      expect(offeredMode(rule, 'SOFT')).toBe('SOFT');
      expect(offeredMode(rule, null)).toBeNull();
      expect(offeredMode(rule, undefined)).toBeUndefined();
    }
  });
});
