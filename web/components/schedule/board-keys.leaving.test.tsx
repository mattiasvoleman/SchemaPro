import { afterEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { TimetableGrid, type TimetableLesson } from "./timetable-grid";

vi.mock("next-intl", () => ({
  useLocale: () => "sv",
  useTranslations: () => (key: string, values?: Record<string, unknown>) =>
    values ? `${key} ${Object.values(values).join(" ")}` : key,
}));

/*
 * A lesson that is parked or removed from the keyboard leaves the week, and the focus it had must not leave the page with it:
 * a person who parks a lesson with P goes on with the arrows, and from <body> the arrows go nowhere.
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
const WEEK = [
  lesson({ id: "mon-9" }),
  lesson({ id: "mon-11", startMinutes: 660, endMinutes: 720, title: "Svenska" }),
  lesson({ id: "mon-13", startMinutes: 780, endMinutes: 840, title: "Engelska" }),
  lesson({ id: "tue-9", dayOfWeek: 2, title: "Idrott" }),
];
const card = (id: string) => document.querySelector<HTMLElement>(`[data-lesson-id="${id}"]`)!;

/** A page that does what the keys ask: the lesson is gone from the week once it is parked or removed. */
function Page({ first, refuse = false }: { first: TimetableLesson[]; refuse?: boolean }) {
  const [lessons, setLessons] = useState(first);
  return (
    <TimetableGrid
      lessons={lessons}
      editable
      board
      validateChange={() => true}
      onLessonCommand={(id) => {
        if (!refuse) setLessons((held) => held.filter((candidate) => candidate.id !== id));
      }}
    />
  );
}

async function board(lessons = WEEK, refuse = false) {
  render(<Page first={lessons} refuse={refuse} />);
  await waitFor(() => expect(line()).not.toBeNull());
  await act(async () => {});
}

afterEach(() => vi.restoreAllMocks());

describe("focus when a lesson leaves the week from the keyboard", () => {
  it("goes to the next lesson of the day when one is parked", async () => {
    await board();
    card("mon-11").focus();
    fireEvent.keyDown(card("mon-11"), { key: "p" });
    expect(card("mon-11")).toBeNull();
    expect(card("mon-13")).toHaveFocus();
  });

  it("goes to the one before when the last of the day is removed, and the arrows then go on from there", async () => {
    await board();
    card("mon-13").focus();
    fireEvent.keyDown(card("mon-13"), { key: "Delete" });
    expect(card("mon-11")).toHaveFocus();
    fireEvent.keyDown(card("mon-11"), { key: "ArrowUp" });
    expect(card("mon-9")).toHaveFocus();
  });

  it("goes to another day when it was the only lesson of its day", async () => {
    await board([lesson({ id: "only" }), lesson({ id: "tue-9", dayOfWeek: 2, title: "Idrott" })]);
    card("only").focus();
    fireEvent.keyDown(card("only"), { key: "Backspace" });
    expect(card("tue-9")).toHaveFocus();
  });

  it("leaves the focus where it is when the write is refused and the lesson stays", async () => {
    await board(WEEK, true);
    card("mon-11").focus();
    fireEvent.keyDown(card("mon-11"), { key: "p" });
    expect(card("mon-11")).toHaveFocus();
  });
});
