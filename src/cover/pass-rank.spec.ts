import { compareRanked } from './cover-rank';
import { rankPassCandidate, type PassRankInput } from './pass-rank';

const MIN = 60_000;
const at = (hour: number, minute = 0) => (hour * 60 + minute) * MIN;

function input(overrides: Partial<PassRankInput> = {}): PassRankInput {
  return {
    userId: 'u',
    kind: 'STAFF',
    pass: { start: at(10), end: at(10, 20), minutes: 20 },
    dayLessons: [],
    releasedGroup: null,
    eventGroup: null,
    counter: { week: 0, term: 0 },
    poolPreference: 'NEUTRAL',
    prefersFree: false,
    wishesFreeDay: false,
    travel: [],
    knowsArea: null,
    teachesStage: null,
    ...overrides,
  };
}

const codes = (overrides: Partial<PassRankInput>) => rankPassCandidate(input(overrides)).reasons.map((r) => [r.code, r.points]);

describe('ranking a candidate for a rastvaktspass', () => {
  it('has no subject, class or load terms, and calls somebody in from home at a cost', () => {
    expect(codes({})).toEqual([['NOT_ON_SITE', -15]]);
    expect(rankPassCandidate(input()).score).toBe(-15);
  });

  it('rewards knowing the area above teaching its stages, after the walks', () => {
    const ranked = rankPassCandidate(
      input({
        knowsArea: 'Skolgården',
        teachesStage: '1–3',
        dayLessons: [{ start: at(8), end: at(9) }, { start: at(11), end: at(12) }],
        travel: [{ from: 'Norra', to: 'Södra', minutes: 15, gap: 10 }],
      }),
    );
    expect(ranked.reasons.map((r) => [r.code, r.points, r.params])).toEqual([
      ['TRAVEL_TOO_SHORT', -20, { from: 'Norra', to: 'Södra', minutes: 15, gap: 10 }],
      ['KNOWS_AREA', 10, { area: 'Skolgården' }],
      ['TEACHES_STAGE', 8, { grades: '1–3' }],
      ['GAP_FILL', 12, {}],
    ]);
    expect(ranked.score).toBe(10);
  });

  it('counts lessons and passes covered, and keeps the pool’s tier', () => {
    expect(codes({ counter: { week: 2, term: 7 }, dayLessons: [{ start: at(8), end: at(9) }] })).toEqual([
      ['ON_SITE', 6],
      ['COUNTER_WEEK', -10],
      ['COUNTER_TERM', -7],
    ]);
    const pool = rankPassCandidate(input({ userId: 'p', kind: 'POOL', poolPreference: 'LAST_RESORT', knowsArea: 'Skolgården' }));
    const staff = rankPassCandidate(input({ userId: 's', counter: { week: 5, term: 15 } }));
    expect(pool.tier).toBe(1);
    expect(
      [pool, staff]
        .map((r) => ({ ...r, counter: { week: 0 } }))
        .sort(compareRanked)
        .map((r) => r.userId),
    ).toEqual(['s', 'p']);
  });

  it('keeps the wishes and the released class', () => {
    expect(codes({ prefersFree: true, wishesFreeDay: true, releasedGroup: '4B' })).toEqual([
      ['ON_SITE', 6],
      ['RELEASED', 8],
      ['PREFERS_FREE', -10],
      ['FREE_DAY_WISH', -10],
    ]);
  });
});
