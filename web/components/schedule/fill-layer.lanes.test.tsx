import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import type { FillProposal } from "@/lib/board-fill";
import FillLayer from "./fill-layer";
import { fillPreview } from "@/lib/fill-store";
import sv from "@/messages/sv.json";

/*
 * Bricks that stand at the same time (E7a, granskaren g519). A proposal for a year or the school lays the classes' bricks in the same hours of the same
 * day, and the layer drew each across the whole column: the boxes lay exactly over one another, only the last one's name could be read, and a proposal of
 * forty bricks looked like ten. Side by side, as the grid draws the lessons it lies over.
 */

const brick = (key: string, over: Record<string, unknown>) => ({ key, postId: "p", studentGroupId: "g1", subjectId: "s", teacherId: "t1", minutes: 60, lessonId: null, ...over });
const at = (startMinutes: number, endMinutes: number) => ({ dayOfWeek: 2, startMinutes, endMinutes, roomId: "r1", noRoom: false });
const proposal: FillProposal = {
  academicYearId: "y1",
  answeredBy: "FILL",
  basis: "a".repeat(32),
  asked: 4,
  placed: [
    { ...brick("a", { studentGroupId: "g1" }), ...at(540, 600) },
    { ...brick("b", { studentGroupId: "g2" }), ...at(540, 600) },
    { ...brick("c", { studentGroupId: "g3" }), ...at(570, 630) },
    { ...brick("d", { studentGroupId: "g4" }), ...at(720, 780) },
  ],
  left: [],
  moved: [],
  truncated: false,
};
const shown = { proposal, labels: new Map([["a", "Matematik 7A"], ["b", "Matematik 7B"], ["c", "Matematik 7C"], ["d", "Matematik 7D"]]) };

afterEach(() => {
  cleanup();
  fillPreview.set(null);
});

describe("FillLayer, bricks at the same time", () => {
  it("puts bricks that overlap in time side by side, each in a lane of its own, and a lone brick as wide as the others", () => {
    const { container } = render(
      <NextIntlClientProvider locale="sv" messages={sv}>
        <FillLayer day={2} scale={{ startMinutes: 480, pxPerMinute: 1 }} shown={shown} />
      </NextIntlClientProvider>,
    );
    const boxes = [...container.querySelectorAll<HTMLElement>("[data-fill-box]")];
    expect(boxes.map((box) => box.textContent)).toEqual(["Matematik 7A 09:00", "Matematik 7B 09:00", "Matematik 7C 09:30", "Matematik 7D 12:00"]);
    const lefts = boxes.map((box) => box.style.left);
    expect(new Set(lefts.slice(0, 3)).size).toBe(3);
    expect(boxes.map((box) => box.style.width)).toEqual(Array(4).fill("calc(33.3333% - 4px)"));
    expect(lefts[0]).toBe("calc(0% + 2px)");
  });

  it("keeps a brick of five minutes tall enough to read its name in (14 px)", () => {
    const short = { ...shown, proposal: { ...proposal, placed: [{ ...proposal.placed[0]!, ...at(540, 545) }] } };
    const { container } = render(
      <NextIntlClientProvider locale="sv" messages={sv}>
        <FillLayer day={2} scale={{ startMinutes: 480, pxPerMinute: 1 }} shown={short} />
      </NextIntlClientProvider>,
    );
    expect(container.querySelector<HTMLElement>("[data-fill-box]")!.style.height).toBe("14px");
  });
});
