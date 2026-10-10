import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useDebouncedValue } from "@/lib/use-debounced-value";

describe("useDebouncedValue", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("answers the first value at once, and a later one only once it has stood still", () => {
    const { result, rerender } = renderHook(({ value }) => useDebouncedValue(value, 600), {
      initialProps: { value: { validTo: "2027-06-11" } as { validTo: string } | null },
    });
    expect(result.current).toEqual({ validTo: "2027-06-11" });
    // Typed digit by digit: each commit restarts the wait.
    for (const typed of ["2027-01-01", "2027-01-11", "2027-01-15"]) {
      rerender({ value: { validTo: typed } });
      act(() => void vi.advanceTimersByTime(300));
      expect(result.current).toEqual({ validTo: "2027-06-11" });
    }
    act(() => void vi.advanceTimersByTime(600));
    expect(result.current).toEqual({ validTo: "2027-01-15" });
    // A new object with the same fields is no change.
    rerender({ value: { validTo: "2027-01-15" } });
    expect(result.current).toEqual({ validTo: "2027-01-15" });
  });
});
