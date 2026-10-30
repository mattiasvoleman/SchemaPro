import { describe, expect, it } from "vitest";
import fixture from "../../src/common/__fixtures__/pupil-list-cases.json";
import { keptByOf, lessonPupils, replacedSubjectOf, replacingBySubject, yearsOf } from "./replacing-groups";

/**
 * Elevlistan i uppföljningen: the web's lessonPupils against the gateway's.
 * src/common/replacing-groups.ts generated the fixture
 * (scripts/generate-pupil-list-fixture.ts) and replays it in
 * pupil-list.contract.spec.ts; here the web's copy answers the same lessons.
 * If the two drift, the timetable's "x/y" counts a SvA pupil on class svenska
 * that SS12000 and the class book leave out.
 */

interface Fixture {
  academicYearId: string;
  pupils: { id: string; homeGroupId: string; groupIds: string[] }[];
  lessons: { id: string; name: string; subjectId: string; groupIds: string[]; named: string[] }[];
  schools: {
    name: string;
    groups: { id: string; kind: string; halfOfId: string | null; replacesSubjectId: string | null; academicYearId: string }[];
    expected: Record<string, { on: string[]; off: string[] }>;
  }[];
}

const f = fixture as unknown as Fixture;
const membersOf = new Map<string, Set<string>>();
for (const pupil of f.pupils) {
  for (const groupId of [pupil.homeGroupId, ...pupil.groupIds]) membersOf.set(groupId, (membersOf.get(groupId) ?? new Set()).add(pupil.id));
}

describe("the web's lesson pupils agree with the gateway's", () => {
  it.each(f.schools.map((school) => [school.name, school] as const))("%s", (_name, school) => {
    const groups = new Map(school.groups.map((group) => [group.id, group]));
    const bySubject = replacingBySubject(replacedSubjectOf(school.groups));
    for (const lesson of f.lessons) {
      const keptBy = keptByOf(groups.get(lesson.groupIds[0]!));
      const scope = { ...lesson, academicYearId: f.academicYearId, ...(keptBy ? { keptBy } : {}) };
      expect([lesson.name, lessonPupils(scope, membersOf, bySubject, yearsOf(school.groups))]).toEqual([lesson.name, school.expected[lesson.id]]);
    }
  });
});
