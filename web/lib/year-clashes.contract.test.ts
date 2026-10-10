import { describe, expect, it } from "vitest";
import fixture from "../../src/common/__fixtures__/year-clashes-cases.json";
import {
  buildGroupConflictMap,
  buildPupilBufferMap,
  detectConflicts,
  type ConflictHit,
} from "./conflicts";
import type { AvailabilityConstraint, MasterLesson } from "./types";

/**
 * The board's clash check against the gateway's publish gate.
 *
 * src/common/year-clashes.ts mirrors detectConflicts' TEACHER, ROOM, GROUP
 * and AVAILABILITY arms so the publish gate PUB_CLASHES counts what this file
 * paints red. Both suites replay the same fixture, generated on the gateway
 * side; here the board's own function is asked, with the inputs it is given
 * on /admin/timetable, and its FRAME, LUNCH and ROOM_LOCK arms left out by
 * not passing their inputs — the gate does not count those (see the module).
 */

interface FixtureCase {
  name: string;
  input: {
    lessons: Array<Record<string, unknown> & { id: string }>;
    constraints: Array<Record<string, unknown>>;
    studentGroupOf: Array<[string, string | null]>;
    memberships: Array<{ studentId: string; studentGroupId: string }>;
    pupilBuffers: Array<{ studentGroupId: string; subjectId: string; minutesBefore: number; minutesAfter: number }>;
  };
  clashes: Record<string, ConflictHit[]>;
}

const { cases } = fixture as unknown as { cases: FixtureCase[] };

describe("the board paints what the publish gate counts", () => {
  it.each(cases.map((c) => [c.name, c] as const))("%s", (_name, c) => {
    const studentGroupOf = new Map(c.input.studentGroupOf);
    const found = detectConflicts(
      c.input.lessons.map((lesson) => ({ academicYearId: "y", isLocked: false, isParked: false, ...lesson })) as unknown as MasterLesson[],
      c.input.constraints.map((row, index) => ({
        id: `c${index}`,
        minGradeLevel: null,
        maxGradeLevel: null,
        reason: null,
        ...row,
      })) as unknown as AvailabilityConstraint[],
      studentGroupOf,
      buildGroupConflictMap(studentGroupOf, c.input.memberships),
      undefined,
      undefined,
      undefined,
      undefined,
      buildPupilBufferMap(c.input.pupilBuffers),
    );
    expect(Object.fromEntries([...found.entries()].sort(([a], [b]) => (a < b ? -1 : 1)))).toEqual(c.clashes);
  });
});
