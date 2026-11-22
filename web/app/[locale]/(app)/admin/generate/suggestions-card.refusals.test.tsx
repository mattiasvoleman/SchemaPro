import { cleanup, render as renderPlain, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@/lib/api";
import type { OptimizationJob } from "@/lib/queries";
import { SuggestionsCard } from "./suggestions-card";

/*
 * A REFUSED PRESS IS SAID IN A SENTENCE THE CARD HAS (omgång 13, G6 del 3, granskning). The card worded `refused.<code>` from whatever code
 * the gateway sent, so a code it has no key for (the area refusal AREA_NOT_YOURS, any code a later gateway adds) showed next-intl's missing
 * message: the key path itself, "generate.suggestions.refused.AREA_NOT_YOURS", as the answer to a press. The press is throttled to three a
 * minute (SuggestionsController, 429 with no code): that has a sentence of its own, because "Försök igen" is the one thing it should not say.
 */

const apiPost = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/api")>()), api: { get: vi.fn(), post: apiPost } }));
vi.mock("@/i18n/navigation", () => ({ Link: ({ children, ...rest }: { children: React.ReactNode }) => <a {...rest}>{children}</a> }));
vi.mock("next-intl", () => ({
  useLocale: () => "sv",
  useTranslations: (namespace: string) => (key: string, values?: Record<string, unknown>) =>
    values ? `${namespace}.${key}(${Object.values(values).join("|")})` : `${namespace}.${key}`,
}));

const NS = "generate.suggestions";
const refusedRun = { id: "job-1", status: "SUCCEEDED", solverStatus: "INFEASIBLE", conflicts: [], errorCode: null, errorParams: null, suggestionsOffered: true, suggestions: null } as unknown as OptimizationJob;

async function pressWith(error: unknown) {
  apiPost.mockRejectedValue(error);
  renderPlain(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { mutations: { retry: false } } })}>
      <SuggestionsCard job={refusedRun} />
    </QueryClientProvider>,
  );
  await userEvent.click(screen.getByRole("button", { name: `${NS}.offerAction` }));
  return (await screen.findByRole("alert")).textContent;
}

beforeEach(() => {
  apiPost.mockReset();
});
afterEach(cleanup);

describe("what a refused press says", () => {
  it.each(["SUGGESTIONS_NOT_FOR_THIS_RUN", "SUGGESTIONS_RUN_IS_OLD", "SUGGESTIONS_YEAR_BUSY"])("says the gateway's own refusal %s in its own sentence", async (code) => {
    expect(await pressWith(new ApiError(409, "conflict", code))).toBe(`${NS}.refused.${code}`);
  });

  it("says a code it has no sentence for as the general one, and not as a key", async () => {
    expect(await pressWith(new ApiError(403, "forbidden", "AREA_NOT_YOURS"))).toBe(`${NS}.refused.OTHER`);
  });

  it("says the throttle as its own sentence, which does not tell the reader to try again at once", async () => {
    expect(await pressWith(new ApiError(429, "ThrottlerException: Too Many Requests"))).toBe(`${NS}.refused.THROTTLED`);
  });

  it("says a failure that is not the gateway's answer as the general one", async () => {
    expect(await pressWith(new Error("network"))).toBe(`${NS}.refused.OTHER`);
  });
});
