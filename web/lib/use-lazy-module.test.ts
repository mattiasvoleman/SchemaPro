import { renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useLazyModule } from "./use-lazy-module";

describe("a module fetched after the page is up", () => {
  it("is null until it has arrived, then the module", async () => {
    const load = vi.fn(async () => ({ answer: 42 }));
    const { result } = renderHook(() => useLazyModule(load));
    expect(result.current).toBeNull();
    await waitFor(() => expect(result.current).toEqual({ answer: 42 }));
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("is fetched once, however often the page is drawn again", async () => {
    const load = vi.fn(async () => ({ answer: 1 }));
    const { rerender, result } = renderHook(() => useLazyModule(load));
    await waitFor(() => expect(result.current).not.toBeNull());
    rerender();
    rerender();
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("does not set anything on a page that has gone before the module came", async () => {
    let arrive: (value: { answer: number }) => void = () => undefined;
    const load = () => new Promise<{ answer: number }>((resolve) => (arrive = resolve));
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { unmount, result } = renderHook(() => useLazyModule(load));
    unmount();
    arrive({ answer: 1 });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(result.current).toBeNull();
    expect(error).not.toHaveBeenCalled();
    error.mockRestore();
  });
});
