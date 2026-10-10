import fixture from './__fixtures__/year-clashes-cases.json';
import { clashPairs, yearClashes, type YearClashHit, type YearClashInput } from './year-clashes';

/**
 * What the board paints red, implemented twice, checked against one list.
 *
 * The publish gate PUB_CLASHES (src/publication) counts this module's
 * clashes; the board paints web/lib/conflicts.ts's. If the two drift, the
 * gate warns about a clash the admin cannot find on the board, or misses one
 * painted red in front of them. Both suites replay
 * src/common/__fixtures__/year-clashes-cases.json — the web's
 * year-clashes.contract.test.ts through detectConflicts, restricted to the
 * four kinds mirrored here.
 *
 * The fixture was GENERATED from this implementation (the script is in the
 * commit message). Fix the code and regenerate when a change is intended;
 * never edit the JSON by hand, because the web replays it.
 */

interface FixtureCase {
  name: string;
  input: YearClashInput;
  clashes: Record<string, YearClashHit[]>;
}

const { cases } = fixture as unknown as { cases: FixtureCase[] };

describe('year clashes agree with the shared fixture', () => {
  it('reaches every kind, a buffer-only clash and a clean year', () => {
    const kinds = new Set(cases.flatMap((c) => Object.values(c.clashes).flat().map((hit) => hit.kind)));
    expect([...kinds].sort()).toEqual(['AVAILABILITY', 'GROUP', 'ROOM', 'TEACHER']);
    expect(cases.some((c) => Object.values(c.clashes).flat().some((hit) => hit.pupilBufferOnly))).toBe(true);
    expect(cases.some((c) => Object.keys(c.clashes).length === 0)).toBe(true);
  });

  it.each(cases.map((c) => [c.name, c] as const))('%s', (_name, c) => {
    const found = Object.fromEntries([...yearClashes(c.input).entries()].sort(([a], [b]) => (a < b ? -1 : 1)));
    expect(found).toEqual(c.clashes);
  });

  it('counts a clash between two lessons once, however many hits name it', () => {
    const teacher = cases.find((c) => c.name === 'a teacher in two places at once');
    expect(clashPairs(yearClashes(teacher!.input))).toEqual([{ kind: 'TEACHER', lessonIds: ['a', 'b'] }]);
  });
});
