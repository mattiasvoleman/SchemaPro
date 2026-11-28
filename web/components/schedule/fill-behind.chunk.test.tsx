import { act, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fillPreview } from "@/lib/fill-store";
import { fillBehind } from "./fill-behind";

/**
 * The layer's code is fetched when a proposal is first in view, and the fetch can fail (a tab left open over a deploy: the chunk is gone). The layer is
 * drawn by the grid, which no DialogLoadBoundary stands over (the app has no error.tsx, so what climbs to the root is Next's client-exception screen over
 * the whole page), so a chunk that does not arrive must leave the board as it was: the dialog the proposal came from says the same in words. A lazy() at module
 * level held the failed import for the tab's whole life and threw it into the render of every column of the board (g516 M-3, the same in Gör plats' layer).
 */
vi.mock("./fill-layer", () => {
  throw new Error("Failed to load chunk fill-layer");
});

const SHOWN = {
  proposal: {
    academicYearId: "y-1",
    answeredBy: "FILL" as const,
    basis: "b".repeat(32),
    asked: 1,
    placed: [{ key: "p|t|60|1", postId: "p", studentGroupId: "g-1", subjectId: "s-1", teacherId: "t", minutes: 60, lessonId: null, dayOfWeek: 1, startMinutes: 480, endMinutes: 540, roomId: null, noRoom: true }],
    left: [],
    moved: [],
    truncated: false,
  },
  labels: new Map([["p|t|60|1", "Matematik 7A"]]),
};

afterEach(() => fillPreview.set(null));

describe("fillBehind when the layer's chunk does not arrive", () => {
  it("draws nothing and does not throw into the grid, now or when the proposal is looked at again", async () => {
    const view = render(<>{fillBehind(1, { startMinutes: 480, pxPerMinute: 1 })}</>);
    await act(async () => {
      fillPreview.set(SHOWN);
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(view.container).toBeEmptyDOMElement();
    // A second proposal asks for the module again, and the answer is the same quiet nothing: the failure is not held against the next look.
    await act(async () => {
      fillPreview.set(null);
      fillPreview.set(SHOWN);
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(view.container).toBeEmptyDOMElement();
  });
});
