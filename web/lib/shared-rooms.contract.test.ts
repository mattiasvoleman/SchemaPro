import { describe, expect, it } from "vitest";
import fixture from "../../src/common/__fixtures__/shared-rooms-cases.json";
import {
  crowdedWith,
  sharedSeatsOf,
  type RoomOccupant,
  type SharedRoomMode,
  type SharedRoomWeeks,
} from "@/lib/shared-rooms";

/**
 * Delade salar, implemented twice, checked against one list of cases — the web
 * half of src/common/shared-rooms.contract.spec.ts.
 *
 * lib/shared-rooms.ts is a copy of the gateway's module, so the board paints a
 * shared hall the way the API's hand edit and the publish gate judge it. If the
 * two drift, the board shows a clash the gate does not count, or a free hall
 * the API then refuses. The expectations in the fixture were written by hand
 * from the rule, not generated from either copy.
 */

interface FixtureOccupant {
  start: number;
  end: number;
  recurrence?: SharedRoomWeeks;
  pupils: string[];
}

const occupantOf = (row: FixtureOccupant): RoomOccupant => ({
  start: row.start,
  end: row.end,
  ...(row.recurrence ? { recurrence: row.recurrence } : {}),
  pupils: new Set(row.pupils),
});

describe("delade salar agree with the shared fixture", () => {
  it.each(fixture.seats.map((c) => [c.name, c] as const))("seats: %s", (_name, c) => {
    expect(sharedSeatsOf(c.mode as SharedRoomMode | null, c.room)).toBe(c.seats);
  });

  it.each(fixture.crowded.map((c) => [c.name, c] as const))("%s", (_name, c) => {
    const found = crowdedWith(
      c.seats,
      occupantOf(c.candidate as FixtureOccupant),
      (c.others as FixtureOccupant[]).map(occupantOf),
    );
    expect([...found].sort()).toEqual(c.crowded);
  });
});
