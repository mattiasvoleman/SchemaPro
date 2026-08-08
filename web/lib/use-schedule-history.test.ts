// Tests for the undo/redo command stack and its keyboard binding. Entries are
// plain fakes; no gateway mutation is ever hit — what matters here is stack
// discipline: LIFO order, redo invalidation, the busy guard, failure keeping
// the entry replayable, and the 100-entry cap.

import { act, renderHook, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  useHistoryKeyboard,
  useScheduleHistory,
  type HistoryEntry,
  type ScheduleHistory,
} from "./use-schedule-history";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

const makeEntry = (label: string, overrides: Partial<HistoryEntry> = {}) => ({
  label,
  undo: vi.fn(async () => {}),
  redo: vi.fn(async () => {}),
  ...overrides,
});

/** Runs an async history op inside act and hands back what it returned. */
async function run(
  op: () => Promise<HistoryEntry | null>,
): Promise<HistoryEntry | null> {
  let out: HistoryEntry | null = null;
  await act(async () => {
    out = await op();
  });
  return out;
}

describe("useScheduleHistory", () => {
  it("starts with nothing to undo or redo", async () => {
    const { result } = renderHook(() => useScheduleHistory());

    expect(result.current.canUndo).toBe(false);
    expect(result.current.canRedo).toBe(false);
    expect(await run(() => result.current.undo())).toBeNull();
    expect(await run(() => result.current.redo())).toBeNull();
  });

  it("undo runs the inverse operation and moves the entry to the redo stack", async () => {
    const { result } = renderHook(() => useScheduleHistory());
    const move = makeEntry("move");

    act(() => result.current.push(move));
    expect(result.current.canUndo).toBe(true);
    expect(result.current.canRedo).toBe(false);

    const undone = await run(() => result.current.undo());
    expect(undone?.label).toBe("move");
    expect(move.undo).toHaveBeenCalledTimes(1);
    expect(move.redo).not.toHaveBeenCalled();
    expect(result.current.canUndo).toBe(false);
    expect(result.current.canRedo).toBe(true);
  });

  it("redo replays the operation and moves the entry back", async () => {
    const { result } = renderHook(() => useScheduleHistory());
    const move = makeEntry("move");

    act(() => result.current.push(move));
    await run(() => result.current.undo());

    const redone = await run(() => result.current.redo());
    expect(redone?.label).toBe("move");
    expect(move.redo).toHaveBeenCalledTimes(1);
    expect(result.current.canUndo).toBe(true);
    expect(result.current.canRedo).toBe(false);
  });

  it("undoes in LIFO order", async () => {
    const { result } = renderHook(() => useScheduleHistory());
    const first = makeEntry("first");
    const second = makeEntry("second");

    act(() => {
      result.current.push(first);
      result.current.push(second);
    });

    expect((await run(() => result.current.undo()))?.label).toBe("second");
    expect((await run(() => result.current.undo()))?.label).toBe("first");
    expect(await run(() => result.current.undo())).toBeNull();
  });

  it("pushing a new edit clears the redo stack", async () => {
    const { result } = renderHook(() => useScheduleHistory());
    const move = makeEntry("move");

    act(() => result.current.push(move));
    await run(() => result.current.undo());
    expect(result.current.canRedo).toBe(true);

    act(() => result.current.push(makeEntry("create")));
    expect(result.current.canRedo).toBe(false);
    expect(await run(() => result.current.redo())).toBeNull();
    expect(move.redo).not.toHaveBeenCalled();
  });

  it("a failed undo propagates the error and keeps the entry undoable", async () => {
    const { result } = renderHook(() => useScheduleHistory());
    const flaky = makeEntry("move", {
      undo: vi.fn(() => Promise.reject(new Error("gateway conflict"))),
    });

    act(() => result.current.push(flaky));
    await act(async () => {
      await expect(result.current.undo()).rejects.toThrow("gateway conflict");
    });

    // The entry never left the undo stack, so the user can retry.
    expect(result.current.canUndo).toBe(true);
    expect(result.current.canRedo).toBe(false);
  });

  it("a failed redo keeps the entry redoable", async () => {
    const { result } = renderHook(() => useScheduleHistory());
    const flaky = makeEntry("move", {
      redo: vi.fn(() => Promise.reject(new Error("gateway conflict"))),
    });

    act(() => result.current.push(flaky));
    await run(() => result.current.undo());
    await act(async () => {
      await expect(result.current.redo()).rejects.toThrow("gateway conflict");
    });

    expect(result.current.canRedo).toBe(true);
    expect(result.current.canUndo).toBe(false);
  });

  it("ignores a second undo while one is in flight", async () => {
    const { result } = renderHook(() => useScheduleHistory());
    const gate = deferred<void>();
    const first = makeEntry("first");
    const slow = makeEntry("slow", { undo: vi.fn(() => gate.promise) });

    act(() => {
      result.current.push(first);
      result.current.push(slow);
    });

    await act(async () => {
      const inFlight = result.current.undo(); // parks on the gate
      expect(await result.current.undo()).toBeNull(); // busy → rejected up front
      gate.resolve();
      expect((await inFlight)?.label).toBe("slow");
    });

    // The overlapping call never touched the next entry down.
    expect(first.undo).not.toHaveBeenCalled();
    expect(result.current.canUndo).toBe(true);
    expect(result.current.canRedo).toBe(true);
  });

  it("ignores an undo while a redo is in flight", async () => {
    const { result } = renderHook(() => useScheduleHistory());
    const gate = deferred<void>();
    const other = makeEntry("other");
    const slow = makeEntry("slow", { redo: vi.fn(() => gate.promise) });

    act(() => {
      result.current.push(other);
      result.current.push(slow);
    });
    await run(() => result.current.undo()); // slow → redo stack

    await act(async () => {
      const inFlight = result.current.redo(); // parks on the gate
      expect(await result.current.undo()).toBeNull(); // busy guard
      gate.resolve();
      expect((await inFlight)?.label).toBe("slow");
    });
    expect(other.undo).not.toHaveBeenCalled();
  });

  it("caps the stack at 100 entries, dropping the oldest", async () => {
    const { result } = renderHook(() => useScheduleHistory());
    const entries = Array.from({ length: 101 }, (_, i) => makeEntry(`e${i}`));

    act(() => {
      for (const entry of entries) result.current.push(entry);
    });

    const undoneLabels: string[] = [];
    for (;;) {
      const undone = await run(() => result.current.undo());
      if (!undone) break;
      undoneLabels.push(undone.label);
    }

    expect(undoneLabels).toHaveLength(100);
    expect(undoneLabels[0]).toBe("e100");
    expect(undoneLabels[99]).toBe("e1");
    // The very first edit fell off the bottom of the stack.
    expect(entries[0].undo).not.toHaveBeenCalled();
  });

  it("clear empties both stacks", async () => {
    const { result } = renderHook(() => useScheduleHistory());

    act(() => {
      result.current.push(makeEntry("a"));
      result.current.push(makeEntry("b"));
    });
    await run(() => result.current.undo());

    act(() => result.current.clear());

    expect(result.current.canUndo).toBe(false);
    expect(result.current.canRedo).toBe(false);
    expect(await run(() => result.current.undo())).toBeNull();
    expect(await run(() => result.current.redo())).toBeNull();
  });
});

describe("useHistoryKeyboard", () => {
  const undoEntry = makeEntry("undone");
  const redoEntry = makeEntry("redone");

  const makeHistory = (): Pick<ScheduleHistory, "undo" | "redo"> => ({
    undo: vi.fn(async () => undoEntry as HistoryEntry),
    redo: vi.fn(async () => redoEntry as HistoryEntry),
  });

  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("ctrl+z undoes and reports the entry through onDone", async () => {
    const user = userEvent.setup();
    const history = makeHistory();
    const onDone = vi.fn();
    renderHook(() => useHistoryKeyboard(history, onDone));

    await user.keyboard("{Control>}z{/Control}");

    expect(history.undo).toHaveBeenCalledTimes(1);
    expect(history.redo).not.toHaveBeenCalled();
    await waitFor(() => expect(onDone).toHaveBeenCalledWith("undo", undoEntry));
  });

  it("cmd+z undoes on macOS", async () => {
    const user = userEvent.setup();
    const history = makeHistory();
    renderHook(() => useHistoryKeyboard(history));

    await user.keyboard("{Meta>}z{/Meta}");

    expect(history.undo).toHaveBeenCalledTimes(1);
  });

  it("ctrl+shift+z redoes", async () => {
    const user = userEvent.setup();
    const history = makeHistory();
    const onDone = vi.fn();
    renderHook(() => useHistoryKeyboard(history, onDone));

    await user.keyboard("{Control>}{Shift>}z{/Shift}{/Control}");

    expect(history.redo).toHaveBeenCalledTimes(1);
    expect(history.undo).not.toHaveBeenCalled();
    await waitFor(() => expect(onDone).toHaveBeenCalledWith("redo", redoEntry));
  });

  it("ctrl+y redoes", async () => {
    const user = userEvent.setup();
    const history = makeHistory();
    renderHook(() => useHistoryKeyboard(history));

    await user.keyboard("{Control>}y{/Control}");

    expect(history.redo).toHaveBeenCalledTimes(1);
    expect(history.undo).not.toHaveBeenCalled();
  });

  it("reports null through onDone when there was nothing to undo", async () => {
    const user = userEvent.setup();
    const history: Pick<ScheduleHistory, "undo" | "redo"> = {
      undo: vi.fn(async () => null),
      redo: vi.fn(async () => null),
    };
    const onDone = vi.fn();
    renderHook(() => useHistoryKeyboard(history, onDone));

    await user.keyboard("{Control>}z{/Control}");

    await waitFor(() => expect(onDone).toHaveBeenCalledWith("undo", null));
  });

  it("does nothing without a modifier key", async () => {
    const user = userEvent.setup();
    const history = makeHistory();
    renderHook(() => useHistoryKeyboard(history));

    await user.keyboard("zy");

    expect(history.undo).not.toHaveBeenCalled();
    expect(history.redo).not.toHaveBeenCalled();
  });

  it("prevents the browser's native undo default", () => {
    const history = makeHistory();
    renderHook(() => useHistoryKeyboard(history));

    // Manual dispatch: defaultPrevented is not observable through user-event.
    const match = new KeyboardEvent("keydown", {
      key: "z",
      ctrlKey: true,
      cancelable: true,
    });
    window.dispatchEvent(match);
    expect(match.defaultPrevented).toBe(true);

    const other = new KeyboardEvent("keydown", {
      key: "k",
      ctrlKey: true,
      cancelable: true,
    });
    window.dispatchEvent(other);
    expect(other.defaultPrevented).toBe(false);
  });

  it("leaves shortcuts alone while typing in an input or textarea", async () => {
    const user = userEvent.setup();
    const history = makeHistory();
    renderHook(() => useHistoryKeyboard(history));

    const input = document.createElement("input");
    const textarea = document.createElement("textarea");
    document.body.append(input, textarea);

    input.focus();
    await user.keyboard("{Control>}z{/Control}");
    textarea.focus();
    await user.keyboard("{Control>}z{/Control}");

    expect(history.undo).not.toHaveBeenCalled();
  });

  it("leaves shortcuts alone inside contenteditable regions", () => {
    const history = makeHistory();
    renderHook(() => useHistoryKeyboard(history));

    // jsdom does not compute isContentEditable from the attribute, so the
    // property is stubbed directly — the hook only reads the property.
    const editor = document.createElement("div");
    Object.defineProperty(editor, "isContentEditable", { value: true });
    document.body.append(editor);

    editor.dispatchEvent(
      new KeyboardEvent("keydown", { key: "z", ctrlKey: true, bubbles: true }),
    );

    expect(history.undo).not.toHaveBeenCalled();
  });

  it("detaches the listener on unmount", async () => {
    const user = userEvent.setup();
    const history = makeHistory();
    const { unmount } = renderHook(() => useHistoryKeyboard(history));

    unmount();
    await user.keyboard("{Control>}z{/Control}");

    expect(history.undo).not.toHaveBeenCalled();
  });

  it("drives a real history stack end to end", async () => {
    const user = userEvent.setup();
    const move = makeEntry("move");
    const { result } = renderHook(() => {
      const history = useScheduleHistory();
      useHistoryKeyboard(history);
      return history;
    });

    act(() => result.current.push(move));
    await user.keyboard("{Control>}z{/Control}");
    await waitFor(() => expect(result.current.canRedo).toBe(true));
    expect(move.undo).toHaveBeenCalledTimes(1);

    await user.keyboard("{Control>}y{/Control}");
    await waitFor(() => expect(result.current.canUndo).toBe(true));
    expect(move.redo).toHaveBeenCalledTimes(1);
  });
});
