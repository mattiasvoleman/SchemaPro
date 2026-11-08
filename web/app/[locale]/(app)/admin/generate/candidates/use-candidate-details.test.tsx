import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useApplyCandidate } from "./use-candidate-details";
import { useStartCandidates } from "../use-schedule-candidates";

/*
 * The two bodies Bästa möjliga schema puts on the wire, as the gateway reads
 * them (g2-kontrakt, "Gateway"): the start with `mode`, and the apply with
 * `acceptedDeviations` — the digest, and only for a candidate that has
 * avsteg. The pages' tests mock these hooks; this is where the body itself is
 * pinned, key for key.
 */

const post = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api")>()),
  api: { post, get: vi.fn(), delete: vi.fn() },
}));
vi.mock("@/utils/supabase/client", () => ({ createClient: () => ({}) }));

function wrapper({ children }: { children: React.ReactNode }) {
  const client = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

beforeEach(() => {
  post.mockReset();
  post.mockResolvedValue({ lessonsCreated: 3, versionId: "v-1" });
});

describe("the apply", () => {
  it("sends the digest as acceptedDeviations beside the mode when it has one", async () => {
    const { result } = renderHook(() => useApplyCandidate(), { wrapper });

    await act(() => result.current.mutateAsync({ candidateId: "c-1", expectedMode: "DRAFT", acceptedDeviations: "abc123" }));

    expect(post).toHaveBeenCalledWith("/api/v1/optimization/candidates/c-1/apply", {
      expectedMode: "DRAFT",
      acceptedDeviations: "abc123",
    });
  });

  it("sends the mode alone for a candidate without avsteg: no key, not even an empty one", async () => {
    const { result } = renderHook(() => useApplyCandidate(), { wrapper });

    await act(() => result.current.mutateAsync({ candidateId: "c-2", expectedMode: "DIRECT" }));

    expect(post).toHaveBeenCalledTimes(1);
    const body = post.mock.calls[0]![1] as Record<string, unknown>;
    expect(Object.keys(body)).toEqual(["expectedMode"]);
    expect(body).toEqual({ expectedMode: "DIRECT" });
  });
});

describe("the start", () => {
  it("sends the mode as it was given, with no count", async () => {
    post.mockResolvedValue({ runId: "run-1" });
    const { result } = renderHook(() => useStartCandidates(), { wrapper });

    await act(() => result.current.mutateAsync({ academicYearId: "y-1", mode: "BEST_EFFORT", weights: { spread: 3 } }));

    expect(post).toHaveBeenCalledWith("/api/v1/optimization/candidates", {
      academicYearId: "y-1",
      mode: "BEST_EFFORT",
      weights: { spread: 3 },
    });
  });
});
