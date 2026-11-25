import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { TimetableGrid, type TimetableLesson } from "./timetable-grid";

vi.mock("next-intl", () => ({
  useLocale: () => "sv",
  useTranslations: () => (key: string, values?: Record<string, unknown>) =>
    values ? `${key} ${Object.values(values).join(" ")}` : key,
}));
// The layer is a chunk that is fetched, and a fetch can fail (a dropped connection, a proxy).
vi.mock("./board-keys", () => {
  throw new Error("Failed to fetch dynamically imported module");
});

const lesson = (overrides: Partial<TimetableLesson> & { id: string }): TimetableLesson => ({
  dayOfWeek: 1,
  startMinutes: 540,
  endMinutes: 600,
  title: "Matematik",
  subtitle: "7A",
  color: "#6366f1",
  ...overrides,
});
const WEEK = [lesson({ id: "mon-9" }), lesson({ id: "tue-9", dayOfWeek: 2, title: "Svenska" })];
const card = (id: string) => document.querySelector<HTMLElement>(`[data-lesson-id="${id}"]`)!;

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("a board whose keys did not come", () => {
  it("is the grid as it was: the arrows move the lesson, and every card is a stop of the tab key", async () => {
    const onLessonChange = vi.fn();
    render(<TimetableGrid lessons={WEEK} editable board onLessonChange={onLessonChange} />);
    // The grid is told of the failure a moment after it has asked.
    await waitFor(() => expect(card("mon-9")).not.toHaveAttribute("tabindex", "-1"));
    expect(card("tue-9")).not.toHaveAttribute("tabindex");
    fireEvent.keyDown(card("mon-9"), { key: "ArrowDown" });
    expect(onLessonChange).toHaveBeenCalledWith("mon-9", { dayOfWeek: 1, startMinutes: 555, endMinutes: 615 });
  });

  it("draws the whole week on a phone, where the buttons that choose a day are in the layer that did not come", async () => {
    vi.stubGlobal("matchMedia", () => ({ matches: true, addEventListener: () => undefined, removeEventListener: () => undefined }));
    render(<TimetableGrid lessons={WEEK} editable board onLessonChange={vi.fn()} />);
    await waitFor(() => expect(document.querySelectorAll("[data-lesson-id]")).toHaveLength(2));
    expect(screen.queryByRole("group")).toBeNull();
  });
});
