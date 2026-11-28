import { act, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { swapPreview } from "@/lib/swap-store";
import type { SwapProposal } from "@/lib/swaps";
import { swapBehind } from "./swap-behind";

/**
 * The layer's code is fetched when a proposal is first in view, and the fetch can fail (a tab left open over a deploy: the chunk is gone). The layer is
 * drawn by the grid, which no DialogLoadBoundary stands over (the app has no error.tsx, so what climbs to the root is Next's client-exception screen over
 * the whole page), so a chunk that does not arrive must leave the board as it was: the list the proposal came from says the same in words.
 */
vi.mock("./swap-layer", () => {
  throw new Error("Failed to load chunk swap-layer");
});

const slot = (dayOfWeek: number, start: number) => ({ dayOfWeek, startMinutes: start, endMinutes: start + 60 });
const PROPOSAL: SwapProposal = {
  id: "p-1",
  kind: "SWAP",
  moves: [
    { lessonId: "l-a", from: slot(1, 480), to: slot(2, 600) },
    { lessonId: "l-b", from: slot(2, 600), to: slot(1, 480) },
  ],
  parallels: [],
  external: [],
  hard: [],
  soft: [],
  lessons: [],
  removedCalendarLessons: 0,
};

afterEach(() => swapPreview.set(null));

describe("swapBehind when the layer's chunk does not arrive", () => {
  it("draws nothing and does not throw into the grid", async () => {
    const view = render(<>{swapBehind(1, { startMinutes: 480, pxPerMinute: 1 })}</>);
    await act(async () => {
      swapPreview.set(PROPOSAL);
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(view.container).toBeEmptyDOMElement();
  });
});
