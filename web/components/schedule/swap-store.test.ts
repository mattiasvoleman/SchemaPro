import { describe, expect, it, vi } from "vitest";
import { swapPreview } from "@/lib/swap-store";
import type { SwapProposal } from "@/lib/swaps";

/** The store the list and the board share: it says what is in view, tells every subscriber when that changes, and lets one go. */
const PROPOSAL = { id: "p-1", kind: "SWAP", moves: [], parallels: [], external: [], hard: [], soft: [], lessons: [], removedCalendarLessons: 0 } as SwapProposal;

describe("swapPreview", () => {
  it("tells each subscriber when the proposal in view changes, and none that has unsubscribed", () => {
    const kept = vi.fn();
    const gone = vi.fn();
    const stopKept = swapPreview.subscribe(kept);
    swapPreview.subscribe(gone)();
    swapPreview.set(PROPOSAL);
    expect(swapPreview.get()).toBe(PROPOSAL);
    expect(kept).toHaveBeenCalledTimes(1);
    expect(gone).not.toHaveBeenCalled();
    swapPreview.set(null);
    expect(kept).toHaveBeenCalledTimes(2);
    stopKept();
    swapPreview.set(PROPOSAL);
    expect(kept).toHaveBeenCalledTimes(2);
    swapPreview.set(null);
  });
});
