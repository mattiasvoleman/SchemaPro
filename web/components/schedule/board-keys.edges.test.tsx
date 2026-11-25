import { afterEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { TimetableGrid, type TimetableLesson } from "./timetable-grid";

vi.mock("next-intl", () => ({
  useLocale: () => "sv",
  useTranslations: () => (key: string, values?: Record<string, unknown>) =>
    values ? `${key} ${Object.values(values).join(" ")}` : key,
}));

/*
 * The edges of the board's keys that no mutant of the first spec had to pass: the browser's own shortcuts, a Shift that is not
 * an arrow's, the end of the drawn day, and a phone opened on a Saturday.
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

async function board(lessons = WEEK, extra: Partial<React.ComponentProps<typeof TimetableGrid>> = {}) {
  const spies = {
    onLessonChange: vi.fn(),
    validateChange: vi.fn().mockReturnValue(true),
    onInvalidDrop: vi.fn(),
    onLessonCommand: vi.fn(),
  };
  render(<TimetableGrid lessons={lessons} editable board {...spies} {...extra} />);
  await waitFor(() => expect(line()).not.toBeNull());
  await act(async () => {});
  return spies;
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("a key with a modifier is the browser's", () => {
  it("leaves Ctrl+P, Ctrl+L and Cmd+Backspace alone: print, the address bar and the page's own", async () => {
    const { onLessonCommand } = await board();
    for (const init of [
      { key: "p", ctrlKey: true },
      { key: "l", ctrlKey: true },
      { key: "m", metaKey: true },
      { key: "Backspace", metaKey: true },
      { key: "Delete", ctrlKey: true },
    ]) {
      const event = new KeyboardEvent("keydown", { ...init, bubbles: true, cancelable: true });
      card("mon-9").dispatchEvent(event);
      expect(event.defaultPrevented, `${init.key} with a modifier`).toBe(false);
    }
    expect(onLessonCommand).not.toHaveBeenCalled();
    expect(line()!).toHaveTextContent("");
  });

  it("does not move focus on Shift and an arrow, which is the browser's selection", async () => {
    await board();
    card("mon-9").focus();
    const event = new KeyboardEvent("keydown", { key: "ArrowDown", shiftKey: true, bubbles: true, cancelable: true });
    card("mon-9").dispatchEvent(event);
    expect(card("mon-9")).toHaveFocus();
    expect(event.defaultPrevented).toBe(false);
  });
});

describe("the end of the drawn day", () => {
  it("lets a lesson be made longer until it ends exactly where the day ends", async () => {
    // The grid draws to 16:00 at least: a lesson of 14:55-15:55 may grow five minutes to 16:00 and no more.
    const { onLessonChange } = await board([lesson({ id: "late", startMinutes: 895, endMinutes: 955 })]);
    fireEvent.keyDown(card("late"), { key: "ArrowDown", altKey: true });
    expect(onLessonChange).toHaveBeenCalledWith("late", { dayOfWeek: 1, startMinutes: 895, endMinutes: 960 });
  });

  it("does not let it grow past it, and says so", async () => {
    const { onLessonChange } = await board([lesson({ id: "last", startMinutes: 900, endMinutes: 960 })]);
    fireEvent.keyDown(card("last"), { key: "ArrowDown", altKey: true });
    expect(onLessonChange).not.toHaveBeenCalled();
    expect(line()!).toHaveTextContent(/^lengthLimit /);
  });
});

describe("a phone opened on a day the week has no column for", () => {
  it("shows Friday on a Saturday and on a Sunday, and not an empty day", async () => {
    vi.stubGlobal("matchMedia", () => ({ matches: true, addEventListener: () => undefined, removeEventListener: () => undefined }));
    for (const day of [28, 29]) {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(new Date(2026, 10, day, 10, 0)); // 28 November 2026 is a Saturday
      const week = [...WEEK, lesson({ id: "fri-8", dayOfWeek: 5, startMinutes: 480, endMinutes: 540, title: "Idrott" })];
      const { unmount } = render(<TimetableGrid lessons={week} editable board />);
      await waitFor(() => expect(line()).not.toBeNull());
      await act(async () => {});
      vi.useRealTimers();
      expect(card("fri-8")).toBeInTheDocument();
      expect(card("mon-9") ?? null).toBeNull();
      unmount();
    }
  });
});
