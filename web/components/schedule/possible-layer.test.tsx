import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import { TIMES } from "@/lib/possible-times.fixture";
import { boardCommands, possibleStore } from "@/lib/possible-store";
import { costWords } from "@/lib/possible-times";
import { HOLD_BEFORE_ASKING_MS, PossibleDay, PossibleHold, PossibleList } from "./possible-layer";
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
  boardCommands.current = null;
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

/** The grid's ghost, as the layer sees it: a value outside React that tells when it changed. */
function ghostCell(initial: { dayOfWeek: number; startMinutes: number; endMinutes: number; valid: boolean; roomId?: string | null } | null) {
  type Ghost = NonNullable<typeof initial>;
  let value = initial;
  const listeners = new Set<() => void>();
  return {
    get: () => value,
    set: (next: Ghost | null) => {
      if (Object.is(next, value)) return;
      value = next;
      for (const listener of [...listeners]) listener();
    },
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

describe("the ghost over a square the board paints free in another room", () => {
  // The fixture's lesson "a" is an hour long; Wednesday 10:00 to 11:00 starts are free in room r2 only.
  const red = (dayOfWeek: number, startMinutes: number, minutes = 60) => ({ dayOfWeek, startMinutes, endMinutes: startMinutes + minutes, valid: false });

  it("is made valid, with the room, once the answer is there", () => {
    const ghost = ghostCell(red(3, 630));
    act(() => possibleStore.set({ lessonId: "a", status: "done", times: TIMES }));
    render(<PossibleHold lessonId="a" ghost={ghost} />);
    expect(ghost.get()).toEqual({ ...red(3, 630), valid: true, roomId: "r2" });
  });

  it("is made valid when the answer comes after the ghost was put over the square, and when the ghost is put over it after the answer", async () => {
    vi.useFakeTimers();
    post.mockResolvedValue(TIMES);
    const ghost = ghostCell(red(3, 630));
    render(<PossibleHold lessonId="a" ghost={ghost} />);
    expect(ghost.get()!.valid).toBe(false);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(HOLD_BEFORE_ASKING_MS);
    });
    expect(ghost.get()).toMatchObject({ valid: true, roomId: "r2" });
    // A pointer that moves on gives the ghost a verdict of its own, and a red one over another square of the stretch is made valid too.
    act(() => ghost.set(red(3, 600)));
    expect(ghost.get()).toMatchObject({ startMinutes: 600, valid: true, roomId: "r2" });
  });

  it("is left red over every other square: a lesson in the way, a stretch a rule shuts, a square that has no answer, and a time the lesson cannot be", () => {
    for (const [name, square] of [
      ["in the way", red(1, 555)],
      ["shut by a rule", red(2, 585)],
      ["no answer", red(5, 480)],
      // A lesson made longer or shorter than it is: the gateway judged the starts of the lesson's own length.
      ["another length", red(3, 630, 90)],
    ] as const) {
      // The layer empties the store when it goes (the lesson is let go), so the answer is put in it for each of them.
      act(() => possibleStore.set({ lessonId: "a", status: "done", times: TIMES }));
      const ghost = ghostCell(square);
      render(<PossibleHold lessonId="a" ghost={ghost} />);
      expect(ghost.get(), name).toEqual(square);
      cleanup();
    }
  });

  it("leaves a ghost that is valid as it is, and one over the answer of another lesson", () => {
    act(() => possibleStore.set({ lessonId: "a", status: "done", times: TIMES }));
    const valid = ghostCell({ ...red(3, 630), valid: true });
    render(<PossibleHold lessonId="a" ghost={valid} />);
    expect(valid.get()).toEqual({ ...red(3, 630), valid: true });
    cleanup();
    // The answer in the store is for "a": the lesson in hand is another, and has none yet.
    act(() => possibleStore.set({ lessonId: "a", status: "done", times: TIMES }));
    const other = ghostCell(red(3, 630));
    render(<PossibleHold lessonId="z" ghost={other} />);
    expect(other.get()).toEqual(red(3, 630));
  });

  it("stops following the ghost and the answer when the lesson is let go", () => {
    const ghost = ghostCell(null);
    const view = render(<PossibleHold lessonId="a" ghost={ghost} />);
    view.unmount();
    act(() => possibleStore.set({ lessonId: "a", status: "done", times: TIMES }));
    act(() => ghost.set(red(3, 630)));
    expect(ghost.get()).toEqual(red(3, 630));
  });
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

  it("clips what it paints to its column: the gateway answers from 07:00 and the board's day starts later, and a run above or below it must not paint over the heading or make the grid scroll", () => {
    const { container } = render(
      <NextIntlClientProvider locale="sv" messages={sv as never}>
        <div style={{ position: "relative" }}>
          <PossibleDay day={1} scale={{ startMinutes: 480, pxPerMinute: 1 }} />
        </div>
      </NextIntlClientProvider>,
    );
    act(() => possibleStore.set({ lessonId: "a", status: "done", times: TIMES }));
    // The first stretch starts at 07:00, an hour above a column that starts at 08:00: it is outside the box unless the layer cuts it off.
    expect(container.querySelector<HTMLElement>("[data-possible-run]")!.style.top).toBe("-60px");
    expect(container.querySelector("[data-possible-day]")!.className).toContain("overflow-hidden");
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

  it("takes an answer that is not the gateway's shape for no answer, and paints nothing from it", async () => {
    vi.useFakeTimers();
    for (const odd of [undefined, null, {}, { days: [] }, "<html>"]) {
      post.mockResolvedValue(odd);
      const view = render(<PossibleHold lessonId="a" />);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(HOLD_BEFORE_ASKING_MS);
      });
      expect(possibleStore.get(), String(odd)).toEqual({ lessonId: "a", status: "failed" });
      view.unmount();
    }
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

describe("the list of possible times", () => {
  const list = (locale: "sv" | "en" = "sv") =>
    render(
      <NextIntlClientProvider locale={locale} messages={(locale === "sv" ? sv : en) as never}>
        <PossibleList />
      </NextIntlClientProvider>,
    );
  const commands = () => {
    const calls = { lay: vi.fn(), goTo: vi.fn(), layAtMarker: vi.fn() };
    boardCommands.current = calls;
    return calls;
  };

  it("is nothing before a lesson is in hand, and says it is looking, and that it could not look", () => {
    const { container } = list();
    expect(container.querySelector("[data-possible-list]")).toBeNull();
    act(() => possibleStore.set({ lessonId: "a", status: "loading" }));
    expect(screen.getByRole("region", { name: "Möjliga tider för" })).toBeTruthy();
    expect(screen.getByText("Letar efter tider …")).toBeTruthy();
    expect(container.querySelector("[data-possible-list]")!.getAttribute("aria-busy")).toBe("true");
    act(() => possibleStore.set({ lessonId: "a", status: "failed" }));
    expect(screen.getByText(/Det gick inte att hämta de möjliga tiderna/)).toBeTruthy();
  });

  it("lists the best times in their order, each as a sentence with what it does to the week and a button that lays it", () => {
    list();
    act(() => possibleStore.set({ lessonId: "a", status: "done", times: TIMES }));
    const region = screen.getByRole("region", { name: "Möjliga tider för Matematik 7A" });
    const items = within(region).getAllByRole("listitem");
    expect(items.map((item) => item.textContent)).toEqual([
      "1. Tisdag 08:00–09:00ingen skillnad för veckan i övrigtLägg",
      "2. Tisdag 08:30–09:30ingen skillnad för veckan i övrigtLägg",
      "3. Onsdag 10:00–11:00i en annan salLägg",
    ]);
    const commandsAsked = commands();
    fireEvent.click(within(region).getByRole("button", { name: "Lägg Matematik 7A Onsdag 10:00–11:00" }));
    expect(commandsAsked.lay).toHaveBeenCalledWith(3);
  });

  it("says in words what a time does: fewer gaps, a better spread, a wish met, another room", () => {
    const base = TIMES.options[0]!;
    const cost = (code: string, delta: number) => ({ code, unit: "MINUTES", before: 0, after: delta, delta });
    expect(costWords({ ...base, costs: [cost("PUPIL_GAPS", -50), cost("TEACHER_GAPS", 15), cost("DISTRIBUTION", -1), cost("TEACHER_DAY", 1), cost("MOVED_LESSONS", 1)], wishes: { met: 1, avoided: 0 }, roomChanged: true })).toEqual([
      "pupilsBetter",
      "teacherMore",
      "distributionBetter",
      "dayWorse",
      "wishMet",
      "roomChanged",
    ]);
    expect(costWords({ ...base, costs: [cost("PUPIL_GAPS", 20), cost("TEACHER_GAPS", -5), cost("DISTRIBUTION", 2), cost("TEACHER_DAY", -1)], wishes: { met: 0, avoided: 2 } })).toEqual([
      "pupilsWorse",
      "teacherLess",
      "distributionWorse",
      "dayBetter",
      "wishBroken",
    ]);
    // Nothing moves, nothing is said (the one lesson moved is no news).
    expect(costWords({ ...base, costs: [cost("MOVED_LESSONS", 1)] })).toEqual([]);
  });

  it("says there is no time when there is none, and says every word in English too", () => {
    list("en");
    act(() => possibleStore.set({ lessonId: "a", status: "done", times: { ...TIMES, options: [] } }));
    expect(screen.getByText("There is no time in the week to put Matematik 7A at.")).toBeTruthy();
    act(() => possibleStore.set({ lessonId: "a", status: "done", times: TIMES }));
    expect(screen.getByRole("button", { name: "Place Matematik 7A Tuesday 08:00–09:00" })).toBeTruthy();
    expect(screen.getByText("in another room")).toBeTruthy();
  });

  it("moves the marker to a typed clock, only when it is a clock, and lays where the marker stands", () => {
    list();
    act(() => possibleStore.set({ lessonId: "a", status: "done", times: TIMES }));
    const asked = commands();
    const move = screen.getByRole("button", { name: "Flytta markören" });
    const field = screen.getByLabelText("Skriv en tid") as HTMLInputElement;
    expect((move as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(field, { target: { value: "09:35" } });
    expect((move as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(move);
    expect(asked.goTo).toHaveBeenCalledWith(9 * 60 + 35);
    fireEvent.click(screen.getByRole("button", { name: "Lägg där markören står" }));
    expect(asked.layAtMarker).toHaveBeenCalledTimes(1);
    fireEvent.change(field, { target: { value: "" } });
    expect((move as HTMLButtonElement).disabled).toBe(true);
  });

  it("does nothing, and says nothing, when the keyboard layer has not come to answer the buttons", () => {
    list();
    act(() => possibleStore.set({ lessonId: "a", status: "done", times: TIMES }));
    expect(() => fireEvent.click(screen.getByRole("button", { name: "Lägg Matematik 7A Tisdag 08:00–09:00" }))).not.toThrow();
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
