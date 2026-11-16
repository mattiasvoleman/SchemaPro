import { useCallback, useRef } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ApiError } from "@/lib/api";
import { placementBoardKey } from "@/lib/placement-board-queries";
import type { BoardPlacement, BoardPost, PlacementBoard } from "@/lib/placement-board";
import { baseKeyOf, inputOf, listAfter, rowsOfPost, type RowEdit } from "@/lib/placement-rows";
import type { PlacementInput, PlacementsOfRequirement } from "@/lib/requirement-placements";
import { invalidatePlacements, savePlacements } from "@/lib/requirement-placements-api";
import { useScheduleHistory } from "@/lib/use-schedule-history";

/*
 * Förlägg i veckan, the write: one PUT of a post's whole list per change, made on
 * top of the rows the page last read (`baseKey`), with undo and redo.
 *
 * ONE KEY, CHAINED. The week's read gives every post a `rowsKey`, and so does the
 * answer of every PUT (the key of the rows it just wrote). A write says "on top of
 * this key" (`baseKey`); if somebody else has written the post since, the gateway
 * answers 409 REQUIREMENT_PLACEMENTS_STALE and writes nothing. The answer's key
 * goes straight into the cached week, so the next change of the post is made on
 * top of what this one wrote without reading the week again.
 *
 * UNDO IS A WRITE, and a write on top of OUR LAST write of the post (`ours`), not
 * of whatever the page last read: when somebody else has written the post in
 * between, an undo that took the page's fresh key would put the old list over
 * their change. Instead it is refused (STALE), and `reconcile` has already thrown
 * the history away when the week showed a key that is not ours.
 *
 * Nothing here holds a row's id: every save gives the rows new ids (a step holds
 * LISTS, which is why undo can put a list back).
 */

/** What a write is made of: the post, its whole new list, and what the list is made on top of. */
export interface PlacementWrite {
  postId: string;
  list: PlacementInput[];
  baseKey?: string;
}

type CountedRow = Pick<BoardPlacement, "teacherId" | "minutes" | "recurrence">;

/**
 * The lessons a list of rows places, per (teacher, length): placement-fit.ts's
 * count, an odd and an even row of one length on an every-week post being ONE lesson
 * in two places. The teacher of a row on a post that shares nothing is the post's.
 */
function placedLessonsOf(rows: readonly CountedRow[], post: Pick<BoardPost, "teacherId" | "recurrence">): Map<string, number> {
  const all = new Map<string, number>();
  const odd = new Map<string, number>();
  const even = new Map<string, number>();
  const add = (map: Map<string, number>, key: string) => map.set(key, (map.get(key) ?? 0) + 1);
  for (const row of rows) {
    const key = `${row.teacherId ?? post.teacherId ?? ""}|${row.minutes}`;
    if (row.recurrence === "ODD_WEEKS") add(odd, key);
    else if (row.recurrence === "EVEN_WEEKS") add(even, key);
    else add(all, key);
  }
  const lessons = new Map(all);
  for (const key of new Set([...odd.keys(), ...even.keys()])) {
    const halves = post.recurrence === "ALL_WEEKS" ? Math.min(odd.get(key) ?? 0, even.get(key) ?? 0) : (odd.get(key) ?? 0) + (even.get(key) ?? 0);
    lessons.set(key, (lessons.get(key) ?? 0) + halves);
  }
  return lessons;
}

/**
 * The week with one post's rows and key replaced by what a write answered, and the post's
 * counts moved by the lessons the write placed or took away (a brick is gone, or is back,
 * as the write lands). The counts are an estimate until the week's own read, which is made
 * at once and says what Generera would ask the engine for (locks, over-demand and all).
 */
export function patchBoard(board: PlacementBoard, postId: string, answer: PlacementsOfRequirement, now: string): PlacementBoard {
  const written: BoardPlacement[] = answer.placements.map((row, index) => {
    const verdict = answer.verdicts[index];
    return {
      ...row,
      changedAt: now,
      verdict: { ok: verdict?.ok ?? true, ...(verdict?.reason ? { reason: verdict.reason } : {}), ...(verdict?.params ? { params: verdict.params } : {}) },
    };
  });
  const before = board.placements.filter((row) => row.requirementId === postId);
  return {
    ...board,
    // The rows of the other posts as they were, then this post's in the order the gateway answered them (day, start, weeks).
    placements: [...board.placements.filter((row) => row.requirementId !== postId), ...written],
    posts: board.posts.map((post) => {
      if (post.id !== postId) return post;
      const was = placedLessonsOf(before, post);
      const placedNow = placedLessonsOf(written, post);
      return {
        ...post,
        rowsKey: answer.rowsKey,
        parts: post.parts.map((part) => {
          const key = `${part.teacherId ?? ""}|${part.minutes}`;
          const delta = (placedNow.get(key) ?? 0) - (was.get(key) ?? 0);
          return delta === 0 ? part : { ...part, placed: Math.max(0, part.placed + delta), left: Math.max(0, part.left - delta) };
        }),
      };
    }),
  };
}

/** What a refused or failed write is, for the page to say it: somebody else wrote the post, Generera is writing, or something else. */
export type WriteProblem = "STALE" | "BUSY" | "OTHER";

export function writeProblemOf(error: unknown): WriteProblem {
  if (error instanceof ApiError && error.status === 409) {
    if (error.code === "REQUIREMENT_PLACEMENTS_STALE") return "STALE";
    if (error.code === "SCHEDULE_BUSY") return "BUSY";
  }
  return "OTHER";
}

/** What a change came to. `gone`: the lesson it was about is no longer in the list (the week moved under the reader). */
export type ChangeResult = { ok: true; answer: PlacementsOfRequirement; list: PlacementInput[] } | { ok: false; gone: true };

export function usePlacementEditor(academicYearId: string | null) {
  const client = useQueryClient();
  const history = useScheduleHistory();
  // The history object is made anew at every render; its two writers are stable, and the callbacks below hold those.
  const { push, clear } = history;
  /** The key of each post as OUR last write left it: what an undo or a redo is made on top of. */
  const ours = useRef(new Map<string, string>());
  const boardKey = placementBoardKey(academicYearId);

  const mutation = useMutation({
    mutationFn: async ({ postId, list, baseKey }: PlacementWrite) => {
      const answer = await savePlacements(postId, list, baseKey);
      // Before the cache is patched: the page compares the week's keys with ours when the week changes.
      ours.current.set(postId, answer.rowsKey);
      // A read that was already on its way carries the week as it was before this write; it must not land after the patch.
      await client.cancelQueries({ queryKey: boardKey });
      client.setQueryData<PlacementBoard>(boardKey, (board) => (board ? patchBoard(board, postId, answer, new Date().toISOString()) : board));
      void invalidatePlacements(client);
      return answer;
    },
  });
  const { mutateAsync } = mutation;

  /**
   * One change to one post: its whole list with the change made, on top of the key
   * the week holds, and a step on the history that puts the list back (and forward
   * again). Rejects with the ApiError of a refused write; nothing is then written
   * and the history is untouched.
   */
  const change = useCallback(
    async (postId: string, edit: RowEdit, label: string): Promise<ChangeResult> => {
      const board = client.getQueryData<PlacementBoard>(boardKey);
      if (!board) return { ok: false, gone: true };
      const rows = rowsOfPost(board, postId);
      const before = rows.map(inputOf);
      const after = listAfter(rows, edit);
      if (after === null) return { ok: false, gone: true };
      const answer = await mutateAsync({ postId, list: after, baseKey: baseKeyOf(board, postId) });
      push({
        label,
        undo: async () => void (await mutateAsync({ postId, list: before, baseKey: ours.current.get(postId) })),
        redo: async () => void (await mutateAsync({ postId, list: after, baseKey: ours.current.get(postId) })),
      });
      return { ok: true, answer, list: after };
    },
    [client, boardKey, mutateAsync, push],
  );

  /**
   * The history against the week just read: a post whose key is not the one our
   * last write left was written by somebody else, and none of our steps on it
   * applies any more. The history is thrown away (it is one stack for the page)
   * and true is returned for the page to say so.
   */
  const reconcile = useCallback(
    (board: PlacementBoard | undefined): boolean => {
      if (!board) return false;
      let someoneElse = false;
      for (const [postId, key] of [...ours.current]) {
        const now = baseKeyOf(board, postId);
        if (now !== undefined && now !== key) {
          ours.current.delete(postId);
          someoneElse = true;
        }
      }
      if (someoneElse) clear();
      return someoneElse;
    },
    [clear],
  );

  return { change, saving: mutation.isPending, history, reconcile };
}
