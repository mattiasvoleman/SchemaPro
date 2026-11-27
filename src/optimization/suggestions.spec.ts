import { randomUUID } from 'node:crypto';
import type { AiEngineSuggestChangesResponse, AiEngineSuggestedChange } from './interfaces/suggest-changes.interface';
import { STAFF_UNSTAFFED_REQUIREMENTS } from '../staffing/staffing-checks';
import { GROUP_CONFLICTS_OVER_ENGINE_LIMIT } from './optimization-proxy.service';
import { BLOCK_PARTLY_LOCKED_SUMMARY } from './parallel-blocks';
import { PLACEMENTS_REFUSED_SUMMARY } from './placed-lessons';
import {
  ANALYSIS_LEASE_SECONDS,
  MAX_NAMED,
  MAX_NAME,
  MAX_STORED_BYTES,
  MAX_STORED_CHANGES,
  PREFLIGHT_REFUSAL_CODES,
  STALE_AFTER_MS,
  failedSuggestions,
  isAbandoned,
  keptOf,
  readAs,
  refusedSuggestions,
  runningSuggestions,
  settledAs,
  suggestionsFromEngine,
  suggestionsMayBeAskedFor,
  suggestionsOf,
  teachersOfSuggestions,
  viewOf,
  type Realiser,
  type SuggestionsStored,
} from './suggestions';

/*
 * The stored analysis (suggestions.ts): what the engine's answer becomes in OptimizationJobs."suggestions", and what comes back out.
 *
 * WHAT THESE HOLD: the whitelist (idempotent, and a value that is not wholly well formed is NOT shown in part); the proof as the engine
 * said it and never raised here; a part-timer's days stored hidden for every reader and merged to one; no person's name; the bounds the
 * column's CHECK sets; the abandoned analysis; and the ranking.
 */

const STARTED = '2027-03-05T10:00:00.000Z';
const NOW = new Date('2027-03-05T10:01:30.000Z');

const RULE_A = randomUUID();
const TEACHER_A = randomUUID();
const REQ_1 = randomUUID();
const REQ_2 = randomUUID();
const ROOM_1 = randomUUID();
const PREF_1 = randomUUID();

/** An engine whose anonymous ids are the real ones with a prefix, so that a missed translation is visible. */
function realiser(extra: Record<string, string> = {}): Realiser {
  const names = new Map<string, string>([
    [REQ_1, 'Matematik för 7B'],
    [REQ_2, 'Idrott för 8A'],
    [ROOM_1, 'B12'],
    ...Object.entries(extra),
  ]);
  const anon = new Map<string, string>([
    ['aaaaaaaa-0000-4000-8000-000000000001', REQ_1],
    ['aaaaaaaa-0000-4000-8000-000000000002', REQ_2],
    ['aaaaaaaa-0000-4000-8000-000000000003', ROOM_1],
    ['aaaaaaaa-0000-4000-8000-000000000004', RULE_A],
    ['aaaaaaaa-0000-4000-8000-000000000005', PREF_1],
  ]);
  return {
    real: (id) => anon.get(id) ?? id,
    nameOf: (id) => names.get(id),
    teacherOfRule: (id) => (id === RULE_A ? TEACHER_A : undefined),
  };
}

const A1 = 'aaaaaaaa-0000-4000-8000-000000000001';
const A2 = 'aaaaaaaa-0000-4000-8000-000000000002';
const A3 = 'aaaaaaaa-0000-4000-8000-000000000003';
const A4 = 'aaaaaaaa-0000-4000-8000-000000000004';
const A5 = 'aaaaaaaa-0000-4000-8000-000000000005';

const cap = (over: Partial<AiEngineSuggestedChange> = {}): AiEngineSuggestedChange => ({
  rule: 'TEACHER_DAILY_CAP', cost: 168, current: 300, needed: 330, weekdays: [3, 2],
  requirementIds: [A1], roomIds: [], resourceIds: [A4], proof: 'SOLVED', ...over,
});
const days = (over: Partial<AiEngineSuggestedChange> = {}): AiEngineSuggestedChange => ({
  rule: 'TEACHER_WORK_DAYS', cost: 1200, current: 3, needed: 4, weekdays: [2],
  requirementIds: [A1], roomIds: [], resourceIds: [randomUUID()], proof: 'SOLVED_TOGETHER', ...over,
});
const lock = (over: Partial<AiEngineSuggestedChange> = {}): AiEngineSuggestedChange => ({
  rule: 'ROOM_LOCK', cost: 80, current: null, needed: null, weekdays: [],
  requirementIds: [A1, A2], roomIds: [A3], resourceIds: [A5], proof: 'SOLVED_TOGETHER', ...over,
});
const perDay = (over: Partial<AiEngineSuggestedChange> = {}): AiEngineSuggestedChange => ({
  rule: 'SUBJECT_PER_DAY', cost: 20, current: 1, needed: 2, weekdays: [2],
  requirementIds: [A2], roomIds: [], resourceIds: [], proof: 'SOLVED_TOGETHER', ...over,
});

function answer(changes: AiEngineSuggestedChange[], over: Partial<AiEngineSuggestChangesResponse> = {}): AiEngineSuggestChangesResponse {
  return {
    requestId: randomUUID(), verdict: 'CHANGES', changes, verified: true, searchSeconds: 60, verifySeconds: 3.94, elapsedMs: 70_000, ...over,
  };
}

const stored = (response: AiEngineSuggestChangesResponse, r: Realiser = realiser()): SuggestionsStored =>
  suggestionsFromEngine(response, r, STARTED, NOW);

describe('the engine answer as the column keeps it', () => {
  it('turns the ids back, names the posts and rooms, and keeps the teacher as an id and never as a name', () => {
    // A list the engine checked together: every change of it has the one proof.
    const result = stored(answer([cap({ proof: 'SOLVED_TOGETHER' }), lock()]));
    const [first, second] = result.changes;
    // A lock costs 80 and a cap 168: the lock goes first.
    expect(first!.rule).toBe('ROOM_LOCK');
    expect(first!.requirementIds).toEqual([REQ_1, REQ_2]);
    expect(first!.requirementNames).toEqual(['Matematik för 7B', 'Idrott för 8A']);
    expect(first!.roomIds).toEqual([ROOM_1]);
    expect(first!.roomNames).toEqual(['B12']);
    expect(first!.resourceIds).toEqual([PREF_1]);
    expect(first!.teacherIds).toEqual([]);
    expect(second!.rule).toBe('TEACHER_DAILY_CAP');
    expect(second!.resourceIds).toEqual([RULE_A]);
    expect(second!.teacherIds).toEqual([TEACHER_A]);
    expect(second!.weekdays).toEqual([2, 3]);
    expect([second!.current, second!.needed]).toEqual([300, 330]);
    expect(JSON.stringify(result)).not.toMatch(/Anna|Bertil/);
    expect(JSON.stringify(result)).not.toContain('aaaaaaaa-0000');
  });

  it('keeps the engine\'s proof and the engine\'s verdict, and says whether the strict model accepted the list', () => {
    const one = stored(answer([cap()]));
    expect(one.changes[0]!.proof).toBe('SOLVED');
    expect(one).toMatchObject({ state: 'DONE', verdict: 'CHANGES', verified: true, total: 1, failure: null, searchSeconds: 60, verifySeconds: 3.9 });
    expect(one.startedAt).toBe(STARTED);
    expect(one.finishedAt).toBe(NOW.toISOString());
  });

  it('never raises a proof the engine did not give: a list that was not checked is MAY_HELP whatever its changes say', () => {
    const result = stored(answer([cap({ proof: 'SOLVED' }), lock({ proof: 'SOLVED_TOGETHER' })], { verified: false }));
    expect(result.verified).toBe(false);
    expect(result.changes.map((change) => change.proof)).toEqual(['MAY_HELP', 'MAY_HELP']);
  });

  it('stores a part-timer\'s days hidden for every reader: the rule and the proof and nothing else, and no price (g385-L-8)', () => {
    const result = stored(answer([days()]));
    expect(result.changes).toEqual([{
      rule: 'TEACHER_WORK_DAYS', proof: 'SOLVED_TOGETHER', cost: 0, current: null, needed: null, weekdays: [],
      requirementIds: [], requirementNames: [], roomIds: [], roomNames: [], resourceIds: [], teacherIds: [], hidden: true,
    }]);
  });

  it('does not let the price of a part-timer\'s days say how many days a post goes over, in the column or in what is read', () => {
    // 1 200 a day: three days over would have been 3 600, and a reader without HR-läs could count them from it.
    const result = stored(answer([days({ cost: 3600 })]));
    expect(JSON.stringify(result)).not.toContain('3600');
    expect(result.changes[0]!.cost).toBe(0);
    // A column written before that carried the price: it is read without it (and is still shown), never refused for it.
    const old = { ...result, changes: [{ ...result.changes[0]!, cost: 3600 }] };
    const read = suggestionsOf(old);
    expect(read).not.toBeNull();
    expect(read!.changes[0]!.cost).toBe(0);
    expect(JSON.stringify(viewOf(read!, new Map()))).not.toContain('3600');
  });

  it('still ranks the part-timers\' days by their price, which is not kept (the order is made before the price is dropped)', () => {
    const result = stored(answer([days({ cost: 3600 }), perDay({ cost: 2000 }), perDay({ cost: 20 })]));
    expect(result.changes.map((change) => change.rule)).toEqual(['SUBJECT_PER_DAY', 'SUBJECT_PER_DAY', 'TEACHER_WORK_DAYS']);
    expect(result.changes.map((change) => change.cost)).toEqual([20, 2000, 0]);
  });

  it('merges several part-timers\' days into one change (the prices added for the order, none kept), and keeps the others apart', () => {
    const result = stored(answer([days({ cost: 1200 }), perDay(), days({ cost: 2400 })]));
    expect(result.changes.map((change) => [change.rule, change.cost])).toEqual([
      ['SUBJECT_PER_DAY', 20],
      ['TEACHER_WORK_DAYS', 0],
    ]);
    // The engine's list had three changes, and the proof is about all three: two part-timers' days are one entry but are still two changes.
    expect(result.total).toBe(3);
    expect(result.changes).toHaveLength(2);
  });

  it('ranks by proof, then price, then the rule\'s place in the engine\'s list', () => {
    const result = stored(answer([
      cap({ cost: 20, proof: 'SOLVED_TOGETHER' }),
      perDay({ cost: 20, proof: 'SOLVED_TOGETHER' }),
      lock({ cost: 5, proof: 'MAY_HELP' }),
    ]));
    // Equal price: the milder rule (SUBJECT_PER_DAY, before TEACHER_DAILY_CAP); the one that is only a measurement goes last.
    expect(result.changes.map((change) => change.rule)).toEqual(['SUBJECT_PER_DAY', 'TEACHER_DAILY_CAP', 'ROOM_LOCK']);
  });

  it('keeps at most six, counts the rest, and never names more than three posts or rooms of a change', () => {
    const many = Array.from({ length: 9 }, (_, index) => perDay({ cost: 10 + index }));
    const result = stored(answer(many));
    expect(result.changes).toHaveLength(MAX_STORED_CHANGES);
    expect(result.total).toBe(9);
    const wide = stored(answer([lock({ requirementIds: [A1, A2, randomUUID(), randomUUID(), randomUUID()], roomIds: [A3, randomUUID(), randomUUID(), randomUUID()] })]));
    expect(wide.changes[0]!.requirementIds).toHaveLength(MAX_NAMED);
    expect(wide.changes[0]!.roomIds).toHaveLength(MAX_NAMED);
  });

  it('names a teacher only for a cap: a lock or a spread whose row happens to be a work rule\'s names nobody', () => {
    const everyoneIsTeacher: Realiser = { ...realiser(), teacherOfRule: () => TEACHER_A };
    const result = stored(answer([lock(), perDay({ resourceIds: [A4] }), cap({ cost: 900, proof: 'SOLVED_TOGETHER' })]), everyoneIsTeacher);
    expect(result.changes.map((change) => [change.rule, change.teacherIds])).toEqual([
      ['SUBJECT_PER_DAY', []],
      ['ROOM_LOCK', []],
      ['TEACHER_DAILY_CAP', [TEACHER_A]],
    ]);
  });

  it('cuts a name to its limit, and leaves out a name the school has not given', () => {
    const long = 'Å'.repeat(MAX_NAME * 3);
    const result = stored(answer([perDay()]), realiser({ [REQ_2]: long }));
    expect(result.changes[0]!.requirementNames).toEqual([long.slice(0, MAX_NAME)]);
    const unnamed = stored(answer([perDay()]), realiser({ [REQ_2]: '' }));
    expect(unnamed.changes[0]!.requirementNames).toEqual([]);
  });

  it('cuts a name at its limit without leaving half of a surrogate pair, which jsonb refuses and would lose the whole analysis', () => {
    const name = `${'x'.repeat(MAX_NAME - 1)}\u{1F3A8} Sal 4`;
    const result = stored(answer([perDay()]), realiser({ [REQ_2]: name }));
    const kept = result.changes[0]!.requirementNames[0]!;
    expect(kept).toBe('x'.repeat(MAX_NAME - 1));
    // No lone surrogate (String.prototype.isWellFormed is ES2024, past test/tsconfig.json's lib).
    expect(kept).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/);
    expect(JSON.stringify(result)).not.toMatch(/\\ud[89ab][0-9a-f]{2}/i);
    expect(suggestionsOf(result)).toEqual(result);
    // A name that is whole at the limit keeps the pair.
    const whole = stored(answer([perDay()]), realiser({ [REQ_2]: `${'x'.repeat(MAX_NAME - 2)}\u{1F3A8}` }));
    expect(whole.changes[0]!.requirementNames[0]).toBe(`${'x'.repeat(MAX_NAME - 2)}\u{1F3A8}`);
  });

  it('drops changes from the end until the whole fits under what the column allows, and counts them', () => {
    const wordy = (index: number): AiEngineSuggestedChange =>
      lock({ cost: index, requirementIds: [randomUUID(), randomUUID(), randomUUID()], roomIds: [randomUUID(), randomUUID(), randomUUID()] });
    const long = 'Ö'.repeat(MAX_NAME);
    const names = (): Realiser => ({ real: (id) => id, nameOf: () => long, teacherOfRule: () => undefined });
    const result = suggestionsFromEngine(answer(Array.from({ length: 6 }, (_, index) => wordy(index))), names(), STARTED, NOW);
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(MAX_STORED_BYTES);
    expect(result.changes.length).toBeLessThan(6);
    expect(result.total).toBe(6);
    // What was kept is the cheapest of them, in order.
    expect(result.changes.map((change) => change.cost)).toEqual([...result.changes.map((change) => change.cost)].sort((a, b) => a - b));
    // And the bound is under the CHECK with the spacing jsonb prints: a space after every colon and comma.
    expect(JSON.stringify(result).replace(/([:,])/g, '$1 ').length).toBeLessThanOrEqual(8192);
  });

  it('says no change for a verdict that has none: a refusal by a hard rule, a search that found nothing', () => {
    for (const verdict of ['NOT_FOUND', 'HARD_REFUSAL'] as const) {
      const result = stored(answer([cap()], { verdict, verified: false }));
      expect(result.changes).toEqual([]);
      expect(result.total).toBe(0);
      expect(result.verdict).toBe(verdict);
      expect(result.verified).toBe(false);
    }
  });

  it.each([
    ['no verdict at all (a 200 that is not the engine\'s answer)', {}],
    ['a verdict of another contract', { verdict: 'NEEDS_MORE_TIME' }],
    ['a verdict that is not a text', { verdict: 7 }],
  ])('is a failed analysis for %s, never a finished one with nothing to say', (_name, odd) => {
    const result = stored({ ...answer([cap()]), verdict: undefined, ...odd } as unknown as AiEngineSuggestChangesResponse);
    expect(result).toMatchObject({ state: 'FAILED', failure: 'ENGINE_FAILED', verdict: null, changes: [], total: 0, verified: false, startedAt: STARTED });
    expect(suggestionsOf(result)).toEqual(result);
  });

  it('does not call a week solvable as it is checked unless the engine checked it', () => {
    expect(stored(answer([], { verdict: 'SOLVABLE_AS_IS', verified: true })).verified).toBe(true);
    expect(stored(answer([], { verdict: 'SOLVABLE_AS_IS', verified: false })).verified).toBe(false);
  });

  it('does not take a figure that is not one: a price below zero or beyond a number is a price of zero', () => {
    const result = stored(answer([perDay({ cost: Number.NaN })]));
    expect(result.changes[0]!.cost).toBe(0);
    const negative = stored(answer([perDay({ cost: -5 })]));
    expect(negative.changes[0]!.cost).toBe(0);
  });
});

describe('the whitelist', () => {
  const good = (): SuggestionsStored => stored(answer([cap(), lock(), days()]));

  it('is idempotent: what it returns it accepts again, unchanged', () => {
    const once = suggestionsOf(good());
    expect(once).not.toBeNull();
    expect(suggestionsOf(once)).toEqual(once);
    expect(suggestionsOf(JSON.parse(JSON.stringify(once)))).toEqual(once);
  });

  it('cuts a name that is too long on the way out as well, so that a hand-edited column is not a way to show more', () => {
    const value = good();
    const wordy = { ...value, changes: value.changes.map((change) => ({ ...change, requirementNames: change.requirementIds.map(() => 'x'.repeat(MAX_NAME * 2)) })) };
    const shown = suggestionsOf(wordy)!;
    for (const change of shown.changes) for (const name of change.requirementNames) expect(name).toHaveLength(MAX_NAME);
    expect(shown.changes.some((change) => change.requirementNames.length > 0)).toBe(true);
  });

  it('accepts a running and a failed analysis', () => {
    expect(suggestionsOf(runningSuggestions(new Date(STARTED)))).toMatchObject({ state: 'RUNNING', changes: [] });
    expect(suggestionsOf(failedSuggestions(STARTED, 'ENGINE_LACKS_SUGGESTIONS', NOW))).toMatchObject({
      state: 'FAILED', failure: 'ENGINE_LACKS_SUGGESTIONS', finishedAt: NOW.toISOString(),
    });
  });

  it.each([
    ['null', null],
    ['an array', []],
    ['a text', 'x'],
    ['another version', { ...good(), version: 2 }],
    ['an unknown state', { ...good(), state: 'DONEISH' }],
    ['a state that is not a text', { ...good(), state: 1 }],
    ['an unknown verdict', { ...good(), verdict: 'MAYBE' }],
    ['an unknown failure', { ...good(), failure: 'EXPLODED' }],
    ['a verified that is not a boolean', { ...good(), verified: 'yes' }],
    ['a start that is not a date', { ...good(), startedAt: 'yesterday' }],
    ['an end that is not a date', { ...good(), finishedAt: 'later' }],
    ['seconds below zero', { ...good(), searchSeconds: -1 }],
    ['seconds beyond a day', { ...good(), verifySeconds: 90_000 }],
    ['a total that is not a whole number', { ...good(), total: 1.5 }],
    ['fewer in the total than are kept', { ...good(), total: 1 }],
    ['more than six changes', { ...good(), total: 20, changes: Array.from({ length: 7 }, () => good().changes[0]) }],
    ['a change that is not an object', { ...good(), changes: ['x'] }],
  ])('refuses %s, and shows nothing of it', (_name, value) => {
    expect(suggestionsOf(value)).toBeNull();
  });

  it.each([
    ['an unknown rule', { rule: 'ROOM_BOUND' }],
    ['an unknown proof', { proof: 'PROVED' }],
    ['a proof the engine does not give', { proof: 'AT_LEAST' }],
    ['a price that is not whole', { cost: 1.5 }],
    ['a price below zero', { cost: -1 }],
    ['a figure that is not a number', { current: '300' }],
    ['a weekday that is not one', { weekdays: [8] }],
    ['more than seven weekdays', { weekdays: [1, 2, 3, 4, 5, 6, 7, 1] }],
    ['an id that is not one', { requirementIds: ['x'] }],
    ['more than three posts', { requirementIds: [randomUUID(), randomUUID(), randomUUID(), randomUUID()] }],
    ['a name that is not a text', { roomNames: [3] }],
    ['two teachers', { teacherIds: [randomUUID(), randomUUID()] }],
    ['a hidden that is not a boolean', { hidden: 1 }],
  ])('refuses a change with %s', (_name, patch) => {
    const value = good();
    expect(suggestionsOf({ ...value, changes: [{ ...value.changes[0], ...patch }] })).toBeNull();
  });

  it('refuses a proof the strict model has not given: a list that was not verified holds MAY_HELP and nothing more (the review of #388, U-1)', () => {
    // The write says so (an unverified answer's changes are stored MAY_HELP); the read says it too, so that a column written by anything
    // else, or edited by hand, cannot show "SOLVED" over a list the strict model never accepted. The card guards itself (listProofOf).
    const unverified = stored(answer([cap(), lock()], { verified: false }));
    expect(unverified.verified).toBe(false);
    expect(unverified.changes.map((change) => change.proof)).toEqual(['MAY_HELP', 'MAY_HELP']);
    expect(suggestionsOf(unverified)).toEqual(unverified);

    for (const proof of ['SOLVED', 'SOLVED_TOGETHER'] as const) {
      const claimed = { ...unverified, changes: [{ ...unverified.changes[0]!, proof }, unverified.changes[1]!] };
      expect(suggestionsOf(claimed)).toBeNull();
    }
    // Verified, the proofs are the engine's own and stay: SOLVED, SOLVED_TOGETHER and a MAY_HELP the engine gave itself.
    const verified = good();
    expect(verified.verified).toBe(true);
    expect(new Set(verified.changes.map((change) => change.proof)).size).toBeGreaterThan(1);
    expect(suggestionsOf(verified)).toEqual(verified);
    expect(suggestionsOf({ ...verified, changes: [{ ...verified.changes[0]!, proof: 'MAY_HELP' }] })).not.toBeNull();
  });

  it.each([['true'], [1], ['false']])('stores what the engine did not check as MAY_HELP, also when `verified` is %p and not the boolean (the review of #431)', (verified) => {
    // The write and the read must agree: a list stored with `verified: false` and a SOLVED proof is one the read refuses, and the analysis
    // that took a minute and a half would end as ENGINE_FAILED at the write.
    const response = answer([cap(), lock()], { verified: verified as never });
    const made = stored(response);

    expect(made.verified).toBe(false);
    expect(made.changes.map((change) => change.proof)).toEqual(['MAY_HELP', 'MAY_HELP']);
    expect(suggestionsOf(made)).toEqual(made);
  });

  it('refuses a part-timer\'s days in any form but the hidden one, and a hidden change that says more', () => {
    const visible = { ...good().changes.find((change) => change.hidden)!, hidden: false };
    expect(suggestionsOf({ ...good(), changes: [visible] })).toBeNull();
    const hidden = good().changes.find((change) => change.hidden)!;
    for (const more of [
      { current: 3 }, { needed: 4 }, { weekdays: [2] }, { requirementIds: [REQ_1] }, { requirementNames: ['x'] },
      { roomIds: [ROOM_1] }, { roomNames: ['B12'] }, { resourceIds: [randomUUID()] }, { teacherIds: [TEACHER_A] },
    ]) {
      expect(suggestionsOf({ ...good(), changes: [{ ...hidden, ...more }] })).toBeNull();
    }
    // A hidden flag on another rule is not the hidden form either.
    expect(suggestionsOf({ ...good(), changes: [{ ...good().changes[0], hidden: true }] })).toBeNull();
  });

  it('refuses a value that is over what the column allows: six changes that each name three posts and three rooms at the longest', () => {
    const [first] = good().changes;
    const heavy = {
      ...first!, hidden: false, rule: 'ROOM_LOCK' as const,
      requirementIds: [randomUUID(), randomUUID(), randomUUID()], roomIds: [randomUUID(), randomUUID(), randomUUID()],
      requirementNames: ['Ö'.repeat(MAX_NAME), 'Ö'.repeat(MAX_NAME), 'Ö'.repeat(MAX_NAME)],
      roomNames: ['Ö'.repeat(MAX_NAME), 'Ö'.repeat(MAX_NAME), 'Ö'.repeat(MAX_NAME)],
    };
    const fat = { ...good(), total: 6, changes: Array.from({ length: 6 }, () => heavy) };
    expect(Buffer.byteLength(JSON.stringify(fat))).toBeGreaterThan(MAX_STORED_BYTES);
    expect(suggestionsOf(fat)).toBeNull();
    // One fewer fits: the bound is the limit, not the shape.
    const fits = { ...fat, changes: fat.changes.slice(0, 2) };
    expect(Buffer.byteLength(JSON.stringify(fits))).toBeLessThanOrEqual(MAX_STORED_BYTES);
    expect(suggestionsOf(fits)).not.toBeNull();
  });
});

describe('the page\'s view', () => {
  it('names the teacher of a cap and leaves the Users id behind', () => {
    const result = viewOf(stored(answer([cap()])), new Map([[TEACHER_A, 'Anna Andersson']]));
    expect(result.changes[0]!.teacherNames).toEqual(['Anna Andersson']);
    expect(Object.keys(result.changes[0]!)).not.toContain('teacherIds');
    expect(JSON.stringify(result)).not.toContain(TEACHER_A);
  });

  it('names nobody whose name the reader may not have (a protected identity is not in the map)', () => {
    expect(viewOf(stored(answer([cap()])), new Map()).changes[0]!.teacherNames).toEqual([]);
  });

  it('says whom a read has to look up: each teacher once', () => {
    const result = stored(answer([cap(), cap({ cost: 400 })]));
    expect(teachersOfSuggestions(result)).toEqual([TEACHER_A]);
    expect(teachersOfSuggestions(null)).toEqual([]);
  });
});

describe('an analysis whose process went away', () => {
  const start = Date.parse(STARTED);
  const lease = ANALYSIS_LEASE_SECONDS * 1000;

  it('holds its place for the lease from its start, and is abandoned once the lease has run out, and not before', () => {
    const running = runningSuggestions(new Date(STARTED));
    expect(running.leaseUntil).toBe(new Date(start + lease).toISOString());
    expect(isAbandoned(running, new Date(start + lease))).toBe(false);
    expect(isAbandoned(running, new Date(start + lease + 1))).toBe(true);
    expect(readAs(running, new Date(start + lease + 1))).toMatchObject({ state: 'FAILED', failure: 'ABANDONED', startedAt: STARTED });
    expect(readAs(running, new Date(start + 1000))).toBe(running);
    // An abandoned analysis ended once, when its lease ran out: every poll says the same time, not the time of the poll.
    const first = readAs(running, new Date(start + lease + 1));
    const later = readAs(running, new Date(start + lease + 90_000));
    expect(later.finishedAt).toBe(first.finishedAt);
    expect(first.finishedAt).toBe(new Date(start + lease).toISOString());
  });

  it('is held by a renewed lease for as long as it is renewed: the start no longer decides', () => {
    // A heartbeat at +150 s pushed the lease to +330 s; at +7 minutes from the start it is still alive, and was never judged by its age.
    const renewed = { ...runningSuggestions(new Date(STARTED)), leaseUntil: new Date(start + 7 * 60_000).toISOString() };
    expect(isAbandoned(renewed, new Date(start + STALE_AFTER_MS + 1))).toBe(false);
    expect(isAbandoned(renewed, new Date(start + 7 * 60_000 + 1))).toBe(true);
  });

  it('is judged by the old rule when it carries no lease: an analysis an API from before the lease started', () => {
    const legacy = { ...runningSuggestions(new Date(STARTED)), leaseUntil: null };
    expect(isAbandoned(legacy, new Date(start + STALE_AFTER_MS))).toBe(false);
    expect(isAbandoned(legacy, new Date(start + STALE_AFTER_MS + 1))).toBe(true);
    expect(readAs(legacy, new Date(start + STALE_AFTER_MS + 1)).finishedAt).toBe(new Date(start + STALE_AFTER_MS).toISOString());
  });

  it('keeps the lease of a RUNNING analysis through the whitelist and drops it from one that has ended', () => {
    const running = runningSuggestions(new Date(STARTED));
    expect(suggestionsOf(JSON.parse(JSON.stringify(running)))?.leaseUntil).toBe(running.leaseUntil);
    const ended = { ...JSON.parse(JSON.stringify(failedSuggestions(STARTED, 'ENGINE_FAILED', NOW))), leaseUntil: running.leaseUntil };
    expect(suggestionsOf(ended)?.leaseUntil).toBeNull();
    // A value that is no time is no lease: the old rule judges it, and the analysis is still read.
    expect(suggestionsOf({ ...JSON.parse(JSON.stringify(running)), leaseUntil: 'soon' })).toMatchObject({ state: 'RUNNING', leaseUntil: null });
    // An analysis written before the field has none.
    const { leaseUntil: _gone, ...older } = JSON.parse(JSON.stringify(running));
    expect(suggestionsOf(older)).toMatchObject({ state: 'RUNNING', leaseUntil: null });
  });

  it('is never shown with its lease: the page is told RUNNING, not for how long', () => {
    const view = viewOf(runningSuggestions(new Date(STARTED)), new Map());
    expect(view).not.toHaveProperty('leaseUntil');
    expect(view).not.toHaveProperty('previous');
  });

  it('has no lease once it has ended, whichever way', () => {
    expect(failedSuggestions(STARTED, 'ABANDONED', NOW).leaseUntil).toBeNull();
    expect(refusedSuggestions(STARTED, NOW).leaseUntil).toBeNull();
    expect(stored(answer([cap()])).leaseUntil).toBeNull();
  });

  it('is never abandoned once it has ended', () => {
    const done = stored(answer([cap()]));
    expect(isAbandoned(done, new Date(Date.parse(STARTED) + 10 * STALE_AFTER_MS))).toBe(false);
    const failed = failedSuggestions(STARTED, 'ENGINE_FAILED', NOW);
    expect(readAs(failed, new Date(Date.parse(STARTED) + 10 * STALE_AFTER_MS))).toBe(failed);
  });
});

describe('an analysis asked over a finished one (g385-L-5)', () => {
  const later = new Date(Date.parse(NOW.toISOString()) + 60_000);
  const withList = () => stored(answer([cap()]));
  const found = () => ({ ...withList(), verdict: 'NOT_FOUND' as const, changes: [], total: 0, verified: false });

  it('keeps a finished analysis with something to say, and nothing else', () => {
    expect(keptOf(withList(), later)).toMatchObject({ state: 'DONE', verdict: 'CHANGES' });
    expect(keptOf({ ...withList(), verdict: 'SOLVABLE_AS_IS', changes: [], total: 0 }, later)).toMatchObject({ verdict: 'SOLVABLE_AS_IS' });
    // Not an analysis that found nothing, one that refused the week, a failed one, nor no analysis.
    expect(keptOf(found(), later)).toBeNull();
    expect(keptOf(refusedSuggestions(STARTED, NOW), later)).toBeNull();
    expect(keptOf(failedSuggestions(STARTED, 'ENGINE_FAILED', NOW), later)).toBeNull();
    expect(keptOf(null, later)).toBeNull();
  });

  it('keeps it without a previous of its own, however many presses went over it', () => {
    const asked = runningSuggestions(later, keptOf(withList(), later));
    const again = keptOf({ ...failedSuggestions(asked.startedAt, 'ABANDONED', later), previous: null }, later);
    expect(again).toBeNull();
    expect(keptOf(asked, new Date(later.getTime() + STALE_AFTER_MS + 1))?.previous).toBeNull();
  });

  it('gives the finished analysis back when the new one ends without a list, and takes the new one when it has an answer', () => {
    const before = withList();
    const failed = failedSuggestions(STARTED, 'ENGINE_BUSY', later);
    expect(settledAs(failed, before)).toBe(before);
    expect(settledAs(found(), before)).toBe(before);
    // An answer replaces it, a refusal by a rule that never gives way included (the week is not the one the list was made for).
    const fresh = stored(answer([perDay()]));
    expect(settledAs(fresh, before)).toBe(fresh);
    const refused = refusedSuggestions(STARTED, later);
    expect(settledAs(refused, before)).toBe(refused);
    // Over nothing a failure is a failure, as it always was.
    expect(settledAs(failed, null)).toBe(failed);
  });

  it('is read as the finished analysis when the run that was asked over it is abandoned, not as a failure', () => {
    const before = withList();
    const asked = runningSuggestions(new Date(STARTED), before);
    const read = readAs(asked, new Date(Date.parse(STARTED) + STALE_AFTER_MS + 1));
    expect(read).toBe(before);
    // Nothing was asked over: the failure it always was.
    expect(readAs(runningSuggestions(new Date(STARTED)), new Date(Date.parse(STARTED) + STALE_AFTER_MS + 1))).toMatchObject({
      state: 'FAILED', failure: 'ABANDONED',
    });
  });

  it('passes through the whitelist as one level of one DONE analysis, in a RUNNING one only', () => {
    const asked = runningSuggestions(later, keptOf(withList(), later));
    expect(suggestionsOf(JSON.parse(JSON.stringify(asked)))).toEqual(asked);
    // Whatever else it is, it is not shown (nor is the analysis): a previous that is FAILED, one with another inside it, or on a DONE one.
    expect(suggestionsOf({ ...asked, previous: failedSuggestions(STARTED, 'ENGINE_FAILED', NOW) })).toBeNull();
    expect(suggestionsOf({ ...asked, previous: asked })).toBeNull();
    expect(suggestionsOf({ ...withList(), previous: withList() })).toBeNull();
    expect(suggestionsOf({ ...asked, previous: { ...withList(), changes: 'x' } })).toBeNull();
    // A column from before the field has none.
    const { previous: _previous, ...old } = withList();
    expect(suggestionsOf(old)).toEqual(withList());
  });

  it('is never in what the page reads', () => {
    const asked = runningSuggestions(later, keptOf(withList(), later));
    expect(Object.keys(viewOf(asked, new Map()))).not.toContain('previous');
    expect(JSON.stringify(viewOf(asked, new Map()))).not.toContain('SUBJECT_PER_DAY');
  });

  it('holds the whole under the column\'s limit with a list of the largest size inside a RUNNING one', () => {
    const many = Array.from({ length: 9 }, (_, index) => perDay({ cost: 10 + index, requirementIds: [REQ_1, REQ_2, randomUUID()] }));
    const big = stored(answer(many));
    const asked = runningSuggestions(later, keptOf(big, later));
    // The column's CHECK counts the text jsonb prints (a space after every colon and comma): a fifth to a quarter longer than the compact text.
    const jsonbText = JSON.stringify(asked).replace(/([:,])/g, '$1 ');
    expect(Buffer.byteLength(jsonbText)).toBeLessThan(8192);
    expect(suggestionsOf(asked)).not.toBeNull();
  });
});

describe('a run the gateway refused before the engine was asked (g393-L-4)', () => {
  const refused = (code: string) => ({ status: 'SUCCEEDED', solverStatus: 'INFEASIBLE', errorCode: null, conflictSummaryCode: code });

  it('is offered no analysis: the engine would answer a refusal after a minute of its cores', () => {
    for (const code of PREFLIGHT_REFUSAL_CODES) expect(suggestionsMayBeAskedFor(refused(code))).toBe(false);
  });

  it('is the engine\'s own refusal when the summary code is one the engine gives, and then it is offered', () => {
    expect(suggestionsMayBeAskedFor(refused('ROOM_SHORTAGE'))).toBe(true);
    expect(suggestionsMayBeAskedFor({ status: 'SUCCEEDED', solverStatus: 'INFEASIBLE', errorCode: null })).toBe(true);
    expect(suggestionsMayBeAskedFor({ status: 'SUCCEEDED', solverStatus: 'TIMEOUT', errorCode: null, conflictSummaryCode: null })).toBe(true);
  });

  it('names the gateway\'s refusals by the constants they are, so that a rename there fails here', () => {
    expect([...PREFLIGHT_REFUSAL_CODES].sort()).toEqual(
      [STAFF_UNSTAFFED_REQUIREMENTS, BLOCK_PARTLY_LOCKED_SUMMARY, PLACEMENTS_REFUSED_SUMMARY, GROUP_CONFLICTS_OVER_ENGINE_LIMIT].sort(),
    );
  });
});
