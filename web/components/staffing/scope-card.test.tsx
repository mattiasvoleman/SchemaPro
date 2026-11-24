import { cleanup, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { ScopeCardData, TeacherScope } from "@/lib/assignment-scope";
import { ScopeCard } from "./scope-card";

vi.mock("next-intl", () => ({
  useLocale: () => "sv",
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

  describe("hours outside the stages (T7)", () => {
    const t7 = { section: "2 § och 3 §", note: "Tolkning (T7): …", cause: "UNREGULATED_HOURS" as const };

    it("answers in its first sentence that the teacher is past the edge only with them, instead of saying 'not over', and shows the interpretation", () => {
      render(<ScopeCard data={data({ verdict: "INSIDE", teachingHours: 688, unregulatedHours: 43, overOnlyWithUnregulated: true }, { interpretations: [t7] })} />);
      // The one sentence that is the answer: said once, and the 'not over the highest level' sentence is not said beside it.
      expect(screen.getAllByText("overOnlyWithUnregulated")).toHaveLength(1);
      expect(screen.queryByText("verdictInside")).not.toBeInTheDocument();
      expect(screen.getByText("overOnlyWithUnregulated")).not.toHaveClass("text-destructive");
      expect(screen.getByText("interpretation(2 § och 3 §|Tolkning (T7): …)")).toBeInTheDocument();
    });

    it("speaks to the teacher on their own page", () => {
      render(<ScopeCard data={data({ verdict: "INSIDE", teachingHours: 688, unregulatedHours: 43, overOnlyWithUnregulated: true })} own />);
      expect(screen.getByText("own.overOnlyWithUnregulated")).toBeInTheDocument();
      expect(screen.queryByText("overOnlyWithUnregulated")).not.toBeInTheDocument();
    });

    it("keeps the verdict over the rektor's own level first, and says the other beneath it", () => {
      render(<ScopeCard data={data({ verdict: "OVER_OWN", teachingHours: 688, highestHours: 600, unregulatedHours: 43, overOnlyWithUnregulated: true })} />);
      expect(screen.getByText("verdictOverOwn(88)")).toHaveClass("text-destructive");
      expect(screen.getAllByText("overOnlyWithUnregulated")).toHaveLength(1);
    });

    it("says nothing of it for a teacher without the cause, and says no 'only with' beside a plain 'not over'", () => {
      render(<ScopeCard data={data({ unregulatedHours: 43 })} />);
      expect(screen.queryByText("overOnlyWithUnregulated")).not.toBeInTheDocument();
      expect(screen.getByText("verdictInside")).toBeInTheDocument();
    });

    it("says beside the förskoleklass row that its hours count in the total but lie outside the stages", () => {
      render(<ScopeCard data={data({ unregulatedHours: 43 })} />);
      expect(rows()).toContain("unregulated=hours(43)");
      expect(screen.getByText("unregulatedNote")).toBeInTheDocument();
    });

    it("says that the planning floor is worked out on the hours in the stages, beside the floor row, for a teacher with hours outside them", () => {
      render(<ScopeCard data={data({ teachingHours: 688, unregulatedHours: 43 })} />);
      expect(rows()).toContain("planningFloor=hours(645)");
      expect(screen.getByText("planningFloorOnStages")).toBeInTheDocument();
      cleanup();
      // Groups with no årskurs are outside the stages as well.
      render(<ScopeCard data={data({ teachingHours: 665, unknownGradeHours: 20 })} />);
      expect(screen.getByText("planningFloorOnStages")).toBeInTheDocument();
    });

    it("says it of no teacher whose hours all lie in the stages, and of no reader who is not shown the floor", () => {
      render(<ScopeCard data={data()} />);
      expect(screen.queryByText("planningFloorOnStages")).not.toBeInTheDocument();
      cleanup();
      // Without HR-läs the floor is not shown (null): a sentence about a row that is not there would explain nothing.
      render(<ScopeCard data={data({ teachingHours: 688, unregulatedHours: 43, planningFloorHours: null, remainingHours: null, planningFits: null })} />);
      expect(rows().map((row) => row.split("=")[0])).not.toContain("planningFloor");
      expect(screen.queryByText("planningFloorOnStages")).not.toBeInTheDocument();
      cleanup();
      // The sentence sits beside the floor row and goes where it goes: a card that is not judged shows neither.
      render(<ScopeCard data={data({ teachingHours: 688, unregulatedHours: 43 }, { yearReason: "NUMBERING_NOT_COVERED" })} />);
      expect(rows().map((row) => row.split("=")[0])).not.toContain("planningFloor");
      expect(screen.queryByText("planningFloorOnStages")).not.toBeInTheDocument();
    });

    it("says it for no teacher without such hours, and not in a ten-year grundskola, where the row itself is left out", () => {
      render(<ScopeCard data={data({ unregulatedHours: 0 })} />);
      expect(screen.queryByText("unregulatedNote")).not.toBeInTheDocument();
      cleanup();
      render(<ScopeCard data={data({ verdict: "NOT_JUDGED", unregulatedHours: 645, stages: [], fullTimeHighestHours: null, fullTimeLowestHours: null, highestHours: null, ordinanceHighestHours: null, planningFloorHours: null, remainingHours: null, planningFits: null }, { yearReason: "NUMBERING_NOT_COVERED" })} />);
      expect(screen.queryByText("unregulatedNote")).not.toBeInTheDocument();
      expect(screen.queryByText("planningFloorOnStages")).not.toBeInTheDocument();
      expect(rows()).toEqual(["teaching=hours(645)"]);
    });
  });

  describe("the rektor's assessment (8 §, 11 §)", () => {
    const assessment = (over: Partial<NonNullable<TeacherScope["assessment"]>> = {}) => ({
      levelHours: 600,
      exceptionKind: null,
      ownInitiativeOn: null,
      note: null,
      decidedAt: "2027-03-05T08:00:00.000Z",
      ...over,
    });

    it("shows the level the rektor set, beside the ordinance's own, and the verdict says it is over the level that was set", () => {
      render(<ScopeCard data={data({ verdict: "OVER_OWN", highestHours: 600, assessment: assessment() })} />);
      expect(rows()).toContain("assessmentLevel=hours(600)");
      expect(screen.getByText("verdictOverOwn(45)")).toBeInTheDocument();
    });

    it("names the ordinance's edge on the row that is called the ordinance's, and the level the rektor set on a row of its own (never the level under the ordinance's name)", () => {
      render(<ScopeCard data={data({ verdict: "OVER_OWN", teachingHours: 645, highestHours: 600, ordinanceHighestHours: 650, assessment: assessment() })} />);
      expect(rows()).toContain("highest=hours(650)");
      expect(rows()).not.toContain("highest=hours(600)");
      expect(rows()).toContain("assessmentLevel=hours(600)");
    });

    it("shows the level after the post as a row of its own for a part-time post, so that 'over by' can be checked against a row", () => {
      render(<ScopeCard data={data({ verdict: "OVER_OWN", teachingHours: 500, highestHours: 464, ordinanceHighestHours: 520, assessment: assessment({ levelHours: 580 }) })} />);
      expect(rows()).toEqual(expect.arrayContaining(["highest=hours(520)", "assessmentLevel=hours(580)", "assessmentHighest=hours(464)"]));
      expect(screen.getByText("verdictOverOwn(36)")).toBeInTheDocument();
    });

    it("says it in the teacher's own words on their own page", () => {
      render(<ScopeCard data={data({ verdict: "OVER_OWN", teachingHours: 500, highestHours: 464, ordinanceHighestHours: 520, assessment: assessment({ levelHours: 580 }) })} own />);
      expect(rows()).toEqual(expect.arrayContaining(["highestOwn=hours(520)", "assessmentLevelOwn=hours(580)", "assessmentHighestOwn=hours(464)"]));
    });

    it("has no row after the post where it is the level itself (full time), nor where the level is above the ordinance's edge", () => {
      render(<ScopeCard data={data({ highestHours: 600, ordinanceHighestHours: 650, assessment: assessment() })} />);
      expect(rows().some((row) => row.startsWith("assessmentHighest"))).toBe(false);
      cleanup();
      render(<ScopeCard data={data({ highestHours: 650, ordinanceHighestHours: 650, assessment: assessment({ levelHours: 700 }) })} />);
      expect(rows().some((row) => row.startsWith("assessmentHighest"))).toBe(false);
    });

    it("speaks of the level as theirs on the teacher's own page", () => {
      render(<ScopeCard data={data({ assessment: assessment() })} own />);
      expect(rows()).toContain("assessmentLevelOwn=hours(600)");
    });

    it("says that an exception is registered, with its day, and that it does not change the verdict", () => {
      render(
        <ScopeCard
          data={data({ verdict: "OVER_MAX", teachingHours: 731, assessment: assessment({ levelHours: null, exceptionKind: "OWN_INITIATIVE", ownInitiativeOn: "2027-05-02" }) })}
        />,
      );
      // One sentence, the day inside it: it was a sentence of its own with the full stop written into the component ("2027-05-02. …").
      expect(screen.getByText(/exceptionRegisteredOn\(exceptionKindOWN_INITIATIVE\|2027-05-02\)/)).toHaveTextContent(
        "exceptionRegisteredOn(exceptionKindOWN_INITIATIVE|2027-05-02) exceptionKeepsVerdict",
      );
      // The verdict above it is the same sentence it would be without the exception: the exception silences nothing.
      expect(screen.getByText(/verdictOverMax/)).toHaveClass("text-destructive");
      expect(rows().some((row) => row.startsWith("assessmentLevel"))).toBe(false);
    });

    it("shows the note, and for a reader without HR-läs the exception kind and nothing else of it", () => {
      render(<ScopeCard data={data({ assessment: assessment({ note: "två grupper om 30" }) })} />);
      expect(screen.getByText("assessmentNote(två grupper om 30)")).toBeInTheDocument();
      const hidden = { levelHours: null, exceptionKind: "SMALL_GROUP" as const, ownInitiativeOn: null, note: null, decidedAt: null };
      render(<ScopeCard data={data({ highestHours: null, ordinanceHighestHours: null, assessment: hidden })} />);
      expect(screen.getByText("exceptionRegistered(exceptionKindSMALL_GROUP) exceptionKeepsVerdict")).toBeInTheDocument();
    });

    it("says nothing of an assessment where none is written", () => {
      render(<ScopeCard data={data()} />);
      expect(screen.queryByText(/exceptionRegistered|assessmentNote/)).not.toBeInTheDocument();
      expect(rows().some((row) => row.startsWith("assessmentLevel"))).toBe(false);
    });
  });
});
