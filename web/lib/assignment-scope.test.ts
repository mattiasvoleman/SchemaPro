import { describe, expect, it } from "vitest";
import {
  hoursOver,
  overOrdinanceIds,
  overScopeIds,
  scopeCardOf,
  type ScopeReport,
  type TeacherScope,
} from "./assignment-scope";
import { scopeAssessmentOf } from "./assignment-scope";

const teacher = (overrides: Partial<TeacherScope> = {}): TeacherScope => ({
  userId: "t-anna",
  verdict: "INSIDE",
  notJudged: null,
  teachingHours: 645,
  stages: [{ gradeFrom: 1, gradeTo: 6, hours: 645, teachingHoursLow: 550, teachingHoursHigh: 650, planningFloorPercent: 100 }],
  unregulatedHours: 0,
  unknownGradeHours: 0,
  fullTimeHighestHours: 650,
  fullTimeLowestHours: 550,
  highestHours: 650,
  ordinanceHighestHours: 650,
  planningFloorHours: 645,
  remainingHours: 1122,
  planningFits: true,
  ...overrides,
});

const version = {
  code: "SFS2026:1487",
  sfs: "SFS 2026:1487",
  title: "Förordning",
  validFrom: "2027-07-01",
  validTo: null,
  source: "https://example.invalid/sfs",
};

const scope = (teachers: TeacherScope[], overrides: Partial<ScopeReport> = {}): ScopeReport => ({
  version,
  yearReason: null,
  interpretations: [],
  teachers,
  ...overrides,
});

describe("scopeCardOf", () => {
  it("is the teacher's row with the lydelse and what rests on an interpretation", () => {
    const interpretations = [{ section: "4 § p. 1 och 5 § p. 1", note: "Tolkning" }];
    const card = scopeCardOf({ scope: scope([teacher()], { interpretations }) }, "t-anna");
    expect(card?.teacher.teachingHours).toBe(645);
    expect(card?.version.code).toBe("SFS2026:1487");
    expect(card?.interpretations).toEqual(interpretations);
  });

  it("carries the interpretation of the hours outside the stages (T7) to the card of the teacher it explains, and to no other", () => {
    const band = { section: "4 § (tolkat) och 5 § p. 1", note: "Tolkning: 110 %" };
    const t7 = { section: "2 § och 3 §", note: "Tolkning (T7): …", cause: "UNREGULATED_HOURS" as const };
    const report = {
      scope: scope([teacher({ overOnlyWithUnregulated: true }), teacher({ userId: "t-bo" })], { interpretations: [band, t7] }),
    };
    expect(scopeCardOf(report, "t-anna")?.interpretations).toEqual([band, t7]);
    expect(scopeCardOf(report, "t-bo")?.interpretations).toEqual([band]);
  });

  it("has nothing to say in a läsår the ordinance does not reach: no lydelse, no card, on any teacher", () => {
    expect(scopeCardOf({ scope: scope([teacher()], { version: null, yearReason: "NOT_IN_FORCE" }) }, "t-anna")).toBeNull();
  });

  it("has nothing to say from a gateway that has no such block, for a teacher with no row, or with no teaching", () => {
    expect(scopeCardOf(undefined, "t-anna")).toBeNull();
    expect(scopeCardOf({}, "t-anna")).toBeNull();
    expect(scopeCardOf({ scope: null }, "t-anna")).toBeNull();
    expect(scopeCardOf({ scope: scope([teacher()]) }, "t-bo")).toBeNull();
    expect(scopeCardOf({ scope: scope([teacher({ notJudged: "NO_TEACHING", verdict: "NOT_JUDGED", teachingHours: 0 })]) }, "t-anna")).toBeNull();
  });

  it("still says why a ten-year läsår has no verdict: the card carries the reason", () => {
    const card = scopeCardOf({ scope: scope([teacher({ verdict: "NOT_JUDGED" })], { yearReason: "NUMBERING_NOT_COVERED" }) }, "t-anna");
    expect(card?.yearReason).toBe("NUMBERING_NOT_COVERED");
  });
});

describe("overOrdinanceIds", () => {
  it("is the teachers over the ordinance's own level, never those over only the level the rektor set", () => {
    const report = {
      scope: scope([
        teacher({ userId: "a", verdict: "OVER_MAX" }),
        teacher({ userId: "b", verdict: "OVER_OWN" }),
        teacher({ userId: "c", verdict: "INSIDE" }),
        teacher({ userId: "d", verdict: "NOT_JUDGED" }),
      ]),
    };
    expect([...overOrdinanceIds(report)]).toEqual(["a"]);
    expect([...overScopeIds(report)].sort()).toEqual(["a", "b"]);
    expect(overOrdinanceIds(undefined).size).toBe(0);
    expect(overOrdinanceIds({ scope: null }).size).toBe(0);
  });
});

describe("overScopeIds", () => {
  it("marks those over the ordinance and those over their own level, and nobody judged inside or not at all", () => {
    const ids = overScopeIds({
      scope: scope([
        teacher({ userId: "a", verdict: "OVER_MAX" }),
        teacher({ userId: "b", verdict: "OVER_OWN" }),
        teacher({ userId: "c", verdict: "INSIDE" }),
        teacher({ userId: "d", verdict: "NOT_JUDGED" }),
      ]),
    });
    expect([...ids].sort()).toEqual(["a", "b"]);
  });

  it("is empty for a report with no block", () => {
    expect(overScopeIds(undefined).size).toBe(0);
    expect(overScopeIds({ scope: null }).size).toBe(0);
  });
});

describe("hoursOver", () => {
  it("is the hours past the line the verdict was judged against, one decimal", () => {
    expect(hoursOver(teacher({ verdict: "OVER_MAX", teachingHours: 731, ordinanceHighestHours: 650 }))).toBe(81);
    expect(hoursOver(teacher({ verdict: "OVER_OWN", teachingHours: 645, highestHours: 600, ordinanceHighestHours: 650 }))).toBe(45);
    expect(hoursOver(teacher({ verdict: "OVER_MAX", teachingHours: 650.7, ordinanceHighestHours: 650 }))).toBe(0.7);
  });

  it("is null for a reader who may not see the line", () => {
    expect(hoursOver(teacher({ verdict: "OVER_MAX", teachingHours: 731, ordinanceHighestHours: null, highestHours: null }))).toBeNull();
  });
});

describe("scopeAssessmentOf", () => {
  const assessment = { levelHours: 600, exceptionKind: null, ownInitiativeOn: null, note: null, decidedAt: "2027-03-05T08:00:00.000Z" };

  it("is there for a teacher with a post and no hours, though scopeCardOf draws no card for one", () => {
    const idle = teacher({ verdict: "NOT_JUDGED", notJudged: "NO_TEACHING", teachingHours: 0, stages: [], fullTimeHighestHours: null, fullTimeLowestHours: null });
    const report = { scope: scope([idle]) };
    expect(scopeCardOf(report, "t-anna")).toBeNull();
    expect(scopeAssessmentOf(report, "t-anna")).toEqual({ assessment: undefined, fullTimeHighestHours: null });
  });

  it("carries the teacher's assessment and the span's edge at full time", () => {
    expect(scopeAssessmentOf({ scope: scope([teacher({ assessment })]) }, "t-anna")).toEqual({ assessment, fullTimeHighestHours: 650 });
  });

  it("is null where the gateway refuses every write: a läsår the ordinance does not reach, and the ten-year numbering", () => {
    expect(scopeAssessmentOf({ scope: scope([teacher()], { version: null, yearReason: "NOT_IN_FORCE" }) }, "t-anna")).toBeNull();
    expect(scopeAssessmentOf({ scope: scope([teacher()], { yearReason: "NUMBERING_NOT_COVERED" }) }, "t-anna")).toBeNull();
  });

  it("is null for a teacher the report has no row for, and for a gateway with no block", () => {
    expect(scopeAssessmentOf({ scope: scope([teacher()]) }, "t-other")).toBeNull();
    expect(scopeAssessmentOf(undefined, "t-anna")).toBeNull();
    expect(scopeAssessmentOf({ scope: null }, "t-anna")).toBeNull();
  });
});
