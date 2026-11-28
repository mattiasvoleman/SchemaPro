import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, waitFor } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import { TIMES } from "@/lib/possible-times.fixture";
import { startsTheGatewayLets } from "@/lib/possible-times";
import { possibleStore } from "@/lib/possible-store";
import { HOLD_BEFORE_ASKING_MS } from "./possible-layer";
import { TimetableGrid, type TimetableLesson } from "./timetable-grid";
import sv from "@/messages/sv.json";

/*
 * E3, the dialog of other times after a refused mouse drop (granskaren g512, #512): the board has asked the gateway about the lesson while it was
 * held, and the page's dialog (page.tsx handleInvalidDrop) reads that answer a microtask after the drop, when React has unmounted the layer that
 * held it. It must still find it: asked for again, every refused drop waits for a second question to the gateway before the dialog opens.
 * With the real layers and the gateway mocked where the page's api client is.
 */

const post = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api", () => ({ api: { post } }));

const lesson: TimetableLesson = { id: "a", dayOfWeek: 1, startMinutes: 540, endMinutes: 600, title: "Matematik", subtitle: "7A", color: "#6366f1" };

/** jsdom has no layout: the grid is pinned as timetable-grid.room.test.tsx pins it (a 56 px axis and five columns of 100 px, 1.1 px a minute). */
const RECT = { x: 0, y: 0, top: 0, left: 0, right: 556, bottom: 528, width: 556, height: 528, toJSON: () => ({}) } as DOMRect;
const xOf = (day: number) => 56 + (day - 1) * 100 + 50;
const yOf = (minute: number) => (minute - 480) * 1.1;

beforeEach(() => {
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockReturnValue(RECT);
  post.mockReset();
  post.mockResolvedValue(TIMES);
  possibleStore.set(null);
});
afterEach(() => vi.restoreAllMocks());

describe("a mouse drop the page refuses, after the board has asked the gateway about the lesson", () => {
  it("is answered from what the board held, as the page reads it a microtask later, and asks the gateway nothing more", async () => {
    let lets: ((dayOfWeek: number, startMinutes: number) => boolean) | undefined;
    // What page.tsx does: loadLessonDialogs().then(({ startsTheGatewayLets }) => startsTheGatewayLets(id)).
    const onInvalidDrop = vi.fn((id: string) => {
      void Promise.resolve().then(async () => {
        lets = await startsTheGatewayLets(id);
      });
    });
    render(
      <NextIntlClientProvider locale="sv" messages={sv as never}>
        <TimetableGrid lessons={[lesson]} editable board validateChange={() => false} onLessonChange={vi.fn()} onInvalidDrop={onInvalidDrop} onLessonCommand={vi.fn()} />
      </NextIntlClientProvider>,
    );
    await waitFor(() => expect(document.querySelector("[data-board-status]")).not.toBeNull());
    await act(async () => {});

    fireEvent.pointerDown(document.querySelector('[data-lesson-id="a"]')!, { pointerId: 1, button: 0, clientX: xOf(1), clientY: yOf(580) });
    fireEvent.pointerMove(window, { pointerId: 1, clientX: xOf(1) + 20, clientY: yOf(580) + 20 });
    await waitFor(() => expect(possibleStore.get()?.status).toBe("done"), { timeout: HOLD_BEFORE_ASKING_MS * 20 });
    expect(post).toHaveBeenCalledTimes(1);
    // Tuesday 09:45 starts in the stretch another school has borrowed (OTHER_SCHOOL): the page refuses it, and the dialog is asked.
    fireEvent.pointerMove(window, { pointerId: 1, clientX: xOf(2), clientY: yOf(585 + 40) });
    fireEvent.pointerUp(window, { pointerId: 1, clientX: xOf(2), clientY: yOf(585 + 40) });
    expect(onInvalidDrop).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(lets).toBeDefined());

    expect(post).toHaveBeenCalledTimes(1);
    expect(lets!(2, 585)).toBe(false);
    expect(lets!(2, 480)).toBe(true);
  });
});
