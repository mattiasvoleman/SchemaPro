import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, waitFor } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import { TIMES } from "@/lib/possible-times.fixture";
import { possibleStore } from "@/lib/possible-store";
import { HOLD_BEFORE_ASKING_MS } from "./possible-layer";
import { TimetableGrid, type TimetableLesson } from "./timetable-grid";
import sv from "@/messages/sv.json";
import en from "@/messages/en.json";

/*
 * E3, "Se" and "Lägg" on the board: a lesson taken up is asked about, the gateway's answer is painted behind the lessons and said by the
 * line below the week when the marker moves, and 1 to 9 take the marker to the best times. With the real catalogue, and the gateway
 * mocked where the page's api client is (so that what is asked is what the board really asks).
 */

const post = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api", () => ({ api: { post } }));

const lesson = (overrides: Partial<TimetableLesson> & { id: string }): TimetableLesson => ({
  dayOfWeek: 1,
  startMinutes: 540,
  endMinutes: 600,
  title: "Matematik",
  subtitle: "7A",
  color: "#6366f1",
  ...overrides,
});
const WEEK = [lesson({ id: "a" }), lesson({ id: "b", dayOfWeek: 1, startMinutes: 570, endMinutes: 630, title: "Svenska", subtitle: "7B" })];

const card = (id: string) => document.querySelector<HTMLElement>(`[data-lesson-id="${id}"]`)!;
const key = (id: string, init: KeyboardEventInit) => fireEvent.keyDown(card(id), init);
const said = () => document.querySelector("[data-board-status]")!.textContent!;

async function board(locale: "sv" | "en" = "sv", extra: Partial<React.ComponentProps<typeof TimetableGrid>> = {}) {
  const view = render(
    <NextIntlClientProvider locale={locale} messages={(locale === "sv" ? sv : en) as never}>
      <TimetableGrid lessons={WEEK} editable board validateChange={vi.fn().mockReturnValue(true)} onLessonChange={vi.fn()} onLessonCommand={vi.fn()} {...extra} />
    </NextIntlClientProvider>,
  );
  await waitFor(() => expect(document.querySelector("[data-board-status]")).not.toBeNull());
  await act(async () => {});
  return view;
}

/** Takes the lesson up and waits for the gateway's answer to be painted. */
async function takeUp(id = "a") {
  key(id, { key: " " });
  await waitFor(() => expect(document.querySelector("[data-possible-day]")).not.toBeNull(), { timeout: HOLD_BEFORE_ASKING_MS * 20 });
}

beforeEach(() => {
  post.mockReset();
  post.mockResolvedValue(TIMES);
  possibleStore.set(null);
});
afterEach(() => vi.restoreAllMocks());

describe("a lesson taken up is asked about, and the answer is painted", () => {
  it("asks the gateway where the lesson can stand once it is in hand, and paints it behind the lessons", async () => {
    await board();
    expect(document.querySelector("[data-possible-day]")).toBeNull();
    await takeUp();
    expect(post).toHaveBeenCalledTimes(1);
    expect(post.mock.calls[0]![0]).toBe("/api/v1/master-lessons/possible-times");
    expect(post.mock.calls[0]![1]).toMatchObject({ lessonId: "a" });
    expect([...document.querySelectorAll("[data-possible-run]")].map((run) => run.getAttribute("data-possible-run"))).toContain("FREE");
    expect(document.querySelector('[data-possible-rank="1"]')).not.toBeNull();
  });

  it("takes the painting away when the lesson is let go, and asks nothing before a lesson is taken", async () => {
    await board();
    expect(post).not.toHaveBeenCalled();
    await takeUp();
    key("a", { key: "Escape" });
    await waitFor(() => expect(document.querySelector("[data-possible-day]")).toBeNull());
    expect(possibleStore.get()).toBeNull();
  });

  it("does not paint on a grid that is not the board, nor on a read-only one", async () => {
    for (const props of [{ board: false, editable: true }, { board: true, editable: false }]) {
      const view = render(
        <NextIntlClientProvider locale="sv" messages={sv as never}>
          <TimetableGrid lessons={WEEK} onLessonChange={vi.fn()} validateChange={vi.fn().mockReturnValue(true)} {...props} />
        </NextIntlClientProvider>,
      );
      key("a", { key: " " });
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, HOLD_BEFORE_ASKING_MS * 2));
      });
      expect(post).not.toHaveBeenCalled();
      expect(document.querySelector("[data-possible-day]")).toBeNull();
      view.unmount();
    }
  });
});

describe("the line says what the gateway says of the marker's square", () => {
  it("says the rule that shuts a square, in words", async () => {
    await board();
    await takeUp();
    // 09:00 down to 11:15 is nine quarters: the class's lunch, which the gateway says shuts every start from there to noon.
    for (let i = 0; i < 9; i++) key("a", { key: "ArrowDown" });
    expect(said()).toBe("Måndag 11:15–12:15: stängt av klassens lunch. Enter visar de närmaste lediga tiderna.");
  });

  it("names the lesson in the way", async () => {
    await board();
    await takeUp();
    key("a", { key: "ArrowDown" }); // 09:15: the run of starts 09:15 to 10:00 is held by Svenska 7B
    expect(said()).toBe("Måndag 09:15–10:15: Svenska 7B ligger i vägen. Enter visar de närmaste lediga tiderna.");
  });

  it("says how many are in the way when several are", async () => {
    await board();
    await takeUp();
    for (let i = 0; i < 5; i++) key("a", { key: "ArrowDown" }); // 10:15, in the crowded stretch
    expect(said()).toBe("Måndag 10:15–11:15: 2 lektioner ligger i vägen. Enter visar de närmaste lediga tiderna.");
  });

  it("says a numbered time as a suggestion, and any other free square as the page does", async () => {
    await board();
    await takeUp();
    for (let i = 0; i < 4; i++) key("a", { key: "ArrowUp" }); // 08:00: free, but a rank only on Tuesday
    expect(said()).toBe("Måndag 08:00–09:00: går att lägga. Enter lägger.");
  });

  it("says what the page says until the gateway has answered", async () => {
    post.mockReturnValue(new Promise(() => undefined));
    await board();
    key("a", { key: " " });
    key("a", { key: "ArrowDown" });
    expect(said()).toBe("Måndag 09:15–10:15: går att lägga. Enter lägger.");
  });
});

describe("1 to 9: the marker goes to the best times", () => {
  it("goes to the time of that number, says it, and Enter lays the lesson there", async () => {
    const onLessonChange = vi.fn();
    await board("sv", { onLessonChange });
    await takeUp();
    key("a", { key: "2" });
    expect(said()).toBe("Tisdag 08:30–09:30: förslag 2. Enter lägger.");
    key("a", { key: "1" });
    expect(said()).toBe("Tisdag 08:00–09:00: förslag 1. Enter lägger.");
    key("a", { key: "Enter" });
    expect(onLessonChange).toHaveBeenCalledWith("a", { dayOfWeek: 2, startMinutes: 480, endMinutes: 540 });
  });

  it("keeps the lesson's own length, and goes to a time in another room as well", async () => {
    await board();
    await takeUp();
    key("a", { key: "3" });
    expect(said()).toBe("Onsdag 10:00–11:00: förslag 3. Enter lägger.");
  });

  it("takes the room with a time the gateway offered in another room, and does not ask the page's own check about it", async () => {
    const onLessonChange = vi.fn();
    // The page's check knows only the lesson's own room, and would refuse every square: the numbered time is the gateway's judgement.
    const validateChange = vi.fn().mockReturnValue(false);
    await board("sv", { onLessonChange, validateChange });
    await takeUp();
    key("a", { key: "3" });
    expect(said()).toBe("Onsdag 10:00–11:00: förslag 3. Enter lägger.");
    validateChange.mockClear();
    key("a", { key: "Enter" });
    expect(validateChange).not.toHaveBeenCalled();
    expect(onLessonChange).toHaveBeenCalledWith("a", { dayOfWeek: 3, startMinutes: 600, endMinutes: 660, roomId: "r2" });
  });

  it("keeps the lesson's own room for a time in its own, and for a square that was reached by the arrows", async () => {
    const onLessonChange = vi.fn();
    await board("sv", { onLessonChange });
    await takeUp();
    key("a", { key: "1" });
    key("a", { key: "Enter" });
    expect(onLessonChange).toHaveBeenLastCalledWith("a", { dayOfWeek: 2, startMinutes: 480, endMinutes: 540, roomId: undefined });
    // 3 (another room), then an arrow: the room is not the arrow's.
    await takeUp();
    key("a", { key: "3" });
    key("a", { key: "ArrowDown" });
    key("a", { key: "Enter" });
    expect(onLessonChange).toHaveBeenLastCalledWith("a", { dayOfWeek: 3, startMinutes: 615, endMinutes: 675 });
  });

  it("says there is no such suggestion, and leaves the marker where it is", async () => {
    const onLessonChange = vi.fn();
    await board("sv", { onLessonChange });
    await takeUp();
    key("a", { key: "9" });
    expect(said()).toBe("Det finns inget förslag 9.");
    key("a", { key: "Enter" });
    // The lesson is put down where it stands, which is no move.
    expect(onLessonChange).not.toHaveBeenCalled();
  });

  it("means nothing before the gateway has answered, and nothing with no lesson in hand", async () => {
    post.mockReturnValue(new Promise(() => undefined));
    await board();
    key("a", { key: "1" });
    expect(said()).toBe("");
    key("a", { key: " " });
    key("a", { key: "1" });
    expect(said()).toBe("Det finns inget förslag 1.");
  });

  it("is said in English too", async () => {
    await board("en");
    await takeUp();
    for (let i = 0; i < 9; i++) key("a", { key: "ArrowDown" });
    expect(said()).toBe("Monday 11:15–12:15: closed by the class's lunch. Enter shows the nearest free times.");
    key("a", { key: "1" });
    expect(said()).toBe("Tuesday 08:00–09:00: suggestion 1. Enter places it.");
  });
});
