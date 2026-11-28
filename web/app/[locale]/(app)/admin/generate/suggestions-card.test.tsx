import { cleanup, render as renderPlain, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@/lib/api";
import type { OptimizationJob } from "@/lib/queries";
import type { SuggestionChange, Suggestions } from "@/lib/suggestion-types";
import { SHOWN_CHANGES, SuggestionsCard } from "./suggestions-card";

/*
 * WHAT TO CHANGE, FOR A WEEK THAT WAS REFUSED OR RAN OUT OF TIME (omgång 13, G6). The stub echoes a sentence's key and its figures in
 * the order the card passes them; suggestions-card.wording.test.ts formats the real Swedish and English texts.
 *
 * What is held here: that the card offers the button only where the gateway says it may and asks for the analysis with one POST; that
 * it says "löser" only for a list the engine checked, says the whole list's proof on a part of it and how many more belong to it;
 * that a part-timer's days carry no figure, no name and no weekday; that a timeout's floor and measurement are said as what they are;
 * that every link is the owner page's, with the row named only by a uuid; and that nothing here changes anything.
 */

const apiGet = vi.hoisted(() => vi.fn());
const apiPost = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api")>()),
  api: { get: apiGet, post: apiPost },
}));
vi.mock("@/i18n/navigation", () => ({
  Link: ({ children, ...rest }: { children: React.ReactNode }) => <a {...rest}>{children}</a>,
}));
const WEEKDAYS: Record<string, string> = { "1": "Måndag", "2": "Tisdag", "3": "Onsdag", "4": "Torsdag", "5": "Fredag" };
vi.mock("next-intl", () => ({
  useLocale: () => "sv",
  // The catalogue's weekdays are the real names, with a capital, so that a test can see how the card writes them in a sentence.
  useTranslations: (namespace: string) => (key: string, values?: Record<string, unknown>) =>
    namespace === "days" ? (WEEKDAYS[key] ?? key) : values ? `${namespace}.${key}(${Object.values(values).join("|")})` : `${namespace}.${key}`,
}));

const NS = "generate.suggestions";
const RULE = "11111111-1111-4111-8111-111111111111";
const POST = "22222222-2222-4222-8222-222222222222";
const ROOM_RULE = "33333333-3333-4333-8333-333333333333";

function render(job: OptimizationJob): ReturnType<typeof renderPlain> {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return renderPlain(
    <QueryClientProvider client={client}>
      <SuggestionsCard job={job} />
    </QueryClientProvider>,
  );
}

const change = (over: Partial<SuggestionChange> = {}): SuggestionChange => ({
  rule: "TEACHER_DAILY_CAP",
  proof: "SOLVED_TOGETHER",
  cost: 168,
  current: 300,
  needed: 330,
  neededIsLeast: null,
  weekdays: [3],
  requirementIds: [POST],
  requirementNames: ["Matematik för 7B"],
  roomIds: [],
  roomNames: [],
  resourceIds: [RULE],
  teacherNames: ["Anna Andersson"],
  hidden: false,
  ...over,
});

const done = (over: Partial<Suggestions> = {}): Suggestions => ({
  version: 1,
  state: "DONE",
  startedAt: "2027-03-05T10:00:00.000Z",
  finishedAt: "2027-03-05T10:01:30.000Z",
  verdict: "CHANGES",
  verified: true,
  total: 1,
  searchSeconds: 60,
  verifySeconds: 2.5,
  changes: [change({ proof: "SOLVED" })],
  failure: null,
  report: null,
  ...over,
});

const job = (over: Partial<OptimizationJob> = {}): OptimizationJob =>
  ({
    id: "job-1",
    status: "SUCCEEDED",
    solverStatus: "INFEASIBLE",
    lessonsGenerated: 0,
    conflictSummary: null,
    conflictSummaryCode: null,
    conflictSummaryParams: null,
    conflicts: [],
    error: null,
    errorCode: null,
    errorParams: null,
    createdAt: "2027-03-05T09:00:00.000Z",
    finishedAt: "2027-03-05T09:03:00.000Z",
    suggestionsOffered: true,
    suggestions: null,
    ...over,
  }) as OptimizationJob;

beforeEach(() => {
  apiGet.mockReset();
  apiPost.mockReset();
});
afterEach(cleanup);

describe("the offer", () => {
  it("is a sentence and a button for a refused run, and asks for the analysis with one POST and nothing in it", async () => {
    apiPost.mockResolvedValue(done({ state: "RUNNING", verdict: null, changes: [], total: 0, finishedAt: null }));
    render(job());

    expect(screen.getByRole("heading", { name: `${NS}.title` })).toBeInTheDocument();
    expect(screen.getByText(`${NS}.offer`)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: `${NS}.offerAction` }));

    await waitFor(() => expect(apiPost).toHaveBeenCalledTimes(1));
    expect(apiPost).toHaveBeenCalledWith("/api/v1/optimization/jobs/job-1/suggestions", {});
  });

  it("says after a TIMEOUT that nothing is proved yet, in the sentence that is its own", () => {
    render(job({ solverStatus: "TIMEOUT" }));
    expect(screen.getByText(`${NS}.offerTimeout`)).toBeInTheDocument();
    expect(screen.queryByText(`${NS}.offer`)).toBeNull();
  });

  it("is not there for a run the gateway does not offer it for, and not drawn at all with nothing to say", () => {
    const { container } = render(job({ suggestionsOffered: false }));
    expect(container).toBeEmptyDOMElement();
  });

  it("is not offered while the analysis runs", () => {
    render(job({ suggestions: done({ state: "RUNNING", verdict: null, changes: [], total: 0, finishedAt: null }) }));
    expect(screen.queryByRole("button")).toBeNull();
  });

  it.each([
    ["SUGGESTIONS_YEAR_BUSY"],
    ["SUGGESTIONS_RUN_IS_OLD"],
    ["SUGGESTIONS_NOT_FOR_THIS_RUN"],
  ])("says a refused start (%s) in its own words and leaves the button to be pressed again", async (code) => {
    apiPost.mockRejectedValue(new ApiError(409, "conflict", code));
    render(job());
    await userEvent.click(screen.getByRole("button", { name: `${NS}.offerAction` }));
    expect(await screen.findByRole("alert")).toHaveTextContent(`${NS}.refused.${code}`);
    expect(screen.getByRole("button", { name: `${NS}.offerAction` })).toBeEnabled();
  });

  it("says another failure of the start as the general one", async () => {
    apiPost.mockRejectedValue(new Error("network"));
    render(job());
    await userEvent.click(screen.getByRole("button", { name: `${NS}.offerAction` }));
    expect(await screen.findByRole("alert")).toHaveTextContent(`${NS}.refused.OTHER`);
  });
});

describe("while it runs", () => {
  const running = () => job({ suggestions: done({ state: "RUNNING", verdict: null, changes: [], total: 0, finishedAt: null }) });

  it("says so as a status and reads the run again, under the key the page reads it by", async () => {
    apiGet.mockResolvedValue(running());
    render(running());
    expect(screen.getByRole("status")).toHaveTextContent(`${NS}.running`);
    await waitFor(() => expect(apiGet).toHaveBeenCalledWith("/api/v1/optimization/jobs/job-1"));
  });

  it("reads nothing when nothing runs", () => {
    render(job({ suggestions: done() }));
    expect(apiGet).not.toHaveBeenCalled();
  });
});

describe("the list of changes", () => {
  it("says a list of one is solved, as the engine checked it, with the sentence, the weekday, the caveat and the link of its page", () => {
    render(job({ suggestions: done() }));

    expect(screen.getByText(`${NS}.intro.SOLVED`)).toBeInTheDocument();
    const [card] = screen.getAllByRole("listitem");
    expect(within(card!).getByText(`${NS}.proof.SOLVED`)).toBeInTheDocument();
    expect(within(card!).getByText(`${NS}.change.TEACHER_DAILY_CAP(Anna Andersson|300|330)`)).toBeInTheDocument();
    // A weekday in the middle of a Swedish sentence takes a small letter, and a list of them is a list in the reader's language.
    expect(within(card!).getByText(`${NS}.weekdays(onsdag)`)).toBeInTheDocument();
    const link = within(card!).getByRole("link");
    expect(link).toHaveAttribute("href", `/admin/people?workRule=${RULE}`);
    expect(link).toHaveAccessibleName(`${NS}.linkLabel(${NS}.link.people|${NS}.change.TEACHER_DAILY_CAP(Anna Andersson|300|330))`);
    // The caveat is said once, under the list: when it was worked out, and that it is not the next Generera's promise.
    expect(screen.getByText(/generate\.suggestions\.caveat\(/)).toBeInTheDocument();
    expect(screen.queryByText(`${NS}.more(1)`)).toBeNull();
  });

  it("says a list of several works TOGETHER, on every change, and that none of them is shown enough alone", () => {
    render(job({
      suggestions: done({
        total: 2,
        changes: [change({ rule: "SUBJECT_PER_DAY", cost: 20, current: 1, needed: 2, resourceIds: [], requirementNames: ["Idrott för 8A"], weekdays: [2], teacherNames: [] }), change()],
      }),
    }));

    expect(screen.getByText(`${NS}.intro.SOLVED_TOGETHER(2)`)).toBeInTheDocument();
    for (const card of screen.getAllByRole("listitem")) expect(within(card).getByText(`${NS}.proof.SOLVED_TOGETHER`)).toBeInTheDocument();
    expect(screen.queryByText(`${NS}.proof.SOLVED`)).toBeNull();
  });

  it("says how many more belong to a list that is shown in part, and shows three at most", () => {
    const many = Array.from({ length: 6 }, (_, index) => change({ cost: 10 + index, requirementNames: [`Post ${index}`] }));
    render(job({ suggestions: done({ total: 9, changes: many }) }));

    expect(screen.getAllByRole("listitem")).toHaveLength(SHOWN_CHANGES);
    expect(SHOWN_CHANGES).toBe(3);
    expect(screen.getByText(`${NS}.more(6)`)).toBeInTheDocument();
    expect(screen.getByText(`${NS}.intro.SOLVED_TOGETHER(9)`)).toBeInTheDocument();
  });

  it("says a list the engine did not check may help, and never that it solves", () => {
    render(job({
      suggestions: done({ verified: false, total: 2, changes: [change({ proof: "MAY_HELP" }), change({ proof: "MAY_HELP", rule: "ROOM_LOCK", current: null, needed: null, roomNames: ["B12"], resourceIds: [ROOM_RULE], teacherNames: [], weekdays: [] })] }),
    }));

    expect(screen.getByText(`${NS}.intro.MAY_HELP`)).toBeInTheDocument();
    expect(screen.getAllByText(`${NS}.proof.MAY_HELP`)).toHaveLength(2);
    expect(screen.queryByText(`${NS}.proof.SOLVED`)).toBeNull();
    expect(screen.queryByText(`${NS}.proof.SOLVED_TOGETHER`)).toBeNull();
  });

  it("says a part-timer's days with no figure, no name and no weekday, and where the page is, and for why", () => {
    // The gateway stores it with nothing but the rule, the price and the proof; a value that carried a weekday or a figure (a hand-edited
    // column, a bug on the other side) is still not drawn by this card.
    const hidden = change({
      rule: "TEACHER_WORK_DAYS", hidden: true, current: 3, needed: 4, weekdays: [2], requirementIds: [], requirementNames: [], resourceIds: [], teacherNames: ["Anna Andersson"],
    });
    render(job({ suggestions: done({ changes: [hidden] }) }));

    const [card] = screen.getAllByRole("listitem");
    expect(within(card!).getByText(`${NS}.change.TEACHER_WORK_DAYS`)).toBeInTheDocument();
    expect(within(card!).getByText(`${NS}.hidden`)).toBeInTheDocument();
    expect(within(card!).queryByText(/weekdays/)).toBeNull();
    expect(card!.textContent).not.toMatch(/Anna|\b3\b|\b4\b/);
    expect(within(card!).getByRole("link")).toHaveAttribute("href", "/admin/staffing");
  });

  it("lists the weekdays the engine needed in the reader's language, with small letters", () => {
    render(job({ suggestions: done({ changes: [change({ proof: "SOLVED", weekdays: [2, 3] })] }) }));
    expect(screen.getByText(`${NS}.weekdays(tisdag och onsdag)`)).toBeInTheDocument();
  });

  it("says each rule in its own sentence and links each to the page that owns it, naming the row by uuid", () => {
    const rows: SuggestionChange[] = [
      change({ rule: "SUBJECT_DAYS_APART", current: 3, needed: 2, resourceIds: [], teacherNames: [], weekdays: [] }),
      change({ rule: "SUBJECT_DAYS_APART", current: 2, needed: 1, resourceIds: [], teacherNames: [], weekdays: [] }),
      change({ rule: "ROOM_LOCK", current: null, needed: null, roomNames: ["B12", "B13"], resourceIds: [ROOM_RULE], teacherNames: [], weekdays: [] }),
    ];
    render(job({ suggestions: done({ total: 3, changes: rows }) }));

    const cards = screen.getAllByRole("listitem");
    expect(within(cards[0]!).getByText(`${NS}.change.SUBJECT_DAYS_APART(Matematik för 7B|3|2)`)).toBeInTheDocument();
    // A spread of one day is no rule: the sentence says the requirement is taken away.
    expect(within(cards[1]!).getByText(`${NS}.change.SUBJECT_DAYS_APART_REMOVE(Matematik för 7B|2)`)).toBeInTheDocument();
    expect(within(cards[0]!).getByRole("link")).toHaveAttribute("href", `/admin/requirements?post=${POST}`);
    expect(within(cards[2]!).getByText(`${NS}.change.ROOM_LOCK(Matematik för 7B|B12 och B13)`)).toBeInTheDocument();
    expect(within(cards[2]!).getByRole("link")).toHaveAttribute("href", `/admin/constraints?roomRule=${ROOM_RULE}`);
  });

  it("says a cap whose teacher the reader may not see without a name, and a lock without rooms as a room more", () => {
    render(job({
      suggestions: done({
        total: 2,
        changes: [change({ teacherNames: [] }), change({ rule: "ROOM_LOCK", current: null, needed: null, roomNames: [], resourceIds: [ROOM_RULE], teacherNames: [], weekdays: [] })],
      }),
    }));
    expect(screen.getByText(`${NS}.change.TEACHER_DAILY_CAP_ANON(300|330)`)).toBeInTheDocument();
    expect(screen.getByText(`${NS}.change.ROOM_LOCK_UNNAMED(Matematik för 7B)`)).toBeInTheDocument();
  });

  it("changes nothing: following a link asks the gateway for nothing, and a list that is only read makes no request at all", async () => {
    render(job({ suggestions: done() }));
    await userEvent.click(screen.getAllByRole("link")[0]!);
    expect(apiPost).not.toHaveBeenCalled();
    expect(apiGet).not.toHaveBeenCalled();
  });
});

describe("what the engine could not show", () => {
  it("says a week laid with nothing giving way only when the engine checked it", () => {
    render(job({ solverStatus: "TIMEOUT", suggestions: done({ verdict: "SOLVABLE_AS_IS", changes: [], total: 0 }) }));
    expect(screen.getByText(`${NS}.verdict.SOLVABLE_AS_IS`)).toBeInTheDocument();
    cleanup();
    render(job({ solverStatus: "TIMEOUT", suggestions: done({ verdict: "SOLVABLE_AS_IS", verified: false, changes: [], total: 0 }) }));
    expect(screen.getByText(`${NS}.verdict.UNCHECKED`)).toBeInTheDocument();
    expect(screen.queryByText(`${NS}.verdict.SOLVABLE_AS_IS`)).toBeNull();
  });

  it("says a search that found nothing as that, with its seconds, and no list", () => {
    render(job({ solverStatus: "TIMEOUT", suggestions: done({ verdict: "NOT_FOUND", changes: [], total: 0, verified: false }) }));
    expect(screen.getByText(`${NS}.verdict.NOT_FOUND(60)`)).toBeInTheDocument();
    expect(screen.queryByRole("list")).toBeNull();
    // The way back: an analysis that found nothing may be asked for again.
    expect(screen.getByRole("button", { name: `${NS}.again` })).toBeInTheDocument();
  });

  it("says a refusal by a rule that never gives way, and that no change of the five can help", () => {
    render(job({ suggestions: done({ verdict: "HARD_REFUSAL", changes: [], total: 0, verified: false }) }));
    expect(screen.getByText(`${NS}.verdict.HARD_REFUSAL`)).toBeInTheDocument();
  });

  it.each([
    ["ENGINE_LACKS_SUGGESTIONS"],
    ["ENGINE_BUSY"],
    ["ENGINE_FAILED"],
    ["NOTHING_TO_PLACE"],
    ["ABANDONED"],
  ] as const)("says a failed analysis (%s) in its own words, and offers to work out again", (failure) => {
    render(job({ suggestions: done({ state: "FAILED", verdict: null, changes: [], total: 0, failure }) }));
    expect(screen.getByText(`${NS}.failed.${failure}`)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: `${NS}.again` })).toBeInTheDocument();
  });

  it("does not offer to work out again for a run the gateway no longer offers it for", () => {
    render(job({ suggestionsOffered: false, suggestions: done({ state: "FAILED", verdict: null, changes: [], total: 0, failure: "ABANDONED" }) }));
    expect(screen.queryByRole("button")).toBeNull();
  });
});

describe("what is known before the engine is asked", () => {
  it("says a cap's floor as at least, with the figure, and links the work rule the refusal named", () => {
    render(job({ solverStatus: null, status: "FAILED", errorCode: "TEACHER_LESSON_LONGER_THAN_DAILY_CAP", errorParams: { rule: RULE, minutes: 45, lessonMinutes: 60 } }));

    expect(screen.getByRole("heading", { name: `${NS}.known.title` })).toBeInTheDocument();
    expect(screen.getByText(`${NS}.proof.AT_LEAST`)).toBeInTheDocument();
    expect(screen.getByText(`${NS}.known.capLesson(60)`)).toBeInTheDocument();
    expect(screen.getByRole("link")).toHaveAttribute("href", `/admin/people?workRule=${RULE}`);
    // A floor is no solution: nothing here says the week is solved.
    expect(screen.queryByText(new RegExp(`${NS}\\.proof\\.SOLVED`))).toBeNull();
  });

  it("says what a timeout's probe measured as a measurement, with no figure, and a link to the page of the rule", () => {
    render(job({
      solverStatus: "TIMEOUT",
      conflicts: [{ category: "TIMEOUT_PROBE", code: "PROBE_SOLVED_WITHOUT_TEACHER_DAILY_CAP", message: "…", params: { seconds: 4 }, resourceNames: [] }],
    }));

    expect(screen.getByText(`${NS}.proof.MEASURED`)).toBeInTheDocument();
    expect(screen.getByText(`${NS}.known.measured.TEACHER_DAILY_CAP`)).toBeInTheDocument();
    expect(screen.getByRole("link")).toHaveAttribute("href", "/admin/people");
  });

  it("gives way to the list once there is one: the floor and the measurement are what is known BEFORE it", () => {
    render(job({
      solverStatus: "TIMEOUT",
      conflicts: [{ category: "TIMEOUT_PROBE", code: "PROBE_SOLVED_WITHOUT_TEACHER_DAILY_CAP", message: "…", params: { seconds: 4 }, resourceNames: [] }],
      suggestions: done(),
    }));
    expect(screen.queryByText(`${NS}.known.title`)).toBeNull();
    expect(screen.getByText(`${NS}.intro.SOLVED`)).toBeInTheDocument();
  });
});
