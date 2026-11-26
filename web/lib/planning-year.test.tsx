import { act, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AcademicYear } from "@/lib/types";

/*
 * THE YEAR A PLANNING PAGE WORKS ON IS WRITTEN TO THE ADDRESS (omgång 15, G6b,
 * g393-U-1). The hook read ?year= once at mount and kept the choice in state
 * only, so a reload, the back button or a copied link came back to the active
 * year — and whoever had counted for next year did not find the answer where
 * they had left it. The four pages that share the hook all get it from here.
 */

const years: AcademicYear[] = [
  { id: "y-now", name: "2026/27", isActive: true, predecessorId: null },
  { id: "y-next", name: "2027/28", isActive: false, predecessorId: "y-now" },
  { id: "y-old", name: "2025/26", isActive: false, predecessorId: null },
].map((year) => ({ startDate: "2026-08-01", endDate: "2027-06-30", ...year }) as AcademicYear);

vi.mock("@/lib/queries", () => ({
  useAcademicYears: () => ({ data: years }),
}));
vi.mock("@/lib/api", () => ({
  api: { get: vi.fn(async () => ({ source: "PROJECTED", homeClasses: [] })) },
}));

import { usePlanningYear, writeYearToAddress } from "./planning-year";

function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

const address = () => `${window.location.pathname}${window.location.search}${window.location.hash}`;

beforeEach(() => {
  window.history.replaceState(null, "", "/sv/admin/generate");
});
afterEach(() => {
  window.history.replaceState(null, "", "/");
});

describe("writeYearToAddress", () => {
  it("sets ?year= and leaves every other parameter and the hash where they were", () => {
    window.history.replaceState(null, "", "/sv/admin/generate?week=3&year=y-old#history");
    writeYearToAddress("y-next");
    expect(address()).toBe("/sv/admin/generate?week=3&year=y-next#history");
  });

  it("removes ?year= for null, and the parameter with it when nothing else is left", () => {
    window.history.replaceState(null, "", "/sv/admin/generate?year=y-next");
    writeYearToAddress(null);
    expect(address()).toBe("/sv/admin/generate");
  });

  it("replaces the entry: choosing a year adds no step to go back through", () => {
    const before = window.history.length;
    writeYearToAddress("y-next");
    expect(window.history.length).toBe(before);
  });

  it("keeps the history state the router put there", () => {
    const state = { __NA: true, tree: ["x"] };
    window.history.replaceState(state, "", "/sv/admin/generate");
    writeYearToAddress("y-next");
    expect(window.history.state).toEqual(state);
  });
});

describe("usePlanningYear", () => {
  it("starts on the active year when the address names none", async () => {
    const { result } = renderHook(() => usePlanningYear(), { wrapper });
    await waitFor(() => expect(result.current.year?.id).toBe("y-now"));
    expect(address()).toBe("/sv/admin/generate");
  });

  it("writes the year chosen to the address, and the page then holds it", async () => {
    const { result } = renderHook(() => usePlanningYear(), { wrapper });
    await waitFor(() => expect(result.current.year?.id).toBe("y-now"));
    act(() => result.current.choose("y-next"));
    expect(result.current.year?.id).toBe("y-next");
    expect(address()).toBe("/sv/admin/generate?year=y-next");
  });

  it("comes back to the year it was left on: a page mounted on that address reads it", async () => {
    const first = renderHook(() => usePlanningYear(), { wrapper });
    await waitFor(() => expect(first.result.current.year?.id).toBe("y-now"));
    act(() => first.result.current.choose("y-next"));
    first.unmount();

    const again = renderHook(() => usePlanningYear(), { wrapper });
    await waitFor(() => expect(again.result.current.year?.id).toBe("y-next"));
  });

  it("takes ?year= off the address when the active year is chosen again", async () => {
    window.history.replaceState(null, "", "/sv/admin/generate?year=y-next&week=3");
    const { result } = renderHook(() => usePlanningYear(), { wrapper });
    await waitFor(() => expect(result.current.year?.id).toBe("y-next"));
    act(() => result.current.choose("y-now"));
    expect(result.current.year?.id).toBe("y-now");
    expect(address()).toBe("/sv/admin/generate?week=3");
  });

  it("ignores ?year= naming a year the page cannot plan for, as before", async () => {
    // ?year= naming a year that is neither the active one nor its successor is ignored on read, as before.
    window.history.replaceState(null, "", "/sv/admin/generate?year=y-old");
    const { result } = renderHook(() => usePlanningYear(), { wrapper });
    await waitFor(() => expect(result.current.year?.id).toBe("y-now"));
  });
});
