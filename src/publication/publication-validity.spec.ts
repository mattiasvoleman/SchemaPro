import {
  classifyOverlap,
  effectiveSegments,
  nextDay,
  uncoveredRanges,
  validOn,
  type PublicationRange,
} from './publication-validity';

const pub = (id: string, at: string, validFrom: string, validTo: string): PublicationRange => ({
  id,
  publishedAt: at,
  validFrom,
  validTo,
});

describe('which publication is valid when', () => {
  it('steps a day across month and year ends', () => {
    expect(nextDay('2026-12-31')).toBe('2027-01-01');
    expect(nextDay('2027-03-01', -1)).toBe('2027-02-28');
  });

  it('gives an HT publication the autumn and a later VT one the spring', () => {
    const ht = pub('ht', '2026-08-10T08:00:00Z', '2026-08-17', '2027-06-11');
    const vt = pub('vt', '2026-12-15T08:00:00Z', '2027-01-11', '2027-06-11');
    expect(effectiveSegments([vt, ht])).toEqual([
      { publicationId: 'ht', from: '2026-08-17', to: '2027-01-10' },
      { publicationId: 'vt', from: '2027-01-11', to: '2027-06-11' },
    ]);
    expect(validOn([ht, vt], '2026-12-20')).toBe('ht');
    expect(validOn([ht, vt], '2027-01-11')).toBe('vt');
    expect(validOn([ht, vt], '2026-08-16')).toBeNull();
  });

  it('lets an earlier publication show through on both sides of a later one inside it', () => {
    const year = pub('year', '2026-08-01T00:00:00Z', '2026-08-17', '2027-06-11');
    const week = pub('week', '2026-09-01T00:00:00Z', '2026-10-05', '2026-10-09');
    expect(effectiveSegments([year, week])).toEqual([
      { publicationId: 'year', from: '2026-08-17', to: '2026-10-04' },
      { publicationId: 'week', from: '2026-10-05', to: '2026-10-09' },
      { publicationId: 'year', from: '2026-10-10', to: '2027-06-11' },
    ]);
  });

  it('orders two publications of the same instant by id, so the answer never flips', () => {
    const a = pub('a', '2026-09-01T00:00:00Z', '2026-09-01', '2026-09-30');
    const b = pub('b', '2026-09-01T00:00:00Z', '2026-09-10', '2026-09-20');
    expect(validOn([b, a], '2026-09-15')).toBe('b');
    expect(validOn([a, b], '2026-09-15')).toBe('b');
  });

  it('merges a publication republished over its own range into one segment', () => {
    const first = pub('x', '2026-09-01T00:00:00Z', '2026-09-01', '2026-09-30');
    const again = pub('x', '2026-09-02T00:00:00Z', '2026-09-10', '2026-10-15');
    expect(effectiveSegments([first, again])).toEqual([{ publicationId: 'x', from: '2026-09-01', to: '2026-10-15' }]);
  });

  it('judges an overlap on the future part only', () => {
    const segments = effectiveSegments([pub('year', '2026-08-01T00:00:00Z', '2026-08-17', '2027-06-11')]);
    // From today to the end: the past is not replaced, so this is FULL.
    expect(classifyOverlap(segments, '2026-10-12', '2027-06-11', '2026-10-12')).toEqual([
      { publicationId: 'year', from: '2026-10-12', to: '2027-06-11', kind: 'FULL' },
    ]);
    expect(classifyOverlap(segments, '2027-01-11', '2027-06-11', '2026-10-12')[0].kind).toBe('TAIL');
    expect(classifyOverlap(segments, '2026-10-12', '2026-12-18', '2026-10-12')[0].kind).toBe('HEAD');
    expect(classifyOverlap(segments, '2026-11-02', '2026-11-06', '2026-10-12')[0].kind).toBe('SPLIT');
    expect(classifyOverlap(segments, '2026-08-17', '2026-09-30', '2026-10-12')).toEqual([]);
  });

  it('finds the dates no segment covers', () => {
    const segments = effectiveSegments([
      pub('ht', '2026-08-01T00:00:00Z', '2026-08-17', '2026-12-18'),
      pub('vt', '2026-12-01T00:00:00Z', '2027-01-18', '2027-06-11'),
    ]);
    expect(uncoveredRanges(segments, '2026-10-12', '2027-06-30')).toEqual([
      { from: '2026-12-19', to: '2027-01-17' },
      { from: '2027-06-12', to: '2027-06-30' },
    ]);
    expect(uncoveredRanges([], '2026-10-12', '2026-10-14')).toEqual([{ from: '2026-10-12', to: '2026-10-14' }]);
  });
});
