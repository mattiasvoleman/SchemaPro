import { describe, expect, it } from "vitest";
import fixture from "../../src/calendar/__fixtures__/school-weeks-cases.json";
import { closedWeeksOf, meetOnlyInClosedWeeks, type ClosedWeeks } from "./closed-weeks";

/**
 * Which weeks no lesson is written in, the board's copy against the gateway's.
 *
 * web/lib/closed-weeks.ts is the browser's copy of src/calendar/school-weeks.ts, and both suites replay the
 * same fixture, generated on the gateway side (school-weeks.contract.spec.ts there). If they drift, the
 * board paints a clash the hand edit and the publish gate do not count, or the other way round.
 */

interface World {
  name: string;
  year: { startDate: string; endDate: string };
  breaks: Array<{ startDate: string; endDate: string; minGradeLevel: number | null; maxGradeLevel: number | null }>;
  grades: Array<number | null>;
  mondays: string[];
}
interface Held {
  recurrence: "ALL_WEEKS" | "ODD_WEEKS" | "EVEN_WEEKS";
  startDate: string | null;
  endDate: string | null;
}

const { worlds, meets } = fixture as unknown as {
  worlds: World[];
  meets: Array<{ world: number; a: Held; b: Held; onlyClosed: boolean }>;
};

describe("the board reads the closed weeks as the gateway does", () => {
  it.each(worlds.map((world) => [world.name, world] as const))("%s: the Mondays of the weeks with no school day", (_name, world) => {
    const closed = closedWeeksOf(world.year, world.breaks, world.grades);
    expect(closed ? [...closed.mondays] : []).toEqual(world.mondays);
  });

  it("answers every pair as the fixture does", () => {
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

  it("is undefined where the school has no break, and none that closes a week", () => {
    const year = { startDate: "2026-08-17", endDate: "2027-06-11" };
    expect(closedWeeksOf(year, [], [9])).toBeUndefined();
    expect(closedWeeksOf(year, [{ startDate: "2026-12-28", endDate: "2026-12-31", minGradeLevel: null, maxGradeLevel: null }], [9])).toBeUndefined();
  });
});
