import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { ScopeCardData, TeacherScope } from "@/lib/assignment-scope";
import { ScopeCard } from "./scope-card";

vi.mock("next-intl", () => ({
  useTranslations: () => (key: string, values?: Record<string, unknown>) =>
    values ? `${key}(${Object.values(values).join("|")})` : key,
}));

/**
 * NO_STAGE is "hours, and none of them in a stage the lydelse has a band for" (src/staffing/assignment-scope.ts: inBands === 0),
 * which is förskoleklass, groups with no årskurs, or both. The card said "undervisningen ligger i förskoleklass" for all three,
 * under a row that said "Grupper utan årskurs".
 */
const noStage = (overrides: Partial<TeacherScope>): ScopeCardData => ({
  teacher: {
    userId: "t-anna",
    verdict: "NOT_JUDGED",
    notJudged: "NO_STAGE",
    teachingHours: 300,
    stages: [],
    unregulatedHours: 0,
    unknownGradeHours: 0,
    fullTimeHighestHours: null,
    fullTimeLowestHours: null,
    highestHours: null,
    ordinanceHighestHours: null,
    planningFloorHours: null,
    remainingHours: null,
    planningFits: null,
    ...overrides,
  },
  version: { code: "SFS2026:1487", sfs: "SFS 2026:1487", title: "x", validFrom: "2027-07-01", validTo: null, source: "https://example.invalid/sfs" },
  yearReason: null,
  interpretations: [],
});

describe("ScopeCard when none of the hours lies in a stage", () => {
  it.each([
    ["only förskoleklass", { unregulatedHours: 300 }, "verdictNoStage"],
    ["only groups with no årskurs", { unknownGradeHours: 300 }, "verdictNoStageUnknown"],
    ["förskoleklass and groups with no årskurs", { unregulatedHours: 120, unknownGradeHours: 180 }, "verdictNoStageBoth"],
  ])("says what the hours are in, and not förskoleklass when they are not: %s", (_name, overrides, key) => {
    render(<ScopeCard data={noStage(overrides)} />);
    expect(screen.getByText(key)).toBeInTheDocument();
    for (const other of ["verdictNoStage", "verdictNoStageUnknown", "verdictNoStageBoth"].filter((k) => k !== key)) {
      expect(screen.queryByText(other)).not.toBeInTheDocument();
    }
  });
});
