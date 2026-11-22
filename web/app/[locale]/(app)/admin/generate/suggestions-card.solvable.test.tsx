import { cleanup, render as renderPlain, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import en from "@/messages/en.json";
import sv from "@/messages/sv.json";
import type { OptimizationJob } from "@/lib/queries";
import type { Suggestions } from "@/lib/suggestion-types";
import { SuggestionsCard } from "./suggestions-card";

/*
 * A WEEK THAT CAN BE LAID AS IT IS (omgång 13, G6 del 3, granskning). The text said "körningen som tog slut hann bara inte hitta det" for
 * every run, and it kept "Det som redan är känt" ("dagstaket minst X") under it. After a REFUSAL both are wrong: the run did not run out of
 * time, the engine proved the week impossible and the week has been changed since (a cap raised in another tab), and the floor the refusal
 * named is the old week's. The text blames time only for a run that did run out of it, and the floor is not said beside an answer that the
 * week, as it stands now, can be laid.
 */

vi.mock("@/lib/api", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/api")>()), api: { get: vi.fn(), post: vi.fn() } }));
vi.mock("@/i18n/navigation", () => ({ Link: ({ children, ...rest }: { children: React.ReactNode }) => <a {...rest}>{children}</a> }));
vi.mock("next-intl", () => ({
  useLocale: () => "sv",
  useTranslations: (namespace: string) => (key: string, values?: Record<string, unknown>) =>
    values ? `${namespace}.${key}(${Object.values(values).join("|")})` : `${namespace}.${key}`,
}));

const NS = "generate.suggestions";
const answer = (over: Partial<Suggestions> = {}): Suggestions => ({
  version: 1, state: "DONE", startedAt: "2027-03-05T10:00:00.000Z", finishedAt: "2027-03-05T10:01:30.000Z", verdict: "SOLVABLE_AS_IS", verified: true,
  total: 0, searchSeconds: 60, verifySeconds: 2.5, changes: [], failure: null, ...over,
});
const render = (over: Partial<OptimizationJob>) => {
  const job = {
    id: "job-1", status: "SUCCEEDED", solverStatus: "INFEASIBLE", conflicts: [], errorCode: "TEACHER_LESSON_LONGER_THAN_DAILY_CAP",
    errorParams: { minutes: 45, lessonMinutes: 60 }, suggestionsOffered: true, suggestions: answer(), ...over,
  } as unknown as OptimizationJob;
  return renderPlain(
    <QueryClientProvider client={new QueryClient()}>
      <SuggestionsCard job={job} />
    </QueryClientProvider>,
  );
};

afterEach(cleanup);

describe("an answer that the week can be laid as it is", () => {
  it("blames the time only for a run that ran out of it", () => {
    render({ solverStatus: "TIMEOUT", errorCode: null, errorParams: null });
    expect(screen.getByText(`${NS}.verdict.SOLVABLE_AS_IS`)).toBeInTheDocument();
  });

  it("says after a refusal that the week has been changed since, and not that the run ran out of time", () => {
    render({});
    expect(screen.getByText(`${NS}.verdict.SOLVABLE_AS_IS_CHANGED`)).toBeInTheDocument();
    expect(screen.queryByText(`${NS}.verdict.SOLVABLE_AS_IS`)).toBeNull();
  });

  it("does not say the old refusal's floor beside it", () => {
    render({});
    expect(screen.queryByText(`${NS}.known.title`)).toBeNull();
    expect(screen.queryByText(`${NS}.known.capLesson(60)`)).toBeNull();
  });

  it("still says the floor beside an answer that found nothing, which is the week as it was", () => {
    render({ suggestions: answer({ verdict: "NOT_FOUND", verified: false }) });
    expect(screen.getByText(`${NS}.known.capLesson(60)`)).toBeInTheDocument();
  });

  it("still says the floor beside an answer the engine did not check, which is no proof that the week can be laid", () => {
    render({ suggestions: answer({ verified: false }) });
    expect(screen.getByText(`${NS}.verdict.UNCHECKED`)).toBeInTheDocument();
    expect(screen.getByText(`${NS}.known.capLesson(60)`)).toBeInTheDocument();
  });

  it("says in both languages that the refused run was made on a week that has changed", () => {
    const text = (messages: unknown): string => (messages as { generate: { suggestions: { verdict: Record<string, string> } } }).generate.suggestions.verdict.SOLVABLE_AS_IS_CHANGED!;
    expect(text(sv)).not.toMatch(/tog slut|hann bara inte/);
    expect(text(sv)).toMatch(/sedan har ändrats/);
    expect(text(en)).not.toMatch(/ran out|did not get to/);
    expect(text(en)).toMatch(/changed since/);
  });
});
