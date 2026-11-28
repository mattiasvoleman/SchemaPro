import { act, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fillPreview } from "@/lib/fill-store";
import { fillBehind } from "./fill-behind";

/** The layer's code is for the first proposal looked at: nothing is fetched while the store is empty (the route's first load carries only the wrapper). */
const fetched = vi.hoisted(() => ({ count: 0 }));
vi.mock("./fill-layer", async () => {
  fetched.count += 1;
  const { createElement } = await import("react");
  return { default: ({ day }: { day: number }) => createElement("p", null, `the layer of day ${day}`) };
});

const SHOWN = {
  proposal: { academicYearId: "y-1", answeredBy: "FILL" as const, basis: "b".repeat(32), asked: 0, placed: [], left: [], moved: [], truncated: false },
  labels: new Map<string, string>(),
};

afterEach(() => fillPreview.set(null));

describe("fillBehind fetches its layer", () => {
  it("when a proposal is first in view, and not before, and draws it for the day it is asked for", async () => {
    render(<>{fillBehind(3, { startMinutes: 480, pxPerMinute: 1 })}</>);
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(fetched.count).toBe(0);
    act(() => fillPreview.set(SHOWN));
    expect(await screen.findByText("the layer of day 3")).toBeInTheDocument();
    expect(fetched.count).toBe(1);
    // The proposal taken away takes the layer with it.
    act(() => fillPreview.set(null));
    expect(screen.queryByText("the layer of day 3")).toBeNull();
  });
});
