import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createTranslator } from "use-intl";
import en from "@/messages/en.json";
import sv from "@/messages/sv.json";
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

  describe("a refusal of the one judge (MASTER_LESSON_REFUSED, src/calendar/lesson-judge.ts)", () => {
    // The real catalogues, through the real translator: the sentence the reader is shown is the sentence under test.
    const common = (messages: typeof sv) => createTranslator({ locale: messages === sv ? "sv" : "en", messages, namespace: "common" }) as never;
    const timetable = (messages: typeof sv) => createTranslator({ locale: messages === sv ? "sv" : "en", messages, namespace: "timetable" }) as never;
    const toldWith = (error: unknown, messages: typeof sv = sv) => {
      const { view } = setup({ t: timetable(messages), tCommon: common(messages) });
      act(() => view.result.current.edits.showError(error));
      return toasts.error.mock.calls.map((call) => call[0]);
    };
    const clash = {
      reason: "TEACHER",
      reasons: "TEACHER",
      otherKind: "LESSON",
      className: "8B",
      subjectName: "Kemi",
      day: 1,
      start: "13:10",
      end: "14:10",
    };

    it("says the clash in the catalogue's words, naming the other lesson by class, subject, day and time, with no 'Schemakonflikt' in front", () => {
      const said = toldWith(new ApiError(409, "Läraren har redan Kemi 8B måndag 13:10–14:10.", "MASTER_LESSON_REFUSED", clash));
      expect(said).toEqual(["Läraren har redan Kemi med 8B, måndag 13:10–14:10."]);
      expect(said[0]).not.toContain("Schemakonflikt");
    });

    it("says it in English for an English reader", () => {
      const said = toldWith(new ApiError(409, "x", "MASTER_LESSON_REFUSED", clash), en as never);
      expect(said).toEqual(["The teacher already has Kemi with 8B, Monday 13:10–14:10."]);
    });

    it("says the board's rules, which name no other lesson", () => {
      expect(toldWith(new ApiError(409, "x", "MASTER_LESSON_REFUSED", { reason: "LUNCH", reasons: "LUNCH" }))).toEqual([
        "Tiden ligger på klassens lunch.",
      ]);
      toasts.error.mockClear();
      expect(toldWith(new ApiError(409, "x", "MASTER_LESSON_REFUSED", { reason: "OTHER_SCHOOL", reasons: "OTHER_SCHOOL", schools: "Norra skolan" }))).toEqual([
        "Tiden är upptagen av Norra skolan.",
      ]);
    });

    it("says which member of a block's card it is about, when the gateway names one", () => {
      const said = toldWith(new ApiError(409, "x", "MASTER_LESSON_REFUSED", { ...clash, requirement: "Idrott för 7A" }));
      expect(said).toEqual(["Idrott för 7A: Läraren har redan Kemi med 8B, måndag 13:10–14:10."]);
    });

    it("falls back to the gateway's own sentence, still without 'Schemakonflikt', when the params did not come", () => {
      const said = toldWith(new ApiError(409, "Läraren har redan en annan lektion.", "MASTER_LESSON_REFUSED"));
      expect(said).toEqual(["Läraren har redan en annan lektion."]);
    });

    it("leaves a 409 with no code as it was: a conflict with the server's words", () => {
      expect(toldWith(new ApiError(409, "Teacher already teaches Math in this slot."))).toEqual(["Schemakonflikt: Teacher already teaches Math in this slot."]);
    });
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

/*
 * ÅNGRA AV ETT DRAG BORT FRÅN EN PLATS SOM FÅR STÅ (granskaren g461, M-3). A lesson that stands on the class's lunch (a timetable read in from a file)
 * may be moved to a time that holds, by "låt stå"; Ångra is a PATCH back to where it stood, which is a NEW place and is refused by the same rule
 * (beslut 4). The reader is told so, and told that the lesson stays where it is, and not "Schemakonflikt" with the gateway's sentence.
 */
describe("undoing a move away from a place the judge let stand", () => {
  const sentences = (messages: typeof sv) => ({
    t: createTranslator({ locale: messages === sv ? "sv" : "en", messages, namespace: "timetable" }) as never,
    tCommon: createTranslator({ locale: messages === sv ? "sv" : "en", messages, namespace: "common" }) as never,
  });
  const lunch = () => new ApiError(409, "Tiden ligger på klassens lunch.", "MASTER_LESSON_REFUSED", { reason: "LUNCH", reasons: "LUNCH" });

  it("says the undo cannot be done, why, and that the lesson stays, on the toolbar's button and on Ctrl+Z", async () => {
    const { view, updateLesson } = setup(sentences(sv));
    await act(async () => void (await view.result.current.edits.undoableUpdate(lesson, { dayOfWeek: 2 })));

    updateLesson.mutateAsync.mockRejectedValueOnce(lunch());
    await act(async () => void (await view.result.current.edits.doUndo()));
    expect(toasts.error).toHaveBeenLastCalledWith("Det går inte att ångra. Tiden ligger på klassens lunch. Lektionen ligger kvar där den är, och nästa Ångra tar steget före.");
    // The step is dropped: the lesson did not move, the refusal is the same every time, and the steps before it are not shut behind it
    // (E1b). It is not on the redo stack either: it was not undone.
    expect(view.result.current.history.canUndo).toBe(false);
    expect(view.result.current.history.canRedo).toBe(false);

    // The same on Ctrl+Z, for the next step.
    await act(async () => void (await view.result.current.edits.undoableUpdate(lesson, { dayOfWeek: 3 })));
    updateLesson.mutateAsync.mockRejectedValueOnce(lunch());
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "z", ctrlKey: true }));
    });
    await vi.waitFor(() => expect(toasts.error).toHaveBeenCalledTimes(2));
    expect(toasts.error).toHaveBeenLastCalledWith("Det går inte att ångra. Tiden ligger på klassens lunch. Lektionen ligger kvar där den är, och nästa Ångra tar steget före.");
  });

  it("says it in English for an English reader", async () => {
    const { view, updateLesson } = setup(sentences(en));
    await act(async () => void (await view.result.current.edits.undoableUpdate(lesson, { dayOfWeek: 2 })));
    updateLesson.mutateAsync.mockRejectedValueOnce(lunch());
    await act(async () => void (await view.result.current.edits.doUndo()));
    expect(toasts.error).toHaveBeenLastCalledWith("This cannot be undone. The time is on the class's lunch. The lesson stays where it is, and the next Undo takes the step before it.");
  });

  it("says it of a clash too, which is what an undo meets when somebody else has taken the place since", async () => {
    const { view, updateLesson } = setup(sentences(sv));
    await act(async () => void (await view.result.current.edits.undoableUpdate(lesson, { dayOfWeek: 2 })));
    updateLesson.mutateAsync.mockRejectedValueOnce(
      new ApiError(409, "x", "MASTER_LESSON_REFUSED", { reason: "TEACHER", reasons: "TEACHER", className: "8B", subjectName: "Kemi", day: 1, start: "13:10", end: "14:10" }),
    );
    await act(async () => void (await view.result.current.edits.doUndo()));
    expect(toasts.error).toHaveBeenLastCalledWith("Det går inte att ångra. Läraren har redan Kemi med 8B, måndag 13:10–14:10. Lektionen ligger kvar där den är, och nästa Ångra tar steget före.");
  });

  it("does not say the lesson stays when what was undone was not a move: a redo, a create, a delete, a move refused as it is made", async () => {
    // A move refused as it is made is told as before: the refusal alone.
    const { view, updateLesson } = setup(sentences(sv));
    updateLesson.mutateAsync.mockRejectedValueOnce(lunch());
    await act(async () => {
      await view.result.current.edits.undoableUpdate(lesson, { dayOfWeek: 2 }).catch(view.result.current.edits.showError);
    });
    expect(toasts.error).toHaveBeenLastCalledWith("Tiden ligger på klassens lunch.");

    // A redo that is refused is a move refused as it is made.
    await act(async () => void (await view.result.current.edits.undoableUpdate(lesson, { dayOfWeek: 2 })));
    await act(async () => void (await view.result.current.edits.doUndo()));
    updateLesson.mutateAsync.mockRejectedValueOnce(lunch());
    await act(async () => void (await view.result.current.edits.doRedo()));
    expect(toasts.error).toHaveBeenLastCalledWith("Tiden ligger på klassens lunch.");
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
