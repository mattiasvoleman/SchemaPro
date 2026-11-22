import { randomUUID } from 'node:crypto';
import type { AiEngineSuggestChangesResponse, AiEngineSuggestedChange } from './interfaces/suggest-changes.interface';
import {
  MAX_NAMED,
  MAX_NAME,
  MAX_STORED_BYTES,
  MAX_STORED_CHANGES,
  STALE_AFTER_MS,
  failedSuggestions,
  isAbandoned,
  readAs,
  runningSuggestions,
  suggestionsFromEngine,
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

  it('stores a part-timer\'s days hidden for every reader: the rule, the price and the proof and nothing else', () => {
    const result = stored(answer([days()]));
    expect(result.changes).toEqual([{
      rule: 'TEACHER_WORK_DAYS', proof: 'SOLVED_TOGETHER', cost: 1200, current: null, needed: null, weekdays: [],
      requirementIds: [], requirementNames: [], roomIds: [], roomNames: [], resourceIds: [], teacherIds: [], hidden: true,
    }]);
  });

  it('merges several part-timers\' days into one change whose price is the sum, and keeps the others apart', () => {
    const result = stored(answer([days({ cost: 1200 }), perDay(), days({ cost: 2400 })]));
    expect(result.changes.map((change) => [change.rule, change.cost])).toEqual([
      ['SUBJECT_PER_DAY', 20],
      ['TEACHER_WORK_DAYS', 3600],
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
  it('is abandoned once it has been RUNNING for longer than any analysis lasts, and not before', () => {
    const running = runningSuggestions(new Date(STARTED));
    const start = Date.parse(STARTED);
    expect(isAbandoned(running, new Date(start + STALE_AFTER_MS))).toBe(false);
    expect(isAbandoned(running, new Date(start + STALE_AFTER_MS + 1))).toBe(true);
    expect(readAs(running, new Date(start + STALE_AFTER_MS + 1))).toMatchObject({ state: 'FAILED', failure: 'ABANDONED', startedAt: STARTED });
    expect(readAs(running, new Date(start + 1000))).toBe(running);
    // An abandoned analysis ended once: every poll says the same time, not the time of the poll.
    const first = readAs(running, new Date(start + STALE_AFTER_MS + 1));
    const later = readAs(running, new Date(start + STALE_AFTER_MS + 90_000));
    expect(later.finishedAt).toBe(first.finishedAt);
    expect(first.finishedAt).toBe(new Date(start + STALE_AFTER_MS).toISOString());
  });

  it('is never abandoned once it has ended', () => {
    const done = stored(answer([cap()]));
    expect(isAbandoned(done, new Date(Date.parse(STARTED) + 10 * STALE_AFTER_MS))).toBe(false);
    const failed = failedSuggestions(STARTED, 'ENGINE_FAILED', NOW);
    expect(readAs(failed, new Date(Date.parse(STARTED) + 10 * STALE_AFTER_MS))).toBe(failed);
  });
});
