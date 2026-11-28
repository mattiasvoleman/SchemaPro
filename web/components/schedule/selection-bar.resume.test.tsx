import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ApiError } from "@/lib/api";
import type { MasterLesson } from "@/lib/types";
import type { HistoryEntry, ScheduleHistory } from "@/lib/use-schedule-history";
import { SelectionBar } from "./selection-bar";

// The real catalogue through the real translator: the buttons under test are the reader's.
vi.mock("next-intl", async () => {
  const { createTranslator } = await import("use-intl");
  const sv = (await import("@/messages/sv.json")).default;
  return {
    useLocale: () => "sv",
    useTranslations: (namespace: string) => createTranslator({ locale: "sv", messages: sv, namespace: namespace as never }),
  };
});
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() } }));

/*
 * A step of many lessons that stops halfway (E9, granskaren g521). Undo and redo of a bulk lock and a bulk delete take the lessons one at a time. A try that
 * stops at the third (the network falls, a colleague changed it) has done the first two, and the next try must go on from the third: from the first again,
 * a lock is asked of lessons that no longer hold it (409 LESSON_CHANGED for the reader's own change, on every try, with the older steps shut behind the step),
 * and a delete would make the first two lessons a second time.
 */
const lesson = (id: string, locked: boolean): MasterLesson =>
  ({ id, academicYearId: "y1", subjectId: "Ma", studentGroupId: "7A", teacherId: "anna", coTeacherId: null, roomId: null, dayOfWeek: 1, startTime: "14:30:00", endTime: "15:30:00", isLocked: locked, isParked: false, recurrence: "ALL_WEEKS", startDate: null, endDate: null, extraGroupIds: [], studentIds: [] }) as MasterLesson;

const changed = () => new ApiError(409, "changed", "LESSON_CHANGED");

describe("an undo of a bulk lock that stops halfway", () => {
  /** The gateway's rule for `expected`: a write that says the lock was X is refused when it is not X. */
  function locks(initial: boolean, ids: string[]) {
    const server = Object.fromEntries(ids.map((id) => [id, initial])) as Record<string, boolean>;
    const down = new Set<string>();
    const mutate = vi.fn(async (body: { id: string; isLocked: boolean; expected: { isLocked: boolean } }) => {
      if (down.has(body.id)) throw new Error("network");
      if (server[body.id] !== body.expected.isLocked) throw changed();
      server[body.id] = body.isLocked;
      return {};
    });
    return { server, down, mutate };
  }

  function draw(selected: MasterLesson[], mutate: ReturnType<typeof vi.fn>) {
    const pushed: HistoryEntry[] = [];
    render(
      <SelectionBar
        shown
        selectedLessons={() => selected}
        updateLesson={{ mutateAsync: mutate } as never}
        deleteLesson={{ mutateAsync: vi.fn() } as never}
        createLesson={{ mutateAsync: vi.fn() } as never}
        history={{ push: (entry: HistoryEntry) => void pushed.push(entry) } as unknown as ScheduleHistory}
        showError={vi.fn()}
        onClear={vi.fn()}
        deleteIcon={null}
      />,
    );
    return pushed;
  }

  it("goes on from the first lesson it has not put back when the network falls at the third, and then the step is done", async () => {
    const { server, down, mutate } = locks(false, ["a", "b", "c", "d"]);
    const pushed = draw(["a", "b", "c", "d"].map((id) => lesson(id, false)), mutate);
    fireEvent.click(screen.getByRole("button", { name: "Lås" }));
    await vi.waitFor(() => expect(pushed).toHaveLength(1));
    expect(server).toEqual({ a: true, b: true, c: true, d: true });

    down.add("c");
    await expect(pushed[0]!.undo()).rejects.toThrow("network");
    expect(server).toEqual({ a: false, b: false, c: true, d: true });

    down.clear();
    await pushed[0]!.undo();
    expect(server).toEqual({ a: false, b: false, c: false, d: false });

    // And the redo is whole again from the first lesson: the step can be taken back and made again, and again.
    await pushed[0]!.redo();
    expect(server).toEqual({ a: true, b: true, c: true, d: true });
    await pushed[0]!.undo();
    expect(server).toEqual({ a: false, b: false, c: false, d: false });
    await pushed[0]!.redo();
    expect(server).toEqual({ a: true, b: true, c: true, d: true });
  });

  it("goes on from the first lesson a redo has not made again", async () => {
    const { server, down, mutate } = locks(false, ["a", "b", "c"]);
    const pushed = draw(["a", "b", "c"].map((id) => lesson(id, false)), mutate);
    fireEvent.click(screen.getByRole("button", { name: "Lås" }));
    await vi.waitFor(() => expect(pushed).toHaveLength(1));
    await pushed[0]!.undo();
    down.add("b");
    await expect(pushed[0]!.redo()).rejects.toThrow("network");
    down.clear();
    await pushed[0]!.redo();
    expect(server).toEqual({ a: true, b: true, c: true });
  });

  it("is dropped when a colleague has changed one of the lessons, so that the older steps are not shut behind it", async () => {
    const { mutate } = locks(false, ["a"]);
    const pushed = draw([lesson("a", false)], mutate);
    fireEvent.click(screen.getByRole("button", { name: "Lås" }));
    await vi.waitFor(() => expect(pushed).toHaveLength(1));
    expect(pushed[0]!.refusedUndo?.(changed())).toBe(true);
    expect(pushed[0]!.refusedUndo?.(new Error("network"))).toBe(false);
  });
});

describe("an undo of a bulk delete that stops halfway", () => {
  it("makes each lesson once, however many tries it takes, and a redo removes each once", async () => {
    const made: string[] = [];
    const removed: string[] = [];
    let failAt: string | null = "a-3";
    const create = vi.fn(async (input: { subjectId: string; startTime: string }) => {
      const id = `new-${made.length}`;
      if (failAt && input.startTime === failAt) throw new Error("network");
      made.push(id);
      return { id };
    });
    const remove = vi.fn(async (id: string) => {
      if (failAt && id === "x-2") throw new Error("network");
      removed.push(id);
    });
    const pushed: HistoryEntry[] = [];
    const selected = ["x-1", "x-2", "x-3"].map((id, index) => ({ ...lesson(id, false), startTime: `a-${index + 1}` }));
    render(
      <SelectionBar
        shown
        selectedLessons={() => selected}
        updateLesson={{ mutateAsync: vi.fn() } as never}
        deleteLesson={{ mutateAsync: remove } as never}
        createLesson={{ mutateAsync: create } as never}
        history={{ push: (entry: HistoryEntry) => void pushed.push(entry) } as unknown as ScheduleHistory}
        showError={vi.fn()}
        onClear={vi.fn()}
        deleteIcon={null}
      />,
    );
    failAt = null;
    fireEvent.click(screen.getByRole("button", { name: "Ta bort" }));
    await vi.waitFor(() => expect(pushed).toHaveLength(1));
    expect(removed).toEqual(["x-1", "x-2", "x-3"]);

    failAt = "a-3";
    await expect(pushed[0]!.undo()).rejects.toThrow("network");
    expect(made).toEqual(["new-0", "new-1"]);
    failAt = null;
    await pushed[0]!.undo();
    // The first two were made by the first try and not again by the second: three lessons in all.
    expect(made).toHaveLength(3);

    removed.length = 0;
    failAt = "redo";
    // The redo removes the lessons by the ids the undo made them under (new-0, new-1, new-2) and stops at the second of them.
    remove.mockImplementation(async (id: string) => {
      if (failAt && id === "new-1") throw new Error("network");
      removed.push(id);
    });
    await expect(pushed[0]!.redo()).rejects.toThrow("network");
    failAt = null;
    await pushed[0]!.redo();
    expect(removed).toEqual(["new-0", "new-1", "new-2"]);

    // A step that has been done, undone and done again is taken back from its first lesson once more, and made again from its first lesson once more.
    removed.length = 0;
    made.length = 0;
    remove.mockImplementation(async (id: string) => void removed.push(id));
    await pushed[0]!.undo();
    expect(made).toHaveLength(3);
    await pushed[0]!.redo();
    expect(removed).toHaveLength(3);
  });

  it("is dropped when the judge refuses to put one back, which it will again", async () => {
    const pushed: HistoryEntry[] = [];
    render(
      <SelectionBar
        shown
        selectedLessons={() => [lesson("a", false)]}
        updateLesson={{ mutateAsync: vi.fn() } as never}
        deleteLesson={{ mutateAsync: vi.fn() } as never}
        createLesson={{ mutateAsync: vi.fn() } as never}
        history={{ push: (entry: HistoryEntry) => void pushed.push(entry) } as unknown as ScheduleHistory}
        showError={vi.fn()}
        onClear={vi.fn()}
        deleteIcon={null}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Ta bort" }));
    await vi.waitFor(() => expect(pushed).toHaveLength(1));
    expect(pushed[0]!.refusedUndo?.(new ApiError(409, "no", "MASTER_LESSON_REFUSED"))).toBe(true);
    expect(pushed[0]!.refusedUndo?.(new Error("network"))).toBe(false);
  });
});
