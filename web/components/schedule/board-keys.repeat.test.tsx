import { afterEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { TimetableGrid, type TimetableLesson } from "./timetable-grid";

vi.mock("next-intl", () => ({
  useLocale: () => "sv",
  useTranslations: () => (key: string, values?: Record<string, unknown>) =>
    values ? `${key} ${Object.values(values).join(" ")}` : key,
}));

/*
 * A key held down repeats (event.repeat), and a write must not: the board's keys that write ask the page for one write each
 * (and one step of undo), and Space takes a lesson up and puts it down. Only the arrows and Home and End are meant to repeat.
 */

/** The board's line under the week: a live region, found by what it is and not by a role the page may also have. */
const line = () => document.querySelector<HTMLElement>('p[aria-live="polite"]');

const lesson = (overrides: Partial<TimetableLesson> & { id: string }): TimetableLesson => ({
  dayOfWeek: 1,
  startMinutes: 540,
  endMinutes: 600,
  title: "Matematik",
  subtitle: "7A",
  color: "#6366f1",
  ...overrides,
});
const WEEK = [lesson({ id: "mon-9" }), lesson({ id: "mon-11", startMinutes: 660, endMinutes: 720, title: "Svenska" })];
const card = (id: string) => document.querySelector<HTMLElement>(`[data-lesson-id="${id}"]`)!;
const press = (id: string, init: KeyboardEventInit, times = 1) => {
  for (let i = 0; i < times; i++) fireEvent.keyDown(card(id), init);
};

async function board() {
  const spies = {
    onLessonChange: vi.fn(),
    validateChange: vi.fn().mockReturnValue(true),
    onInvalidDrop: vi.fn(),
    onLessonCommand: vi.fn(),
  };
  render(<TimetableGrid lessons={WEEK} editable board {...spies} />);
  await waitFor(() => expect(line()).not.toBeNull());
  await act(async () => {});
  return spies;
}

afterEach(() => vi.restoreAllMocks());

describe("a key held down", () => {
  it("writes once: the first press counts and its repeats do not", async () => {
    const { onLessonCommand, onLessonChange } = await board();
    press("mon-9", { key: "l" });
    press("mon-9", { key: "l", repeat: true }, 10);
    expect(onLessonCommand).toHaveBeenCalledTimes(1);

    press("mon-9", { key: "ArrowDown", altKey: true });
    press("mon-9", { key: "ArrowDown", altKey: true, repeat: true }, 10);
    expect(onLessonChange).toHaveBeenCalledTimes(1);
  });

  it("does not put down what it has just taken up, and take it up again", async () => {
    const { onLessonChange } = await board();
    press("mon-9", { key: " " });
    expect(line()!).toHaveTextContent(/^pickedUp /);
    press("mon-9", { key: " ", repeat: true }, 5);
    expect(line()!).toHaveTextContent(/^pickedUp /);
    expect(onLessonChange).not.toHaveBeenCalled();
  });

  it("still moves focus and the marker on every repeat of an arrow", async () => {
    await board();
    card("mon-9").focus();
    press("mon-9", { key: "ArrowDown", repeat: true });
    expect(card("mon-11")).toHaveFocus();
    press("mon-11", { key: " " });
    press("mon-11", { key: "ArrowUp", repeat: true }, 2);
    expect(line()!).toHaveTextContent(/^markerFree /);
    // Two repeats of an arrow are two steps of a quarter of an hour.
    expect(document.querySelector('[class*="border-dashed"]')).toHaveTextContent("10:30–11:30");
  });
});
