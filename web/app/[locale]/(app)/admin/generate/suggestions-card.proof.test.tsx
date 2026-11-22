import { cleanup, render as renderPlain, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OptimizationJob } from "@/lib/queries";
import type { SuggestionChange, Suggestions } from "@/lib/suggestion-types";
import { SuggestionsCard } from "./suggestions-card";

/*
 * "LÖSER VECKAN" IS SAID FOR THE LIST THE ENGINE CHECKED, AND BY ONE RULE (omgång 13, G6 del 3, granskning). The wire carries `verified`
 * (the strict model accepted the timetable with every change of the list applied) and a `proof` on each change. The card read only the first
 * change's `proof`: a list marked SOLVED beside `verified: false`, a list with one change below the others, or a SOLVED beside a total of
 * several all said "löst" or "just den här ändringen" on what the gateway happened to store. The gateway holds to the rule when it writes
 * the column; the card must hold to it when it reads it.
 */

vi.mock("@/lib/api", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/api")>()), api: { get: vi.fn(), post: vi.fn() } }));
vi.mock("@/i18n/navigation", () => ({ Link: ({ children, ...rest }: { children: React.ReactNode }) => <a {...rest}>{children}</a> }));
vi.mock("next-intl", () => ({
  useLocale: () => "sv",
  useTranslations: (namespace: string) => (key: string, values?: Record<string, unknown>) =>
    namespace === "days" ? key : values ? `${namespace}.${key}(${Object.values(values).join("|")})` : `${namespace}.${key}`,
}));

const NS = "generate.suggestions";
const change = (proof: SuggestionChange["proof"]): SuggestionChange => ({
  rule: "TEACHER_DAILY_CAP", proof, cost: 168, current: 300, needed: 330, weekdays: [], requirementIds: [], requirementNames: [], roomIds: [],
  roomNames: [], resourceIds: [], teacherNames: ["Anna Andersson"], hidden: false,
});
const render = (over: Partial<Suggestions>) => {
  const list: Suggestions = {
    version: 1, state: "DONE", startedAt: "2027-03-05T10:00:00.000Z", finishedAt: "2027-03-05T10:01:30.000Z", verdict: "CHANGES", verified: true,
    total: 1, searchSeconds: 60, verifySeconds: 2.5, changes: [change("SOLVED")], failure: null, ...over,
  };
  const job = { id: "job-1", status: "SUCCEEDED", solverStatus: "INFEASIBLE", conflicts: [], errorCode: null, errorParams: null, suggestionsOffered: true, suggestions: list } as unknown as OptimizationJob;
  return renderPlain(
    <QueryClientProvider client={new QueryClient()}>
      <SuggestionsCard job={job} />
    </QueryClientProvider>,
  );
};

afterEach(cleanup);

describe("what the card says of a list", () => {
  it("says solved for a list of one that the engine checked", () => {
    render({});
    expect(screen.getByText(`${NS}.intro.SOLVED`)).toBeInTheDocument();
    expect(screen.getByText(`${NS}.proof.SOLVED`)).toBeInTheDocument();
  });

  it("never says solved for a list the strict model did not accept, whatever the change says", () => {
    render({ verified: false, changes: [change("SOLVED")] });
    expect(screen.getByText(`${NS}.intro.MAY_HELP`)).toBeInTheDocument();
    expect(screen.getByText(`${NS}.proof.MAY_HELP`)).toBeInTheDocument();
    expect(screen.queryByText(`${NS}.proof.SOLVED`)).toBeNull();
    expect(screen.queryByText(`${NS}.intro.SOLVED`)).toBeNull();
  });

  it("takes the weakest proof of the list, not the first change's", () => {
    render({ total: 2, changes: [change("SOLVED_TOGETHER"), change("MAY_HELP")] });
    expect(screen.getByText(`${NS}.intro.MAY_HELP`)).toBeInTheDocument();
    expect(screen.queryByText(`${NS}.proof.SOLVED_TOGETHER`)).toBeNull();
    expect(screen.getAllByText(`${NS}.proof.MAY_HELP`)).toHaveLength(2);
  });

  it("does not say 'just den här ändringen' of a list that has more than one change", () => {
    render({ total: 3, changes: [change("SOLVED"), change("SOLVED")] });
    expect(screen.getByText(`${NS}.intro.SOLVED_TOGETHER(3)`)).toBeInTheDocument();
    expect(screen.queryByText(`${NS}.intro.SOLVED`)).toBeNull();
    expect(screen.getAllByText(`${NS}.proof.SOLVED_TOGETHER`)).toHaveLength(2);
  });
});
