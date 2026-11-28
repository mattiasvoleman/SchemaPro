import { act, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { swapPreview } from "@/lib/swap-store";
import type { SwapProposal } from "@/lib/swaps";
import { swapBehind } from "./swap-behind";
import SwapLayer from "./swap-layer";

/**
 * E5a: what the board draws of the proposal in view. The picture is the list's own words laid on the day's column: where a lesson goes, where
 * it leaves (with where to), the picked lesson heavier, and nothing on a day the proposal does not touch.
 */

vi.mock("next-intl", async () => {
  const { createTranslator } = await import("use-intl");
  const sv = (await import("@/messages/sv.json")).default;
  return {
    useLocale: () => "sv",
    useTranslations: (namespace: string) => createTranslator({ locale: "sv", messages: sv, namespace: namespace as never }),
  };
});

const slot = (dayOfWeek: number, start: number, length = 60) => ({ dayOfWeek, startMinutes: start, endMinutes: start + length });
const lesson = (id: string, subjectName: string, groupName: string) => ({ id, subjectName, groupName, teacherId: null, coTeacherId: null, roomId: null, isLocked: false });

const PROPOSAL: SwapProposal = {
  id: "p-1",
  kind: "MAKE_ROOM",
  moves: [
    { lessonId: "l-a", from: slot(1, 480), to: slot(2, 600) },
    { lessonId: "l-b", from: slot(2, 600), to: slot(4, 540, 45) },
  ],
  parallels: [],
  external: [],
  hard: ["CLASH"],
  soft: [],
  lessons: [lesson("l-a", "Matematik", "7A"), lesson("l-b", "Kemi", "7B")],
  removedCalendarLessons: 0,
  levels: { "l-a": 0, "l-b": 1 },
  depth: 1,
};
const scale = { startMinutes: 480, pxPerMinute: 1 };

afterEach(() => swapPreview.set(null));

describe("SwapLayer: one proposal on one day", () => {
  it("draws where each lesson goes and where it leaves, with the lesson's name and where it is going", () => {
    const { container } = render(<SwapLayer day={2} scale={scale} proposal={PROPOSAL} />);
    // Tuesday: Matematik comes here (10:00), Kemi leaves (from 10:00) to Thursday 09:00.
    const arrives = container.querySelector('[data-swap-box="arrives"]') as HTMLElement;
    const leaves = container.querySelector('[data-swap-box="leaves"]') as HTMLElement;
    expect(arrives).toHaveTextContent("Matematik 7A kommer hit");
    expect(arrives.style.top).toBe("120px");
    expect(arrives.style.height).toBe("60px");
    expect(leaves).toHaveTextContent("Kemi 7B lämnar, till Torsdag 09:00");
    expect(leaves.style.top).toBe("120px");
  });

  it("makes the picked lesson's outline heavier, and says nothing in colour alone: the words are in the box", () => {
    const { container } = render(<SwapLayer day={2} scale={scale} proposal={PROPOSAL} />);
    const arrives = container.querySelector('[data-swap-box="arrives"]') as HTMLElement;
    expect(arrives).toHaveAttribute("data-swap-picked");
    expect(arrives.className).toContain("border-[3px]");
    const other = render(<SwapLayer day={4} scale={scale} proposal={PROPOSAL} />).container.querySelector('[data-swap-box="arrives"]') as HTMLElement;
    expect(other).not.toHaveAttribute("data-swap-picked");
    expect(other).toHaveTextContent("Kemi 7B kommer hit");
    expect(other.style.height).toBe("45px");
  });

  it("draws nothing on a day the proposal does not touch, and is inert and hidden from a screen reader (the list says the same in words)", () => {
    const empty = render(<SwapLayer day={3} scale={scale} proposal={PROPOSAL} />);
    expect(empty.container).toBeEmptyDOMElement();
    const drawn = render(<SwapLayer day={1} scale={scale} proposal={PROPOSAL} />).container.firstElementChild as HTMLElement;
    expect(drawn).toHaveAttribute("aria-hidden", "true");
    expect(drawn.className).toContain("pointer-events-none");
  });

  it("draws the lesson that is laid where a brick or a lesson on the tray was asked to stand, which is not among the moves", () => {
    const laid: SwapProposal = { ...PROPOSAL, moves: [PROPOSAL.moves[1]!], lay: { lessonId: null, subjectName: "Historia", groupName: "7C", teacherId: null, coTeacherId: null, roomId: null, slot: slot(2, 600) } };
    const { container } = render(<SwapLayer day={2} scale={scale} proposal={laid} />);
    expect(container.querySelector('[data-swap-box="arrives"]')).toHaveTextContent("Historia 7C kommer hit");
  });
});

describe("swapBehind: the board's slot for it, which is all the route carries", () => {
  it("is empty while no proposal is in view and draws the layer when one is, fetching it then and not before", async () => {
    const { container } = render(<>{swapBehind(2, scale)}</>);
    expect(container).toBeEmptyDOMElement();
    act(() => swapPreview.set(PROPOSAL));
    expect(await screen.findByText("Matematik 7A kommer hit")).toBeInTheDocument();
    act(() => swapPreview.set(null));
    expect(container).toBeEmptyDOMElement();
  });
});
