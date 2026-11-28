import { act, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { swapPreview } from "@/lib/swap-store";
import type { SwapProposal } from "@/lib/swaps";
import { behindOf, boardBehind } from "./board-behind";

vi.mock("next-intl", async () => {
  const { createTranslator } = await import("use-intl");
  const sv = (await import("@/messages/sv.json")).default;
  return {
    useLocale: () => "sv",
    useTranslations: (namespace: string) => createTranslator({ locale: "sv", messages: sv, namespace: namespace as never }),
  };
});

/**
 * The grid takes ONE `behind` function, and the board has more than one layer to draw (the proposals of Byt and Gör plats, and of Lägg det som går):
 * `behindOf` is what puts them in it, so that the page never has to be edited for the next layer.
 */
const scale = { startMinutes: 480, pxPerMinute: 1 };
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
  lessons: [
    { id: "l-a", subjectName: "Matematik", groupName: "7A", teacherId: null, coTeacherId: null, roomId: null, isLocked: false },
    { id: "l-b", subjectName: "Kemi", groupName: "7B", teacherId: null, coTeacherId: null, roomId: null, isLocked: false },
  ],
  removedCalendarLessons: 0,
};

afterEach(() => swapPreview.set(null));

describe("behindOf", () => {
  it("draws every layer it is given, for the day and the scale the grid asks with, in the order given", () => {
    const calls: Array<[number, typeof scale]> = [];
    const layer = (name: string) => (day: number, given: typeof scale) => {
      calls.push([day, given]);
      return <p data-layer={name}>{name}</p>;
    };
    const { container } = render(<>{behindOf(layer("first"), layer("second"))(3, scale)}</>);
    expect([...container.querySelectorAll("[data-layer]")].map((node) => node.getAttribute("data-layer"))).toEqual(["first", "second"]);
    expect(calls).toEqual([
      [3, scale],
      [3, scale],
    ]);
  });

  it("draws nothing for a layer that draws nothing, and not even a wrapper", () => {
    const { container } = render(<>{behindOf(() => null, () => null)(1, scale)}</>);
    expect(container).toBeEmptyDOMElement();
  });
});

describe("boardBehind: the grundschema board's layers", () => {
  it("draws the proposal of Byt and Gör plats when one is in view, and nothing when none is", async () => {
    const { container } = render(<>{boardBehind(2, scale)}</>);
    expect(container).toBeEmptyDOMElement();
    act(() => swapPreview.set(PROPOSAL));
    expect(await screen.findByText("Matematik 7A kommer hit")).toBeInTheDocument();
    act(() => swapPreview.set(null));
    expect(container).toBeEmptyDOMElement();
  });
});
