import { EMPTY_SITE_MAP, pairKey, type SiteMap } from '../common/site-travel';
import { travelLoad, type TravelMaster } from './travel-load';

/**
 * Restid as arbetstid (20261124090000): a teacher's walks between sites,
 * counted over the läsår's school days from the grundschema. Norra and
 * Södra are 15 minutes apart. The year is the four weeks from Monday 7
 * September 2026 (ISO week 37, odd) to Sunday 4 October.
 */

const NORRA = '10000000-0000-4000-8000-000000000001';
const SODRA = '20000000-0000-4000-8000-000000000002';
const MAP: SiteMap = {
  siteOfRoom: new Map([
    ['n1', NORRA],
    ['s1', SODRA],
  ]),
  nameOf: new Map(),
  minutes: new Map([[pairKey(NORRA, SODRA), 15]]),
};
const YEAR = { startDate: '2026-09-07', endDate: '2026-10-04' };

const master = (id: string, dayOfWeek: number, from: string, to: string, roomId: string | null, rest: Partial<TravelMaster> = {}): TravelMaster => ({
  id,
  teacherIds: ['anna'],
  dayOfWeek,
  start: Number(from.slice(0, 2)) * 60 + Number(from.slice(3)),
  end: Number(to.slice(0, 2)) * 60 + Number(to.slice(3)),
  roomId,
  recurrence: 'ALL_WEEKS',
  startDate: null,
  endDate: null,
  ...rest,
});

/** Monday: Norra 08–09, Södra 09:15–10:15, Norra 13–14 — two walks, 30 minutes. */
const MONDAY = [master('a', 1, '08:00', '09:00', 'n1'), master('b', 1, '09:15', '10:15', 's1'), master('c', 1, '13:00', '14:00', 'n1')];

describe('travelLoad', () => {
  it('counts each day’s walks, whatever the gap, over the year’s teaching weeks', () => {
    expect(travelLoad(MAP, MONDAY, YEAR, [])).toEqual([
      { userId: 'anna', minutesPerWeek: 30, peakMinutesPerWeek: 30, hoursPerYear: 2 },
    ]);
  });

  it('honours the weeks a lesson runs: an odd-week walk is half a walk a week, and its busiest week whole', () => {
    const odd = [master('a', 1, '08:00', '09:00', 'n1'), master('b', 1, '09:15', '10:15', 's1', { recurrence: 'ODD_WEEKS' })];
    // Weeks 37 and 39 are odd: two walks of 15 in four weeks.
    expect(travelLoad(MAP, odd, YEAR, [])).toEqual([
      { userId: 'anna', minutesPerWeek: 8, peakMinutesPerWeek: 15, hoursPerYear: 0.5 },
    ]);
  });

  it('counts a lesson only between its Från and Till, and no day a school-wide lov closes', () => {
    const dated = [MONDAY[0]!, { ...MONDAY[1]!, startDate: '2026-09-21' }];
    // From the third Monday: two walks.
    expect(travelLoad(MAP, dated, YEAR, [])[0]!.hoursPerYear).toBe(0.5);
    // A lov on the first Monday leaves three; a closure for åk 7–9 only closes nothing here.
    expect(travelLoad(MAP, MONDAY, YEAR, [{ startDate: '2026-09-07', endDate: '2026-09-07' }])[0]!.hoursPerYear).toBe(1.5);
    expect(
      travelLoad(MAP, MONDAY, YEAR, [{ startDate: '2026-09-07', endDate: '2026-09-07', minGradeLevel: 7, maxGradeLevel: 9 }])[0]!
        .hoursPerYear,
    ).toBe(2);
  });

  it('is the co-teacher’s too, and counts nothing to or from a room on no site, or none', () => {
    const shared = MONDAY.map((row) => ({ ...row, teacherIds: ['anna', 'bo'] }));
    expect(travelLoad(MAP, shared, YEAR, []).map((row) => row.userId)).toEqual(['anna', 'bo']);
    const unknown = [master('a', 1, '08:00', '09:00', 'annex'), master('b', 1, '09:15', '10:15', 's1'), master('c', 1, '13:00', '14:00', null)];
    expect(travelLoad(MAP, unknown, YEAR, [])).toEqual([]);
  });

  it('is nothing at a school with no travel figure: one site, or none', () => {
    expect(travelLoad(EMPTY_SITE_MAP, MONDAY, YEAR, [])).toEqual([]);
  });
});
