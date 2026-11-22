import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@/lib/api";
import { LESSON_IS_PLACED } from "@/lib/lesson-is-placed";
import { useScheduleHistory } from "@/lib/use-schedule-history";
import type { MasterLesson } from "@/lib/types";
import { useUndoableEdits } from "./use-undoable-edits";

/**
 * The page's writes, undo and redo, held where they now live. page.test.tsx drives the grid, so it never runs
 * the closures a history entry carries (what undo puts back, what redo does again, which id a recreated lesson
 * answers to); these do, on the hook itself, against real history.
 */
const toasts = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() }));
vi.mock("sonner", () => ({ toast: toasts }));

const lesson = {
  id: "l-1",
  academicYearId: "y-1",
  subjectId: "s-1",
  studentGroupId: "g-1",
  teacherId: "t-1",
  coTeacherId: null,
  roomId: "r-1",
  dayOfWeek: 1,
  startTime: "08:00:00",
  endTime: "09:00:00",
  isLocked: false,
  isParked: false,
  recurrence: "ALL_WEEKS",
  startDate: null,
  endDate: null,
  extraGroupIds: [],
  studentIds: [],
} as MasterLesson;

/** The translator as the page's tests have it: the key, with its values after it. */
const echo = ((key: string) => `echo.${key}`) as never;
/** The engine catalogue as a lookup: every code is there, and each sentence says which catalogue it came from (a text ending in the code is the real translator's fallback). */
const catalogue = (name: string) => Object.assign((key: string) => `${name} says ${key}`, { has: () => true }) as never;

function setup(overrides: Partial<Parameters<typeof useUndoableEdits>[0]> = {}) {
  const updateLesson = { mutateAsync: vi.fn().mockResolvedValue({ propagatedLessons: 1 }) };
  const createLesson = { mutateAsync: vi.fn().mockResolvedValue({ id: "new-1" }) };
  const deleteLesson = { mutateAsync: vi.fn().mockResolvedValue({ removedCalendarLessons: 0 }) };
  const view = renderHook(
    (props: { tEngine: never }) => {
      const history = useScheduleHistory();
      const edits = useUndoableEdits({
        t: echo,
        tCommon: echo,
        tEngine: props.tEngine,
        updateLesson: updateLesson as never,
        createLesson: createLesson as never,
        deleteLesson: deleteLesson as never,
        history,
        ...overrides,
      });
      return { history, edits };
    },
    { initialProps: { tEngine: catalogue("engine") } },
  );
  return { view, updateLesson, createLesson, deleteLesson };
}

beforeEach(() => {
  Object.values(toasts).forEach((fn) => fn.mockClear());
});

describe("an undoable update", () => {
  it("sends the patch, and undo puts the lesson as it was where redo puts it as it became", async () => {
    const { view, updateLesson } = setup();

    await act(async () => {
      await view.result.current.edits.undoableUpdate(lesson, { dayOfWeek: 3, startTime: "10:00" });
    });
    expect(updateLesson.mutateAsync).toHaveBeenLastCalledWith({ id: "l-1", dayOfWeek: 3, startTime: "10:00" });
    expect(view.result.current.history.canUndo).toBe(true);

    await act(async () => void (await view.result.current.history.undo()));
    // The snapshot has the clock as the inputs write it ("HH:MM", not the database's "HH:MM:SS").
    expect(updateLesson.mutateAsync).toHaveBeenLastCalledWith(
      expect.objectContaining({ id: "l-1", dayOfWeek: 1, startTime: "08:00", endTime: "09:00", roomId: "r-1" }),
    );

    await act(async () => void (await view.result.current.history.redo()));
    expect(updateLesson.mutateAsync).toHaveBeenLastCalledWith(
      expect.objectContaining({ id: "l-1", dayOfWeek: 3, startTime: "10:00", endTime: "09:00" }),
    );
  });
});

describe("an undoable create", () => {
  it("is undone by deleting what it made, and redone by making it again under the id undo then deletes", async () => {
    const { view, createLesson, deleteLesson } = setup();
    const input = { academicYearId: "y-1", subjectId: "s-1", studentGroupId: "g-1" } as never;

    await act(async () => void (await view.result.current.edits.undoableCreate(input)));
    await act(async () => void (await view.result.current.history.undo()));
    expect(deleteLesson.mutateAsync).toHaveBeenLastCalledWith("new-1");

    createLesson.mutateAsync.mockResolvedValueOnce({ id: "new-2" });
    await act(async () => void (await view.result.current.history.redo()));
    expect(createLesson.mutateAsync).toHaveBeenLastCalledWith(input);

    // The entry now answers to the lesson redo made: undoing again deletes THAT one, not the first.
    await act(async () => void (await view.result.current.history.undo()));
    expect(deleteLesson.mutateAsync).toHaveBeenLastCalledWith("new-2");
  });
});

describe("an undoable delete", () => {
  it("is undone by making the lesson again from what it was, and redone by deleting the one undo made", async () => {
    const { view, createLesson, deleteLesson } = setup();

    await act(async () => void (await view.result.current.edits.undoableDelete(lesson)));
    expect(deleteLesson.mutateAsync).toHaveBeenLastCalledWith("l-1");

    createLesson.mutateAsync.mockResolvedValueOnce({ id: "again-1" });
    await act(async () => void (await view.result.current.history.undo()));
    expect(createLesson.mutateAsync).toHaveBeenLastCalledWith(
      expect.objectContaining({ subjectId: "s-1", studentGroupId: "g-1", startTime: "08:00", roomId: "r-1" }),
    );

    await act(async () => void (await view.result.current.history.redo()));
    expect(deleteLesson.mutateAsync).toHaveBeenLastCalledWith("again-1");
  });
});

describe("how a failed write is told", () => {
  const told = (error: unknown) => {
    const { view } = setup();
    act(() => view.result.current.edits.showError(error));
    return toasts.error.mock.calls.map((call) => call[0]);
  };

  it("says a staffing refusal in the engine catalogue's words, with no 'conflict' in front", () => {
    const said = told(new ApiError(409, "no", "STAFF_TEACHER_NOT_QUALIFIED", { subject: "Slöjd" }));
    expect(said).toEqual(["engine says STAFF_TEACHER_NOT_QUALIFIED"]);
  });

  it("says a lesson that is its förläggning's as that, and any other 409 as a conflict with the server's words", () => {
    expect(told(new ApiError(409, "x", LESSON_IS_PLACED))).toEqual(["echo.lessonIsPlaced"]);
    toasts.error.mockClear();
    expect(told(new ApiError(409, "room taken"))).toEqual(["echo.editConflict: room taken"]);
  });

  it("says another error by its message, and something that is no error by the common one", () => {
    expect(told(new Error("offline"))).toEqual(["offline"]);
    toasts.error.mockClear();
    expect(told("a string")).toEqual(["echo.error"]);
  });

  it("asks the translator it is handed on each render, not the first one", () => {
    const { view } = setup();
    view.rerender({ tEngine: catalogue("second") });
    act(() => view.result.current.edits.showError(new ApiError(409, "no", "STAFF_TEACHER_NOT_QUALIFIED", {})));
    expect(toasts.error.mock.calls[0]![0]).toBe("second says STAFF_TEACHER_NOT_QUALIFIED");
  });
});

describe("undo and redo from the toolbar and from the keyboard", () => {
  it("toasts what was undone and redone, and says nothing when there is nothing to do", async () => {
    const { view } = setup();
    await act(async () => void (await view.result.current.edits.doUndo()));
    expect(toasts.info).not.toHaveBeenCalled();

    await act(async () => void (await view.result.current.edits.undoableUpdate(lesson, { dayOfWeek: 2 })));
    await act(async () => void (await view.result.current.edits.doUndo()));
    expect(toasts.info).toHaveBeenLastCalledWith("echo.undone");
    await act(async () => void (await view.result.current.edits.doRedo()));
    expect(toasts.info).toHaveBeenLastCalledWith("echo.redone");
  });

  it("tells a failed undo through showError and keeps the entry", async () => {
    const { view, updateLesson } = setup();
    await act(async () => void (await view.result.current.edits.undoableUpdate(lesson, { dayOfWeek: 2 })));
    updateLesson.mutateAsync.mockRejectedValueOnce(new ApiError(409, "room taken"));
    await act(async () => void (await view.result.current.edits.doUndo()));
    expect(toasts.error).toHaveBeenCalledWith("echo.editConflict: room taken");
    expect(view.result.current.history.canUndo).toBe(true);
  });

  it("runs the same undo on Ctrl+Z, says it, and reports a failure the way the button does", async () => {
    const { view, updateLesson } = setup();
    await act(async () => void (await view.result.current.edits.undoableUpdate(lesson, { dayOfWeek: 2 })));

    updateLesson.mutateAsync.mockRejectedValueOnce(new ApiError(409, "room taken"));
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "z", ctrlKey: true }));
    });
    await vi.waitFor(() => expect(toasts.error).toHaveBeenCalledWith("echo.editConflict: room taken"));

    await act(async () => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "z", ctrlKey: true }));
    });
    await vi.waitFor(() => expect(toasts.info).toHaveBeenCalledWith("echo.undone"));
  });
});
