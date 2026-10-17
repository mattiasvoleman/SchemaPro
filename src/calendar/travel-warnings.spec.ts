import { pairKey, type SiteMap } from '../common/site-travel';
import {
  sharePupils,
  travelWarningsOf,
  weeksCover,
  TRAVEL_TIME_SHORT,
  type TravelDayLesson,
  type TravelWarningContext,
  type TravelWeeks,
} from './travel-warnings';

/**
 * A hand edit's TRAVEL_TIME_SHORT (Skolområden och restid, 20261124090000).
 * Norra and Södra are 15 minutes apart. Anna teaches; 7A is a class whose
 * Spanska pupils are p1 and p2, its Tyska pupils p3 and p4.
 */

const NORRA = '10000000-0000-4000-8000-000000000001';
const SODRA = '20000000-0000-4000-8000-000000000002';

const MAP: SiteMap = {
  siteOfRoom: new Map([
    ['n1', NORRA],
    ['n2', NORRA],
    ['s1', SODRA],
  ]),
  nameOf: new Map([
    [NORRA, 'Norra'],
    [SODRA, 'Södra'],
  ]),
  minutes: new Map([[pairKey(NORRA, SODRA), 15]]),
};

const minutes = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3));

const lesson = (
  id: string,
  from: string,
  to: string,
  roomId: string | null,
  rest: Partial<Omit<TravelDayLesson, 'pupils'>> & { pupils?: string[] } = {},
): TravelDayLesson => ({
  id,
  start: minutes(from),
  end: minutes(to),
  roomId,
  subjectName: rest.subjectName ?? id,
  teacherIds: rest.teacherIds ?? [],
  groupIds: rest.groupIds ?? [],
  pupils: new Set(rest.pupils ?? []),
  weeks: rest.weeks ?? EVERY_WEEK,
});

const EVERY_WEEK: TravelWeeks = { recurrence: 'ALL_WEEKS', startDate: null, endDate: null };

const context = (overrides: Partial<TravelWarningContext> = {}): TravelWarningContext => ({
  map: MAP,
  weeksMeet: () => true,
  halvesPair: () => false,
  teacherName: (id) => ({ anna: 'Anna Ek', bo: 'Bo Ås' })[id] ?? id,
  groupName: (id) => ({ g7a: '7A', spa: 'Spanska 7', tys: 'Tyska 7', h1: '7A:1', h2: '7A:2' })[id] ?? id,
  ...overrides,
});

const CLASS = ['p1', 'p2', 'p3', 'p4'];

describe('travelWarningsOf', () => {
  it('warns of the teacher’s walk from the lesson before, with the other lesson named', () => {
    const target = lesson('sv', '10:05', '11:00', 's1', { subjectName: 'Svenska', teacherIds: ['anna'] });
    const day = [lesson('ma', '09:00', '10:00', 'n1', { subjectName: 'Matematik', teacherIds: ['anna'] })];
    expect(travelWarningsOf(context(), target, day)).toEqual([
      {
        code: TRAVEL_TIME_SHORT,
        params: {
          party: 'TEACHER',
          name: 'Anna Ek',
          from: 'Norra',
          to: 'Södra',
          minutes: 15,
          gap: 5,
          other: 'Matematik',
          time: '09:00–10:00',
        },
      },
    ]);
  });

  it('warns of each teacher on the lesson, and of the walk to the lesson after', () => {
    const target = lesson('sv', '10:00', '11:00', 'n1', { teacherIds: ['anna', 'bo'] });
    const day = [
      lesson('a', '11:05', '12:00', 's1', { teacherIds: ['anna'] }),
      lesson('b', '11:10', '12:00', 's1', { teacherIds: ['bo'] }),
    ];
    expect(travelWarningsOf(context(), target, day).map((w) => [w.params.name, w.params.from, w.params.to, w.params.gap])).toEqual([
      ['Anna Ek', 'Norra', 'Södra', 5],
      ['Bo Ås', 'Norra', 'Södra', 10],
    ]);
  });

  it('says nothing of a gap that holds the walk, another teacher’s day, other weeks, or a room on no site', () => {
    const target = lesson('sv', '10:15', '11:00', 's1', { teacherIds: ['anna'] });
    expect(travelWarningsOf(context(), target, [lesson('ma', '09:00', '10:00', 'n1', { teacherIds: ['anna'] })])).toEqual([]);
    const close = lesson('sv', '10:05', '11:00', 's1', { teacherIds: ['anna'] });
    expect(travelWarningsOf(context(), close, [lesson('ma', '09:00', '10:00', 'n1', { teacherIds: ['bo'] })])).toEqual([]);
    expect(
      travelWarningsOf(context({ weeksMeet: () => false }), close, [lesson('ma', '09:00', '10:00', 'n1', { teacherIds: ['anna'] })]),
    ).toEqual([]);
    expect(travelWarningsOf(context(), { ...close, roomId: 'annex' }, [lesson('ma', '09:00', '10:00', 'n1', { teacherIds: ['anna'] })])).toEqual([]);
    expect(travelWarningsOf(context(), { ...close, roomId: null }, [lesson('ma', '09:00', '10:00', 'n1', { teacherIds: ['anna'] })])).toEqual([]);
  });

  it('warns of the pupils who walk, named by the smaller lesson, each from the lesson they come from', () => {
    // 7A at Norra 10:05; Spanska at Södra until 09:55, Tyska at Norra until 10:00.
    const target = lesson('sv', '10:05', '11:00', 'n1', { groupIds: ['g7a'], pupils: CLASS });
    const day = [
      lesson('spa', '09:00', '09:55', 's1', { subjectName: 'Spanska', groupIds: ['spa'], pupils: ['p1', 'p2'] }),
      lesson('tys', '09:00', '10:00', 'n2', { subjectName: 'Tyska', groupIds: ['tys'], pupils: ['p3', 'p4'] }),
    ];
    expect(travelWarningsOf(context(), target, day).map((w) => [w.params.party, w.params.name, w.params.other, w.params.gap])).toEqual([
      ['PUPILS', 'Spanska 7', 'Spanska', 10],
    ]);
  });

  it('holds a half to the pupils it may hold, as the clash check does', () => {
    // 7A:1 has no pupils placed yet; its class walks from Södra all the same.
    const target = lesson('sv', '10:05', '11:00', 'n1', { groupIds: ['g7a'], pupils: CLASS });
    const day = [lesson('sl', '09:00', '10:00', 's1', { subjectName: 'Slöjd', groupIds: ['h1'], pupils: [] })];
    expect(travelWarningsOf(context(), target, day)).toEqual([]);
    const paired = context({ halvesPair: (a, b) => [a, b].sort().join() === 'g7a,h1' });
    expect(travelWarningsOf(paired, target, day).map((w) => [w.params.party, w.params.name])).toEqual([['PUPILS', '7A:1']]);
  });

  it('names a walk once, however many routes find it', () => {
    // The teacher and the class walk the same way: two parties, two warnings; the same party twice, one.
    const target = lesson('sv', '10:05', '11:00', 's1', { teacherIds: ['anna', 'anna'], groupIds: ['g7a'], pupils: CLASS });
    const day = [lesson('ma', '09:00', '10:00', 'n1', { teacherIds: ['anna'], groupIds: ['g7a'], pupils: CLASS })];
    expect(travelWarningsOf(context(), target, day).map((w) => w.params.party)).toEqual(['TEACHER', 'PUPILS']);
  });
});

describe('a lesson between two others hides the walk only where it stands', () => {
  // 30 minutes between Norra and Södra here, so a 25-minute gap is short.
  const LONG: SiteMap = { ...MAP, minutes: new Map([[pairKey(NORRA, SODRA), 30]]) };

  it('only in the weeks it runs: an odd-week lesson between leaves the even weeks’ walk', () => {
    const target = lesson('t', '09:25', '10:00', 'n1', { teacherIds: ['anna'] });
    const from = lesson('o', '08:00', '09:00', 's1', { teacherIds: ['anna'], weeks: { recurrence: 'EVEN_WEEKS', startDate: null, endDate: null } });
    const oddBetween = lesson('m', '09:00', '09:20', 'n2', { teacherIds: ['anna'], weeks: { recurrence: 'ODD_WEEKS', startDate: null, endDate: null } });
    expect(travelWarningsOf(context({ map: LONG }), target, [from, oddBetween]).map((w) => [w.params.other, w.params.gap])).toEqual([
      ['o', 25],
    ]);
    // Every week between: hidden.
    expect(travelWarningsOf(context({ map: LONG }), target, [from, { ...oddBetween, weeks: EVERY_WEEK }])).toEqual([]);
  });

  it('only between its own Från and Till: one that stops at Christmas leaves the spring’s walk', () => {
    const target = lesson('t', '09:25', '10:00', 'n1', { teacherIds: ['anna'] });
    const from = lesson('o', '08:00', '09:00', 's1', { teacherIds: ['anna'] });
    const autumn = lesson('m', '09:00', '09:20', 'n2', { teacherIds: ['anna'], weeks: { recurrence: 'ALL_WEEKS', startDate: null, endDate: '2026-12-20' } });
    expect(travelWarningsOf(context({ map: LONG }), target, [from, autumn]).map((w) => w.params.other)).toEqual(['o']);
  });

  it('for pupils, only those it holds: modersmål with one Spanska pupil leaves the other four walking', () => {
    const target = lesson('ma', '09:25', '10:00', 'n1', { groupIds: ['g7a'], pupils: ['a1', 'a2', 'a3', 'a4', 'a5', 'b1'] });
    const spanska = lesson('spa', '08:00', '09:00', 's1', { groupIds: ['spa'], pupils: ['a1', 'a2', 'a3', 'a4', 'a5'] });
    const modersmal = lesson('mod', '09:00', '09:20', 'n2', { groupIds: [], pupils: ['a1'] });
    expect(
      travelWarningsOf(context({ map: LONG }), target, [spanska, modersmal]).map((w) => [w.params.party, w.params.other]),
    ).toEqual([['PUPILS', 'spa']]);
    // Every Spanska pupil there in between: hidden.
    expect(travelWarningsOf(context({ map: LONG }), target, [spanska, { ...modersmal, pupils: new Set(['a1', 'a2', 'a3', 'a4', 'a5']) }])).toEqual([]);
  });
});

describe('weeksCover', () => {
  const w = (recurrence: TravelWeeks['recurrence'], startDate: string | null = null, endDate: string | null = null): TravelWeeks => ({
    recurrence,
    startDate,
    endDate,
  });

  it('is every week, or the parity two lessons share, over the dates they share', () => {
    expect(weeksCover(w('ALL_WEEKS'), w('ALL_WEEKS'), w('ALL_WEEKS'))).toBe(true);
    expect(weeksCover(w('ODD_WEEKS'), w('ALL_WEEKS'), w('ALL_WEEKS'))).toBe(false);
    expect(weeksCover(w('ODD_WEEKS'), w('ODD_WEEKS'), w('ALL_WEEKS'))).toBe(true);
    expect(weeksCover(w('EVEN_WEEKS'), w('ODD_WEEKS'), w('ALL_WEEKS'))).toBe(false);
    expect(weeksCover(w('ALL_WEEKS', '2026-08-17'), w('ALL_WEEKS', '2026-09-01'), w('ALL_WEEKS'))).toBe(true);
    expect(weeksCover(w('ALL_WEEKS', '2026-10-01'), w('ALL_WEEKS', '2026-09-01'), w('ALL_WEEKS'))).toBe(false);
    expect(weeksCover(w('ALL_WEEKS', null, '2026-12-20'), w('ALL_WEEKS'), w('ALL_WEEKS', null, '2026-12-20'))).toBe(true);
    expect(weeksCover(w('ALL_WEEKS', null, '2026-12-20'), w('ALL_WEEKS'), w('ALL_WEEKS'))).toBe(false);
  });
});

describe('sharePupils', () => {
  it('is a group in common, a pupil in common, or a half beside its class', () => {
    const a = lesson('a', '09:00', '10:00', null, { groupIds: ['g7a'], pupils: ['p1'] });
    expect(sharePupils(a, lesson('b', '10:00', '11:00', null, { groupIds: ['g7a'] }), () => false)).toBe(true);
    expect(sharePupils(a, lesson('b', '10:00', '11:00', null, { groupIds: ['spa'], pupils: ['p1'] }), () => false)).toBe(true);
    expect(sharePupils(a, lesson('b', '10:00', '11:00', null, { groupIds: ['h1'] }), () => false)).toBe(false);
    expect(sharePupils(a, lesson('b', '10:00', '11:00', null, { groupIds: ['h1'] }), () => true)).toBe(true);
  });
});
