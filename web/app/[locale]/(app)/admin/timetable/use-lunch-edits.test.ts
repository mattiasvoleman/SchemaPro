import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@/lib/api";
import { useScheduleHistory } from "@/lib/use-schedule-history";
import { useLunchEdits } from "./use-lunch-edits";

/**
 * A class's meal placed, moved and removed by hand, each undoable. page.test.tsx covers the gestures that reach
 * these (a click on empty time, a drag, the refusal of a taken day); what it never runs is the closures a history
 * entry carries: what undo restores for a day that had a meal the school placed, one the solver fed and none at
 * all, and which id redo and undo then answer to.
 */
const toasts = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() }));
vi.mock("sonner", () => ({ toast: toasts }));

const echo = ((key: string) => `echo.${key}`) as never;

type Sitting = { id: string; studentGroupId: string; dayOfWeek: number; startTime: string; isGenerated: boolean };
const sitting = (over: Partial<Sitting> = {}): Sitting => ({
  id: "m-1",
  studentGroupId: "g-1",
  dayOfWeek: 2,
  startTime: "11:00:00",
  isGenerated: false,
  ...over,
});

function setup(sittings: Sitting[], options: { onlyGroup?: string | null; shownYear?: { id: string } | null } = {}) {
  const lunchMutations = {
    create: { mutateAsync: vi.fn().mockResolvedValue({ id: "made-1" }) },
    update: { mutateAsync: vi.fn().mockResolvedValue({}) },
    remove: { mutateAsync: vi.fn().mockResolvedValue({}) },
  };
  const view = renderHook(() => {
    const history = useScheduleHistory();
    const lunch = useLunchEdits({
      lunchSittings: sittings as never,
      shownYear: (options.shownYear === undefined ? { id: "y-1" } : options.shownYear) as never,
      lunchMutations: lunchMutations as never,
      tCommon: echo,
      t: echo,
      onlyGroup: options.onlyGroup === undefined ? "g-1" : options.onlyGroup,
      history,
    });
    return { history, lunch };
  });
  return { view, lunchMutations };
}

beforeEach(() => {
  Object.values(toasts).forEach((fn) => fn.mockClear());
});

describe("placing a meal by hand", () => {
  it("makes it for the class in view on the day clicked, and undo removes it where redo makes it again under a new id", async () => {
    const { view, lunchMutations } = setup([]);

    await act(async () => void (await view.result.current.lunch.placeLunch(3, 11 * 60 + 30)));
    const body = { academicYearId: "y-1", studentGroupId: "g-1", dayOfWeek: 3, startTime: "11:30" };
    expect(lunchMutations.create.mutateAsync).toHaveBeenLastCalledWith(body);

    await act(async () => void (await view.result.current.history.undo()));
    expect(lunchMutations.remove.mutateAsync).toHaveBeenLastCalledWith("made-1");

    lunchMutations.create.mutateAsync.mockResolvedValueOnce({ id: "made-2" });
    await act(async () => void (await view.result.current.history.redo()));
    expect(lunchMutations.create.mutateAsync).toHaveBeenLastCalledWith(body);

    // The entry answers to the meal redo made.
    await act(async () => void (await view.result.current.history.undo()));
    expect(lunchMutations.remove.mutateAsync).toHaveBeenLastCalledWith("made-2");
  });

  it("is undone to the school's own earlier time on a day that had one it placed", async () => {
    const { view, lunchMutations } = setup([sitting({ dayOfWeek: 2, startTime: "11:00:00", isGenerated: false })]);

    await act(async () => void (await view.result.current.lunch.placeLunch(2, 12 * 60)));
    await act(async () => void (await view.result.current.history.undo()));

    expect(lunchMutations.update.mutateAsync).toHaveBeenLastCalledWith({ id: "made-1", startTime: "11:00" });
    expect(lunchMutations.remove.mutateAsync).not.toHaveBeenCalled();
  });

  it("is undone by removing the hand row on a day the solver had fed, so the next run places the meal again", async () => {
    const { view, lunchMutations } = setup([sitting({ dayOfWeek: 2, isGenerated: true })]);

    await act(async () => void (await view.result.current.lunch.placeLunch(2, 12 * 60)));
    await act(async () => void (await view.result.current.history.undo()));

    expect(lunchMutations.remove.mutateAsync).toHaveBeenLastCalledWith("made-1");
    expect(lunchMutations.update.mutateAsync).not.toHaveBeenCalled();
  });

  it("does nothing with no class in view, or no year", async () => {
    const a = setup([], { onlyGroup: null });
    await act(async () => void (await a.view.result.current.lunch.placeLunch(2, 700)));
    const b = setup([], { shownYear: null });
    await act(async () => void (await b.view.result.current.lunch.placeLunch(2, 700)));
    expect(a.lunchMutations.create.mutateAsync).not.toHaveBeenCalled();
    expect(b.lunchMutations.create.mutateAsync).not.toHaveBeenCalled();
  });
});

describe("moving a meal", () => {
  it("updates it to the new day and time, and undo puts it back where it was where redo moves it again", async () => {
    const { view, lunchMutations } = setup([sitting({ id: "m-1", dayOfWeek: 2, startTime: "11:00:00" })]);

    await act(async () => void (await view.result.current.lunch.moveLunch("m-1", 4, 12 * 60 + 15)));
    expect(lunchMutations.update.mutateAsync).toHaveBeenLastCalledWith({ id: "m-1", dayOfWeek: 4, startTime: "12:15" });

    await act(async () => void (await view.result.current.history.undo()));
    expect(lunchMutations.update.mutateAsync).toHaveBeenLastCalledWith({ id: "m-1", dayOfWeek: 2, startTime: "11:00" });

    await act(async () => void (await view.result.current.history.redo()));
    expect(lunchMutations.update.mutateAsync).toHaveBeenLastCalledWith({ id: "m-1", dayOfWeek: 4, startTime: "12:15" });
  });

  it("refuses a day the class already has a meal on, and moves within its own day", async () => {
    const { view, lunchMutations } = setup([
      sitting({ id: "m-1", dayOfWeek: 2 }),
      sitting({ id: "m-2", dayOfWeek: 3 }),
      // Another class's meal on that day is no obstacle.
      sitting({ id: "m-3", dayOfWeek: 4, studentGroupId: "g-2" }),
    ]);

    await act(async () => void (await view.result.current.lunch.moveLunch("m-1", 3, 700)));
    expect(toasts.error).toHaveBeenCalledWith("echo.lunchDayTaken");
    expect(lunchMutations.update.mutateAsync).not.toHaveBeenCalled();

    await act(async () => void (await view.result.current.lunch.moveLunch("m-1", 4, 700)));
    await act(async () => void (await view.result.current.lunch.moveLunch("m-1", 2, 720)));
    expect(lunchMutations.update.mutateAsync).toHaveBeenCalledTimes(2);
  });

  it("does nothing for a meal that is not there", async () => {
    const { view, lunchMutations } = setup([]);
    await act(async () => void (await view.result.current.lunch.moveLunch("gone", 2, 700)));
    expect(lunchMutations.update.mutateAsync).not.toHaveBeenCalled();
  });
});

describe("removing a meal", () => {
  it("removes it, and undo makes it again from what it was where redo removes the one undo made", async () => {
    const { view, lunchMutations } = setup([sitting({ id: "m-1", studentGroupId: "g-1", dayOfWeek: 2, startTime: "11:00:00" })]);

    await act(async () => void (await view.result.current.lunch.removeLunch("m-1")));
    expect(lunchMutations.remove.mutateAsync).toHaveBeenLastCalledWith("m-1");

    lunchMutations.create.mutateAsync.mockResolvedValueOnce({ id: "again-1" });
    await act(async () => void (await view.result.current.history.undo()));
    expect(lunchMutations.create.mutateAsync).toHaveBeenLastCalledWith({
      academicYearId: "y-1",
      studentGroupId: "g-1",
      dayOfWeek: 2,
      startTime: "11:00",
    });

    await act(async () => void (await view.result.current.history.redo()));
    expect(lunchMutations.remove.mutateAsync).toHaveBeenLastCalledWith("again-1");
  });
});

describe("a failed write", () => {
  it("says the gateway's own words for an API error and the common sentence for anything else", async () => {
    const { view, lunchMutations } = setup([]);
    lunchMutations.create.mutateAsync.mockRejectedValueOnce(new ApiError(409, "slot taken"));
    await act(async () => void (await view.result.current.lunch.placeLunch(2, 700)));
    expect(toasts.error).toHaveBeenLastCalledWith("slot taken");

    lunchMutations.create.mutateAsync.mockRejectedValueOnce(new Error("offline"));
    await act(async () => void (await view.result.current.lunch.placeLunch(2, 700)));
    expect(toasts.error).toHaveBeenLastCalledWith("echo.error");
    // Nothing was registered to undo for either.
    expect(view.result.current.history.canUndo).toBe(false);
  });
});

describe("what a meal's step says it was about (E9, granskaren g521)", () => {
  it("names the day and the time of a meal that was placed, one that was moved (where it went) and one that was removed (where it stood)", async () => {
    const { view } = setup([sitting({ id: "m-2", dayOfWeek: 4, startTime: "11:30:00" })]);
    await act(async () => void (await view.result.current.lunch.placeLunch(3, 11 * 60 + 30)));
    await act(async () => void (await view.result.current.lunch.moveLunch("m-2", 5, 12 * 60)));
    await act(async () => void (await view.result.current.lunch.removeLunch("m-2")));
    expect(view.result.current.history.steps().done.map((entry) => entry.meta)).toEqual([
      { what: "lunch", kind: "place", dayOfWeek: 3, startTime: "11:30" },
      { what: "lunch", kind: "move", dayOfWeek: 5, startTime: "12:00" },
      { what: "lunch", kind: "remove", dayOfWeek: 4, startTime: "11:30" },
    ]);
  });
});
