import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { headerStateOf, keepShown, rangeOf, tickedOf, useBulkSelection } from "./bulk-selection";

const ROWS = ["a", "b", "c", "d", "e"];

describe("the selection's rules", () => {
  it("counts only the ticked rows that are shown, in list order", () => {
    expect(tickedOf(new Set(["d", "a", "x"]), ROWS)).toEqual(["a", "d"]);
  });

  it("draws the header box empty, half or full", () => {
    expect(headerStateOf(new Set(), ROWS)).toBe("none");
    expect(headerStateOf(new Set(["b"]), ROWS)).toBe("some");
    expect(headerStateOf(new Set(ROWS), ROWS)).toBe("all");
    // A row ticked and since hidden does not make the shown ones "some".
    expect(headerStateOf(new Set(["x"]), ROWS)).toBe("none");
  });

  it("keeps a selection to the rows shown, and says when nothing changes", () => {
    expect(keepShown(new Set(["a", "x"]), ROWS)).toEqual(new Set(["a"]));
    expect(keepShown(new Set(["a", "b"]), ROWS)).toBeNull();
  });

  it("takes the rows between two clicks in list order, whichever came first", () => {
    expect(rangeOf(ROWS, "b", "d")).toEqual(["b", "c", "d"]);
    expect(rangeOf(ROWS, "d", "b")).toEqual(["b", "c", "d"]);
    expect(rangeOf(ROWS, null, "c")).toEqual(["c"]);
    // An anchor the search has hidden since: just the row clicked.
    expect(rangeOf(ROWS, "x", "c")).toEqual(["c"]);
  });
});

describe("useBulkSelection", () => {
  const render = (shown: string[]) =>
    renderHook(({ rows }) => useBulkSelection(rows), { initialProps: { rows: shown } });

  it("ticks and unticks one row", () => {
    const { result } = render(ROWS);
    act(() => result.current.toggle("c"));
    expect(result.current.ticked).toEqual(["c"]);
    expect(result.current.isTicked("c")).toBe(true);
    expect(result.current.header).toBe("some");
    act(() => result.current.toggle("c"));
    expect(result.current.ticked).toEqual([]);
  });

  it("with Shift, ticks every row from the last one clicked, and unticks them the same way", () => {
    const { result } = render(ROWS);
    act(() => result.current.toggle("b"));
    act(() => result.current.toggle("d", true));
    expect(result.current.ticked).toEqual(["b", "c", "d"]);
    // Shift on a ticked row unticks the range from the last click (d) to it.
    act(() => result.current.toggle("c", true));
    expect(result.current.ticked).toEqual(["b"]);
  });

  it("ticks every shown row with the header box, and unticks them when all are", () => {
    const { result } = render(ROWS);
    act(() => result.current.toggle("a"));
    act(() => result.current.toggleAll());
    expect(result.current.ticked).toEqual(ROWS);
    expect(result.current.header).toBe("all");
    act(() => result.current.toggleAll());
    expect(result.current.ticked).toEqual([]);
  });

  it("lets go of a row a search hides, and does not bring it back when the search is cleared", () => {
    const { result, rerender } = render(ROWS);
    act(() => result.current.toggleAll());
    rerender({ rows: ["a", "b"] });
    expect(result.current.ticked).toEqual(["a", "b"]);
    rerender({ rows: ROWS });
    expect(result.current.ticked).toEqual(["a", "b"]);
    expect(result.current.header).toBe("some");
  });

  it("lets go of a deleted row", () => {
    const { result, rerender } = render(ROWS);
    act(() => result.current.toggle("e"));
    rerender({ rows: ["a", "b", "c", "d"] });
    expect(result.current.ticked).toEqual([]);
    expect(result.current.header).toBe("none");
  });

  it("clears everything", () => {
    const { result } = render(ROWS);
    act(() => result.current.toggleAll());
    act(() => result.current.clear());
    expect(result.current.ticked).toEqual([]);
    // And a Shift-click after a clear starts a range of its own.
    act(() => result.current.toggle("d", true));
    expect(result.current.ticked).toEqual(["d"]);
  });
});
