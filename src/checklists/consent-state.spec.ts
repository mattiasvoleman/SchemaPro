import { consentStateOf, countStates, inOrder, latestOf, openAskOf, type ConsentKind, type ConsentState, type StateAsk, type StateEntry } from './consent-state';

const at = (iso: string) => new Date(iso);
const entry = (id: string, kind: ConsentKind, recordedAt: string): StateEntry => ({ id, kind, recordedAt: at(recordedAt) });
const ask = (requestId: string, askedAt: string, over: Partial<StateAsk> = {}): StateAsk => ({
  requestId,
  askedAt: at(askedAt),
  asked: 2,
  waiting: 1,
  met: false,
  ...over,
});

describe('consent-state', () => {
  describe('inOrder', () => {
    it('puts the answers in the order they were written, oldest first', () => {
      const ordered = inOrder([entry('c', 'GRANTED', '2026-11-03T10:00:00Z'), entry('a', 'WITHDRAWN', '2026-11-05T10:00:00Z'), entry('b', 'DECLINED', '2026-11-01T10:00:00Z')]);
      expect(ordered.map((e) => e.id)).toEqual(['b', 'c', 'a']);
    });

    it('orders answers written at the same instant by id, whichever way round they come', () => {
      const first = entry('a', 'GRANTED', '2026-11-03T10:00:00Z');
      const second = entry('b', 'WITHDRAWN', '2026-11-03T10:00:00Z');
      expect(inOrder([second, first]).map((e) => e.id)).toEqual(['a', 'b']);
      expect(inOrder([first, second]).map((e) => e.id)).toEqual(['a', 'b']);
    });

    it('keeps two identical entries as they are and does not touch the array it was given', () => {
      const one = entry('a', 'GRANTED', '2026-11-03T10:00:00Z');
      const input = [entry('z', 'GRANTED', '2026-11-04T10:00:00Z'), one, one];
      const ordered = inOrder(input);
      expect(ordered).toHaveLength(3);
      expect(ordered.map((e) => e.id)).toEqual(['a', 'a', 'z']);
      expect(input.map((e) => e.id)).toEqual(['z', 'a', 'a']);
      expect(ordered).not.toBe(input);
    });

    it('is empty for no answers', () => {
      expect(inOrder([])).toEqual([]);
    });
  });

  describe('latestOf', () => {
    it('is null when there is no answer', () => {
      expect(latestOf([])).toBeNull();
    });

    it('is the answer written last, not the one that comes last in the list', () => {
      const latest = entry('b', 'WITHDRAWN', '2026-11-05T10:00:00Z');
      expect(latestOf([latest, entry('a', 'GRANTED', '2026-11-03T10:00:00Z')])).toBe(latest);
    });

    it('is the one with the higher id when two were written at the same instant', () => {
      const earlier = entry('a', 'GRANTED', '2026-11-03T10:00:00Z');
      const later = entry('b', 'WITHDRAWN', '2026-11-03T10:00:00Z');
      expect(latestOf([later, earlier])).toBe(later);
      expect(latestOf([earlier, later])).toBe(later);
    });
  });

  describe('openAskOf', () => {
    const latest = entry('e', 'WITHDRAWN', '2026-11-03T10:00:00Z');

    it('is null without a request', () => {
      expect(openAskOf([], null)).toBeNull();
      expect(openAskOf([], latest)).toBeNull();
    });

    it('is a request that waits for a guardian and was made after the latest answer', () => {
      const open = ask('r-1', '2026-11-04T08:00:00Z');
      expect(openAskOf([open], latest)).toBe(open);
    });

    it('is any request that waits when there is no answer at all', () => {
      const open = ask('r-1', '2020-01-01T08:00:00Z');
      expect(openAskOf([open], null)).toBe(open);
    });

    it('is not a request that is met', () => {
      expect(openAskOf([ask('r-1', '2026-11-04T08:00:00Z', { met: true })], latest)).toBeNull();
    });

    it('is not a request nobody can answer any more (waiting 0)', () => {
      expect(openAskOf([ask('r-1', '2026-11-04T08:00:00Z', { waiting: 0 })], latest)).toBeNull();
    });

    it('is not a request made before the latest answer, nor one made at the very instant of it', () => {
      expect(openAskOf([ask('r-1', '2026-11-02T08:00:00Z')], latest)).toBeNull();
      expect(openAskOf([ask('r-2', '2026-11-03T10:00:00Z')], latest)).toBeNull();
    });

    it('is the newest of several that wait, and skips those that do not count', () => {
      const old = ask('r-old', '2026-11-04T08:00:00Z');
      const newest = ask('r-new', '2026-11-06T08:00:00Z');
      const met = ask('r-met', '2026-11-07T08:00:00Z', { met: true });
      const before = ask('r-before', '2026-11-01T08:00:00Z');
      expect(openAskOf([old, met, newest, before], latest)).toBe(newest);
      expect(openAskOf([newest, old], latest)).toBe(newest);
    });
  });

  describe('consentStateOf', () => {
    it('is MISSING for a pupil nobody has answered for and nobody has been asked about', () => {
      expect(consentStateOf([], [])).toEqual({ state: 'MISSING', latest: null, ask: null });
    });

    it.each(['GRANTED', 'DECLINED', 'WITHDRAWN'] as const)('is %s when that is the latest answer', (kind) => {
      const only = entry('a', kind, '2026-11-03T10:00:00Z');
      expect(consentStateOf([only], [])).toEqual({ state: kind, latest: only, ask: null });
    });

    it('lets the latest answer win: a consent that was taken back is WITHDRAWN, and given again GRANTED', () => {
      const granted = entry('a', 'GRANTED', '2026-11-01T10:00:00Z');
      const withdrawn = entry('b', 'WITHDRAWN', '2026-11-02T10:00:00Z');
      const again = entry('c', 'GRANTED', '2026-11-03T10:00:00Z');
      expect(consentStateOf([granted, withdrawn], []).state).toBe('WITHDRAWN');
      expect(consentStateOf([again, withdrawn, granted], []).state).toBe('GRANTED');
      expect(consentStateOf([again, withdrawn, granted], []).latest).toBe(again);
    });

    it('is ASKED while a request made after the latest answer waits for a guardian, and still names the answer it follows', () => {
      const withdrawn = entry('a', 'WITHDRAWN', '2026-11-02T10:00:00Z');
      const open = ask('r-1', '2026-11-03T08:00:00Z');
      expect(consentStateOf([withdrawn], [open])).toEqual({ state: 'ASKED', latest: withdrawn, ask: open });
    });

    it('is ASKED for a pupil with no answer when a request waits', () => {
      const open = ask('r-1', '2026-11-03T08:00:00Z');
      expect(consentStateOf([], [open])).toEqual({ state: 'ASKED', latest: null, ask: open });
    });

    it('is not ASKED by a request that is met: the latest answer, or MISSING, stands', () => {
      const met = ask('r-1', '2026-11-03T08:00:00Z', { met: true });
      expect(consentStateOf([], [met]).state).toBe('MISSING');
      expect(consentStateOf([entry('a', 'DECLINED', '2026-11-02T10:00:00Z')], [met])).toMatchObject({ state: 'DECLINED', ask: null });
    });

    it('is not ASKED by a request nobody can answer (waiting 0)', () => {
      const nobody = ask('r-1', '2026-11-03T08:00:00Z', { waiting: 0 });
      expect(consentStateOf([], [nobody])).toEqual({ state: 'MISSING', latest: null, ask: null });
    });

    it('is not ASKED by a request older than the latest answer: the answer was given after the question', () => {
      const old = ask('r-1', '2026-11-01T08:00:00Z');
      const granted = entry('a', 'GRANTED', '2026-11-02T10:00:00Z');
      expect(consentStateOf([granted], [old])).toEqual({ state: 'GRANTED', latest: granted, ask: null });
    });
  });

  describe('countStates', () => {
    it('counts nobody for no pupils', () => {
      expect(countStates([])).toEqual({ pupils: 0, granted: 0, declined: 0, withdrawn: 0, asked: 0, missing: 0 });
    });

    it('counts each state once per pupil, and every pupil in pupils', () => {
      const states: ConsentState[] = ['GRANTED', 'GRANTED', 'GRANTED', 'DECLINED', 'WITHDRAWN', 'WITHDRAWN', 'ASKED', 'MISSING', 'MISSING', 'MISSING', 'MISSING'];
      expect(countStates(states)).toEqual({ pupils: 11, granted: 3, declined: 1, withdrawn: 2, asked: 1, missing: 4 });
    });

    it('adds up: every pupil is in exactly one of the five', () => {
      const counts = countStates(['GRANTED', 'DECLINED', 'ASKED', 'MISSING', 'WITHDRAWN', 'GRANTED']);
      expect(counts.granted + counts.declined + counts.withdrawn + counts.asked + counts.missing).toBe(counts.pupils);
    });
  });
});
