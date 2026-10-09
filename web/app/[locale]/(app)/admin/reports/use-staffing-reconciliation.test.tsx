import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it, vi, type Mock } from "vitest";
import { api } from "@/lib/api";
import { useStaffingReconciliation } from "./use-staffing-reconciliation";

vi.mock("@/lib/api", () => ({ api: { get: vi.fn() } }));
const get = api.get as unknown as Mock;

function wrapper() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
}

/*
 * A range takes ~1,7 s to answer for a large school. While the next one
 * loads, the tab keeps the figures it has — for the same läsår — instead of
 * dropping to a skeleton and blanking the date the admin did not touch.
 */
describe("useStaffingReconciliation", () => {
  it("keeps the previous range's answer, flagged as a placeholder, while a new range of the same year loads", async () => {
    let release: (value: unknown) => void = () => {};
    get.mockResolvedValueOnce({ from: "2026-08-17", to: "2026-10-08" });
    get.mockImplementationOnce(() => new Promise((resolve) => (release = resolve)));
    const { result, rerender } = renderHook(
      ({ from }: { from: string | null }) => useStaffingReconciliation("y1", from, null),
      { wrapper: wrapper(), initialProps: { from: null as string | null } },
    );
    await waitFor(() => expect(result.current.data).toEqual({ from: "2026-08-17", to: "2026-10-08" }));

    rerender({ from: "2026-09-01" });
    expect(result.current.isLoading).toBe(false);
    expect(result.current.isPlaceholderData).toBe(true);
    expect(result.current.data).toEqual({ from: "2026-08-17", to: "2026-10-08" });

    release({ from: "2026-09-01", to: "2026-10-08" });
    await waitFor(() => expect(result.current.isPlaceholderData).toBe(false));
    expect(result.current.data).toEqual({ from: "2026-09-01", to: "2026-10-08" });
  });

  it("never shows another läsår's figures as a placeholder", async () => {
    get.mockResolvedValueOnce({ from: "2026-08-17", to: "2026-10-08" });
    get.mockImplementationOnce(() => new Promise(() => {}));
    const { result, rerender } = renderHook(
      ({ year }: { year: string }) => useStaffingReconciliation(year, null, null),
      { wrapper: wrapper(), initialProps: { year: "y1" } },
    );
    await waitFor(() => expect(result.current.data).toBeDefined());
    rerender({ year: "y0" });
    expect(result.current.data).toBeUndefined();
    expect(result.current.isLoading).toBe(true);
  });
});
