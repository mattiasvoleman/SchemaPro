import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useOptimizationJob, type OptimizationJob } from "@/lib/queries";
import type { Suggestions } from "@/lib/suggestion-types";
import { SuggestionsCard } from "./suggestions-card";

/*
 * THE CARD AND THE PAGE READ ONE RUN UNDER ONE KEY (omgång 13, G6 del 3, granskning). The card draws what `job.suggestions` says, and `job`
 * is the page's own read of the run (useOptimizationJob). So everything the card does to be read again (the first answer to the press, the
 * reads every three seconds while the engine counts, the stop when it has answered) has to land in the cache the PAGE reads, or the card
 * says "räknar" for ever. suggestions-card.test.tsx hands the card a fixed `job` and so cannot see any of it; this one mounts the card the
 * way the page does and lets the gateway answer RUNNING, RUNNING and then DONE.
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
vi.mock("next-intl", () => ({
  useLocale: () => "sv",
  useTranslations: (namespace: string) => (key: string, values?: Record<string, unknown>) =>
    values ? `${namespace}.${key}(${Object.values(values).join("|")})` : `${namespace}.${key}`,
}));

const NS = "generate.suggestions";
const RUNNING: Suggestions = {
  version: 1, state: "RUNNING", startedAt: "2027-03-05T10:00:00.000Z", finishedAt: null, verdict: null, verified: false, total: 0,
  searchSeconds: null, verifySeconds: null, changes: [], failure: null, report: null,
};
const ANSWERED: Suggestions = { ...RUNNING, state: "DONE", finishedAt: "2027-03-05T10:01:30.000Z", verdict: "NOT_FOUND", searchSeconds: 60 };
const REFUSED = {
  id: "job-1", status: "SUCCEEDED", solverStatus: "INFEASIBLE", lessonsGenerated: 0, conflictSummary: null, conflictSummaryCode: null,
  conflictSummaryParams: null, conflicts: [], error: null, errorCode: null, errorParams: null, createdAt: "2027-03-05T09:00:00.000Z",
  finishedAt: "2027-03-05T09:03:00.000Z", suggestionsOffered: true, suggestions: null,
} as unknown as OptimizationJob;

/** The page's side of it: the run read the way generate/page.tsx reads it, and the card drawn from what that read says. */
function PageOf() {
  const { data: job } = useOptimizationJob("job-1");
  return job ? <SuggestionsCard job={job} /> : null;
}

function mount() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <PageOf />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  apiGet.mockReset();
  apiPost.mockReset();
  vi.useFakeTimers({ shouldAdvanceTime: true });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("the card and the page read one run", () => {
  it("shows the press at once, reads the run again every three seconds while the engine counts, and stops when it has answered", async () => {
    // The gateway: the run as the page read it, then RUNNING for two reads, then the answer.
    let reads = 0;
    apiGet.mockImplementation(async () => {
      reads += 1;
      return reads === 1 ? REFUSED : reads <= 3 ? { ...REFUSED, suggestions: RUNNING } : { ...REFUSED, suggestions: ANSWERED };
    });
    apiPost.mockResolvedValue(RUNNING);
    mount();

    await userEvent.click(await screen.findByRole("button", { name: `${NS}.offerAction` }));
    // The press answers RUNNING, and what the card shows comes from the page's cache: no read has been needed for it yet.
    expect(await screen.findByRole("status")).toHaveTextContent(`${NS}.running`);

    // Every three seconds a read. The answer arrives in the card the page draws, with no second source of truth.
    await vi.advanceTimersByTimeAsync(3000);
    await vi.advanceTimersByTimeAsync(3000);
    expect(await screen.findByText(`${NS}.verdict.NOT_FOUND(60)`)).toBeInTheDocument();
    expect(screen.queryByRole("status")).toBeNull();

    // And once it has answered nothing asks again.
    const afterAnswer = apiGet.mock.calls.length;
    await vi.advanceTimersByTimeAsync(12_000);
    expect(apiGet).toHaveBeenCalledTimes(afterAnswer);
  });

  it("asks once for a press that is pressed twice", async () => {
    apiGet.mockResolvedValueOnce(REFUSED).mockResolvedValue({ ...REFUSED, suggestions: RUNNING });
    apiPost.mockImplementation(() => new Promise((resolve) => setTimeout(() => resolve(RUNNING), 200)));
    mount();

    const button = await screen.findByRole("button", { name: `${NS}.offerAction` });
    await userEvent.dblClick(button);
    await vi.advanceTimersByTimeAsync(400);
    await waitFor(() => expect(screen.getByRole("status")).toBeInTheDocument());
    expect(apiPost).toHaveBeenCalledTimes(1);
  });
});
