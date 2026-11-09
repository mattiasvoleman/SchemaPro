import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { GUARDIAN_KEYS } from "./guardian-keys";
import { useAnswerLeaveConsent } from "./leave-consent-queries";
import { useLeavePolicy, useSaveLeavePolicy } from "./leave-policy-queries";
import type { LeavePolicy } from "./types";

/**
 * What goes over the wire for Ledighetspolicy (K4): the policy every role
 * reads, an administrator's save of the whole of it (lib/leave-policy-queries.ts),
 * and a guardian's final answer to the request for consent
 * (lib/leave-consent-queries.ts). The routes are the gateway's contract
 * (reports/k4/api-contract.md).
 */

const api = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), put: vi.fn() }));
vi.mock("@/lib/api", () => ({ api }));

const DEFAULT: LeavePolicy = { requireAllGuardians: false, minDaysAhead: null, shortNotice: "REFUSE", contact: "OFF" };
const CHOSEN: LeavePolicy = { requireAllGuardians: true, minDaysAhead: 14, shortNotice: "FLAG", contact: "REQUIRED" };

function setup() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  return { client, wrapper };
}

beforeEach(() => {
  vi.clearAllMocks();
  api.get.mockResolvedValue(DEFAULT);
  api.put.mockResolvedValue(CHOSEN);
  api.post.mockResolvedValue({ id: "l-1", answer: "GIVEN", state: "WAITING" });
});

describe("the policy", () => {
  it("is read from its own route", async () => {
    const { wrapper } = setup();
    const { result } = renderHook(() => useLeavePolicy(), { wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(api.get).toHaveBeenCalledWith("/api/v1/leave-policy");
    expect(result.current.data).toEqual(DEFAULT);
  });

  it("is saved whole with a PUT, and what the gateway answers replaces what is shown", async () => {
    const { client, wrapper } = setup();
    client.setQueryData(GUARDIAN_KEYS.leavePolicy, DEFAULT);
    const { result } = renderHook(() => useSaveLeavePolicy(), { wrapper });
    await act(async () => {
      await result.current.mutateAsync(CHOSEN);
    });
    expect(api.put).toHaveBeenCalledWith("/api/v1/leave-policy", CHOSEN);
    expect(client.getQueryData(GUARDIAN_KEYS.leavePolicy)).toEqual(CHOSEN);
  });

  it("reads the policy again after a save", async () => {
    const { client, wrapper } = setup();
    const { result } = renderHook(() => useSaveLeavePolicy(), { wrapper });
    const invalidate = vi.spyOn(client, "invalidateQueries");
    await act(async () => {
      await result.current.mutateAsync(CHOSEN);
    });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: GUARDIAN_KEYS.leavePolicy });
  });
});

describe("a guardian's consent", () => {
  it("is posted to the request, as a yes or a no", async () => {
    const { wrapper } = setup();
    const { result } = renderHook(() => useAnswerLeaveConsent(), { wrapper });
    await act(async () => {
      await result.current.mutateAsync({ id: "l-1", consent: true });
      await result.current.mutateAsync({ id: "l-2", consent: false });
    });
    expect(api.post).toHaveBeenNthCalledWith(1, "/api/v1/leave-requests/l-1/consent", { consent: true });
    expect(api.post).toHaveBeenNthCalledWith(2, "/api/v1/leave-requests/l-2/consent", { consent: false });
  });

  it("reads the family's list and the inboxes again, also when the answer was refused", async () => {
    api.post.mockRejectedValue(new Error("409"));
    const { client, wrapper } = setup();
    const { result } = renderHook(() => useAnswerLeaveConsent(), { wrapper });
    const invalidate = vi.spyOn(client, "invalidateQueries");
    await act(async () => {
      await result.current.mutateAsync({ id: "l-1", consent: true }).catch(() => undefined);
    });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: GUARDIAN_KEYS.leaveRequests });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: GUARDIAN_KEYS.leaveInbox });
  });
});
