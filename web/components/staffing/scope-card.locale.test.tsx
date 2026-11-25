import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ScopeCardData, TeacherScope } from "@/lib/assignment-scope";
import { ScopeCard } from "./scope-card";

const locale = vi.hoisted(() => ({ current: "sv" as "sv" | "en" }));
vi.mock("next-intl", () => ({
  useLocale: () => locale.current,
  useTranslations: () => (key: string, values?: Record<string, unknown>) =>
    values ? `${key}(${Object.values(values).join("|")})` : key,
}));

afterEach(() => {
  cleanup();
  locale.current = "sv";
});

/*
 * THE HOURS AND THE DAY OF THE OMFATTNING CARD IN THE READER'S LANGUAGE (the review of #411, L-1 and L-5; of #397, L-8).
 *
 * `formatPercent` wrote hours with the Swedish comma and no grouping in every language, so an English reader read "603,3 h" and "1122 h",
 * and the day of an exception stood as ISO text, as a sentence of its own with its full stop written into the component. The echo stub here
 * shows the figures as the card passes them to its sentences.
 */
const teacher = (overrides: Partial<TeacherScope> = {}): TeacherScope => ({
  userId: "t-anna",
  verdict: "INSIDE",
  notJudged: null,
  teachingHours: 603.3,
  stages: [{ gradeFrom: 1, gradeTo: 6, hours: 603.3, teachingHoursLow: 550, teachingHoursHigh: 650, planningFloorPercent: 100 }],
  unregulatedHours: 0,
  unknownGradeHours: 0,
  fullTimeHighestHours: 650,
  fullTimeLowestHours: 550,
  highestHours: 650,
  ordinanceHighestHours: 650,
  planningFloorHours: 603.3,
  remainingHours: 1122,
  planningFits: true,
  ...overrides,
});

const data = (overrides: Partial<TeacherScope> = {}): ScopeCardData => ({
  teacher: teacher(overrides),
  version: { code: "SFS2026:1487", sfs: "SFS 2026:1487", title: "x", validFrom: "2027-07-01", validTo: null, source: "https://example.invalid/sfs" },
  yearReason: null,
  interpretations: [],
});

const rows = () => screen.getAllByRole("term").map((term) => `${term.textContent}=${term.nextElementSibling?.textContent}`);

describe("the hours the card says", () => {
  it("are written with the Swedish comma and no grouping in Swedish, as they were", () => {
    render(<ScopeCard data={data()} />);
    expect(rows()).toContain("teaching=hours(603,3)");
    expect(rows()).toContain("remaining=hours(1122)");
    expect(rows()).toContain("spanFullTime=span(550|650)");
  });

  it("are written with a point and grouped thousands in English", () => {
    locale.current = "en";
    render(<ScopeCard data={data()} />);
    expect(rows()).toContain("teaching=hours(603.3)");
    expect(rows()).toContain("planningFloor=hours(603.3)");
    expect(rows()).toContain("remaining=hours(1,122)");
    expect(rows().join("\n")).not.toMatch(/603,3/);
  });

  it("are written the same way in the span and in the amount over the edge", () => {
    locale.current = "en";
    render(<ScopeCard data={data({ verdict: "OVER_MAX", teachingHours: 1250.5, fullTimeHighestHours: 1100.5, fullTimeLowestHours: 1001.5, highestHours: 1100.5, ordinanceHighestHours: 1100.5 })} />);
    expect(rows()).toContain("spanFullTime=span(1,001.5|1,100.5)");
    expect(screen.getByText("verdictOverMax(150)")).toBeInTheDocument();
    cleanup();
    render(<ScopeCard data={data({ verdict: "OVER_MAX", teachingHours: 2250.5, fullTimeHighestHours: 1100.5, highestHours: 1100.5, ordinanceHighestHours: 1100.5 })} />);
    expect(screen.getByText("verdictOverMax(1,150)")).toBeInTheDocument();
  });

  it("are written the same way on the teacher's own page", () => {
    locale.current = "en";
    render(<ScopeCard data={data({ verdict: "OVER_OWN", teachingHours: 645.5, highestHours: 600.5 })} own />);
    expect(screen.getByText("own.verdictOverOwn(45)")).toBeInTheDocument();
    expect(rows()).toContain("teachingOwn=hours(645.5)");
  });
});

describe("the exception and its day", () => {
  const assessment = (over: Partial<NonNullable<TeacherScope["assessment"]>> = {}) => ({
    levelHours: null,
    exceptionKind: "OWN_INITIATIVE" as const,
    ownInitiativeOn: "2027-05-02",
    note: null,
    decidedAt: "2027-03-05T08:00:00.000Z",
    ...over,
  });
  const sentence = () => screen.getByText(/^exceptionRegistered/).textContent;

  it("is one sentence with the day inside it, and the day is the ISO day in Swedish", () => {
    render(<ScopeCard data={data({ verdict: "OVER_MAX", teachingHours: 731, assessment: assessment() })} />);
    expect(sentence()).toBe("exceptionRegisteredOn(exceptionKindOWN_INITIATIVE|2027-05-02) exceptionKeepsVerdict");
    // The day was a sentence of its own, with the full stop written into the component.
    expect(document.body.textContent).not.toContain("2027-05-02.");
  });

  it("says the day in English as English writes it", () => {
    locale.current = "en";
    render(<ScopeCard data={data({ verdict: "OVER_MAX", teachingHours: 731, assessment: assessment() })} />);
    expect(sentence()).toBe("exceptionRegisteredOn(exceptionKindOWN_INITIATIVE|2 May 2027) exceptionKeepsVerdict");
  });

  it("is in the teacher's own words on their own page", () => {
    locale.current = "en";
    render(<ScopeCard data={data({ verdict: "OVER_MAX", teachingHours: 731, assessment: assessment() })} own />);
    expect(sentence()).toBe("exceptionRegisteredOn(own.exceptionKindOWN_INITIATIVE|2 May 2027) exceptionKeepsVerdict");
  });

  it("has no day, and no separate sentence for it, when the exception is another kind", () => {
    render(<ScopeCard data={data({ assessment: assessment({ exceptionKind: "SMALL_GROUP", ownInitiativeOn: null }) })} />);
    expect(sentence()).toBe("exceptionRegistered(exceptionKindSMALL_GROUP) exceptionKeepsVerdict");
  });

  it("has no day when the exception has none written, whichever kind it is", () => {
    render(<ScopeCard data={data({ assessment: assessment({ ownInitiativeOn: null }) })} />);
    expect(sentence()).toBe("exceptionRegistered(exceptionKindOWN_INITIATIVE) exceptionKeepsVerdict");
  });
});
