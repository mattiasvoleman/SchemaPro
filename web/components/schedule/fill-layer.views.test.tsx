import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import type { FillProposal } from "@/lib/board-fill";
import FillLayer from "./fill-layer";
import { fillBehind } from "./fill-behind";
import { fillPreview } from "@/lib/fill-store";
import sv from "@/messages/sv.json";

/*
 * The proposal on the boards of the views by class, teacher and room (E7a, granskaren g519). The page draws one board per class, teacher or room in those
 * views and gave them no layer, so a proposal was drawn on the combined board only, while the dialog said "drawn as dashed boxes on the board" in every view.
 * A board draws the bricks that are its own.
 */

const brick = (key: string, over: Record<string, unknown>) => ({ key, postId: "p", studentGroupId: "g1", subjectId: "s", teacherId: "t1", minutes: 60, lessonId: null, ...over });
const proposal: FillProposal = {
  academicYearId: "y1",
  answeredBy: "FILL",
  basis: "a".repeat(32),
  asked: 4,
  placed: [
    { ...brick("a", {}), dayOfWeek: 2, startMinutes: 540, endMinutes: 600, roomId: "r1", noRoom: false },
    { ...brick("b", { studentGroupId: "g2", teacherId: "t2" }), dayOfWeek: 2, startMinutes: 600, endMinutes: 660, roomId: "r2", noRoom: false },
    { ...brick("c", { teacherId: null }), dayOfWeek: 2, startMinutes: 660, endMinutes: 720, roomId: null, noRoom: true },
  ],
  left: [],
  moved: [],
  truncated: false,
};
const shown = { proposal, labels: new Map([["a", "Matematik 7A"], ["b", "Svenska 7B"], ["c", "Idrott 7A"]]) };
const scale = { startMinutes: 480, pxPerMinute: 1 };

const keysOf = (container: HTMLElement) => [...container.querySelectorAll<HTMLElement>("[data-fill-box]")].map((box) => box.textContent);
const draw = (only?: { by: "group" | "teacher" | "room"; id: string | null }) =>
  render(
    <NextIntlClientProvider locale="sv" messages={sv}>
      <FillLayer day={2} scale={scale} shown={shown} only={only} />
    </NextIntlClientProvider>,
  ).container;

afterEach(() => {
  cleanup();
  fillPreview.set(null);
});

describe("FillLayer on the board of one class, teacher or room", () => {
  it("draws every brick on the combined board", () => {
    expect(keysOf(draw())).toEqual(["Matematik 7A 09:00", "Svenska 7B 10:00", "Idrott 7A 11:00, utan sal"]);
  });

  it("draws the bricks of the class on a class's board", () => {
    expect(keysOf(draw({ by: "group", id: "g2" }))).toEqual(["Svenska 7B 10:00"]);
  });

  it("draws the bricks of the teacher on a teacher's board, and those with no teacher on the board of no teacher", () => {
    expect(keysOf(draw({ by: "teacher", id: "t1" }))).toEqual(["Matematik 7A 09:00"]);
    cleanup();
    expect(keysOf(draw({ by: "teacher", id: null }))).toEqual(["Idrott 7A 11:00, utan sal"]);
  });

  it("draws the bricks of the room on a room's board, and those laid with no room on the board of no room", () => {
    expect(keysOf(draw({ by: "room", id: "r2" }))).toEqual(["Svenska 7B 10:00"]);
    cleanup();
    expect(keysOf(draw({ by: "room", id: null }))).toEqual(["Idrott 7A 11:00, utan sal"]);
  });

  it("is what fillBehind hands the layer for a board of a view: the view and the board's key, \"__none__\" being the board of nothing", async () => {
    fillPreview.set(shown);
    const { container, findByText } = render(<NextIntlClientProvider locale="sv" messages={sv}>{fillBehind(2, scale, "teacher", "t2")}</NextIntlClientProvider>);
    expect(await findByText("Svenska 7B 10:00")).toBeTruthy();
    expect(keysOf(container)).toEqual(["Svenska 7B 10:00"]);
    cleanup();
    const none = render(<NextIntlClientProvider locale="sv" messages={sv}>{fillBehind(2, scale, "room", "__none__")}</NextIntlClientProvider>);
    expect(await none.findByText("Idrott 7A 11:00, utan sal")).toBeTruthy();
    expect(keysOf(none.container)).toEqual(["Idrott 7A 11:00, utan sal"]);
    cleanup();
    const combined = render(<NextIntlClientProvider locale="sv" messages={sv}>{fillBehind(2, scale, "none")}</NextIntlClientProvider>);
    expect(await combined.findByText("Matematik 7A 09:00")).toBeTruthy();
    expect(keysOf(combined.container)).toHaveLength(3);
  });
});
