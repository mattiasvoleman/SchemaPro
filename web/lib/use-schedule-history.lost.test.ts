import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useScheduleHistory, type HistoryEntry } from "./use-schedule-history";

/*
 * Steps that leave the history without being undone (E9, granskaren g521): the list of the session's steps says its first row is how the timetable
 * looked when the reader began, which holds only while every step is still in it.
 */
const entry = (label: string, over: Partial<HistoryEntry> = {}): HistoryEntry => ({ label, undo: vi.fn(async () => {}), redo: vi.fn(async () => {}), ...over });

describe("steps that left the history without being undone", () => {
  it("counts the oldest ones that fall off the end of a full history", () => {
    const { result } = renderHook(() => useScheduleHistory());
    act(() => {
      for (let i = 0; i < 103; i++) result.current.push(entry(`s${i}`));
    });
    expect(result.current.steps().done).toHaveLength(100);
    expect(result.current.steps().lost).toBe(3);
  });

  it("counts a step that could not be undone for good (refusedUndo): it is dropped and what it did stands", async () => {
    const { result } = renderHook(() => useScheduleHistory());
    const refusal = new Error("no");
    act(() => {
      result.current.push(entry("a"));
      result.current.push(entry("b", { undo: async () => Promise.reject(refusal), refusedUndo: () => true }));
    });
    await act(async () => void (await result.current.undo().catch(() => null)));
    expect(result.current.steps().done.map((step) => step.label)).toEqual(["a"]);
    expect(result.current.steps().lost).toBe(1);
  });

  it("does not count a step whose undo failed and stays on top for another try, or one that was undone", async () => {
    const { result } = renderHook(() => useScheduleHistory());
    act(() => {
      result.current.push(entry("a"));
      result.current.push(entry("b", { undo: async () => Promise.reject(new Error("network")) }));
    });
    await act(async () => void (await result.current.undo().catch(() => null)));
    expect(result.current.steps().lost).toBe(0);
  });

  it("starts again from nothing when the history is cleared", () => {
    const { result } = renderHook(() => useScheduleHistory());
    act(() => {
      for (let i = 0; i < 101; i++) result.current.push(entry(`s${i}`));
      result.current.clear();
    });
    expect(result.current.steps().lost).toBe(0);
  });
});
