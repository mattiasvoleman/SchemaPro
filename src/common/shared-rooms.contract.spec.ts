import fixture from './__fixtures__/shared-rooms-cases.json';
import {
  crowdedWith,
  sharedSeatsOf,
  type RoomOccupant,
  type SharedRoomMode,
  type SharedRoomWeeks,
} from './shared-rooms';

/**
 * Delade salar, implemented twice, checked against one list of cases.
 *
 * web/lib/shared-rooms.ts is a copy of this module, so the board paints a
 * shared hall the way the gateway's hand edit and the publish gate judge it.
 * If the two drift, the board shows a clash the gate does not count, or a free
 * hall the API then refuses. Neither suite can see the other, so both replay
 * src/common/__fixtures__/shared-rooms-cases.json — the web importing it
 * across the package boundary, as it does the other contract fixtures.
 *
 * The expectations were written by hand from the rule, not generated from the
 * code: each case says in its name what it is about.
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

describe('delade salar agree with the shared fixture', () => {
  it.each(fixture.seats.map((c) => [c.name, c] as const))('seats: %s', (_name, c) => {
    expect(sharedSeatsOf(c.mode as SharedRoomMode | null, c.room)).toBe(c.seats);
  });

  it.each(fixture.crowded.map((c) => [c.name, c] as const))('%s', (_name, c) => {
    const found = crowdedWith(
      c.seats,
      occupantOf(c.candidate as FixtureOccupant),
      (c.others as FixtureOccupant[]).map(occupantOf),
    );
    expect([...found].sort()).toEqual(c.crowded);
  });
});
