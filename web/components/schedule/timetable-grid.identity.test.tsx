import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render } from "@testing-library/react";
import { TimetableGrid, type TimetableLesson } from "./timetable-grid";

vi.mock("next-intl", () => ({
  useLocale: () => "sv",
  useTranslations: () => (key: string, values?: Record<string, unknown>) =>
    values ? `${key} ${Object.values(values).join(" ")}` : key,
}));

/*
 * What a memoised card and a ghost outside React's state must not lose: that a card is its lesson's and not its place in the
 * day's list (focus is on the element), and that the ghost is drawn in the one column it stands in.
 */

const lesson = (overrides: Partial<TimetableLesson> & { id: string }): TimetableLesson => ({
  dayOfWeek: 1,
  startMinutes: 540,
  endMinutes: 600,
  title: "Matematik",
  subtitle: "7A",
  color: "#6366f1",
  ...overrides,
});
const card = (id: string) => document.querySelector<HTMLElement>(`[data-lesson-id="${id}"]`)!;
const ghosts = () => document.querySelectorAll('[class*="border-dashed"][class*="border-2"]');

const RECT = { x: 0, y: 0, top: 0, left: 0, right: 556, bottom: 528, width: 556, height: 528, toJSON: () => ({}) } as DOMRect;

beforeEach(() => {
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockReturnValue(RECT);
});
afterEach(() => vi.restoreAllMocks());

describe("the card of a lesson is the same element for as long as the lesson is in the week", () => {
  it("keeps focus on a lesson when another one is brought in before it", () => {
    const a = lesson({ id: "a" });
    const b = lesson({ id: "b", startMinutes: 660, endMinutes: 720, title: "Svenska" });
    const { rerender } = render(<TimetableGrid lessons={[a, b]} editable />);
    card("b").focus();
    const element = card("b");

    rerender(<TimetableGrid lessons={[lesson({ id: "c", startMinutes: 480, endMinutes: 540, title: "Idrott" }), a, b]} editable />);

    expect(card("b")).toBe(element);
    expect(card("b")).toHaveFocus();
  });

  it("keeps the element of a lesson that another one has moved out from before", () => {
    const a = lesson({ id: "a" });
    const b = lesson({ id: "b", startMinutes: 660, endMinutes: 720, title: "Svenska" });
    const { rerender } = render(<TimetableGrid lessons={[a, b]} editable />);
    const element = card("b");
    rerender(<TimetableGrid lessons={[b]} editable />);
    expect(card("b")).toBe(element);
  });
});

describe("the ghost of a drag", () => {
  it("is drawn in the column it stands in and in no other, and leaves it when the pointer goes to another", () => {
    render(<TimetableGrid lessons={[lesson({ id: "a" }), lesson({ id: "b", dayOfWeek: 2 })]} editable validateChange={() => true} onLessonChange={vi.fn()} />);
    fireEvent.pointerDown(card("a"), { pointerId: 1, button: 0, clientX: 100, clientY: 10 });
    // 556 wide, 56 of it the axis: a day column is 100 px, and x = 120 is Monday's, x = 320 Wednesday's.
    fireEvent.pointerMove(window, { pointerId: 1, clientX: 120, clientY: 300 });
    expect(ghosts()).toHaveLength(1);
    const first = ghosts()[0]!.parentElement;
    fireEvent.pointerMove(window, { pointerId: 1, clientX: 320, clientY: 300 });
    expect(ghosts()).toHaveLength(1);
    expect(ghosts()[0]!.parentElement).not.toBe(first);
    fireEvent.pointerUp(window, { pointerId: 1, clientX: 320, clientY: 300 });
    expect(ghosts()).toHaveLength(0);
  });
});
