import { compareRanked, rankCandidate, type RankInput } from './cover-rank';

const H = 3_600_000;
const base = (overrides: Partial<RankInput> = {}): RankInput => ({
  userId: 'u',
  kind: 'STAFF',
  qualification: null,
  teachesSubject: false,
  teachesGroupSubject: false,
  teachesGroup: false,
  mentor: false,
  lesson: { start: 10 * H, end: 11 * H, minutes: 60 },
  dayLessons: [{ start: 8 * H, end: 9 * H }],
  releasedGroup: null,
  counter: { week: 0, term: 0 },
  load: { weekMinutes: 0, target: null, tolerancePercent: 10 },
  poolPreference: 'NEUTRAL',
  prefersFree: false,
  names: { subject: 'Matematik', group: '7A', grades: '7' },
  ...overrides,
});

const points = (input: RankInput) =>
  Object.fromEntries(rankCandidate(input).reasons.map((reason) => [reason.code, reason.points]));

describe('cover ranking', () => {
  it('scores each term with its reason and params', () => {
    const ranked = rankCandidate(
      base({
        qualification: 'LEGITIMATION',
        teachesGroupSubject: true,
        mentor: true,
        dayLessons: [{ start: 8 * H, end: 9 * H }, { start: 13 * H, end: 14 * H }],
        releasedGroup: '8B',
        prefersFree: true,
      }),
    );
    expect(ranked.reasons).toEqual([
      { code: 'QUAL_LEGITIMATION', params: { subject: 'Matematik', grades: '7' }, points: 40 },
      { code: 'TEACHES_GROUP_SUBJECT', params: { group: '7A', subject: 'Matematik' }, points: 25 },
      { code: 'MENTOR', params: { group: '7A' }, points: 8 },
      { code: 'GAP_FILL', params: {}, points: 12 },
      { code: 'RELEASED', params: { group: '8B' }, points: 8 },
      { code: 'PREFERS_FREE', params: {}, points: -10 },
    ]);
    expect(ranked.score).toBe(40 + 25 + 8 + 12 + 8 - 10);
  });

  it('TILLATEN names no grades (it is for the year), BEHORIG does', () => {
    expect(rankCandidate(base({ qualification: 'TILLATEN' })).reasons[0]).toEqual({
      code: 'QUAL_TILLATEN',
      params: { subject: 'Matematik' },
      points: 15,
    });
    expect(points(base({ qualification: 'BEHORIG' })).QUAL_BEHORIG).toBe(30);
  });

  it('TEACHES_SUBJECT is the floor only without a qualification', () => {
    expect(points(base({ teachesSubject: true })).TEACHES_SUBJECT).toBe(10);
    expect(points(base({ teachesSubject: true, qualification: 'BEHORIG' })).TEACHES_SUBJECT).toBeUndefined();
  });

  it('presence: on site +6, called in −15', () => {
    expect(points(base()).ON_SITE).toBe(6);
    expect(points(base({ dayLessons: [] })).NOT_ON_SITE).toBe(-15);
  });

  it('the counter is capped: −5 a week up to −25, −1 a term up to −15', () => {
    expect(points(base({ counter: { week: 2, term: 4 } }))).toMatchObject({ COUNTER_WEEK: -10, COUNTER_TERM: -4 });
    expect(points(base({ counter: { week: 9, term: 40 } }))).toMatchObject({ COUNTER_WEEK: -25, COUNTER_TERM: -15 });
    const reasons = rankCandidate(base({ counter: { week: 1, term: 0 } })).reasons;
    expect(reasons.find((r) => r.code === 'COUNTER_WEEK')?.params).toEqual({ count: 1 });
    expect(reasons.some((r) => r.code === 'COUNTER_TERM')).toBe(false);
  });

  it('load against the target: under +6, over the tolerance −20, no target nothing', () => {
    expect(points(base({ load: { weekMinutes: 600, target: 900, tolerancePercent: 10 } })).UNDER_TARGET).toBe(6);
    expect(points(base({ load: { weekMinutes: 960, target: 900, tolerancePercent: 10 } })).OVER_TARGET).toBe(-20);
    // Inside the band: neither.
    const band = points(base({ load: { weekMinutes: 870, target: 900, tolerancePercent: 10 } }));
    expect(band.UNDER_TARGET ?? band.OVER_TARGET).toBeUndefined();
    expect(points(base({ load: { weekMinutes: 2000, target: null, tolerancePercent: 10 } })).OVER_TARGET).toBeUndefined();
  });

  it('LAST_RESORT cancels a LEGITIMATION for a pool vikarie', () => {
    const pool = rankCandidate(base({ kind: 'POOL', qualification: 'LEGITIMATION', poolPreference: 'LAST_RESORT' }));
    const staff = rankCandidate(base({ qualification: null }));
    expect(pool.score).toBe(staff.score);
    expect(points(base({ kind: 'POOL', poolPreference: 'PREFER' })).POOL_PREFERRED).toBe(20);
    expect(points(base({ kind: 'POOL' })).POOL).toBe(0);
  });

  it('keeps the old picker’s order: behörighet first, then the class’s own teacher', () => {
    const legit = rankCandidate(base({ userId: 'a', qualification: 'LEGITIMATION' }));
    const primary = rankCandidate(base({ userId: 'b', teachesGroupSubject: true, teachesSubject: true }));
    const tillaten = rankCandidate(base({ userId: 'c', qualification: 'TILLATEN', teachesGroupSubject: true }));
    const plain = rankCandidate(base({ userId: 'd', teachesSubject: true }));
    const order = [plain, tillaten, primary, legit]
      .map((r) => ({ ...r, counter: { week: 0 } }))
      .sort(compareRanked)
      .map((r) => r.userId);
    // LEGITIMATION (40) > TILLATEN + own class (40, then id) > own class (35) > subject (10).
    expect(order).toEqual(['a', 'c', 'b', 'd']);
  });

  it('ties break by fewer covers this week, then by id', () => {
    const a = { userId: 'a', score: 10, reasons: [], counter: { week: 2 } };
    const b = { userId: 'b', score: 10, reasons: [], counter: { week: 1 } };
    const c = { userId: 'c', score: 10, reasons: [], counter: { week: 1 } };
    expect([a, c, b].sort(compareRanked).map((r) => r.userId)).toEqual(['b', 'c', 'a']);
  });
});
