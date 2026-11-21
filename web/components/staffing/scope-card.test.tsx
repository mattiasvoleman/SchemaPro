import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { ScopeCardData, TeacherScope } from "@/lib/assignment-scope";
import { ScopeCard } from "./scope-card";

vi.mock("next-intl", () => ({
  useTranslations: () => (key: string, values?: Record<string, unknown>) =>
    values ? `${key}(${Object.values(values).join("|")})` : key,
}));

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

const data = (overrides: Partial<TeacherScope> = {}, rest: Partial<ScopeCardData> = {}): ScopeCardData => ({
  teacher: teacher(overrides),
  version: {
    code: "SFS2026:1487",
    sfs: "SFS 2026:1487",
    title: "Förordning",
    validFrom: "2027-07-01",
    validTo: null,
    source: "https://example.invalid/sfs",
  },
  yearReason: null,
  interpretations: [],
  ...rest,
});

const rows = () =>
  screen.getAllByRole("term").map((term) => `${term.textContent}=${term.nextElementSibling?.textContent}`);

describe("ScopeCard", () => {
  it("states the hours beside the span for the stage, and the floor, and says that inside the span is the rektor's call", () => {
    render(<ScopeCard data={data()} />);
    expect(rows()).toEqual([
      "teaching=hours(645)",
      "highest=hours(650)",
      "spanFullTime=span(550|650)",
      "stage(1|6)=hours(645)",
      "planningFloor=hours(645)",
      "remaining=hours(1122)",
    ]);
    expect(screen.getByText("verdictInside")).toBeInTheDocument();
    expect(screen.getByText("verdictInside")).not.toHaveClass("text-destructive");
    expect(screen.getByText("fits")).toBeInTheDocument();
  });

  it("says by how much a teacher is over the ordinance's highest level, in words and in the destructive tone", () => {
    render(<ScopeCard data={data({ verdict: "OVER_MAX", teachingHours: 731, ordinanceHighestHours: 650, highestHours: 650 })} />);
    const verdict = screen.getByText("verdictOverMax(81)");
    expect(verdict).toHaveClass("text-destructive");
  });

  it("says over the teacher's own level when that is what it is, and not over the ordinance", () => {
    render(<ScopeCard data={data({ verdict: "OVER_OWN", teachingHours: 645, highestHours: 600, ordinanceHighestHours: 650 })} />);
    expect(screen.getByText("verdictOverOwn(45)")).toBeInTheDocument();
  });

  it("keeps the verdict and loses the figures that give the post back, for a reader without HR-läs", () => {
    render(
      <ScopeCard
        data={data({ verdict: "OVER_MAX", teachingHours: 731, highestHours: null, ordinanceHighestHours: null, remainingHours: null, planningFits: null })}
      />,
    );
    expect(screen.getByText("verdictOverMaxHidden")).toBeInTheDocument();
    expect(rows().map((row) => row.split("=")[0])).toEqual(["teaching", "spanFullTime", "stage(1|6)", "planningFloor"]);
    expect(screen.queryByText("fits")).not.toBeInTheDocument();
    expect(screen.queryByText("doesNotFit")).not.toBeInTheDocument();
  });

  it("says when the working time does not hold the planning floor", () => {
    render(<ScopeCard data={data({ remainingHours: 620.3, planningFits: false })} />);
    expect(screen.getByText("doesNotFit")).toBeInTheDocument();
    expect(screen.queryByText("fits")).not.toBeInTheDocument();
  });

  it("says that the span is weighted when the teacher teaches in two stages, and lists both", () => {
    render(
      <ScopeCard
        data={data({
          teachingHours: 860,
          stages: [
            { gradeFrom: 1, gradeTo: 6, hours: 645, teachingHoursLow: 550, teachingHoursHigh: 650, planningFloorPercent: 100 },
            { gradeFrom: 7, gradeTo: 9, hours: 215, teachingHoursLow: 500, teachingHoursHigh: 600, planningFloorPercent: 110 },
          ],
        })}
      />,
    );
    expect(screen.getByText("blended")).toBeInTheDocument();
    expect(rows()).toContain("stage(7|9)=hours(215)");
  });

  it("counts förskoleklass and groups with no årskurs, and says what that means", () => {
    render(<ScopeCard data={data({ unregulatedHours: 215, unknownGradeHours: 43 })} />);
    expect(rows()).toContain("unregulated=hours(215)");
    expect(rows()).toContain("unknownGrade=hours(43)");
    expect(screen.getByText("unknownGradeNote")).toBeInTheDocument();
  });

  it.each([
    ["no post", { verdict: "NOT_JUDGED", notJudged: "NO_POST" } as Partial<TeacherScope>, "verdictNoPost"],
    ["only förskoleklass", { verdict: "NOT_JUDGED", notJudged: "NO_STAGE" } as Partial<TeacherScope>, "verdictNoStage"],
  ])("says why nothing is judged: %s", (_name, overrides, key) => {
    render(<ScopeCard data={data(overrides)} />);
    expect(screen.getByText(key)).toBeInTheDocument();
    expect(screen.queryByText("remaining")).not.toBeInTheDocument();
    expect(screen.queryByText("planningFloor")).not.toBeInTheDocument();
  });

  it("says that the ten-year grundskola has no figures yet, shows the hours, and judges nothing", () => {
    render(<ScopeCard data={data({ verdict: "NOT_JUDGED", stages: [], fullTimeHighestHours: null, fullTimeLowestHours: null, highestHours: null, ordinanceHighestHours: null, planningFloorHours: null, remainingHours: null, planningFits: null }, { yearReason: "NUMBERING_NOT_COVERED" })} />);
    expect(screen.getByText("verdictNumbering")).toBeInTheDocument();
    expect(rows()).toEqual(["teaching=hours(645)"]);
  });

  it("names an interpretation, with its paragraph, and says where the ordinance can be read", () => {
    render(<ScopeCard data={data({}, { interpretations: [{ section: "4 § p. 1 och 5 § p. 1", note: "Tolkning: 110 %" }] })} />);
    expect(screen.getByText("interpretation(4 § p. 1 och 5 § p. 1|Tolkning: 110 %)")).toBeInTheDocument();
    const link = screen.getByRole("link", { name: /source/ });
    expect(link).toHaveAttribute("href", "https://example.invalid/sfs");
    expect(link).toHaveAttribute("rel", "noreferrer");
    // The caption says whose measure this is, not the riktmärke's.
    expect(screen.getByText(/caption\(SFS 2026:1487\|2027-07-01\)/)).toBeInTheDocument();
  });

  it("speaks to the teacher on their own page", () => {
    render(<ScopeCard data={data({ verdict: "OVER_MAX", teachingHours: 731, ordinanceHighestHours: 650, highestHours: 650 })} own />);
    expect(rows().slice(0, 2).map((row) => row.split("=")[0])).toEqual(["teachingOwn", "highestOwn"]);
  });
});
