import { describe, expect, it } from "vitest";
import fixture from "../../src/common/__fixtures__/replacing-groups-cases.json";
import {
  leavesLesson,
  pupilKeysOf,
  replacedSubjectOf,
  replacementPairs,
  replacementsOf,
  replacingBySubject,
  replacingGroupsOfNamed,
} from "./replacing-groups";

/**
 * Ersättande grupper: the web's copy of the rule against the gateway's.
 *
 * src/common/replacing-groups.ts generated the fixture
 * (scripts/generate-replacing-groups-fixture.ts) and replays it in its own
 * spec; here the web's copy answers the same questions. If the two drift, the
 * board paints a clash the publish gate does not count, or the timplan's live
 * Mål mode credits a SvA pupil with class svenska the server does not.
 */

interface Fixture {
  groups: { id: string; replacesSubjectId: string | null }[];
  groupsOfPupil: Record<string, string[]>;
  pairs: [string, string][];
  lessons: { id: string; subjectId: string; groupIds: string[]; named: string[] }[];
  expected: {
    leaves: { lesson: string; pupil: string; leaves: boolean }[];
    keys: Record<string, string[]>;
    addedPairs: [string, string][];
  };
}

const f = fixture as unknown as Fixture;
const replaced = replacedSubjectOf(f.groups);
const bySubject = replacingBySubject(replaced);
const pairs = new Set(f.pairs.map(([a, b]) => `${a} ${b}`));
const shares = (a: string, b: string) => pairs.has(a < b ? `${a} ${b}` : `${b} ${a}`);
const partnersOf = (groupId: string) => f.pairs.flatMap(([a, b]) => (a === groupId ? [b] : b === groupId ? [a] : []));

describe("the web's replacing groups agree with the gateway's", () => {
  it("takes the same pupils off the same lessons", () => {
    const lessons = new Map(f.lessons.map((lesson) => [lesson.id, lesson]));
    for (const row of f.expected.leaves) {
      const lesson = lessons.get(row.lesson)!;
      const got = leavesLesson(replacementsOf(f.groupsOfPupil[row.pupil]!, replaced), lesson, lesson.named.includes(row.pupil));
      expect([row.lesson, row.pupil, got]).toEqual([row.lesson, row.pupil, row.leaves]);
    }
  });

  it("gives every lesson the same keys, and adds the same pairs", () => {
    const keys = Object.fromEntries(
      f.lessons.map((lesson) => [
        lesson.id,
        pupilKeysOf(lesson, bySubject, shares, replacingGroupsOfNamed(lesson.named, (pupil) => f.groupsOfPupil[pupil] ?? [], replaced)),
      ]),
    );
    expect(keys).toEqual(f.expected.keys);
    expect(replacementPairs(Object.values(keys).flat(), partnersOf)).toEqual(f.expected.addedPairs);
  });
});
