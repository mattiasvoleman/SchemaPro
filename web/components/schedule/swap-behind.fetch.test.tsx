import { act, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { swapPreview } from "@/lib/swap-store";
import type { SwapProposal } from "@/lib/swaps";
import { swapBehind } from "./swap-behind";

/** The layer's code is for the first proposal looked at: nothing is fetched while the store is empty (the route's first load carries only the wrapper). */
const fetched = vi.hoisted(() => ({ count: 0 }));
vi.mock("./swap-layer", async () => {
  fetched.count += 1;
  const { createElement } = await import("react");
  return { default: () => createElement("p", null, "the layer") };
});

afterEach(() => swapPreview.set(null));

describe("swapBehind fetches its layer", () => {
  it("when a proposal is first in view, and not before", async () => {
    render(<>{swapBehind(1, { startMinutes: 480, pxPerMinute: 1 })}</>);
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(fetched.count).toBe(0);
    act(() => swapPreview.set({ id: "p", kind: "SWAP", moves: [], parallels: [], external: [], hard: [], soft: [], lessons: [], removedCalendarLessons: 0 } as SwapProposal));
    expect(await screen.findByText("the layer")).toBeInTheDocument();
    expect(fetched.count).toBe(1);
  });
});
