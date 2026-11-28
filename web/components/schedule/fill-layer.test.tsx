import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import type { FillProposal } from "@/lib/board-fill";
import FillLayer from "./fill-layer";
import { fillBehind } from "./fill-behind";
import { fillPreview } from "@/lib/fill-store";
import sv from "@/messages/sv.json";
import en from "@/messages/en.json";

/*
 * The proposal of Lägg det som går on the board: dashed outlines, one for each brick laid on the day, inert and hidden from a screen reader (the
 * dialog says the same in words), with the words in the outline and not only in its colour.
 */

const brick = (key: string) => ({ key, postId: "p", studentGroupId: "g", subjectId: "s", teacherId: "t", minutes: 60, lessonId: null });
const proposal: FillProposal = {
  academicYearId: "y1",
  answeredBy: "FILL",
  basis: "a".repeat(32),
  asked: 3,
  placed: [
    { ...brick("a"), dayOfWeek: 2, startMinutes: 540, endMinutes: 600, roomId: "r1", noRoom: false },
    { ...brick("b"), dayOfWeek: 2, startMinutes: 720, endMinutes: 765, roomId: null, noRoom: true },
    { ...brick("c"), dayOfWeek: 4, startMinutes: 480, endMinutes: 540, roomId: "r1", noRoom: false },
  ],
  left: [],
  moved: [],
  truncated: false,
};
const shown = { proposal, labels: new Map([["a", "Matematik 7A"], ["b", "Svenska 7B"], ["c", "Idrott 7A"]]) };
const scale = { startMinutes: 480, pxPerMinute: 1 };

const view = (locale: "sv" | "en", day: number) =>
  render(
    <NextIntlClientProvider locale={locale} messages={locale === "sv" ? sv : en}>
      <FillLayer day={day} scale={scale} shown={shown} />
    </NextIntlClientProvider>,
  );

afterEach(() => {
  cleanup();
  fillPreview.set(null);
});

describe("FillLayer", () => {
  it("draws the bricks laid on its day where they would stand, and none of the other days'", () => {
    const { container } = view("sv", 2);
    const boxes = [...container.querySelectorAll<HTMLElement>("[data-fill-box]")];
    expect(boxes).toHaveLength(2);
    expect(boxes[0]!.style.top).toBe("60px");
    expect(boxes[0]!.style.height).toBe("60px");
    expect(boxes[1]!.style.top).toBe("240px");
    expect(boxes[1]!.style.height).toBe("45px");
  });

  it("says in words what and when, and \"utan sal\" for a brick laid with no room, in both languages", () => {
    const sv_ = view("sv", 2);
    expect(sv_.container.textContent).toContain("Matematik 7A 09:00");
    expect(sv_.container.textContent).toContain("Svenska 7B 12:00, utan sal");
    cleanup();
    const en_ = view("en", 2);
    expect(en_.container.textContent).toContain("Svenska 7B 12:00, no room");
  });

  it("is inert and hidden from a screen reader: the dialog has the words", () => {
    const { container } = view("sv", 4);
    const layer = container.querySelector<HTMLElement>("[data-fill-layer]")!;
    expect(layer.getAttribute("aria-hidden")).toBe("true");
    expect(layer.className).toContain("pointer-events-none");
  });

  it("draws nothing on a day nothing is laid on", () => {
    expect(view("sv", 5).container.innerHTML).toBe("");
  });
});

describe("fillBehind", () => {
  it("draws nothing while the store is empty, and the layer for the day once a proposal is shown", async () => {
    const { container, findByText } = render(<NextIntlClientProvider locale="sv" messages={sv}>{fillBehind(2, scale)}</NextIntlClientProvider>);
    expect(container.innerHTML).toBe("");
    fillPreview.set(shown);
    expect(await findByText("Matematik 7A 09:00")).toBeTruthy();
  });
});
