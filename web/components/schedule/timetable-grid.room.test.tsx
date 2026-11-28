import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import { TIMES } from "@/lib/possible-times.fixture";
import { possibleStore } from "@/lib/possible-store";
import { HOLD_BEFORE_ASKING_MS } from "./possible-layer";
import { TimetableGrid, type TimetableLesson } from "./timetable-grid";
import sv from "@/messages/sv.json";

/*
 * E3, the mouse and "Ledigt, annan sal" (granskaren g503, #507 M-1): a lesson dragged onto a stretch the board paints free in another room is
 * laid there, in the room the gateway judged, as Enter lays it (board-keys.possible.test.tsx). The page's own check (validateChange) knows
 * only the lesson's own room, taken at such a time, and says no to every square of the stretch: it is the layer's answer that makes the ghost
 * valid and carries the room to the drop. With the real layers and the gateway mocked where the page's api client is.
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

/**
 * jsdom has no layout: the grid is pinned as timetable-grid.test.tsx pins it: a 56 px axis and five columns of 100 px, 08:00 to 16:00 at
 * 1.1 px a minute. Day n starts at x = 56 + (n - 1) * 100 and a minute m is at y = (m - 480) * 1.1.
 */
const RECT = { x: 0, y: 0, top: 0, left: 0, right: 556, bottom: 528, width: 556, height: 528, toJSON: () => ({}) } as DOMRect;
const xOf = (day: number) => 56 + (day - 1) * 100 + 50;
const yOf = (minute: number) => (minute - 480) * 1.1;

const down = (element: Element, init: PointerEventInit) => fireEvent.pointerDown(element, { pointerId: 1, button: 0, ...init });
const move = (init: PointerEventInit) => fireEvent.pointerMove(window, { pointerId: 1, ...init });
const up = (init: PointerEventInit) => fireEvent.pointerUp(window, { pointerId: 1, ...init });

const ghostOf = () => document.querySelector<HTMLElement>('[class*="border-dashed"][class*="border-2"]');

async function board(validateChange = vi.fn().mockReturnValue(false)) {
  const onLessonChange = vi.fn();
  const onInvalidDrop = vi.fn();
  render(
    <NextIntlClientProvider locale="sv" messages={sv as never}>
      <TimetableGrid lessons={[lesson({ id: "a" })]} editable board validateChange={validateChange} onLessonChange={onLessonChange} onInvalidDrop={onInvalidDrop} onLessonCommand={vi.fn()} />
    </NextIntlClientProvider>,
  );
  await waitFor(() => expect(document.querySelector("[data-board-status]")).not.toBeNull());
  await act(async () => {});
  return { onLessonChange, onInvalidDrop, validateChange };
}

/** Takes the lesson up with the pointer (a grab 40 minutes into it) and moves a little, so that the drag has begun. */
function grab() {
  down(document.querySelector('[data-lesson-id="a"]')!, { clientX: xOf(1), clientY: yOf(580) });
  move({ clientX: xOf(1) + 20, clientY: yOf(580) + 20 });
}
/** Over the square where the lesson would START at `start`, on `day`: the grab is 40 minutes into it. */
const over = (day: number, start: number) => move({ clientX: xOf(day), clientY: yOf(start + 40) });
const answered = () => waitFor(() => expect(possibleStore.get()?.status).toBe("done"), { timeout: HOLD_BEFORE_ASKING_MS * 20 });

beforeEach(() => {
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockReturnValue(RECT);
  post.mockReset();
  post.mockResolvedValue(TIMES);
  possibleStore.set(null);
});
afterEach(() => vi.restoreAllMocks());

describe("a lesson dragged with the mouse onto a stretch that is free in another room", () => {
  it("is laid there with the room, after the answer has come and the pointer moves onto the square", async () => {
    const { onLessonChange, onInvalidDrop } = await board();
    grab();
    await answered();
    // Wednesday 10:30 is inside the stretch of another room (10:00 to 11:00 starts), whose room the answer names.
    over(3, 630);
    expect(ghostOf()).toHaveClass("border-success");
    up({ clientX: xOf(3), clientY: yOf(670) });
    expect(onLessonChange).toHaveBeenCalledTimes(1);
    expect(onLessonChange).toHaveBeenCalledWith("a", { dayOfWeek: 3, startMinutes: 630, endMinutes: 690, roomId: "r2" });
    expect(onInvalidDrop).not.toHaveBeenCalled();
  });

  it("is laid there when the answer comes after the pointer has stopped on the square: the ghost turns valid with it", async () => {
    const { onLessonChange, onInvalidDrop } = await board();
    grab();
    over(3, 630);
    // The gateway has not answered: the page's own check says no, and the ghost is red.
    expect(ghostOf()).toHaveClass("border-destructive");
    await answered();
    expect(ghostOf()).toHaveClass("border-success");
    up({ clientX: xOf(3), clientY: yOf(670) });
    expect(onLessonChange).toHaveBeenCalledWith("a", { dayOfWeek: 3, startMinutes: 630, endMinutes: 690, roomId: "r2" });
    expect(onInvalidDrop).not.toHaveBeenCalled();
  });

  it("is refused as before on a square the answer paints as anything else: a lesson in the way, and a stretch a rule shuts", async () => {
    const { onLessonChange, onInvalidDrop } = await board();
    grab();
    await answered();
    // Monday 09:15 to 10:00 is IN_THE_WAY (Svenska 7B) and Tuesday 09:45 starts in the stretch Norra skolan has borrowed.
    over(1, 555);
    expect(ghostOf()).toHaveClass("border-destructive");
    over(2, 585);
    expect(ghostOf()).toHaveClass("border-destructive");
    up({ clientX: xOf(2), clientY: yOf(625) });
    expect(onLessonChange).not.toHaveBeenCalled();
    expect(onInvalidDrop).toHaveBeenCalledTimes(1);
  });

  it("is laid there when the page's own check says yes too: the lesson's own room is lent to another school, which the page holds no loan of", async () => {
    // The page says yes to every square (validateChange true): it does not know the hour the lesson's room is lent out, which is the very
    // reason the gateway paints the stretch "Ledigt, annan sal". The drop must carry the room, or the save answers OTHER_SCHOOL.
    const { onLessonChange, onInvalidDrop } = await board(vi.fn().mockReturnValue(true));
    grab();
    await answered();
    over(3, 630);
    expect(ghostOf()).toHaveClass("border-success");
    up({ clientX: xOf(3), clientY: yOf(670) });
    expect(onLessonChange).toHaveBeenCalledTimes(1);
    expect(onLessonChange).toHaveBeenCalledWith("a", { dayOfWeek: 3, startMinutes: 630, endMinutes: 690, roomId: "r2" });
    expect(onInvalidDrop).not.toHaveBeenCalled();
  });

  it("goes on being asked of the page where the board paints nothing of another room: the move of a lesson in its own room carries no room", async () => {
    const { onLessonChange } = await board(vi.fn().mockReturnValue(true));
    grab();
    await answered();
    // Tuesday 08:00 is free in the lesson's own room: the page says yes, and the move is what it always was.
    over(2, 480);
    up({ clientX: xOf(2), clientY: yOf(520) });
    expect(onLessonChange).toHaveBeenCalledWith("a", { dayOfWeek: 2, startMinutes: 480, endMinutes: 540 });
    expect(screen.queryByRole("alert")).toBeNull();
  });
});
