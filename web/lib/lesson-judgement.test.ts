import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MasterLesson } from "@/lib/types";
import { JUDGE_DELAY_MS, moveOf, useLessonJudgement, type JudgedDraft, type LessonJudgement } from "./lesson-judgement";

const post = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api", () => ({ api: { post } }));

const NONE = "__none__";

const lesson = {
  id: "l-1",
  academicYearId: "y-1",
  subjectId: "s-1",
  studentGroupId: "g-1",
  teacherId: "t-1",
  coTeacherId: null,
  roomId: "r-1",
  dayOfWeek: 1,
  startTime: "10:00:00",
  endTime: "11:00:00",
  isLocked: false,
  isParked: false,
  recurrence: "ALL_WEEKS",
  startDate: null,
  endDate: null,
  extraGroupIds: [],
  studentIds: [],
} as MasterLesson;

/** The dialog's fields as openEditor fills them from the lesson: nothing moved. */
const standing: JudgedDraft = {
  dayOfWeek: "1",
  startTime: "10:00",
  endTime: "11:00",
  roomId: "r-1",
  teacherId: "t-1",
  recurrence: "ALL_WEEKS",
  startDate: "",
  endDate: "",
};

describe("what the fields say of an exemption (Undantag med flit)", () => {
  it("asks with the rules the reader answered yes to, and says them in the order the gateway writes them", () => {
    expect(moveOf(lesson, { ...standing, startTime: "14:30", endTime: "15:30", exempt: ["LUNCH", "FRAME"] }, NONE)).toEqual({
      lessonId: "l-1",
      startTime: "14:30",
      endTime: "15:30",
      exempt: ["FRAME", "LUNCH"],
    });
  });

  it("asks nothing when the answer is the lesson's own: a lesson that already stands with an exemption, left as it is", () => {
    const exempt = { ...lesson, exemptFrom: ["FRAME" as const], isLocked: true };
    expect(moveOf(exempt, { ...standing, exempt: ["FRAME"] }, NONE)).toBeNull();
    // A lesson that stands against a rule can be made an exemption without moving it (låt stå): the answer yes is what moved.
    expect(moveOf(lesson, { ...standing, exempt: ["FRAME"] }, NONE)).toEqual({ lessonId: "l-1", exempt: ["FRAME"] });
    // Taken back, nothing is asked: a lesson with fewer exemptions is let through by every rule it was.
    expect(moveOf(exempt, { ...standing, exempt: [] }, NONE)).toBeNull();
  });

  it("is a request like any other without an answer: no `exempt` key, so the question is the one it always was", () => {
    expect(moveOf(lesson, { ...standing, startTime: "13:10", endTime: "14:10" }, NONE)).toEqual({ lessonId: "l-1", startTime: "13:10", endTime: "14:10" });
    expect(moveOf(lesson, { ...standing, startTime: "13:10", endTime: "14:10", exempt: [] }, NONE)).toEqual({ lessonId: "l-1", startTime: "13:10", endTime: "14:10" });
  });
});

describe("what the fields have moved", () => {
  it("is nothing for a lesson left as it stands: no question is asked", () => {
    expect(moveOf(lesson, standing, NONE)).toBeNull();
  });

  it("is only the fields that differ from the lesson, said the way the PATCH says them", () => {
    expect(moveOf(lesson, { ...standing, dayOfWeek: "3", startTime: "13:10", endTime: "14:10" }, NONE)).toEqual({
      lessonId: "l-1",
      dayOfWeek: 3,
      startTime: "13:10",
      endTime: "14:10",
    });
    // "No room" and "no teacher" are the page's value for null; a window's empty field is the year's own boundary, null too.
    expect(moveOf(lesson, { ...standing, roomId: NONE, teacherId: NONE }, NONE)).toEqual({ lessonId: "l-1", roomId: null, teacherId: null });
    expect(moveOf(lesson, { ...standing, recurrence: "ODD_WEEKS", startDate: "2027-01-11" }, NONE)).toEqual({
      lessonId: "l-1",
      recurrence: "ODD_WEEKS",
      startDate: "2027-01-11",
    });
    expect(moveOf({ ...lesson, endDate: "2027-03-05" }, standing, NONE)).toEqual({ lessonId: "l-1", endDate: null });
  });

  it("is nothing while the clock is not a clock the gateway reads, or does not end after it starts", () => {
    for (const fields of [{ startTime: "" }, { endTime: "" }, { endTime: "10:00" }, { startTime: "12:00" }, { startTime: "8:5" }, { endTime: "24:00" }]) {
      expect(moveOf(lesson, { ...standing, dayOfWeek: "2", ...fields }, NONE)).toBeNull();
    }
  });

  it("does not take the lock for a move: the lock is no placement", () => {
    // The dialog's draft has an isLocked too; moveOf takes only what the judge reads.
    expect(moveOf(lesson, { ...standing, isLocked: true } as JudgedDraft, NONE)).toBeNull();
  });
});

describe("the question asked while the dialog is filled in", () => {
  const refused: LessonJudgement = {
    ok: false,
    moves: [
      {
        lessonId: "l-1",
        ok: false,
        refusals: [{ reason: "LUNCH", params: {}, text: "Tiden ligger på klassens lunch." }],
      },
    ],
  };

  beforeEach(() => {
    vi.useFakeTimers();
    post.mockReset();
    post.mockResolvedValue(refused);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const run = (draft: JudgedDraft) =>
    renderHook((props: { draft: JudgedDraft }) => useLessonJudgement(lesson, props.draft, NONE), { initialProps: { draft } });

  it("asks nothing for a lesson that has not been touched, and is idle", async () => {
    const view = run(standing);
    await act(async () => void (await vi.advanceTimersByTimeAsync(JUDGE_DELAY_MS * 3)));
    expect(post).not.toHaveBeenCalled();
    expect(view.result.current).toEqual({ status: "idle" });
  });

  it("asks once the fields have stood still for the delay, with only what moved, as one move, and says the answer", async () => {
    const view = run({ ...standing, startTime: "12:00", endTime: "13:00" });
    expect(view.result.current).toEqual({ status: "checking" });
    await act(async () => void (await vi.advanceTimersByTimeAsync(JUDGE_DELAY_MS - 1)));
    expect(post).not.toHaveBeenCalled();
    await act(async () => void (await vi.advanceTimersByTimeAsync(1)));
    expect(post).toHaveBeenCalledTimes(1);
    expect(post.mock.calls[0]![0]).toBe("/api/v1/master-lessons/judge");
    expect(post.mock.calls[0]![1]).toEqual({ moves: [{ lessonId: "l-1", startTime: "12:00", endTime: "13:00" }] });
    expect(view.result.current).toEqual({ status: "done", judgement: refused.moves[0] });
  });

  it("asks only about the last of several quick changes, and cancels the one on its way", async () => {
    const view = run({ ...standing, startTime: "12:00", endTime: "13:00" });
    await act(async () => void (await vi.advanceTimersByTimeAsync(JUDGE_DELAY_MS)));
    expect(post).toHaveBeenCalledTimes(1);
    const first = post.mock.calls[0]![2] as AbortSignal;

    view.rerender({ draft: { ...standing, startTime: "12:00", endTime: "13:30" } });
    expect(first.aborted).toBe(true);
    await act(async () => void (await vi.advanceTimersByTimeAsync(JUDGE_DELAY_MS)));
    expect(post).toHaveBeenCalledTimes(2);
    expect(post.mock.calls[1]![1]).toEqual({ moves: [{ lessonId: "l-1", startTime: "12:00", endTime: "13:30" }] });
  });

  it("does not say an answer that belongs to fields since changed", async () => {
    let answer: (value: LessonJudgement) => void = () => {};
    post.mockImplementationOnce(() => new Promise<LessonJudgement>((resolve) => (answer = resolve)));
    const view = run({ ...standing, startTime: "12:00", endTime: "13:00" });
    await act(async () => void (await vi.advanceTimersByTimeAsync(JUDGE_DELAY_MS)));

    view.rerender({ draft: { ...standing, dayOfWeek: "2" } });
    await act(async () => answer(refused));
    expect(view.result.current).toEqual({ status: "checking" });
  });

  it("does not say the answer to the fields it was asked of for the very render that has other fields in it", async () => {
    const view = run({ ...standing, startTime: "12:00", endTime: "13:00" });
    await act(async () => void (await vi.advanceTimersByTimeAsync(JUDGE_DELAY_MS)));
    expect(view.result.current.status).toBe("done");
    // The render that carries the new fields is drawn before any effect has run: the old answer must not be in it.
    const seen: string[] = [];
    const again = renderHook(
      (props: { draft: JudgedDraft }) => {
        const judged = useLessonJudgement(lesson, props.draft, NONE);
        seen.push(judged.status);
        return judged;
      },
      { initialProps: { draft: { ...standing, startTime: "12:00", endTime: "13:00" } } },
    );
    await act(async () => void (await vi.advanceTimersByTimeAsync(JUDGE_DELAY_MS)));
    seen.length = 0;
    again.rerender({ draft: { ...standing, startTime: "12:00", endTime: "13:30" } });
    expect(seen[0]).toBe("checking");
  });

  it("is idle again when the fields are put back as the lesson has them", async () => {
    const view = run({ ...standing, dayOfWeek: "2" });
    await act(async () => void (await vi.advanceTimersByTimeAsync(JUDGE_DELAY_MS)));
    expect(view.result.current.status).toBe("done");
    view.rerender({ draft: standing });
    expect(view.result.current).toEqual({ status: "idle" });
  });

  it("says `failed` when the question gets no answer, and does not throw: the save is still the judge", async () => {
    post.mockRejectedValueOnce(new Error("offline"));
    const view = run({ ...standing, dayOfWeek: "2" });
    await act(async () => void (await vi.advanceTimersByTimeAsync(JUDGE_DELAY_MS)));
    expect(view.result.current).toEqual({ status: "failed" });
  });

  it("says `failed` for a 200 with no body or no moves, and throws nothing, instead of staying on `checking` for ever (granskaren g462, L-6)", async () => {
    // The api client answers `undefined` for a 200 with no body (lib/api.ts); the gateway always sends one, so this is defence in depth.
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);
    try {
      for (const nothing of [undefined, null, {}, { ok: true }, { ok: true, moves: [] }]) {
        post.mockResolvedValueOnce(nothing);
        const view = run({ ...standing, dayOfWeek: "2" });
        await act(async () => void (await vi.advanceTimersByTimeAsync(JUDGE_DELAY_MS)));
        expect(view.result.current, JSON.stringify(nothing)).toEqual({ status: "failed" });
        view.unmount();
      }
      await vi.advanceTimersByTimeAsync(10);
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off("unhandledRejection", unhandled);
    }
  });

  it("asks nothing and says nothing for a dialog with no lesson", async () => {
    const view = renderHook(() => useLessonJudgement(null, { ...standing, dayOfWeek: "2" }, NONE));
    await act(async () => void (await vi.advanceTimersByTimeAsync(JUDGE_DELAY_MS * 2)));
    expect(post).not.toHaveBeenCalled();
    expect(view.result.current).toEqual({ status: "idle" });
  });
});
