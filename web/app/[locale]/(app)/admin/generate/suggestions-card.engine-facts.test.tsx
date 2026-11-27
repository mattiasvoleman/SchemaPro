import { cleanup, render as renderPlain, screen, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OptimizationJob, TimeoutReport } from "@/lib/queries";
import type { SuggestionChange, Suggestions } from "@/lib/suggestion-types";
import { SuggestionsCard, leastOf } from "./suggestions-card";

/*
 * WHAT THE CARD SAYS OF THE ENGINE'S TWO NEW FACTS (G6b, #493): how far a number is known (`neededIsLeast`) and where a search's time went
 * (`report`, for a NOT_FOUND).
 *
 * "Mindre räcker inte" is a PROOF (the engine answered INFEASIBLE for the step below, with the other changes of the list as they are) and is
 * said only then. A step it tried and did not finish deciding is said as that, and a step it did not try is not mentioned. Nothing is said
 * of a list the engine did not check, nor of a part-timer's days, whose figure is hidden for every reader (g493-L-5): the gateway keeps the
 * field null for both, and the card does not rest on it.
 */

vi.mock("@/lib/api", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/api")>()), api: { get: vi.fn(), post: vi.fn() } }));
vi.mock("@/i18n/navigation", () => ({ Link: ({ children, ...rest }: { children: React.ReactNode }) => <a {...rest}>{children}</a> }));
vi.mock("next-intl", () => ({
  useLocale: () => "sv",
  useTranslations: (namespace: string) => (key: string, values?: Record<string, unknown>) =>
    namespace === "days" ? key : values ? `${namespace}.${key}(${Object.values(values).join("|")})` : `${namespace}.${key}`,
}));

const NS = "generate.suggestions";
const TA = "generate.timeoutAccount";

const change = (over: Partial<SuggestionChange> = {}): SuggestionChange => ({
  rule: "TEACHER_DAILY_CAP", proof: "SOLVED", cost: 168, current: 300, needed: 330, neededIsLeast: null, weekdays: [], requirementIds: [],
  requirementNames: [], roomIds: [], roomNames: [], resourceIds: [], teacherNames: ["Anna Andersson"], hidden: false, ...over,
});

const answer = (over: Partial<Suggestions> = {}): Suggestions => ({
  version: 1, state: "DONE", startedAt: "2027-03-05T10:00:00.000Z", finishedAt: "2027-03-05T10:01:30.000Z", verdict: "CHANGES", verified: true,
  total: 1, searchSeconds: 60, verifySeconds: 2.5, changes: [change()], failure: null, report: null, ...over,
});

const report = (over: Partial<TimeoutReport> = {}): TimeoutReport => ({
  totalSeconds: 71.2, budgetSeconds: 60, configuredBudgetSeconds: 60, callerWaitSeconds: null,
  stages: [{ stage: "PRECHECKS", seconds: 0.3 }, { stage: "BUILD", seconds: 9.4 }, { stage: "SEARCH_CLEAN", seconds: 60 }],
  search: { solutions: 0, phases: [{ phase: "CLEAN", seconds: 60, conflicts: 1834, branches: 20113 }] },
  weekLoadCut: false, ...over,
});

const render = (list: Suggestions) => {
  const job = { id: "job-1", status: "SUCCEEDED", solverStatus: "TIMEOUT", conflicts: [], errorCode: null, errorParams: null, suggestionsOffered: true, suggestions: list } as unknown as OptimizationJob;
  return renderPlain(
    <QueryClientProvider client={new QueryClient()}>
      <SuggestionsCard job={job} />
    </QueryClientProvider>,
  );
};

afterEach(cleanup);

describe("leastOf: what is said of a number", () => {
  const checked = { verified: true, total: 1 };
  const number = { hidden: false, needed: 330 };

  it("says it was proved the least only where the engine proved it, and says so for the list when the list has several", () => {
    expect(leastOf(checked, { ...number, neededIsLeast: true })).toBe("PROVED");
    expect(leastOf({ verified: true, total: 3 }, { ...number, neededIsLeast: true })).toBe("PROVED_TOGETHER");
  });

  it("says a step it tried and did not decide as that", () => {
    expect(leastOf(checked, { ...number, neededIsLeast: false })).toBe("UNDECIDED");
    expect(leastOf({ verified: true, total: 3 }, { ...number, neededIsLeast: false })).toBe("UNDECIDED");
  });

  it("says nothing where the engine did not try, or sent nothing (an analysis from before the field)", () => {
    expect(leastOf(checked, { ...number, neededIsLeast: null })).toBeNull();
    expect(leastOf(checked, { ...number, neededIsLeast: undefined as unknown as null })).toBeNull();
  });

  it("says nothing of a list the engine did not check, whatever the field says", () => {
    expect(leastOf({ verified: false, total: 1 }, { ...number, neededIsLeast: true })).toBeNull();
    expect(leastOf({ verified: false, total: 1 }, { ...number, neededIsLeast: false })).toBeNull();
  });

  it("says nothing of a part-timer's days, and nothing of a change with no number", () => {
    expect(leastOf(checked, { hidden: true, needed: null, neededIsLeast: true })).toBeNull();
    expect(leastOf(checked, { hidden: true, needed: 4, neededIsLeast: true })).toBeNull();
    expect(leastOf(checked, { hidden: false, needed: null, neededIsLeast: true })).toBeNull();
  });
});

describe("the card says how far a number is known", () => {
  it("says a proof under a change of a list of one: less will not do", () => {
    render(answer({ changes: [change({ neededIsLeast: true })] }));
    expect(screen.getByText(`${NS}.least.PROVED`)).toBeInTheDocument();
    expect(screen.queryByText(`${NS}.least.UNDECIDED`)).toBeNull();
  });

  it("says it of a list of several as holding with the other changes as they are, on each change it was proved for and no other", () => {
    render(answer({ total: 3, changes: [change({ neededIsLeast: true }), change({ rule: "SUBJECT_PER_DAY", neededIsLeast: false }), change({ rule: "ROOM_LOCK", needed: null })] }));
    expect(screen.getAllByText(`${NS}.least.PROVED_TOGETHER`)).toHaveLength(1);
    expect(screen.getAllByText(`${NS}.least.UNDECIDED`)).toHaveLength(1);
    expect(screen.queryByText(`${NS}.least.PROVED`)).toBeNull();
  });

  it("says a step the engine tried and did not finish as that, and does not call the number the least", () => {
    render(answer({ changes: [change({ neededIsLeast: false })] }));
    expect(screen.getByText(`${NS}.least.UNDECIDED`)).toBeInTheDocument();
    expect(screen.queryByText(`${NS}.least.PROVED`)).toBeNull();
  });

  it("says nothing under a change the engine did not try to lower", () => {
    render(answer({ changes: [change({ neededIsLeast: null })] }));
    expect(screen.queryByText(/least\./)).toBeNull();
  });

  it("says nothing of a list the engine did not check, even when a change claims a proof", () => {
    render(answer({ verified: false, changes: [change({ proof: "MAY_HELP", neededIsLeast: true })] }));
    expect(screen.getByText(`${NS}.intro.MAY_HELP`)).toBeInTheDocument();
    expect(screen.queryByText(/least\./)).toBeNull();
  });

  it("says nothing under a part-timer's days, which the card says only as a post needing a day more (g493-L-5)", () => {
    render(answer({ changes: [change({ rule: "TEACHER_WORK_DAYS", hidden: true, current: null, needed: null, neededIsLeast: true, teacherNames: [] })] }));
    expect(screen.getByText(`${NS}.change.TEACHER_WORK_DAYS`)).toBeInTheDocument();
    expect(screen.getByText(`${NS}.hidden`)).toBeInTheDocument();
    expect(screen.queryByText(/least\./)).toBeNull();
  });

  it("puts it under the sentence it is about, in the change's own card", () => {
    render(answer({ total: 2, changes: [change({ neededIsLeast: true }), change({ rule: "SUBJECT_PER_DAY", neededIsLeast: false, requirementNames: ["Idrott för 8A"] })] }));
    const [first, second] = screen.getAllByRole("listitem").filter((item) => item.closest("ol") !== null);
    expect(within(first!).getByText(`${NS}.least.PROVED_TOGETHER`)).toBeInTheDocument();
    expect(within(second!).getByText(`${NS}.least.UNDECIDED`)).toBeInTheDocument();
  });
});

describe("the card says where a search's time went", () => {
  const notFound = (over: Partial<Suggestions> = {}) => answer({ verdict: "NOT_FOUND", verified: false, total: 0, changes: [], verifySeconds: null, report: report(), ...over });

  it("lists the steps of a NOT_FOUND with their seconds, beside the answer that it is no proof", () => {
    render(notFound());
    expect(screen.getByText(`${NS}.verdict.NOT_FOUND(60)`)).toBeInTheDocument();
    expect(screen.getByText(`${NS}.time.title`)).toBeInTheDocument();
    expect(screen.getByText(`${TA}.stage(PRECHECKS|0.3)`)).toBeInTheDocument();
    expect(screen.getByText(`${TA}.stage(BUILD|9.4)`)).toBeInTheDocument();
    expect(screen.getByText(`${TA}.stage(SEARCH_CLEAN|60)`)).toBeInTheDocument();
    expect(screen.getByText(`${TA}.searchNone(1|60)`)).toBeInTheDocument();
    expect(screen.getByText(`${TA}.budget(60)`)).toBeInTheDocument();
  });

  it("says nothing of where the time went when the engine sent no report (an engine from before it, an analysis made before)", () => {
    render(notFound({ report: null }));
    expect(screen.getByText(`${NS}.verdict.NOT_FOUND(60)`)).toBeInTheDocument();
    expect(screen.queryByText(`${NS}.time.title`)).toBeNull();
    render(notFound({ report: undefined as unknown as null }));
    expect(screen.queryByText(`${NS}.time.title`)).toBeNull();
  });

  it("says no search began where none did, and not where a step the page has no name for may have been one", () => {
    const none = report({ stages: [{ stage: "PRECHECKS", seconds: 1 }, { stage: "BUILD", seconds: 59 }], budgetSeconds: 0, configuredBudgetSeconds: 0, search: { solutions: 0, phases: [] } });
    const { unmount } = render(notFound({ report: none }));
    expect(screen.getByText(`${TA}.searchNotRun`)).toBeInTheDocument();
    unmount();
    render(notFound({ report: { ...none, otherSeconds: 30 } }));
    expect(screen.queryByText(`${TA}.searchNotRun`)).toBeNull();
    expect(screen.getByText(`${TA}.searchOther(30)`)).toBeInTheDocument();
    expect(screen.getByText(`${TA}.otherSteps(30)`)).toBeInTheDocument();
  });

  it("says a search that was given less than the engine is set to give it, and the setup that took a large part of the run", () => {
    render(notFound({ report: report({ budgetSeconds: 30, configuredBudgetSeconds: 60, stages: [{ stage: "BUILD", seconds: 30 }, { stage: "SEARCH_CLEAN", seconds: 30 }], totalSeconds: 61 }) }));
    expect(screen.getByText(`${TA}.budgetShort(30|60)`)).toBeInTheDocument();
    expect(screen.getByText(`${TA}.cause.SHORT_CLOCK(30|60)`)).toBeInTheDocument();
    expect(screen.getByText(`${TA}.cause.SLOW_SETUP(30|61)`)).toBeInTheDocument();
  });

  it("says how long the gateway waited where the report says it", () => {
    render(notFound({ report: report({ budgetSeconds: 30, configuredBudgetSeconds: 60, callerWaitSeconds: 195 }) }));
    expect(screen.getByText(`${TA}.cause.SHORT_CLOCK_WAIT(30|60|195)`)).toBeInTheDocument();
    expect(screen.queryByText(`${TA}.cause.SHORT_CLOCK(30|60)`)).toBeNull();
  });

  it("names no cause where none could be measured: the answer above it already says it is no proof either way", () => {
    render(notFound());
    expect(screen.queryByText(/cause\./)).toBeNull();
  });

  it("is drawn for a NOT_FOUND and for nothing else", () => {
    render(answer({ report: report() }));
    expect(screen.queryByText(`${NS}.time.title`)).toBeNull();
  });
});
