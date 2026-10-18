import {
  CANDIDATE_VARIANTS,
  callTimeoutMs,
  isGenerateRequest,
  leaseSecondsFor,
  refreshWeights,
  searchFor,
  snapshotNameOf,
  variantOf,
  variantsFor,
  weightsFor,
} from './candidate-variants';

const SETTINGS = { maxSeconds: 30, workers: 4 };

describe('the variant table (design §1)', () => {
  it('is KEEP, TEACHER_GAPS, SPREAD, FREE, in ordinal order, with their Swedish labels', () => {
    expect(CANDIDATE_VARIANTS.map(({ ordinal, code, label }) => [ordinal, code, label])).toEqual([
      [1, 'KEEP', 'Behåll mest'],
      [2, 'TEACHER_GAPS', 'Färre håltimmar för lärarna'],
      [3, 'SPREAD', 'Jämnare veckor'],
      [4, 'FREE', 'Friare placering'],
    ]);
  });

  it('gives KEEP no override and no seed, and every other variant a seed of its own and a code the database accepts', () => {
    expect(CANDIDATE_VARIANTS[0]).toMatchObject({ overrides: {}, seed: null });
    const seeds = CANDIDATE_VARIANTS.slice(1).map((variant) => variant.seed);
    expect(new Set(seeds).size).toBe(seeds.length);
    for (const variant of CANDIDATE_VARIANTS) expect(variant.code).toMatch(/^[A-Z][A-Z0-9_]{0,31}$/);
  });

  it('asks a run of 2 for KEEP and TEACHER_GAPS, of 3 for SPREAD too, of 4 for all, and holds a count to 2..4', () => {
    expect(variantsFor(2).map((v) => v.code)).toEqual(['KEEP', 'TEACHER_GAPS']);
    expect(variantsFor(3).map((v) => v.code)).toEqual(['KEEP', 'TEACHER_GAPS', 'SPREAD']);
    expect(variantsFor(4).map((v) => v.code)).toEqual(['KEEP', 'TEACHER_GAPS', 'SPREAD', 'FREE']);
    expect(variantsFor(1)).toHaveLength(2);
    expect(variantsFor(9)).toHaveLength(4);
  });

  it('finds a variant by its code, and only KEEP is Generera\'s own request', () => {
    expect(variantOf('SPREAD')?.ordinal).toBe(3);
    expect(variantOf('LATER')).toBeUndefined();
    expect(isGenerateRequest('KEEP')).toBe(true);
    expect(isGenerateRequest('FREE')).toBe(false);
  });
});

describe('weights', () => {
  it('lays the overrides over the run\'s base, and KEEP over no base sends none', () => {
    expect(weightsFor({ disruption: 20, spread: 4 }, variantOf('TEACHER_GAPS')!)).toEqual({ disruption: 2, spread: 4, teacherGap: 8 });
    expect(weightsFor({ spread: 4 }, variantOf('KEEP')!)).toEqual({ spread: 4 });
    expect(weightsFor(null, variantOf('KEEP')!)).toBeNull();
    expect(weightsFor(undefined, variantOf('FREE')!)).toEqual({ disruption: 0 });
  });

  it('raises a refresh\'s disruption to the floor of 40, and keeps a higher one', () => {
    expect(refreshWeights({ disruption: 2, teacherGap: 8 })).toEqual({ disruption: 40, teacherGap: 8 });
    expect(refreshWeights(null)).toEqual({ disruption: 40 });
    expect(refreshWeights({ disruption: 90 })).toEqual({ disruption: 90 });
  });
});

describe('search, timeouts and the lease', () => {
  it('sends KEEP as the lead with the workers, the probes and the candidate budget, and no seed', () => {
    // One budget for every candidate: the emphases are compared at it (docs/verification-baseline.md).
    expect(searchFor({ variant: 'KEEP', seed: null, lead: true }, SETTINGS)).toEqual({ workers: 4, probes: true, maxSeconds: 30 });
  });

  it('sends every other variant its seed and the candidate budget, without the probes', () => {
    expect(searchFor({ variant: 'SPREAD', seed: 2, lead: false }, SETTINGS)).toEqual({
      workers: 4,
      probes: false,
      maxSeconds: 30,
      seed: 2,
    });
    expect(searchFor({ variant: 'LATER', seed: null, lead: false }, SETTINGS)).toEqual({ workers: 4, probes: false, maxSeconds: 30 });
  });

  it('waits (budget + 45 + probe 20) seconds a call: 95 s for the lead, 75 s for the others, at a budget of 30', () => {
    expect(callTimeoutMs({ variant: 'KEEP', seed: null, lead: true }, SETTINGS)).toBe(95_000);
    expect(callTimeoutMs({ variant: 'TEACHER_GAPS', seed: 1, lead: false }, SETTINGS)).toBe(75_000);
    // A refresh whose first candidate is not KEEP still probes.
    expect(callTimeoutMs({ variant: 'FREE', seed: 3, lead: true }, { maxSeconds: 120, workers: 1 })).toBe(185_000);
  });

  it('leases a run twice its longest call, within 60..3600 s', () => {
    const calls = [
      { variant: 'KEEP', seed: null, lead: true },
      { variant: 'TEACHER_GAPS', seed: 1, lead: false },
    ];
    expect(leaseSecondsFor(calls, SETTINGS)).toBe(190);
    expect(leaseSecondsFor([], SETTINGS)).toBe(60);
  });
});

describe('snapshotNameOf', () => {
  it('names the safety version by the ordinal and the Swedish label, or the ordinal alone for a code it does not know', () => {
    expect(snapshotNameOf(2, 'TEACHER_GAPS')).toBe('Före schemaförslag 2 – Färre håltimmar för lärarna');
    expect(snapshotNameOf(3, 'LATER')).toBe('Före schemaförslag 3');
  });
});
