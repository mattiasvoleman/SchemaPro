import {
  WEEK_BOUNDS_EXTRA_KEYS,
  WEEK_BOUNDS_RESPONSE_KEYS,
  WEEK_BOUNDS_ROW_KEYS,
  type AiEngineWeekBoundsExtra,
  type AiEngineWeekBoundsResponse,
  type AiEngineWeekBoundsRow,
} from './interfaces/staffing-search.interface';
import { cutoffsOf, readEvaluation } from './staffing-search';
import { WEEK_BOUNDS_PATH } from './staffing-search.service';

/**
 * Lärarval F3's wire contract with the engine's exact week count, pinned from the gateway's side.
 *
 * The engine's models (optimization-engine/app/schemas/week_bounds.py) forbid extra fields, and its request IS Generera's
 * plus three optional fields: a name changed on one side only is a 422 for the whole request or a key this gateway never reads.
 * The mirror of these lists is tests/test_week_bounds.py (RESPONSE_KEYS, ROW_KEYS, REQUEST_EXTRA_KEYS and the OpenAPI
 * properties); either half failing means the two sides have parted company. Fix the code, not the list, and change both
 * halves in the commit that deploys the engine.
 *
 * The engine deploys with the API on every merge, so an API that is the newer of the two meets an engine without the route (a
 * 404, read as ENGINE_OLDER) and the engine that is the newer meets an API that never asks: nothing here is needed by the other
 * side to boot.
 */
const RESPONSE_FIELDS = ['deadlineHit', 'elapsedMs', 'refusal', 'requestId', 'rows', 'weeksCounted', 'weeksTotal'];
const ROW_FIELDS = ['capacityMinutes', 'converged', 'cutoff', 'demandMinutes', 'over', 'parity', 'period', 'year'];
const EXTRA_FIELDS = ['cutoffs', 'seconds', 'years'];

const row = (): AiEngineWeekBoundsRow => ({
  year: 9,
  period: 0,
  parity: null,
  demandMinutes: 2355,
  capacityMinutes: 2350,
  over: true,
  converged: true,
  cutoff: false,
});

/** Every field the engine declares, so that a field added to the interface fails to compile here. */
const reply = (): AiEngineWeekBoundsResponse => ({
  requestId: '55555555-5555-4555-8555-555555555555',
  weeksTotal: 2,
  weeksCounted: 2,
  rows: [row()],
  refusal: { code: 'TEACHER_HOURS_SHORT', params: { minutes: 3000 } },
  deadlineHit: false,
  elapsedMs: 5,
});

const extra = (): Required<AiEngineWeekBoundsExtra> => ({
  years: [9],
  cutoffs: [{ year: 9, demandMinutes: 2355, capacityMinutes: 2350 }],
  seconds: 25,
});

describe('Lärarval F3: the exact week count, the wire contract', () => {
  it('reads exactly the response and row fields the engine declares', () => {
    expect(Object.keys(reply()).sort()).toEqual(RESPONSE_FIELDS);
    expect(Object.keys(row()).sort()).toEqual(ROW_FIELDS);
    expect([...WEEK_BOUNDS_RESPONSE_KEYS].sort()).toEqual(RESPONSE_FIELDS);
    expect([...WEEK_BOUNDS_ROW_KEYS].sort()).toEqual(ROW_FIELDS);
  });

  it('adds exactly the three optional request fields the engine takes, and a cutoff is a share of the week\'s supply', () => {
    expect(Object.keys(extra()).sort()).toEqual(EXTRA_FIELDS);
    expect([...WEEK_BOUNDS_EXTRA_KEYS].sort()).toEqual(EXTRA_FIELDS);
    expect(Object.keys(extra().cutoffs[0]!).sort()).toEqual(['capacityMinutes', 'demandMinutes', 'year']);
    expect(
      cutoffsOf(new Map([[9, new Map([['0:x', { demand: 2355, capacity: 2350 }]])]]), [9]),
    ).toEqual(extra().cutoffs);
  });

  it('asks the route the engine serves', () => {
    expect(WEEK_BOUNDS_PATH).toBe('/api/v1/week-bounds');
  });

  it('reads an answer of the engine\'s declared shape as figures, and one it cannot be sure of as nothing to rank by', () => {
    const exact = readEvaluation(reply() satisfies AiEngineWeekBoundsResponse as never, [9]);
    expect(exact).toEqual({ kind: 'REFUSED', code: 'TEACHER_HOURS_SHORT' });

    const figures = readEvaluation({ ...reply(), refusal: null }, [9]);
    expect(figures.kind).toBe('FIGURES');
    expect(readEvaluation({ ...reply(), refusal: null, rows: [{ ...row(), converged: false }] }, [9])).toEqual({
      kind: 'UNRANKED',
      reason: 'NOT_EXACT',
    });
  });
});
