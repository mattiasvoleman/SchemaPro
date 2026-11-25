import { afterEach, describe, expect, it, vi } from "vitest";
import { act, render, screen, waitFor } from "@testing-library/react";
import { TimetableGrid, type TimetableLesson } from "./timetable-grid";

vi.mock("next-intl", () => ({
  useLocale: () => "sv",
  useTranslations: () => (key: string, values?: Record<string, unknown>) =>
    values ? `${key} ${Object.values(values).join(" ")}` : key,
}));

/*
 * What a finger on a card may do is the grid's to say only where the grid is edited. A read-only week (a teacher's, a pupil's) is
 * 720 px wide in a box that scrolls sideways, and on a phone the cards cover most of it: a touch-action that allows only a vertical
 * pan on every card would leave a swipe that starts on a card unable to scroll the week, and unable to pinch.
 */

/** The board's line under the week: a live region, found by what it is and not by a role the page may also have. */
const line = () => document.querySelector<HTMLElement>('p[aria-live="polite"]');

const WEEK: TimetableLesson[] = [
  { id: "mon-9", dayOfWeek: 1, startMinutes: 540, endMinutes: 600, title: "Matematik", subtitle: "7A", color: "#6366f1" },
  { id: "tue-9", dayOfWeek: 2, startMinutes: 540, endMinutes: 600, title: "Svenska", subtitle: "7A", color: "#6366f1" },
];
const card = (id: string) => document.querySelector<HTMLElement>(`[data-lesson-id="${id}"]`)!;
const touchClasses = (id: string) => [...card(id).classList].filter((name) => name.startsWith("touch-"));

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("touch-action on a card", () => {
  it("is not set on a grid that is only read, whatever the window", () => {
    vi.stubGlobal("matchMedia", () => ({ matches: true, addEventListener: () => undefined, removeEventListener: () => undefined }));
    render(<TimetableGrid lessons={WEEK} onLessonClick={vi.fn()} />);
    expect(touchClasses("mon-9")).toEqual([]);
  });

  it("is none on a grid that is dragged, and a vertical pan on the board of a phone, where nothing is", async () => {
    const { unmount } = render(<TimetableGrid lessons={WEEK} editable onLessonChange={vi.fn()} />);
    expect(touchClasses("mon-9")).toEqual(["touch-none"]);
    unmount();

    vi.stubGlobal("matchMedia", () => ({ matches: true, addEventListener: () => undefined, removeEventListener: () => undefined }));
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(2026, 10, 23, 10, 0)); // a Monday
    render(<TimetableGrid lessons={WEEK} editable board onLessonChange={vi.fn()} />);
    await waitFor(() => expect(line()).not.toBeNull());
    await act(async () => {});
    vi.useRealTimers();
    expect(touchClasses("mon-9")).toEqual(["touch-pan-y"]);
  });
});
