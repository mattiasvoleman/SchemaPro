import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import { TIMES } from "@/lib/possible-times.fixture";
import { possibleStore } from "@/lib/possible-store";
import { HOLD_BEFORE_ASKING_MS, PossibleDay, PossibleHold } from "./possible-layer";
import sv from "@/messages/sv.json";
import en from "@/messages/en.json";

const post = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api", () => ({ api: { post } }));

const SCALE = { startMinutes: 420, pxPerMinute: 1 };
const day = (n: number, locale: "sv" | "en" = "sv") =>
  render(
    <NextIntlClientProvider locale={locale} messages={(locale === "sv" ? sv : en) as never}>
      <div style={{ position: "relative" }}>
        <PossibleDay day={n} scale={SCALE} />
      </div>
    </NextIntlClientProvider>,
  );

beforeEach(() => {
  post.mockReset();
  possibleStore.set(null);
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("the painted day", () => {
  it("paints nothing until the gateway has answered, and nothing for a lesson that has no answer", () => {
    const { container } = day(1);
    expect(container.querySelector("[data-possible-day]")).toBeNull();
    act(() => possibleStore.set({ lessonId: "a", status: "loading" }));
    expect(container.querySelector("[data-possible-day]")).toBeNull();
    act(() => possibleStore.set({ lessonId: "a", status: "failed" }));
    expect(container.querySelector("[data-possible-day]")).toBeNull();
  });

  it("paints each stretch where its starts are, in words, with the rule a closed one is shut by", () => {
    const { container } = day(1);
    act(() => possibleStore.set({ lessonId: "a", status: "done", times: TIMES }));
    const runs = [...container.querySelectorAll<HTMLElement>("[data-possible-run]")];
    // The lesson's own square, and the crowded stretch, are not painted: the first is where it stands, the second is for the line to say.
    expect(runs.map((run) => run.dataset.possibleRun)).toEqual(["CLOSED", "FREE", "IN_THE_WAY", "CLOSED"]);
    expect(runs.map((run) => run.textContent)).toEqual(["Ramtid", "Ledigt", "Svenska 7B i vägen", "Lunch"]);
    // 07:00 is the top; a run starting 08:00 stands 60 px down and is the length of its starts and one step (45 minutes and a step of 15).
    expect(runs[1]!.style.top).toBe("60px");
    expect(runs[1]!.style.height).toBe("60px");
    expect(runs[0]!.style.top).toBe("0px");
  });

  it("numbers the best times where they start, on their own day", () => {
    const { container } = day(2);
    act(() => possibleStore.set({ lessonId: "a", status: "done", times: TIMES }));
    expect([...container.querySelectorAll<HTMLElement>("[data-possible-rank]")].map((badge) => [badge.dataset.possibleRank, badge.style.top])).toEqual([
      ["1", "60px"],
      ["2", "90px"],
    ]);
    expect(container.querySelector('[data-possible-run="CLOSED"]')!.textContent).toBe("Annan skola");
  });

  it("says a time in another room as that, and is a picture only: hidden from a screen reader and inert to a pointer", () => {
    const { container } = day(3);
    act(() => possibleStore.set({ lessonId: "a", status: "done", times: TIMES }));
    expect(container.querySelector('[data-possible-run="CHANGE"]')!.textContent).toBe("Ledigt, annan sal");
    const layer = container.querySelector("[data-possible-day]")!;
    expect(layer.getAttribute("aria-hidden")).toBe("true");
    expect(layer.className).toContain("pointer-events-none");
  });

  it("says every word in English too, and none of them as a key", () => {
    const { container } = day(1, "en");
    act(() => possibleStore.set({ lessonId: "a", status: "done", times: TIMES }));
    expect([...container.querySelectorAll("[data-possible-run]")].map((run) => run.textContent)).toEqual(["School hours", "Free", "Svenska 7B in the way", "Lunch"]);
  });

  it("paints a day it has no runs for as nothing", () => {
    const { container } = day(5);
    act(() => possibleStore.set({ lessonId: "a", status: "done", times: TIMES }));
    expect(container.querySelectorAll("[data-possible-run]")).toHaveLength(0);
  });
});

describe("holding a lesson", () => {
  it("asks the gateway after a moment and keeps the answer in the store while it is held", async () => {
    vi.useFakeTimers();
    post.mockResolvedValue(TIMES);
    render(<PossibleHold lessonId="a" />);
    expect(post).not.toHaveBeenCalled();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(HOLD_BEFORE_ASKING_MS);
    });
    expect(post).toHaveBeenCalledTimes(1);
    expect(post.mock.calls[0]![1]).toMatchObject({ lessonId: "a" });
    expect(possibleStore.get()).toMatchObject({ lessonId: "a", status: "done" });
  });

  it("asks nothing of a click: pressed and let go within the moment", async () => {
    vi.useFakeTimers();
    const { unmount } = render(<PossibleHold lessonId="a" />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(HOLD_BEFORE_ASKING_MS - 10);
    });
    unmount();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(HOLD_BEFORE_ASKING_MS * 2);
    });
    expect(post).not.toHaveBeenCalled();
    expect(possibleStore.get()).toBeNull();
  });

  it("empties the store when the lesson is let go, and drops an answer that comes after it", async () => {
    vi.useFakeTimers();
    let answer!: (times: typeof TIMES) => void;
    post.mockReturnValue(new Promise((resolve) => (answer = resolve as typeof answer)));
    const { unmount } = render(<PossibleHold lessonId="a" />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(HOLD_BEFORE_ASKING_MS);
    });
    expect(possibleStore.get()).toMatchObject({ lessonId: "a", status: "loading" });
    unmount();
    expect(possibleStore.get()).toBeNull();
    answer(TIMES);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10);
    });
    expect(possibleStore.get()).toBeNull();
  });

  it("says it has no answer when the gateway does not, and the store is the lesson's only while it is held", async () => {
    vi.useFakeTimers();
    post.mockRejectedValue(new Error("down"));
    const first = render(<PossibleHold lessonId="a" />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(HOLD_BEFORE_ASKING_MS);
    });
    expect(possibleStore.get()).toEqual({ lessonId: "a", status: "failed" });
    first.unmount();
    // Another lesson taken up before the first one's cleanup would have emptied the store: its own entry is not removed.
    possibleStore.set({ lessonId: "b", status: "loading" });
    first.unmount();
    expect(possibleStore.get()).toEqual({ lessonId: "b", status: "loading" });
  });
});

describe("what the route's first load may not take", () => {
  // The grid is on /admin/timetable's first load, and the painting is for a lesson in hand: its module (and the gateway client and the
  // store it brings) is fetched when the first lesson is taken up, and nothing in the first load names it but a dynamic import.
  const source = (file: string) => readFileSync(join(process.cwd(), "components/schedule", file), "utf8");

  it("is imported by the grid dynamically and never statically", () => {
    const grid = source("timetable-grid.tsx");
    expect(grid).toMatch(/import\(\s*"\.\/possible-layer"\s*\)/);
    expect(grid).not.toMatch(/from\s+["']\.\/possible-layer["']/);
    expect(grid).not.toMatch(/from\s+["']@\/lib\/possible-(store|times)["']/);
  });

  it("brings the keyboard layer nothing heavier than the two small modules both of them read", () => {
    const keys = source("board-keys.tsx");
    expect(keys).not.toMatch(/from\s+["']\.\/possible-layer["']/);
    expect(keys).toMatch(/from\s+["']@\/lib\/possible-store["']/);
  });
});
