import { render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { SwapProposal } from "@/lib/swaps";
import SwapLayer from "./swap-layer";

/** Which outline of a proposal on the board is the heavy one, and the edges of the picture (what the other rows of swap-layer.test.tsx leave unpinned). */
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

describe("SwapLayer: which outline is the heavy one, and the edges of the picture", () => {
  const TRADE_NO_LEVELS: SwapProposal = {
    ...PROPOSAL,
    kind: "SWAP",
    levels: undefined,
    depth: undefined,
    moves: [
      { lessonId: "l-a", from: slot(1, 480), to: slot(1, 600) },
      { lessonId: "l-b", from: slot(1, 600), to: slot(1, 480) },
    ],
  };
  const boxes = (container: HTMLElement, kind: "arrives" | "leaves") => [...container.querySelectorAll<HTMLElement>(`[data-swap-box="${kind}"]`)];

  it("a swap of two marked lessons has no levels, and both are the person's choice: both outlines are the heavy one", () => {
    const { container } = render(<SwapLayer day={1} scale={scale} proposal={TRADE_NO_LEVELS} />);
    expect(boxes(container, "arrives").map((box) => box.hasAttribute("data-swap-picked"))).toEqual([true, true]);
  });

  it("a make-room proposal that came without levels has none picked (nobody can say which it is)", () => {
    const { container } = render(<SwapLayer day={1} scale={scale} proposal={{ ...TRADE_NO_LEVELS, kind: "MAKE_ROOM" }} />);
    expect(boxes(container, "arrives").map((box) => box.hasAttribute("data-swap-picked"))).toEqual([false, false]);
  });

  it("the heavy outline is for what arrives: a picked lesson that leaves is drawn as every other that leaves", () => {
    const { container } = render(<SwapLayer day={1} scale={scale} proposal={TRADE_NO_LEVELS} />);
    for (const box of boxes(container, "leaves")) expect(box.className).not.toContain("border-[3px]");
  });

  it("draws a lesson that is laid on its own day only", () => {
    const laid: SwapProposal = { ...PROPOSAL, moves: [], lay: { lessonId: null, subjectName: "Historia", groupName: "7C", teacherId: null, coTeacherId: null, roomId: null, slot: slot(2, 600) } };
    expect(render(<SwapLayer day={3} scale={scale} proposal={laid} />).container).toBeEmptyDOMElement();
  });

  it("never draws an outline lower than the label it carries, however short the lesson", () => {
    const short: SwapProposal = { ...PROPOSAL, moves: [{ lessonId: "l-a", from: { dayOfWeek: 1, startMinutes: 480, endMinutes: 485 }, to: { dayOfWeek: 2, startMinutes: 600, endMinutes: 605 } }] };
    const { container } = render(<SwapLayer day={2} scale={scale} proposal={short} />);
    expect(container.querySelector<HTMLElement>('[data-swap-box="arrives"]')!.style.height).toBe("14px");
  });
});
