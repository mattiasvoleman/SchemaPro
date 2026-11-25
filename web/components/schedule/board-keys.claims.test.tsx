import { afterEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import { TimetableGrid, type TimetableLesson } from "./timetable-grid";
import sv from "@/messages/sv.json";
import en from "@/messages/en.json";

/*
 * What the line under the week claims, for the three keys whose write is the page's and is answered later (lock, park,
 * remove). The line is said when the key is pressed. A write the gateway refuses (a lesson that is placed, a clash) is told by
 * the page's own toast, and a line that has said "låst" or "Ctrl+Z ångrar" by then has said what is not so: Ctrl+Z, pressed on
 * its word, takes back the edit before it.
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
const WEEK = [lesson({ id: "mon-9" }), lesson({ id: "tue-930", dayOfWeek: 2, startMinutes: 570, endMinutes: 630, title: "Engelska", locked: true })];
const card = (id: string) => document.querySelector<HTMLElement>(`[data-lesson-id="${id}"]`)!;

async function board(locale: "sv" | "en") {
  render(
    <NextIntlClientProvider locale={locale} messages={locale === "sv" ? sv : en} timeZone="Europe/Stockholm">
      <TimetableGrid lessons={WEEK} editable board validateChange={() => true} onLessonChange={vi.fn()} onLessonCommand={vi.fn()} />
    </NextIntlClientProvider>,
  );
  await waitFor(() => expect(line()).not.toBeNull());
  await act(async () => {});
}

afterEach(() => vi.restoreAllMocks());

describe("the line says what the key asks for, and not that it has been done", () => {
  it("lock, unlock and remove are said as being asked for", async () => {
    await board("sv");
    fireEvent.keyDown(card("mon-9"), { key: "l" });
    expect(line()!).toHaveTextContent(/^Låser Matematik 7A\.$/);
    fireEvent.keyDown(card("tue-930"), { key: "L" });
    expect(line()!).toHaveTextContent(/^Låser upp Engelska 7A\.$/);
    fireEvent.keyDown(card("mon-9"), { key: "Delete" });
    expect(line()!).toHaveTextContent(/^Tar bort Matematik 7A\.$/);
  });

  for (const [name, messages] of [["sv", sv], ["en", en]] as const) {
    it(`promises no undo and no finished state in a sentence the key says before the write is answered (${name})`, () => {
      const said = (messages as unknown as { boardKeys: Record<string, string> }).boardKeys;
      for (const sentence of ["locked", "unlocked", "parked", "removed", "placed"]) {
        expect(said[sentence], sentence).not.toMatch(/Ctrl|ångra|undo/i);
      }
      expect(said.locked).toMatch(/^(Låser|Locking) \{lesson\}\.$/);
      expect(said.unlocked).toMatch(/^(Låser upp|Unlocking) \{lesson\}\.$/);
    });
  }
});
