import type { ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "./api";
import type { BoardPart, BoardPlacement, BoardPost, PlacementBoard } from "./placement-board";
import { placementBoardKey } from "./placement-board-queries";
import { keysOfRows } from "./placement-rows";
import { WriteFailure, patchBoard, usePlacementEditor, writeProblemOf } from "./placement-write";
import type { PlacementsOfRequirement, RequirementPlacement } from "./requirement-placements";

const save = vi.hoisted(() => vi.fn());
vi.mock("./requirement-placements-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./requirement-placements-api")>()),
  savePlacements: save,
}));

const part = (over: Partial<BoardPart> = {}): BoardPart => ({ teacherId: "anna", minutes: 60, count: 3, locked: 0, placed: 1, left: 2, cannotPlace: null, ...over });

const post = (over: Partial<BoardPost> = {}): BoardPost => ({
  id: "post-1",
  studentGroupId: "g-7a",
  subjectId: "s-ma",
  teacherId: "anna",
  coTeacherId: null,
  recurrence: "ALL_WEEKS",
  startDate: null,
  endDate: null,
  cannotPlace: null,
  parts: [part()],
  rowsKey: "aaaaaaaaaaaaaaaa",
  ...over,
});

const row = (over: Partial<BoardPlacement> = {}): BoardPlacement => ({
  id: "row-1",
  requirementId: "post-1",
  dayOfWeek: 2,
  startTime: "10:00",
  endTime: "11:00",
  minutes: 60,
  roomId: "r-a12",
  roomName: "A12",
  recurrence: "ALL_WEEKS",
  teacherId: null,
  changedAt: "2026-11-13T08:00:00.000Z",
  verdict: { ok: true },
  ...over,
});

const stored = (over: Partial<RequirementPlacement> = {}): RequirementPlacement => {
  const { changedAt: _changedAt, verdict: _verdict, ...plain } = row();
  return { ...plain, ...over };
};

const answerOf = (rows: RequirementPlacement[], rowsKey: string): PlacementsOfRequirement => ({
  placements: rows,
  verdicts: rows.map((_, index) => ({ index, ok: true })),
  rowsKey,
});

const board = (over: Partial<PlacementBoard> = {}): PlacementBoard => ({
  academicYearId: "y1",
  placements: [row({ id: "row-1" }), row({ id: "other", requirementId: "post-2", dayOfWeek: 4 })],
  posts: [post(), post({ id: "post-2", rowsKey: "bbbbbbbbbbbbbbbb", parts: [part({ left: 1 })] })],
  kept: [],
  meals: [],
  blocks: [],
  ...over,
});

describe("patchBoard", () => {
  it("replaces the post's rows and key with the answer and leaves the other posts as they were", () => {
    const answer = answerOf([stored({ id: "n-1", dayOfWeek: 3 })], "cccccccccccccccc");
    const patched = patchBoard(board(), "post-1", answer, "2026-11-16T09:00:00.000Z");
    expect(patched.placements.filter((entry) => entry.requirementId === "post-1").map((entry) => [entry.id, entry.dayOfWeek, entry.changedAt])).toEqual([
      ["n-1", 3, "2026-11-16T09:00:00.000Z"],
    ]);
    expect(patched.placements.find((entry) => entry.id === "other")).toEqual(board().placements[1]);
    expect(patched.posts.map((entry) => entry.rowsKey)).toEqual(["cccccccccccccccc", "bbbbbbbbbbbbbbbb"]);
  });

  it("gives each written row the gateway's verdict, with its reason and figures", () => {
    const answer: PlacementsOfRequirement = {
      placements: [stored({ id: "n-1" }), stored({ id: "n-2", dayOfWeek: 4 })],
      verdicts: [{ index: 0, ok: true }, { index: 1, ok: false, reason: "TEACHER", params: { className: "7B" } }],
      rowsKey: "cccccccccccccccc",
    };
    const [first, second] = patchBoard(board({ placements: [] }), "post-1", answer, "now").placements;
    expect(first!.verdict).toEqual({ ok: true });
    expect(second!.verdict).toEqual({ ok: false, reason: "TEACHER", params: { className: "7B" } });
  });

  it("moves the counts: a lesson placed is one fewer to lay, and one taken away is back", () => {
    const added = patchBoard(board(), "post-1", answerOf([stored({ id: "a" }), stored({ id: "b", dayOfWeek: 4 })], "k"), "now");
    expect(added.posts[0]!.parts[0]).toMatchObject({ placed: 2, left: 1 });
    const removed = patchBoard(board(), "post-1", answerOf([], "k"), "now");
    expect(removed.posts[0]!.parts[0]).toMatchObject({ placed: 0, left: 3 });
    // The other post's counts are its own.
    expect(added.posts[1]!.parts[0]).toMatchObject({ left: 1 });
  });

  it("leaves the counts alone for a move, which places nothing new", () => {
    const moved = patchBoard(board(), "post-1", answerOf([stored({ id: "n", dayOfWeek: 5 })], "k"), "now");
    expect(moved.posts[0]!.parts[0]).toMatchObject({ placed: 1, left: 2 });
  });

  it("counts an odd and an even row of one length as ONE lesson on an every-week post, and each as one on an odd-week post", () => {
    // The board held one whole row (placed 1, left 2); a pair of halves replaces it: still one lesson placed.
    const pair = answerOf([stored({ id: "a", recurrence: "ODD_WEEKS" }), stored({ id: "b", dayOfWeek: 4, recurrence: "EVEN_WEEKS" })], "k");
    expect(patchBoard(board(), "post-1", pair, "now").posts[0]!.parts[0]).toMatchObject({ placed: 1, left: 2 });
    // A lone half is no lesson: the row that was one lesson is replaced by something that places none.
    const lone = answerOf([stored({ id: "a", recurrence: "ODD_WEEKS" })], "k");
    expect(patchBoard(board(), "post-1", lone, "now").posts[0]!.parts[0]).toMatchObject({ placed: 0, left: 3 });
    const odd = answerOf([stored({ id: "a", recurrence: "ODD_WEEKS" }), stored({ id: "b", dayOfWeek: 4, recurrence: "ODD_WEEKS" })], "k");
    const onOddPost = board({ posts: [post({ recurrence: "ODD_WEEKS", parts: [part({ placed: 0, left: 3 })] }), post({ id: "post-2" })], placements: [] });
    expect(patchBoard(onOddPost, "post-1", odd, "now").posts[0]!.parts[0]).toMatchObject({ placed: 2, left: 1 });
  });

  it("never lets a count go below nought", () => {
    const patched = patchBoard(board({ posts: [post({ parts: [part({ placed: 0, left: 0 })] })], placements: [] }), "post-1", answerOf([stored(), stored({ dayOfWeek: 4 })], "k"), "now");
    expect(patched.posts[0]!.parts[0]).toMatchObject({ placed: 2, left: 0 });
  });

  it("counts a shared post's rows by their own teacher, and a row with none as the post's", () => {
    const shared = board({
      placements: [],
      posts: [post({ parts: [part({ placed: 0, left: 2 }), part({ teacherId: "bo", count: 1, placed: 0, left: 1 })] })],
    });
    const patched = patchBoard(shared, "post-1", answerOf([stored({ id: "a", teacherId: "bo" })], "k"), "now");
    expect(patched.posts[0]!.parts.map((entry) => [entry.teacherId, entry.placed, entry.left])).toEqual([
      ["anna", 0, 2],
      ["bo", 1, 0],
    ]);
  });
});

describe("what a failed write is", () => {
  it("is STALE for the gateway's REQUIREMENT_PLACEMENTS_STALE and BUSY for SCHEDULE_BUSY, and nothing else is either", () => {
    expect(writeProblemOf(new ApiError(409, "x", "REQUIREMENT_PLACEMENTS_STALE", { requirementId: "p" }))).toBe("STALE");
    expect(writeProblemOf(new ApiError(409, "x", "SCHEDULE_BUSY"))).toBe("BUSY");
    expect(writeProblemOf(new ApiError(409, "x", "REQUIREMENT_PLACEMENT_REFUSED"))).toBe("OTHER");
    expect(writeProblemOf(new ApiError(500, "x", "REQUIREMENT_PLACEMENTS_STALE"))).toBe("OTHER");
    expect(writeProblemOf(new Error("x"))).toBe("OTHER");
    // A refused write comes wrapped with the list that was sent: it is the same problem.
    expect(writeProblemOf(new WriteFailure(new ApiError(409, "x", "REQUIREMENT_PLACEMENTS_STALE"), [], 0))).toBe("STALE");
    expect(writeProblemOf(new WriteFailure(new ApiError(409, "x", "SCHEDULE_BUSY"), [], -1))).toBe("BUSY");
    expect(writeProblemOf(new WriteFailure(new Error("x"), [], 0))).toBe("OTHER");
  });
});

describe("usePlacementEditor", () => {
  let client: QueryClient;
  const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  const cached = () => client.getQueryData<PlacementBoard>(placementBoardKey("y1"))!;
  const firstRowKey = () => keysOfRows(board().placements.filter((entry) => entry.requirementId === "post-1"))[0]!;

  beforeEach(() => {
    save.mockReset();
    client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    client.setQueryData(placementBoardKey("y1"), board());
  });

  it("writes the post's whole list on top of the key the week holds, and puts the answer's rows and key into the week", async () => {
    save.mockResolvedValue(answerOf([stored({ id: "n-1", dayOfWeek: 3, startTime: "09:00" })], "dddddddddddddddd"));
    const { result } = renderHook(() => usePlacementEditor("y1"), { wrapper });
    let outcome: Awaited<ReturnType<typeof result.current.change>>;
    await act(async () => {
      outcome = await result.current.change("post-1", { kind: "move", key: firstRowKey(), to: { dayOfWeek: 3, startMinutes: 540 } }, "move");
    });
    expect(save).toHaveBeenCalledWith("post-1", [{ dayOfWeek: 3, startTime: "09:00", minutes: 60, roomId: "r-a12", recurrence: "ALL_WEEKS" }], "aaaaaaaaaaaaaaaa");
    expect(outcome!).toMatchObject({ ok: true });
    expect(cached().posts[0]!.rowsKey).toBe("dddddddddddddddd");
    expect(cached().placements.find((entry) => entry.id === "n-1")).toMatchObject({ dayOfWeek: 3 });
  });

  it("makes the next change on top of the key the last answer gave, without the week being read again", async () => {
    save.mockResolvedValueOnce(answerOf([stored({ id: "n-1" }), stored({ id: "n-2", dayOfWeek: 4 })], "kkkkkkkkkkkkkkkk"));
    save.mockResolvedValueOnce(answerOf([stored({ id: "m-1" })], "llllllllllllllll"));
    const { result } = renderHook(() => usePlacementEditor("y1"), { wrapper });
    await act(async () => {
      await result.current.change("post-1", { kind: "add", input: { dayOfWeek: 4, startTime: "10:00", minutes: 60, roomId: "r-a12", recurrence: "ALL_WEEKS" } }, "place");
    });
    const keys = keysOfRows(cached().placements.filter((entry) => entry.requirementId === "post-1"));
    await act(async () => {
      await result.current.change("post-1", { kind: "remove", keys: [keys[1]!] }, "remove");
    });
    expect(save.mock.calls[1]![2]).toBe("kkkkkkkkkkkkkkkk");
    expect(save.mock.calls[1]![1]).toHaveLength(1);
  });

  it("undoes by writing the list back on top of OUR last key, not the key the week shows when somebody else has written since", async () => {
    save.mockResolvedValueOnce(answerOf([stored({ id: "n-1", dayOfWeek: 5 })], "1111111111111111"));
    save.mockResolvedValueOnce(answerOf([stored({ id: "u-1" })], "2222222222222222"));
    const { result } = renderHook(() => usePlacementEditor("y1"), { wrapper });
    await act(async () => {
      await result.current.change("post-1", { kind: "move", key: firstRowKey(), to: { dayOfWeek: 5, startMinutes: 600 } }, "move");
    });
    // Somebody else writes the post: the week now shows a key that is not ours.
    client.setQueryData(placementBoardKey("y1"), { ...cached(), posts: cached().posts.map((entry) => (entry.id === "post-1" ? { ...entry, rowsKey: "9999999999999999" } : entry)) });
    await act(async () => {
      await result.current.history.undo();
    });
    expect(save.mock.calls[1]![2]).toBe("1111111111111111");
    // The list it wrote back is the list as it was before the move: day 2 at 10:00, its room and weeks as they were.
    expect(save.mock.calls[1]![1]).toEqual([{ dayOfWeek: 2, startTime: "10:00", minutes: 60, roomId: "r-a12", recurrence: "ALL_WEEKS" }]);
  });

  it("chains undo and redo on the key each write left", async () => {
    save.mockResolvedValueOnce(answerOf([stored({ id: "n-1", dayOfWeek: 5 })], "1111111111111111"));
    save.mockResolvedValueOnce(answerOf([stored({ id: "u-1" })], "2222222222222222"));
    save.mockResolvedValueOnce(answerOf([stored({ id: "r-1", dayOfWeek: 5 })], "3333333333333333"));
    const { result } = renderHook(() => usePlacementEditor("y1"), { wrapper });
    await act(async () => {
      await result.current.change("post-1", { kind: "move", key: firstRowKey(), to: { dayOfWeek: 5, startMinutes: 600 } }, "move");
    });
    await act(async () => void (await result.current.history.undo()));
    await act(async () => void (await result.current.history.redo()));
    expect(save.mock.calls.map((call) => call[2])).toEqual(["aaaaaaaaaaaaaaaa", "1111111111111111", "2222222222222222"]);
    expect(save.mock.calls[2]![1]).toEqual([{ dayOfWeek: 5, startTime: "10:00", minutes: 60, roomId: "r-a12", recurrence: "ALL_WEEKS" }]);
  });

  it("says with the refusal which list was sent and where the changed lesson stood in it, so that a refusal about another row can be told", async () => {
    save.mockRejectedValue(new ApiError(409, "no", "REQUIREMENT_PLACEMENT_REFUSED", { index: 1, reason: "TEACHER" }));
    const { result } = renderHook(() => usePlacementEditor("y1"), { wrapper });
    let failure: unknown;
    await act(async () => {
      failure = await result.current
        .change("post-1", { kind: "move", key: firstRowKey(), to: { dayOfWeek: 3, startMinutes: 540 } }, "move")
        .catch((error: unknown) => error);
    });
    expect(failure).toBeInstanceOf(WriteFailure);
    expect((failure as WriteFailure).changedIndex).toBe(0);
    expect((failure as WriteFailure).list).toEqual([{ dayOfWeek: 3, startTime: "09:00", minutes: 60, roomId: "r-a12", recurrence: "ALL_WEEKS" }]);
    // A removal has no lesson left in the list.
    await act(async () => {
      failure = await result.current.change("post-1", { kind: "remove", keys: [firstRowKey()] }, "remove").catch((error: unknown) => error);
    });
    expect((failure as WriteFailure).changedIndex).toBe(-1);
  });

  it("refuses to change a lesson the week no longer has, and writes nothing", async () => {
    const { result } = renderHook(() => usePlacementEditor("y1"), { wrapper });
    let outcome: Awaited<ReturnType<typeof result.current.change>>;
    await act(async () => {
      outcome = await result.current.change("post-1", { kind: "remove", keys: ["gone"] }, "remove");
    });
    expect(outcome!).toEqual({ ok: false, gone: true });
    expect(save).not.toHaveBeenCalled();
  });

  it("leaves the week and the history as they were when the write is refused", async () => {
    save.mockRejectedValue(new ApiError(409, "stale", "REQUIREMENT_PLACEMENTS_STALE", { requirementId: "post-1" }));
    const { result } = renderHook(() => usePlacementEditor("y1"), { wrapper });
    await act(async () => {
      await expect(
        result.current.change("post-1", { kind: "add", input: { dayOfWeek: 4, startTime: "10:00", minutes: 60, roomId: null, recurrence: "ALL_WEEKS" } }, "place"),
      ).rejects.toBeInstanceOf(WriteFailure);
    });
    expect(result.current.history.canUndo).toBe(false);
    expect(cached()).toEqual(board());
  });

  it("clears the history when the week shows a post with a key that is not the one our last write left, and not otherwise", async () => {
    save.mockResolvedValue(answerOf([stored({ id: "n-1" }), stored({ id: "n-2", dayOfWeek: 4 })], "1111111111111111"));
    const { result } = renderHook(() => usePlacementEditor("y1"), { wrapper });
    await act(async () => {
      await result.current.change("post-1", { kind: "add", input: { dayOfWeek: 4, startTime: "10:00", minutes: 60, roomId: "r-a12", recurrence: "ALL_WEEKS" } }, "place");
    });
    expect(result.current.history.canUndo).toBe(true);
    // The week as our own write left it (and the other post as it was): nothing changed under us.
    let changed = true;
    act(() => {
      changed = result.current.reconcile(cached());
    });
    expect(changed).toBe(false);
    expect(result.current.history.canUndo).toBe(true);
    // Another post changed: not ours, not a reason.
    act(() => {
      changed = result.current.reconcile({ ...cached(), posts: cached().posts.map((entry) => (entry.id === "post-2" ? { ...entry, rowsKey: "7777777777777777" } : entry)) });
    });
    expect(changed).toBe(false);
    // Our post written by somebody else.
    act(() => {
      changed = result.current.reconcile({ ...cached(), posts: cached().posts.map((entry) => (entry.id === "post-1" ? { ...entry, rowsKey: "8888888888888888" } : entry)) });
    });
    expect(changed).toBe(true);
    expect(result.current.history.canUndo).toBe(false);
  });
});
