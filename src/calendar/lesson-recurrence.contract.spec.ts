import fixture from './__fixtures__/recurrence-cases.json';
import { weeksCanOverlap, type RecurrenceWindow } from './lesson-recurrence';

/**
 * One rule, implemented twice, checked against one list of cases.
 *
 * The room optimisation decides in Python which lessons may share a room
 * (weeks_can_overlap in optimization-engine/app/solver/room_walks.py), and this
 * gateway decides it here — in the grid's clash check and in the guard that
 * refuses an apply. The two sides must read a clash identically: if the engine
 * thinks odd and even weeks can meet when the gateway does not, it refuses a
 * swap the grid would allow; if it thinks they cannot when the gateway does, it
 * proposes a move that apply then refuses as a clash. Neither test suite can see
 * the other, so both replay src/calendar/__fixtures__/recurrence-cases.json.
 *
 * Fix the code, not the fixture — and when a case is added, it is added for
 * both sides at once.
 */

interface FixtureWindow {
  recurrence: 'ALL_WEEKS' | 'ODD_WEEKS' | 'EVEN_WEEKS';
  startDate: string | null;
  endDate: string | null;
}

interface FixtureCase {
  name: string;
  a: FixtureWindow;
  b: FixtureWindow;
  meets: boolean;
}

/** `YYYY-MM-DD` as the midnight-UTC Date a `@db.Date` column comes back as. */
const asWindow = (window: FixtureWindow): RecurrenceWindow => ({
  recurrence: window.recurrence,
  startDate: window.startDate ? new Date(`${window.startDate}T00:00:00.000Z`) : null,
  endDate: window.endDate ? new Date(`${window.endDate}T00:00:00.000Z`) : null,
});

const cases = (fixture as { cases: FixtureCase[] }).cases;

describe('weeksCanOverlap agrees with the shared recurrence fixture', () => {
  it('has cases to replay', () => {
    // An empty or renamed list would make every assertion below vacuous.
    expect(cases.length).toBeGreaterThan(10);
    expect(cases.some((entry) => entry.meets)).toBe(true);
    expect(cases.some((entry) => !entry.meets)).toBe(true);
  });

  it.each(cases.map((entry) => [entry.name, entry] as const))('%s', (_name, entry) => {
    expect(weeksCanOverlap(asWindow(entry.a), asWindow(entry.b))).toBe(entry.meets);
  });
});
