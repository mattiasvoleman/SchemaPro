import {
  EMPTY_SITE_MAP,
  neighboursOf,
  pairKey,
  travelBreaches,
  walkBetween,
  walksOfDay,
  type PlacedLesson,
  type SiteMap,
} from './site-travel';

/**
 * Skolområden och restid (20261124090000): the rule the hand edits, the
 * vikarie suggestions and the load read. Norra and Södra are 15 minutes
 * apart; Hallen has no figure to either; the annex room stands on no site.
 */

const NORRA = '10000000-0000-4000-8000-000000000001';
const SODRA = '20000000-0000-4000-8000-000000000002';
const HALLEN = '30000000-0000-4000-8000-000000000003';

const MAP: SiteMap = {
  siteOfRoom: new Map([
    ['n1', NORRA],
    ['n2', NORRA],
    ['s1', SODRA],
    ['h1', HALLEN],
  ]),
  nameOf: new Map([
    [NORRA, 'Norra'],
    [SODRA, 'Södra'],
    [HALLEN, 'Hallen'],
  ]),
  minutes: new Map([[pairKey(SODRA, NORRA), 15]]),
};

const at = (id: string, from: string, to: string, roomId: string | null): PlacedLesson => {
  const minutes = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3));
  return { id, start: minutes(from), end: minutes(to), roomId };
};

describe('pairKey', () => {
  it('is the pair in id order, whichever way it is asked, as SiteTravelTimes stores it', () => {
    expect(pairKey(NORRA, SODRA)).toBe(pairKey(SODRA, NORRA));
    expect(pairKey(SODRA.toUpperCase(), NORRA)).toBe(`${NORRA}|${SODRA}`);
  });
});

describe('walkBetween', () => {
  it('is the pair’s figure between rooms on two sites, the same both ways', () => {
    expect(walkBetween(MAP, 'n1', 's1')).toEqual({ fromSite: NORRA, toSite: SODRA, minutes: 15 });
    expect(walkBetween(MAP, 's1', 'n2')).toEqual({ fromSite: SODRA, toSite: NORRA, minutes: 15 });
  });

  it('is nothing on one site, without a room, on no site, or between sites with no figure', () => {
    expect(walkBetween(MAP, 'n1', 'n2')).toBeNull();
    expect(walkBetween(MAP, null, 's1')).toBeNull();
    expect(walkBetween(MAP, 'annex', 's1')).toBeNull();
    expect(walkBetween(MAP, 'h1', 's1')).toBeNull();
  });
});

describe('neighboursOf', () => {
  it('is a teacher’s nearest lesson on each side, both of two that end together', () => {
    const target = at('t', '10:15', '11:00', 's1');
    const others = [at('a', '08:00', '09:00', 'n1'), at('b', '09:05', '10:00', 'n1'), at('c', '08:00', '08:55', 'n2'),
      at('d', '11:10', '12:00', 'n1'), at('e', '13:00', '14:00', 'n1')];
    const { before, after } = neighboursOf(target, others);
    expect(before.map((l) => l.id).sort()).toEqual(['b']);
    expect(after.map((l) => l.id)).toEqual(['d']);
    // Two lessons on one end, neither between the other and the target.
    const tied = neighboursOf(target, [at('x', '09:00', '10:00', 'n1'), at('y', '09:10', '10:00', 's1')]);
    expect(tied.before.map((l) => l.id).sort()).toEqual(['x', 'y']);
  });

  it('is each pupil’s nearest: a lesson between two that share nobody hides neither', () => {
    // 7A at 10:05; before it, its Spanska pupils at Södra until 09:55 and its Tyska pupils at Norra until 10:00.
    const target = { ...at('7a', '10:05', '11:00', 'n1'), pupils: ['p1', 'p2', 'p3', 'p4'] };
    const spanska = { ...at('spa', '09:00', '09:55', 's1'), pupils: ['p1', 'p2'] };
    const tyska = { ...at('tys', '09:00', '10:00', 'n2'), pupils: ['p3', 'p4'] };
    const earlier = { ...at('mor', '08:00', '08:50', 'n1'), pupils: ['p1', 'p2', 'p3', 'p4'] };
    // Hidden when every pupil the lesson and 7A's share goes to some lesson in between.
    const hidden = (o: { pupils: string[] }, between: readonly { pupils: string[] }[]) =>
      o.pupils.filter((p) => target.pupils.includes(p)).every((p) => between.some((m) => m.pupils.includes(p)));
    const { before } = neighboursOf(target, [spanska, tyska, earlier], hidden);
    expect(before.map((l) => l.id).sort()).toEqual(['spa', 'tys']);
    // The morning lesson's pupils all go to Spanska or Tyska after it: nobody walks from it to 7A's.
    expect(before.map((l) => l.id)).not.toContain('mor');
  });

  it('counts a lesson overlapping the target as neither before nor after it', () => {
    const target = at('t', '10:00', '11:00', 'n1');
    expect(neighboursOf(target, [at('o', '10:30', '11:30', 's1')])).toEqual({ before: [], after: [] });
  });
});

describe('travelBreaches', () => {
  it('names each walk the gap does not hold, from the lesson before and to the lesson after', () => {
    const target = at('t', '10:05', '11:00', 's1');
    const breaches = travelBreaches(MAP, target, [at('b', '09:00', '10:00', 'n1'), at('a', '11:10', '12:00', 'n2')]);
    expect(breaches.map((b) => [b.from.id, b.to.id, b.walk.minutes, b.gap])).toEqual([
      ['b', 't', 15, 5],
      ['t', 'a', 15, 10],
    ]);
  });

  it('holds a gap of exactly the walk, and says nothing of an unknown walk', () => {
    const target = at('t', '10:15', '11:00', 's1');
    expect(travelBreaches(MAP, target, [at('b', '09:00', '10:00', 'n1')])).toEqual([]);
    expect(travelBreaches(MAP, at('t', '10:00', '11:00', 'h1'), [at('b', '09:00', '10:00', 'n1')])).toEqual([]);
    expect(travelBreaches(MAP, at('t', '10:00', '11:00', 'annex'), [at('b', '09:00', '10:00', 's1')])).toEqual([]);
  });

  it('is nothing at a school with no figure at all, one site or none', () => {
    const target = at('t', '10:00', '11:00', 's1');
    expect(travelBreaches(EMPTY_SITE_MAP, target, [at('b', '09:00', '10:00', 'n1')])).toEqual([]);
  });
});

describe('walksOfDay', () => {
  it('is every walk between one lesson and the next, whatever the gap', () => {
    const day = [at('c', '13:00', '14:00', 'n1'), at('a', '08:00', '09:00', 'n1'), at('b', '09:00', '10:00', 's1'),
      at('d', '14:00', '15:00', 'h1')];
    expect(walksOfDay(MAP, day)).toEqual([
      { fromSite: NORRA, toSite: SODRA, minutes: 15 },
      { fromSite: SODRA, toSite: NORRA, minutes: 15 },
    ]);
  });

  it('starts no walk from a lesson the next one overlaps, and none of 0 minutes', () => {
    const zero: SiteMap = { ...MAP, minutes: new Map([[pairKey(NORRA, SODRA), 0]]) };
    expect(walksOfDay(zero, [at('a', '08:00', '09:00', 'n1'), at('b', '09:00', '10:00', 's1')])).toEqual([]);
    expect(walksOfDay(MAP, [at('a', '08:00', '09:30', 'n1'), at('b', '09:00', '10:00', 's1')])).toEqual([]);
  });
});
