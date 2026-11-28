import { makeWorld } from '../swaps/__fixtures__/swap-world';
import { pointsOf } from './fill-plan';

/*
 * The starts the fill asks about are the points where something in the school begins or ends. Another school's hold on a room (Delade lokaler) is a closed
 * stretch of the room as a closed hour is, and the first start after it is a start nothing else in the school marks: left out of the points, a brick that
 * can only stand in that room after the hold is "NO_FREE_START" with a start the judge would let through.
 */

const base = makeWorld({ seed: 5, classes: 3, perClass: 0 });

describe('the starts of the fill: another school\'s holds', () => {
  it('are points too: where a hold begins and where it ends', () => {
    const data = {
      ...base.data,
      lessons: [],
      sittings: [],
      constraints: [],
      frames: [{ min: 7, max: 9, day: null, start: 480, end: 900 }],
      holds: [{ holdId: 'h1', kind: 'ROOM_LENT', resourceKind: 'ROOM' as const, resourceId: 'r1', dayOfWeek: 2, startTime: '08:00:00', endTime: '10:20:00', schools: ['Annan skola'] }],
    } as unknown as typeof base.data;
    expect(pointsOf(data, { fromMinutes: 480, toMinutes: 900 })).toEqual([480, 620, 900]);
  });

  it('are left out when they lie outside the day the frames give', () => {
    const data = {
      ...base.data,
      lessons: [],
      sittings: [],
      constraints: [],
      frames: [{ min: 7, max: 9, day: null, start: 480, end: 900 }],
      holds: [{ holdId: 'h2', kind: 'ROOM_LENT', resourceKind: 'ROOM' as const, resourceId: 'r1', dayOfWeek: 2, startTime: '16:00:00', endTime: '17:00:00', schools: ['Annan skola'] }],
    } as unknown as typeof base.data;
    expect(pointsOf(data, { fromMinutes: 480, toMinutes: 900 })).toEqual([480, 900]);
  });
});
