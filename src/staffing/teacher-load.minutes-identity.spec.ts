import fixture from './__fixtures__/teacher-load-cases.json';
import {
  buildTeacherLoadReport,
  countedMinutesByTeacher,
  loadWeightOf,
  weigh,
  type LoadInput,
  type LoadRequirement,
} from './teacher-load';

/**
 * MINUTES SCHOOLS SEE NO FIGURE CHANGE — held as a property, not hoped for.
 *
 * Fas 3 put a weight on every teacher charge (Skola24's Faktor-modell). Every
 * school counts by MINUTES until an admin says otherwise, and for them the
 * report must be the double it always was. So every case of the shared
 * fixture is run with a RANDOM loadFactor on every subject, resolved the way
 * readLoadInput resolves it — loadWeightOf(policy.loadModel, factor) — and
 * the JSON is compared with the run that has no weights at all. Under MINUTES
 * the weight is 1 and weigh() returns its argument untouched, so the strings
 * must be equal byte for byte, not merely close.
 *
 * And the other edge: a school that chose FACTOR before Fas 3 has every
 * factor at 1.000 (the column's default), so its report must equal the
 * MINUTES one except for the model it names.
 *
 * A seeded generator, so a failure names a reproducible case.
 */

interface FixtureCase {
  name: string;
  input: LoadInput;
}

const { cases } = fixture as unknown as { cases: FixtureCase[] };

/** mulberry32: small, seeded, good enough to scatter factors over 0.5..3. */
function seeded(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** The input as readLoadInput would hand it over: weights resolved per subject. */
function weighted(input: LoadInput, model: 'MINUTES' | 'FACTOR', factorOf: (subjectId: string) => number): LoadInput {
  return {
    ...input,
    policy: input.policy ? { ...input.policy, loadModel: model } : null,
    requirements: input.requirements.map(
      (row): LoadRequirement => ({ ...row, loadWeight: loadWeightOf(model, factorOf(row.subjectId)) }),
    ),
  };
}

/** The input with no weight and no model: what every case looked like before Fas 3. */
function unweighted(input: LoadInput): LoadInput {
  return {
    ...input,
    requirements: input.requirements.map((row) => {
      const { loadWeight: _weight, ...rest } = row;
      return rest;
    }),
  };
}

const withoutModel = (report: object): string => {
  const { loadModel: _model, ...rest } = report as { loadModel: string };
  return JSON.stringify(rest);
};

describe('the load report under MINUTES is the same doubles whatever the subjects’ factors say', () => {
  it('has cases to run, the Fas 3 FACTOR case among them', () => {
    expect(cases.length).toBeGreaterThan(20);
    expect(cases.some((entry) => entry.input.policy?.loadModel === 'FACTOR')).toBe(true);
  });

  it.each(cases.map((entry, index) => [entry.name, entry, index] as const))(
    'MINUTES with random factors: %s',
    (_name, entry, index) => {
      // Cases whose own policy is FACTOR are measured against MINUTES too:
      // the property is about the model, not about the case.
      const random = seeded(20261009 + index);
      const factors = new Map<string, number>();
      const factorOf = (subjectId: string): number => {
        if (!factors.has(subjectId)) factors.set(subjectId, Math.round((0.5 + random() * 2.5) * 1000) / 1000);
        return factors.get(subjectId)!;
      };
      const base = unweighted(entry.input);
      const minutes = weighted(base, 'MINUTES', factorOf);
      expect(minutes.requirements.every((row) => row.loadWeight === 1)).toBe(true);
      const plain = buildTeacherLoadReport({
        ...base,
        policy: base.policy ? { ...base.policy, loadModel: 'MINUTES' } : null,
      });
      expect(JSON.stringify(buildTeacherLoadReport(minutes))).toBe(JSON.stringify(plain));
      // And the per-request figure the picker and the write checks read.
      expect([...countedMinutesByTeacher(minutes)]).toEqual([...countedMinutesByTeacher(base)]);
    },
  );

  it.each(cases.map((entry) => [entry.name, entry] as const))(
    'FACTOR with every factor at 1.000 differs only in the model it names: %s',
    (_name, entry) => {
      const base = unweighted(entry.input);
      const minutes = buildTeacherLoadReport({
        ...base,
        policy: base.policy ? { ...base.policy, loadModel: 'MINUTES' } : null,
      });
      const factor = buildTeacherLoadReport(weighted(base, 'FACTOR', () => 1));
      expect(withoutModel(factor)).toBe(withoutModel(minutes));
    },
  );
});

describe('loadWeightOf and weigh', () => {
  it('is 1 under MINUTES and without a model, whatever the factor', () => {
    for (const factor of [0.5, 0.7, 1, 2.999, null, undefined, Number.NaN]) {
      expect(loadWeightOf('MINUTES', factor)).toBe(1);
      expect(loadWeightOf(undefined, factor)).toBe(1);
      expect(loadWeightOf(null, factor)).toBe(1);
    }
  });

  it('is the factor under FACTOR, and 1 for a factor that is no positive number', () => {
    expect(loadWeightOf('FACTOR', 0.7)).toBe(0.7);
    expect(loadWeightOf('FACTOR', 1.25)).toBe(1.25);
    for (const factor of [null, undefined, 0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(loadWeightOf('FACTOR', factor)).toBe(1);
    }
  });

  it('returns the minutes themselves for weight 1 or none — not a product equal to them', () => {
    // 0.1 + 0.2 is the classic double that × 1 would keep anyway; the point
    // is that no multiplication happens, so no reader has to prove it.
    const minutes = 0.1 + 0.2;
    expect(Object.is(weigh(minutes, 1), minutes)).toBe(true);
    expect(Object.is(weigh(minutes, undefined), minutes)).toBe(true);
    expect(weigh(100, 0.7)).toBe(70);
  });
});
