import fixture from './__fixtures__/school-weeks-cases.json';
import { closedWeeksOf, meetOnlyInClosedWeeks, type ClosedWeeks, type HeldWeeks } from './school-weeks';

/**
 * Which weeks no lesson is written in, implemented twice and checked against one list.
 *
 * The gateway reads the weeks for the generator's periods, the hand edit and the publish gate
 * (src/calendar/school-weeks.ts); the board reads them for what it paints red (web/lib/closed-weeks.ts, the
 * browser's copy: the two packages share no build). If the two drift, the board paints a clash the gateway
 * does not count or the other way round. Both suites replay src/calendar/__fixtures__/school-weeks-cases.json,
 * which was GENERATED from this implementation: fix the code and regenerate when a change is intended, and
 * never edit the JSON by hand, because the web replays it.
 */

interface World {
  name: string;
  year: { startDate: string; endDate: string };
  breaks: Array<{ startDate: string; endDate: string; minGradeLevel: number | null; maxGradeLevel: number | null }>;
  grades: Array<number | null>;
  mondays: string[];
}
interface Meet {
  world: number;
  a: HeldWeeks;
  b: HeldWeeks;
  onlyClosed: boolean;
}

const { worlds, meets } = fixture as unknown as { worlds: World[]; meets: Meet[] };
const day = (value: string): Date => new Date(`${value}T00:00:00.000Z`);

describe('closed weeks agree with the shared fixture', () => {
  it('has worlds that close weeks and worlds that close none, and both answers of the pair rule', () => {
    expect(worlds.some((world) => world.mondays.length > 0)).toBe(true);
    expect(worlds.some((world) => world.mondays.length === 0)).toBe(true);
    expect(meets.some((meet) => meet.onlyClosed)).toBe(true);
    expect(meets.some((meet) => !meet.onlyClosed)).toBe(true);
  });

  it.each(worlds.map((world) => [world.name, world] as const))('%s: the Mondays of the weeks with no school day', (_name, world) => {
    const closed = closedWeeksOf(world.year, {
      breaks: world.breaks.map((entry) => ({ ...entry, startDate: day(entry.startDate), endDate: day(entry.endDate) })),
      grades: world.grades,
    });
    expect(closed ? [...closed.mondays] : []).toEqual(world.mondays);
  });

  it('answers every pair as the fixture does', () => {
    const closedOf = new Map<number, ClosedWeeks>();
    worlds.forEach((world, index) => {
      if (world.mondays.length > 0) {
        closedOf.set(index, { from: world.year.startDate, to: world.year.endDate, mondays: new Set(world.mondays) });
      }
    });
    for (const meet of meets) {
      expect({ meet, said: meetOnlyInClosedWeeks(meet.a, meet.b, closedOf.get(meet.world)) }).toEqual({
        meet,
        said: meet.onlyClosed,
      });
    }
  });
});
