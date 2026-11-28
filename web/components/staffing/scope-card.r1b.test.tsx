import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { KNOWN_INTERPRETATIONS, type ScopeCardData, type TeacherScope } from "@/lib/assignment-scope";
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
 * R1b: what R1 left open on the card, as the card says it (the echo stub shows the key and the values the card passes to its sentences).
 *
 *   - hours outside the stages are told apart: förskoleklass is one row, a year no band covers another (#399, L-5);
 *   - a level above the edge of the teacher's own stage says it counts to the edge and no higher (#411, L-3);
 *   - an interpretation is English to an English reader when it is one the gateway holds, word for word, and as recorded otherwise (#397, L-4).
 */
const teacher = (overrides: Partial<TeacherScope> = {}): TeacherScope => ({
  userId: "t-anna",
  verdict: "INSIDE",
  notJudged: null,
  teachingHours: 400,
  stages: [{ gradeFrom: 1, gradeTo: 6, hours: 400, teachingHoursLow: 550, teachingHoursHigh: 650, planningFloorPercent: 100 }],
  unregulatedHours: 0,
  unknownGradeHours: 0,
  fullTimeHighestHours: 650,
  fullTimeLowestHours: 550,
  highestHours: 650,
  ordinanceHighestHours: 650,
  planningFloorHours: 400,
  remainingHours: null,
  planningFits: null,
  ...overrides,
});

const data = (overrides: Partial<TeacherScope> = {}, extra: Partial<ScopeCardData> = {}): ScopeCardData => ({
  teacher: teacher(overrides),
  version: { code: "SFS2026:1487", sfs: "SFS 2026:1487", title: "x", validFrom: "2027-07-01", validTo: null, source: "https://example.invalid/sfs" },
  yearReason: null,
  interpretations: [],
  ...extra,
});

const rows = () => screen.queryAllByRole("term").map((term) => `${term.textContent}=${term.nextElementSibling?.textContent}`);

describe("the hours outside the stages (#399, L-5)", () => {
  it("are förskoleklass alone when the gateway says so: one row, and the note of förskoleklass", () => {
    render(<ScopeCard data={data({ unregulatedHours: 200, preschoolHours: 200 })} />);
    expect(rows()).toContain("unregulated=hours(200)");
    expect(rows().filter((row) => row.startsWith("outsideStages="))).toEqual([]);
    expect(screen.getByText("unregulatedNote")).toBeInTheDocument();
    expect(screen.queryByText("outsideStagesNote")).not.toBeInTheDocument();
  });

  it("are two rows when part of them lie in a year no band covers: förskoleklass is only the part that is årskurs 0", () => {
    render(<ScopeCard data={data({ unregulatedHours: 600, preschoolHours: 200 })} />);
    expect(rows()).toContain("unregulated=hours(200)");
    expect(rows()).toContain("outsideStages=hours(400)");
    expect(screen.getByText("unregulatedNote")).toBeInTheDocument();
    expect(screen.getByText("outsideStagesNote")).toBeInTheDocument();
  });

  it("are NOT förskoleklass when none of them is: a teacher in a year no band covers is not said to teach förskoleklass", () => {
    render(<ScopeCard data={data({ unregulatedHours: 400, preschoolHours: 0 })} />);
    expect(rows().filter((row) => row.startsWith("unregulated="))).toEqual([]);
    expect(rows()).toContain("outsideStages=hours(400)");
    expect(screen.queryByText("unregulatedNote")).not.toBeInTheDocument();
    expect(screen.getByText("outsideStagesNote")).toBeInTheDocument();
  });

  it("are förskoleklass, all of them, from a gateway that does not tell them apart (the field is absent): the card says what it said", () => {
    render(<ScopeCard data={data({ unregulatedHours: 200 })} />);
    expect(rows()).toContain("unregulated=hours(200)");
    expect(rows().filter((row) => row.startsWith("outsideStages="))).toEqual([]);
    expect(screen.getByText("unregulatedNote")).toBeInTheDocument();
  });

  it("have a sentence of their own for a teacher with no hours in any stage, and a year no band covers is not said to be förskoleklass", () => {
    render(<ScopeCard data={data({ verdict: "NOT_JUDGED", notJudged: "NO_STAGE", stages: [], unregulatedHours: 400, preschoolHours: 0, teachingHours: 400, fullTimeHighestHours: null, fullTimeLowestHours: null, highestHours: null, ordinanceHighestHours: null, planningFloorHours: null })} />);
    expect(screen.getByText("verdictNoStageOutside")).toBeInTheDocument();
    expect(screen.queryByText("verdictNoStage")).not.toBeInTheDocument();
  });

  it("keep the sentence of förskoleklass for a teacher whose hours are förskoleklass alone", () => {
    render(<ScopeCard data={data({ verdict: "NOT_JUDGED", notJudged: "NO_STAGE", stages: [], unregulatedHours: 200, preschoolHours: 200, teachingHours: 200, fullTimeHighestHours: null, fullTimeLowestHours: null, highestHours: null, ordinanceHighestHours: null, planningFloorHours: null })} />);
    expect(screen.getByText("verdictNoStage")).toBeInTheDocument();
  });
});

describe("a level above the edge of the teacher's own stage (#411, L-3)", () => {
  const level = (hours: number) => ({ assessment: { levelHours: hours, exceptionKind: null, ownInitiativeOn: null, note: null, decidedAt: null } });

  it("says it counts to the edge and no higher, with both figures", () => {
    // A teacher in årskurs 7-9: the edge at full time is 600, and the rektor has set 640 (the gateway holds it to the highest edge of any stage, 650).
    render(<ScopeCard data={data({ ...level(640), fullTimeHighestHours: 600, ordinanceHighestHours: 600, highestHours: 600 })} />);
    expect(screen.getByText("levelAboveEdge(640|600)")).toBeInTheDocument();
  });

  it("says it on the teacher's own page in the teacher's own words", () => {
    render(<ScopeCard data={data({ ...level(640), fullTimeHighestHours: 600, ordinanceHighestHours: 600, highestHours: 600 })} own />);
    expect(screen.getByText("own.levelAboveEdge(640|600)")).toBeInTheDocument();
    expect(screen.queryByText("levelAboveEdge(640|600)")).not.toBeInTheDocument();
  });

  it("says nothing for a level at the edge or under it", () => {
    render(<ScopeCard data={data({ ...level(600), fullTimeHighestHours: 600, ordinanceHighestHours: 600, highestHours: 600 })} />);
    expect(screen.queryByText(/levelAboveEdge/)).not.toBeInTheDocument();
    cleanup();
    render(<ScopeCard data={data({ ...level(560) })} />);
    expect(screen.queryByText(/levelAboveEdge/)).not.toBeInTheDocument();
  });

  it("says nothing for a reader who may not read the level (the gateway sends none), and nothing without an edge", () => {
    render(<ScopeCard data={data({ assessment: { levelHours: null, exceptionKind: "SMALL_GROUP", ownInitiativeOn: null, note: null, decidedAt: null } })} />);
    expect(screen.queryByText(/levelAboveEdge/)).not.toBeInTheDocument();
    cleanup();
    render(<ScopeCard data={data({ ...level(640), fullTimeHighestHours: null })} />);
    expect(screen.queryByText(/levelAboveEdge/)).not.toBeInTheDocument();
  });
});

describe("an interpretation in the reader's language (#397, L-4)", () => {
  const [band, unregulated] = KNOWN_INTERPRETATIONS;
  const interpretation = (note: string, over: object = {}) => ({ section: "4 § p. 1 och 5 § p. 1", note, ...over });

  it("is the note as recorded, in Swedish, to a Swedish reader", () => {
    render(<ScopeCard data={data({}, { interpretations: [interpretation(band!.sv)] })} />);
    expect(screen.getByText(`interpretation(4 § p. 1 och 5 § p. 1|${band!.sv})`)).toBeInTheDocument();
    expect(screen.queryByText(/interpretationTranslated/)).not.toBeInTheDocument();
  });

  it("is the English text of a note the gateway holds, to an English reader, word for word what the note is", () => {
    locale.current = "en";
    render(<ScopeCard data={data({}, { interpretations: [interpretation(band!.sv)] })} />);
    expect(screen.getByText("interpretationTranslated(4 § p. 1 och 5 § p. 1|knownInterpretation.band7to9)")).toBeInTheDocument();
  });

  it("is the English text of T7 too, by its own key", () => {
    locale.current = "en";
    render(<ScopeCard data={data({ verdict: "INSIDE", overOnlyWithUnregulated: true, unregulatedHours: 100, preschoolHours: 100 }, { interpretations: [interpretation(unregulated!.sv, { section: "2 § och 3 §", cause: "UNREGULATED_HOURS" })] })} />);
    expect(screen.getByText("interpretationTranslated(2 § och 3 §|knownInterpretation.unregulated)")).toBeInTheDocument();
  });

  it("is the note as recorded, labelled as Swedish, when the note is not one the card knows: a note the database changed is never shown under a translation of the old one", () => {
    locale.current = "en";
    render(<ScopeCard data={data({}, { interpretations: [interpretation(`${band!.sv} (ändrad)`)] })} />);
    expect(screen.queryByText(/interpretationTranslated/)).not.toBeInTheDocument();
    expect(screen.getByText(`interpretation(4 § p. 1 och 5 § p. 1|${band!.sv} (ändrad))`)).toBeInTheDocument();
  });
});
