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

  it("tells the page when the module does not come, once, and never a page that has gone (review of #341, MEDEL-1)", async () => {
    const failure = new Error("Failed to load chunk");
    const onError = vi.fn();
    const { result } = renderHook(() => useLazyModule(async () => Promise.reject(failure), onError));
    await waitFor(() => expect(onError).toHaveBeenCalledTimes(1));
    expect(onError).toHaveBeenCalledWith(failure);
    expect(result.current).toBeNull();

    let fail: (error: Error) => void = () => undefined;
    const late = vi.fn();
    const { unmount } = renderHook(() => useLazyModule(() => new Promise<{ answer: number }>((_, reject) => (fail = reject)), late));
    unmount();
    fail(failure);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(late).not.toHaveBeenCalled();
  });

  it("is not fetched while nobody wants it, and is fetched once somebody does (review of #341, LÅG-5)", async () => {
    const load = vi.fn(async () => ({ answer: 7 }));
    const { rerender, result } = renderHook(({ wanted }) => useLazyModule(load, undefined, wanted), { initialProps: { wanted: false } });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(load).not.toHaveBeenCalled();
    expect(result.current).toBeNull();
    rerender({ wanted: true });
    await waitFor(() => expect(result.current).toEqual({ answer: 7 }));
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("keeps a module that has arrived when it is no longer wanted", async () => {
    const load = vi.fn(async () => ({ answer: 8 }));
    const { rerender, result } = renderHook(({ wanted }) => useLazyModule(load, undefined, wanted), { initialProps: { wanted: true } });
    await waitFor(() => expect(result.current).not.toBeNull());
    rerender({ wanted: false });
    expect(result.current).toEqual({ answer: 8 });
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("does not tell a page that stopped wanting the module about a failure of it", async () => {
    let fail: (error: Error) => void = () => undefined;
    const onError = vi.fn();
    const { rerender } = renderHook(({ wanted }) => useLazyModule(() => new Promise<{ answer: number }>((_, reject) => (fail = reject)), onError, wanted), {
      initialProps: { wanted: true },
    });
    rerender({ wanted: false });
    fail(new Error("Failed to load chunk"));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(onError).not.toHaveBeenCalled();
  });
});
