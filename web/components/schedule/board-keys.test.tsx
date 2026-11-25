import { afterEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { TimetableGrid, type TimetableLesson } from "./timetable-grid";
import svMessages from "@/messages/sv.json";
import enMessages from "@/messages/en.json";

vi.mock("next-intl", () => ({
  useLocale: () => "sv",
  // The key and its values, in the order the layer gives them: enough to say what was said.
  useTranslations: () => (key: string, values?: Record<string, unknown>) =>
    values ? `${key} ${Object.values(values).join(" ")}` : key,
}));

const lesson = (overrides: Partial<TimetableLesson> & { id: string }): TimetableLesson => ({
  dayOfWeek: 1,
  startMinutes: 540,
  endMinutes: 600,
  title: "Matematik",
  subtitle: "7A",
  color: "#6366f1",
  ...overrides,
});

// Monday 09:00 and 11:00, Tuesday 09:30.
const WEEK = [
  lesson({ id: "mon-9" }),
  lesson({ id: "mon-11", startMinutes: 660, endMinutes: 720, title: "Svenska" }),
  lesson({ id: "tue-930", dayOfWeek: 2, startMinutes: 570, endMinutes: 630, title: "Engelska", locked: true }),
];

const card = (id: string) => document.querySelector<HTMLElement>(`[data-lesson-id="${id}"]`)!;
const ghost = (container: HTMLElement) => container.querySelector('[class*="border-dashed"]');
const key = (id: string, init: KeyboardEventInit) => fireEvent.keyDown(card(id), init);
/** The line under the week that says what a key did: a live region, found by its own mark (the page has a role="status" of its own). */
const statusLine = () => document.querySelector<HTMLElement>("[data-board-status]");

/** The board with its keys: waits for the layer, which the grid fetches when it is editable. */
async function board(extra: Partial<React.ComponentProps<typeof TimetableGrid>> = {}, lessons = WEEK) {
  const spies = {
    onLessonChange: vi.fn(),
    validateChange: vi.fn().mockReturnValue(true),
    onInvalidDrop: vi.fn(),
    onLessonCommand: vi.fn(),
    onLessonClick: vi.fn(),
    onToggleSelect: vi.fn(),
  };
  const view = render(<TimetableGrid lessons={lessons} editable board {...spies} {...extra} />);
  await waitFor(() => expect(statusLine()).not.toBeNull());
  // The layer's listeners are put up by an effect that runs a moment after the line is drawn: let it run before a key is pressed.
  await act(async () => {});
  return { ...view, ...spies };
}

afterEach(() => vi.restoreAllMocks());

describe("the board's keys: focus", () => {
  it("has one card in the tab order, the first of the week, and the others reached with the arrows", async () => {
    await board();
    expect(card("mon-9")).toHaveAttribute("tabindex", "0");
    expect(card("mon-11")).toHaveAttribute("tabindex", "-1");
    expect(card("tue-930")).toHaveAttribute("tabindex", "-1");
  });

  it("moves focus with the arrows and moves nothing", async () => {
    const { onLessonChange, validateChange } = await board();
    card("mon-9").focus();
    key("mon-9", { key: "ArrowDown" });
    expect(card("mon-11")).toHaveFocus();
    key("mon-11", { key: "ArrowRight" });
    expect(card("tue-930")).toHaveFocus();
    key("tue-930", { key: "ArrowLeft" });
    expect(card("mon-9")).toHaveFocus();
    key("mon-9", { key: "End" });
    expect(card("mon-11")).toHaveFocus();
    key("mon-11", { key: "Home" });
    expect(card("mon-9")).toHaveFocus();
    expect(onLessonChange).not.toHaveBeenCalled();
    expect(validateChange).not.toHaveBeenCalled();
  });

  it("makes the card that has focus the one in the tab order, however it got focus", async () => {
    await board();
    card("tue-930").focus();
    await waitFor(() => expect(card("tue-930")).toHaveAttribute("tabindex", "0"));
    expect(card("mon-9")).toHaveAttribute("tabindex", "-1");
  });

  it("stays where it is at the edge of the week", async () => {
    await board();
    card("mon-9").focus();
    key("mon-9", { key: "ArrowUp" });
    key("mon-9", { key: "ArrowLeft" });
    expect(card("mon-9")).toHaveFocus();
  });

  it("leaves Tab and Enter to the page: Enter opens the lesson, Shift+Enter selects it", async () => {
    const { onLessonClick, onToggleSelect } = await board();
    key("mon-9", { key: "Enter" });
    expect(onLessonClick).toHaveBeenCalledWith(expect.objectContaining({ id: "mon-9" }));
    key("mon-9", { key: "Enter", shiftKey: true });
    key("mon-9", { key: " ", shiftKey: true });
    expect(onToggleSelect).toHaveBeenCalledTimes(2);
  });

  it("does not open the lesson on a plain Space, which takes it up", async () => {
    const { onLessonClick } = await board();
    key("mon-9", { key: " " });
    expect(onLessonClick).not.toHaveBeenCalled();
    expect(statusLine()).toHaveTextContent(/^pickedUp /);
  });

  it("does nothing before the layer has come, and moves nothing", () => {
    const onLessonChange = vi.fn();
    render(<TimetableGrid lessons={WEEK} editable board onLessonChange={onLessonChange} />);
    // The layer is a fetched chunk: in the same tick it has not arrived, and an arrow moves nothing.
    key("mon-9", { key: "ArrowDown" });
    key("mon-9", { key: " " });
    expect(onLessonChange).not.toHaveBeenCalled();
  });
});

describe("the board's keys: taking a lesson up and putting it down", () => {
  it("takes it up with Space and M, moves a marker with the arrows and puts it down with Enter", async () => {
    const { container, onLessonChange, validateChange } = await board();
    card("mon-9").focus();
    key("mon-9", { key: " " });
    expect(ghost(container)).toHaveTextContent("09:00–10:00");
    // The lesson in hand is drawn as one.
    expect(card("mon-9")).toHaveClass("opacity-40");

    key("mon-9", { key: "ArrowDown" });
    expect(ghost(container)).toHaveTextContent("09:15–10:15");
    expect(validateChange).toHaveBeenLastCalledWith("mon-9", { dayOfWeek: 1, startMinutes: 555, endMinutes: 615 });
    key("mon-9", { key: "ArrowRight" });
    key("mon-9", { key: "ArrowDown", shiftKey: true });
    expect(ghost(container)).toHaveTextContent("09:20–10:20");
    expect(statusLine()).toHaveTextContent("markerFree 2 09:20 10:20");

    key("mon-9", { key: "Enter" });
    expect(onLessonChange).toHaveBeenCalledTimes(1);
    expect(onLessonChange).toHaveBeenCalledWith("mon-9", { dayOfWeek: 2, startMinutes: 560, endMinutes: 620 });
    expect(ghost(container)).toBeNull();
    expect(card("mon-9")).not.toHaveClass("opacity-40");
    expect(statusLine()).toHaveTextContent("placed Matematik 7A 2 09:20 10:20");
  });

  it("puts it down with Space as well, and takes it up with M", async () => {
    const { onLessonChange } = await board();
    key("mon-9", { key: "m" });
    key("mon-9", { key: "ArrowDown" });
    key("mon-9", { key: " " });
    expect(onLessonChange).toHaveBeenCalledWith("mon-9", { dayOfWeek: 1, startMinutes: 555, endMinutes: 615 });
  });

  it("draws the marker red where the page says no, and Enter there opens the page's list of free times", async () => {
    const validateChange = vi.fn((_id: string, change: { startMinutes: number }) => change.startMinutes < 600);
    const { container, onLessonChange, onInvalidDrop } = await board({ validateChange });
    key("mon-9", { key: " " });
    key("mon-9", { key: "ArrowDown" });
    expect(ghost(container)).toHaveClass("border-success");
    for (let step = 0; step < 3; step++) key("mon-9", { key: "ArrowDown" });
    expect(ghost(container)).toHaveClass("border-destructive");
    expect(statusLine()).toHaveTextContent(/^markerTaken /);

    key("mon-9", { key: "Enter" });
    expect(onLessonChange).not.toHaveBeenCalled();
    expect(onInvalidDrop).toHaveBeenCalledWith("mon-9", { dayOfWeek: 1, startMinutes: 600, endMinutes: 660 });
    expect(statusLine()).toHaveTextContent(/^refused /);
    expect(ghost(container)).toBeNull();
  });

  it("lets go with Esc and changes nothing", async () => {
    const { container, onLessonChange, onInvalidDrop } = await board();
    key("mon-9", { key: " " });
    key("mon-9", { key: "ArrowDown" });
    key("mon-9", { key: "Escape" });
    expect(ghost(container)).toBeNull();
    expect(onLessonChange).not.toHaveBeenCalled();
    expect(onInvalidDrop).not.toHaveBeenCalled();
    expect(statusLine()).toHaveTextContent("letGo Matematik 7A");
  });

  it("puts it down on the square it came from without a write", async () => {
    const { onLessonChange } = await board();
    key("mon-9", { key: " " });
    key("mon-9", { key: "ArrowDown" });
    key("mon-9", { key: "ArrowUp" });
    key("mon-9", { key: "Enter" });
    expect(onLessonChange).not.toHaveBeenCalled();
    expect(statusLine()).toHaveTextContent(/^letGo /);
  });

  it("keeps the marker inside the week and the hours drawn", async () => {
    const { container, validateChange } = await board();
    key("mon-9", { key: " " });
    key("mon-9", { key: "ArrowLeft" });
    expect(validateChange).not.toHaveBeenCalled();
    expect(ghost(container)).toHaveTextContent("09:00–10:00");
    for (let step = 0; step < 40; step++) key("mon-9", { key: "ArrowUp" });
    expect(ghost(container)).toHaveTextContent("08:00–09:00");
  });

  it("holds every other key while a lesson is in hand: a lock or a removal then would be a surprise", async () => {
    const { onLessonCommand } = await board();
    key("mon-9", { key: " " });
    key("mon-9", { key: "l" });
    key("mon-9", { key: "p" });
    key("mon-9", { key: "Delete" });
    expect(onLessonCommand).not.toHaveBeenCalled();
  });

  it("lets go of what is in hand when a pointer takes hold of the week", async () => {
    const { container } = await board();
    key("mon-9", { key: " " });
    expect(ghost(container)).not.toBeNull();
    fireEvent.pointerDown(card("mon-11"), { pointerId: 1, button: 0 });
    expect(ghost(container)).toBeNull();
  });

  it("lets go of a lesson that is no longer in the week", async () => {
    const { container, rerender, onLessonChange } = await board();
    key("mon-9", { key: " " });
    rerender(<TimetableGrid lessons={WEEK.slice(1)} editable board onLessonChange={onLessonChange} />);
    await waitFor(() => expect(ghost(container)).toBeNull());
  });

  it("follows the card to the day it was put down on", async () => {
    const { rerender, onLessonChange, validateChange } = await board();
    card("mon-9").focus();
    key("mon-9", { key: " " });
    key("mon-9", { key: "ArrowRight" });
    key("mon-9", { key: "Enter" });
    expect(onLessonChange).toHaveBeenCalled();
    // The page saves and the card is drawn in Tuesday's column, a new button: focus is not left on <body>.
    rerender(
      <TimetableGrid
        lessons={[lesson({ id: "mon-9", dayOfWeek: 2 }), ...WEEK.slice(1)]}
        editable
        board
        onLessonChange={onLessonChange}
        validateChange={validateChange}
      />,
    );
    await waitFor(() => expect(card("mon-9")).toHaveFocus());
  });
});

describe("the board's keys: length, lock, park and remove", () => {
  it("changes the length five minutes at a time with Alt and the arrows", async () => {
    const { onLessonChange } = await board();
    key("mon-9", { key: "ArrowDown", altKey: true });
    expect(onLessonChange).toHaveBeenLastCalledWith("mon-9", { dayOfWeek: 1, startMinutes: 540, endMinutes: 605 });
    key("mon-9", { key: "ArrowUp", altKey: true });
    expect(onLessonChange).toHaveBeenLastCalledWith("mon-9", { dayOfWeek: 1, startMinutes: 540, endMinutes: 595 });
    expect(statusLine()).toHaveTextContent(/^length Matematik 7A 55 /);
  });

  it("does not make a lesson shorter than fifteen minutes, and says so", async () => {
    const { onLessonChange } = await board({}, [lesson({ id: "short", startMinutes: 540, endMinutes: 555 })]);
    key("short", { key: "ArrowUp", altKey: true });
    expect(onLessonChange).not.toHaveBeenCalled();
    expect(statusLine()).toHaveTextContent(/^lengthLimit /);
  });

  it("asks the page about a new length, and opens its list of free times when the length is refused", async () => {
    const { onLessonChange, onInvalidDrop } = await board({ validateChange: vi.fn().mockReturnValue(false) });
    key("mon-9", { key: "ArrowDown", altKey: true });
    expect(onLessonChange).not.toHaveBeenCalled();
    expect(onInvalidDrop).toHaveBeenCalledWith("mon-9", { dayOfWeek: 1, startMinutes: 540, endMinutes: 605 });
    expect(statusLine()).toHaveTextContent(/^lengthRefused /);
  });

  it("asks the page to lock, park and remove, and says what it did", async () => {
    const { onLessonCommand } = await board();
    key("mon-9", { key: "l" });
    expect(onLessonCommand).toHaveBeenLastCalledWith("mon-9", "lock");
    expect(statusLine()).toHaveTextContent("locked Matematik 7A");
    key("tue-930", { key: "L" });
    expect(statusLine()).toHaveTextContent("unlocked Engelska 7A");
    key("mon-9", { key: "p" });
    expect(onLessonCommand).toHaveBeenLastCalledWith("mon-9", "park");
    key("mon-11", { key: "Delete" });
    expect(onLessonCommand).toHaveBeenLastCalledWith("mon-11", "remove");
    key("mon-11", { key: "Backspace" });
    expect(onLessonCommand).toHaveBeenCalledTimes(5);
  });

  it("leaves Ctrl+Z to the page's history", async () => {
    const { onLessonCommand } = await board();
    const event = new KeyboardEvent("keydown", { key: "z", ctrlKey: true, bubbles: true, cancelable: true });
    card("mon-9").dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
    expect(onLessonCommand).not.toHaveBeenCalled();
  });

  it("does nothing for a duty beside the lessons, which opens nothing", async () => {
    const { onLessonCommand } = await board({}, [lesson({ id: "duty", duty: true }), ...WEEK]);
    key("duty", { key: "l" });
    key("duty", { key: " " });
    expect(onLessonCommand).not.toHaveBeenCalled();
    expect(statusLine()).toHaveTextContent("");
  });
});

describe("the board's keys: the list of keys", () => {
  it("opens and closes with ?, and has a line for each of the twelve", async () => {
    await board();
    expect(screen.queryByRole("term")).toBeNull();
    key("mon-9", { key: "?" });
    const list = screen.getByLabelText("keysTitle");
    expect(within(list).getAllByRole("term")).toHaveLength(12);
    expect(within(list).getAllByRole("definition")).toHaveLength(12);
    key("mon-9", { key: "?" });
    expect(screen.queryByLabelText("keysTitle")).toBeNull();
  });

  for (const [name, messages] of [["sv", svMessages], ["en", enMessages]] as const) {
    it(`is written in ${name}, every line and every sentence the layer says`, () => {
      const board = (messages as unknown as { boardKeys: Record<string, unknown> }).boardKeys;
      const keys = board.keys as Record<string, { keys: string; does: string }>;
      expect(Object.keys(keys).sort()).toEqual(
        ["arrows", "take", "marker", "put", "letGoKey", "length", "lock", "park", "remove", "open", "select", "undo"].sort(),
      );
      for (const row of Object.values(keys)) {
        expect(row.keys).toBeTruthy();
        expect(row.does).toBeTruthy();
      }
      for (const sentence of [
        "pickedUp", "markerFree", "markerTaken", "placed", "refused", "letGo", "length", "lengthLimit", "lengthRefused",
        "locked", "unlocked", "parked", "removed", "keysTitle",
      ]) {
        expect(typeof board[sentence], sentence).toBe("string");
      }
    });
  }
});

describe("the default keys are the grid's own", () => {
  it("still move the lesson with the arrows when the grid is not a board (Förlägg i veckan)", () => {
    const onLessonChange = vi.fn();
    render(<TimetableGrid lessons={WEEK} editable onLessonChange={onLessonChange} />);
    fireEvent.keyDown(card("mon-9"), { key: "ArrowDown" });
    expect(onLessonChange).toHaveBeenCalledWith("mon-9", { dayOfWeek: 1, startMinutes: 555, endMinutes: 615 });
    expect(card("mon-9")).not.toHaveAttribute("tabindex");
    expect(statusLine()).toBeNull();
  });

  it("is not a board for a reader: nothing is fetched and nothing moves", () => {
    render(<TimetableGrid lessons={WEEK} board />);
    expect(statusLine()).toBeNull();
    expect(card("mon-9")).not.toHaveAttribute("tabindex");
  });
});

describe("the board on a phone", () => {
  /** A window narrower than 768 px: the grid asks matchMedia and is told yes. */
  function phone(matches = true) {
    const listeners = new Set<() => void>();
    const query = {
      get matches() {
        return matches;
      },
      addEventListener: (_: string, listener: () => void) => listeners.add(listener),
      removeEventListener: (_: string, listener: () => void) => listeners.delete(listener),
    };
    vi.stubGlobal("matchMedia", () => query);
    return {
      widen: () => {
        matches = false;
        for (const listener of listeners) listener();
      },
    };
  }

  const FRIDAY = new Date(2026, 10, 27, 10, 0); // a Friday: the day the board opens on, when nobody has chosen one
  const setup = async (extra: Partial<React.ComponentProps<typeof TimetableGrid>> = {}, lessons = WEEK) => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(FRIDAY);
    const view = await board(extra, lessons);
    vi.useRealTimers();
    return view;
  };

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("draws one day, today's, with the buttons that choose another, and says how many lessons each has", async () => {
    phone();
    const week = [...WEEK, lesson({ id: "fri-8", dayOfWeek: 5, startMinutes: 480, endMinutes: 540, title: "Idrott" })];
    await setup({}, week);

    expect(document.querySelectorAll("[data-lesson-id]")).toHaveLength(1);
    expect(card("fri-8")).toBeInTheDocument();
    const group = screen.getByRole("group", { name: "dayPicker" });
    const buttons = within(group).getAllByRole("button");
    expect(buttons).toHaveLength(5);
    expect(buttons[4]).toHaveAttribute("aria-pressed", "true");
    expect(buttons[0]).toHaveAttribute("aria-pressed", "false");
    // The mock translator says the key and its values: Monday has two lessons.
    expect(buttons[0]).toHaveAccessibleName("dayTab 1 2");

    fireEvent.click(buttons[0]!);
    expect(document.querySelectorAll("[data-lesson-id]")).toHaveLength(2);
    expect(card("mon-9")).toBeInTheDocument();
    expect(buttons[0]).toHaveAttribute("aria-pressed", "true");
  });

  it("has no width of its own to scroll sideways in", async () => {
    phone();
    const { container } = await setup();
    expect(container.querySelector('[class*="min-w-[720px]"]')).toBeNull();
  });

  it("drags nothing: a finger on a card may scroll the page, and a tap opens the lesson", async () => {
    phone();
    const { onLessonClick, onLessonChange, container } = await setup();
    fireEvent.click(screen.getByRole("button", { name: /dayTab 1/ }));
    expect(card("mon-9")).toHaveClass("touch-pan-y");
    expect(card("mon-9")).not.toHaveClass("touch-none");
    fireEvent.pointerDown(card("mon-9"), { pointerId: 1, button: 0, clientX: 100, clientY: 10 });
    fireEvent.pointerMove(window, { pointerId: 1, clientX: 300, clientY: 200 });
    fireEvent.pointerUp(window, { pointerId: 1, clientX: 300, clientY: 200 });
    expect(container.querySelector('[class*="border-dashed"]')).toBeNull();
    expect(onLessonChange).not.toHaveBeenCalled();
    // The click that follows a tap opens it, once.
    fireEvent.click(card("mon-9"));
    expect(onLessonClick).toHaveBeenCalledTimes(1);
    expect(onLessonClick).toHaveBeenCalledWith(expect.objectContaining({ id: "mon-9" }));
  });

  it("draws the day the focus goes to, and focus follows", async () => {
    phone();
    await setup();
    fireEvent.click(screen.getByRole("button", { name: /dayTab 1/ }));
    card("mon-11").focus();
    key("mon-11", { key: "ArrowRight" });
    await waitFor(() => expect(card("tue-930")).toBeInTheDocument());
    expect(card("mon-9") ?? null).toBeNull();
    await waitFor(() => expect(card("tue-930")).toHaveFocus());
  });

  it("keeps a lesson in hand in its day, since another would take the card and the focus out of the page", async () => {
    phone();
    const { container, onLessonChange } = await setup();
    fireEvent.click(screen.getByRole("button", { name: /dayTab 1/ }));
    card("mon-9").focus();
    key("mon-9", { key: " " });
    key("mon-9", { key: "ArrowRight" });
    expect(card("mon-9")).toBeInTheDocument();
    expect(ghost(container)).toHaveTextContent("09:00–10:00");
    key("mon-9", { key: "ArrowDown" });
    key("mon-9", { key: "Enter" });
    expect(onLessonChange).toHaveBeenCalledWith("mon-9", { dayOfWeek: 1, startMinutes: 555, endMinutes: 615 });
  });

  it("is the whole week again when the window is widened", async () => {
    const { widen } = phone();
    await setup();
    expect(document.querySelectorAll("[data-lesson-id]")).toHaveLength(0);
    widen();
    await waitFor(() => expect(document.querySelectorAll("[data-lesson-id]")).toHaveLength(3));
    expect(screen.queryByRole("group", { name: "dayPicker" })).toBeNull();
  });

  it("is not a phone's grid for a grid that is not the board, whatever the window", () => {
    phone();
    render(<TimetableGrid lessons={WEEK} editable onLessonChange={vi.fn()} />);
    expect(document.querySelectorAll("[data-lesson-id]")).toHaveLength(3);
    expect(screen.queryByRole("group", { name: "dayPicker" })).toBeNull();
  });
});

describe("the board's tab stop follows what is drawn", () => {
  it("is a card of the day that is shown on a phone, also after the person has focused a lesson of another", async () => {
    vi.stubGlobal("matchMedia", () => ({ matches: true, addEventListener: () => undefined, removeEventListener: () => undefined }));
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(2026, 10, 23, 10, 0)); // a Monday
    await board();
    vi.useRealTimers();
    card("mon-9").focus();
    await waitFor(() => expect(card("mon-9")).toHaveAttribute("tabindex", "0"));
    fireEvent.click(screen.getByRole("button", { name: /dayTab 2/ }));
    // Tuesday is drawn and the card focused last is not: a card that is drawn has to be the way in.
    expect(card("tue-930")).toHaveAttribute("tabindex", "0");
    vi.unstubAllGlobals();
  });
});
