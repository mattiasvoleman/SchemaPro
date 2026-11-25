import { afterEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, waitFor } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import { TimetableGrid, type TimetableLesson } from "./timetable-grid";
import sv from "@/messages/sv.json";
import en from "@/messages/en.json";

/*
 * The sentences the board says, with the REAL catalogue: board-keys.test.tsx echoes keys and values, which says that a key was
 * asked for and not that its sentence can be made from what it was given (a placeholder the code never passes makes next-intl say
 * the key itself, "boardKeys.pickedUp", in the browser). Here the translator is next-intl's, and each sentence is read as a person
 * reads it.
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

const WEEK = [lesson({ id: "a" }), lesson({ id: "b", dayOfWeek: 2, startMinutes: 570, endMinutes: 630, title: "Svenska", locked: true })];

const card = (id: string) => document.querySelector<HTMLElement>(`[data-lesson-id="${id}"]`)!;
const key = (id: string, init: KeyboardEventInit) => fireEvent.keyDown(card(id), init);
const said = () => document.querySelector("[data-board-status]")!.textContent!;

async function board(locale: "sv" | "en", extra: Partial<React.ComponentProps<typeof TimetableGrid>> = {}) {
  const view = render(
    <NextIntlClientProvider locale={locale} messages={(locale === "sv" ? sv : en) as never}>
      <TimetableGrid
        lessons={WEEK}
        editable
        board
        validateChange={vi.fn().mockReturnValue(true)}
        onLessonChange={vi.fn()}
        onLessonCommand={vi.fn()}
        {...extra}
      />
    </NextIntlClientProvider>,
  );
  await waitFor(() => expect(document.querySelector("[data-board-status]")).not.toBeNull());
  await act(async () => {});
  return view;
}

afterEach(() => vi.restoreAllMocks());

describe("what the board says, in the catalogue's own words", () => {
  it("says every key in Swedish as a sentence, and never as a key", async () => {
    await board("sv");
    const all: string[] = [];
    const note = () => all.push(said());

    key("a", { key: " " });
    note();
    expect(said()).toBe("Tog upp Matematik 7A, Måndag 09:00–10:00. Pilarna flyttar markören, Enter lägger, Esc släpper.");
    key("a", { key: "ArrowDown" });
    note();
    expect(said()).toBe("Måndag 09:15–10:15: går att lägga. Enter lägger.");
    key("a", { key: "Enter" });
    note();
    expect(said()).toBe("Flyttar Matematik 7A till Måndag 09:15–10:15.");

    key("a", { key: " " });
    key("a", { key: "Escape" });
    note();
    expect(said()).toBe("Släppte Matematik 7A. Ingenting ändrades.");

    key("a", { key: "ArrowDown", altKey: true });
    note();
    expect(said()).toBe("Matematik 7A är 65 minuter och slutar 10:05.");

    key("a", { key: "l" });
    note();
    expect(said()).toBe("Låser Matematik 7A.");
    key("b", { key: "L" });
    note();
    expect(said()).toBe("Låser upp Svenska 7A.");
    key("a", { key: "p" });
    note();
    expect(said()).toBe("Parkerar Matematik 7A.");
    key("a", { key: "Delete" });
    note();
    expect(said()).toBe("Tar bort Matematik 7A.");

    for (const sentence of all) expect(sentence).not.toMatch(/boardKeys\./);
  });

  it("says a square that does not hold, a refusal and a length that is not allowed", async () => {
    await board("sv", { validateChange: vi.fn().mockReturnValue(false) });
    key("a", { key: " " });
    key("a", { key: "ArrowDown" });
    expect(said()).toBe("Måndag 09:15–10:15: går inte att lägga här. Enter visar de närmaste lediga tiderna.");
    key("a", { key: "Enter" });
    expect(said()).toBe("Matematik 7A går inte att lägga Måndag 09:15–10:15. De närmaste lediga tiderna visas.");
    key("a", { key: "ArrowDown", altKey: true });
    expect(said()).toBe("Matematik 7A går inte att göra 65 minuter. De närmaste lediga tiderna visas.");
  });

  it("says the same in English", async () => {
    await board("en");
    key("a", { key: " " });
    expect(said()).toBe("Picked up Matematik 7A, Monday 09:00–10:00. The arrow keys move the marker, Enter puts it down, Esc lets go.");
    key("a", { key: "ArrowDown" });
    expect(said()).toBe("Monday 09:15–10:15: free. Enter puts it down.");
    key("a", { key: "Escape" });
    key("a", { key: "l" });
    expect(said()).toBe("Locking Matematik 7A.");
  });

  it("names the day buttons of a phone with their day and their number of lessons, in the catalogue's plural", async () => {
    vi.stubGlobal("matchMedia", () => ({ matches: true, addEventListener: () => undefined, removeEventListener: () => undefined }));
    try {
      await board("sv");
      const names = [...document.querySelectorAll("[role='group'] button")].map((button) => button.getAttribute("aria-label"));
      expect(names).toEqual([
        "Måndag: 1 lektion",
        "Tisdag: 1 lektion",
        "Onsdag: inga lektioner",
        "Torsdag: inga lektioner",
        "Fredag: inga lektioner",
      ]);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("calls a clash a clash, in both languages", async () => {
    for (const [locale, word] of [["sv", "Krock"], ["en", "Clash"]] as const) {
      const { unmount } = await board(locale, {});
      unmount();
      render(
        <NextIntlClientProvider locale={locale} messages={(locale === "sv" ? sv : en) as never}>
          <TimetableGrid lessons={[lesson({ id: "x", conflicted: true, conflictNote: "Läraren har Kemi 8B." })]} />
        </NextIntlClientProvider>,
      );
      expect(card("x").textContent).toContain(`${word}: Läraren har Kemi 8B.`);
      document.body.innerHTML = "";
    }
  });

  it("calls the card of a block by the block and answers L, P and Delete on it by saying that its own dialog opens, in both languages", async () => {
    const block = lesson({ id: "blk", title: "Språkval åk 7", subtitle: "7A · A. Lind; 7B · B. Ek", blockCard: true });
    const onLessonCommand = vi.fn();
    for (const [locale, opens] of [
      ["sv", "Språkval åk 7 är ett block: blockets egen ruta öppnas, där lås, parkera och ta bort gäller hela blocket."],
      ["en", "Språkval åk 7 is a block: its own dialog opens, where lock, park and remove apply to the whole block."],
    ] as const) {
      const { unmount } = await board(locale, { lessons: [block], onLessonCommand });
      for (const [pressed, command] of [["l", "lock"], ["p", "park"], ["Delete", "remove"]] as const) {
        key("blk", { key: pressed });
        expect(said()).toBe(opens);
        expect(onLessonCommand).toHaveBeenLastCalledWith("blk", command);
      }
      key("blk", { key: " " });
      expect(said()).toMatch(locale === "sv" ? /^Tog upp Språkval åk 7, Måndag 09:00–10:00\./ : /^Picked up Språkval åk 7, Monday 09:00–10:00\./);
      unmount();
    }
  });
});
