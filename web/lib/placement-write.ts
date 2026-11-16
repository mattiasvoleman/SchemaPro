import { useCallback, useRef } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ApiError } from "@/lib/api";
import { saveBlockPlacements, type BlockPlacementInput, type PlacementsOfBlock } from "@/lib/block-placements";
import { baseKeyOfBlock, blockInputOf, blockListAfter, keysOfBlockRows, patchBoardBlock, rowsOfBlock, type BlockEdit } from "@/lib/placement-block-rows";
import { placementBoardKey } from "@/lib/placement-board-queries";
import type { BoardPlacement, BoardPost, PlacementBoard } from "@/lib/placement-board";
import { baseKeyOf, inputOf, keysOfRows, listAfter, rowsOfPost, type RowEdit } from "@/lib/placement-rows";
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
 *
 * A PARALLEL BLOCK's lessons are written the same way and by the same hook, so that the history stays ONE stack for the page:
 * `changeBlock` sends the block's whole list (PUT /teaching-blocks/:id/placements) on top of the key the week holds for the
 * block, chains the answer's key into the cached week, and undoes on the key OUR last write of the block left (`ours` holds it
 * as `block:<id>`, apart from a post's, which is a uuid). The server compares a block's `baseKey` BEFORE the fit and the judge
 * (a write that is both old and refused is STALE), a post's AFTER the judge: the order is the gateway's and is not evened out
 * here. The index a refusal names is a place in the list that was SENT, so a failure carries that list.
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

/**
 * A write that did not go through, with what the page needs to say why: the list that was sent (the gateway names a refused
 * row by its place in it) and where in it the lesson the reader changed is (-1: a removal, which has none left). The gateway
 * judges EVERY row of a post at every write, so a row that no longer holds refuses a change of another row, and the sentence
 * is about that row and not about the one the reader moved.
 */
export class WriteFailure extends Error {
  constructor(
    public readonly reason: unknown,
    /** The lessons that were sent, a post's rows or a block's: the refusal's `index` is a place in this list. */
    public readonly list: readonly SentLesson[],
    public readonly changedIndex: number,
  ) {
    super(reason instanceof Error ? reason.message : "Förläggningarna sparades inte.");
    this.name = "WriteFailure";
  }
}

/** What the page reads of a lesson that was sent: where it stands. */
export type SentLesson = Pick<PlacementInput, "dayOfWeek" | "startTime" | "minutes">;

/** What a refused or failed write is, for the page to say it: somebody else wrote the post, Generera is writing, or something else. */
export type WriteProblem = "STALE" | "BUSY" | "OTHER";

export function writeProblemOf(failure: unknown): WriteProblem {
  const error = failure instanceof WriteFailure ? failure.reason : failure;
  if (error instanceof ApiError && error.status === 409) {
    if (error.code === "REQUIREMENT_PLACEMENTS_STALE" || error.code === "BLOCK_PLACEMENTS_STALE") return "STALE";
    if (error.code === "SCHEDULE_BUSY") return "BUSY";
  }
  return "OTHER";
}

/** What a change came to. `gone`: the lesson it was about is no longer in the list (the week moved under the reader). */
export type ChangeResult = { ok: true; answer: PlacementsOfRequirement; list: PlacementInput[] } | { ok: false; gone: true };

/** What a change of a block's lessons came to. */
export type BlockChangeResult = { ok: true; answer: PlacementsOfBlock; list: BlockPlacementInput[] } | { ok: false; gone: true };

/** What a write of a block is made of: the block, its whole new list, and the key the list is made on top of. */
export interface BlockWrite {
  blockId: string;
  list: BlockPlacementInput[];
  baseKey: string;
}

/** The name a block's key has among `ours`: a post's is its id, a uuid, which never starts so. */
const ourKeyOfBlock = (blockId: string): string => `block:${blockId}`;

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

  const blockMutation = useMutation({
    mutationFn: async ({ blockId, list, baseKey }: BlockWrite) => {
      const answer = await saveBlockPlacements(blockId, list, baseKey);
      // Before the cache is patched: the page compares the week's keys with ours when the week changes.
      ours.current.set(ourKeyOfBlock(blockId), answer.rowsKey);
      await client.cancelQueries({ queryKey: boardKey });
      client.setQueryData<PlacementBoard>(boardKey, (board) => (board ? patchBoardBlock(board, blockId, answer, new Date().toISOString()) : board));
      void invalidatePlacements(client);
      return answer;
    },
  });
  const { mutateAsync: mutateBlockAsync } = blockMutation;

  /**
   * One change to one post: its whole list with the change made, on top of the key
   * the week holds, and a step on the history that puts the list back (and forward
   * again). Rejects with a WriteFailure holding the ApiError of a refused write;
   * nothing is then written and the history is untouched.
   */
  const change = useCallback(
    async (postId: string, edit: RowEdit, label: string): Promise<ChangeResult> => {
      const board = client.getQueryData<PlacementBoard>(boardKey);
      if (!board) return { ok: false, gone: true };
      const rows = rowsOfPost(board, postId);
      const before = rows.map(inputOf);
      const after = listAfter(rows, edit);
      if (after === null) return { ok: false, gone: true };
      const changedIndex = edit.kind === "add" ? after.length - 1 : edit.kind === "move" ? keysOfRows(rows).indexOf(edit.key) : -1;
      let answer: PlacementsOfRequirement;
      try {
        answer = await mutateAsync({ postId, list: after, baseKey: baseKeyOf(board, postId) });
      } catch (error) {
        throw new WriteFailure(error, after, changedIndex);
      }
      // A step is a write too and is refused like one, by a row of the list it puts back as well as by somebody else's write: it
      // carries the list it sent and no changed row (-1), so that the page says a refusal about a row as being about that row.
      const step = (list: PlacementInput[]) => async () => {
        try {
          await mutateAsync({ postId, list, baseKey: ours.current.get(postId) });
        } catch (error) {
          throw new WriteFailure(error, list, -1);
        }
      };
      push({ label, undo: step(before), redo: step(after) });
      return { ok: true, answer, list: after };
    },
    [client, boardKey, mutateAsync, push],
  );

  /**
   * One change to one block: its whole list with the change made, on top of the key the week holds for the block, and a step on the
   * history that puts the list back (and forward again). A change of one lesson sends every lesson of the block, each as it stands
   * with the rooms its posts chose. Rejects with a WriteFailure holding the ApiError of a refused write; nothing is then written
   * and the history is untouched.
   */
  const changeBlock = useCallback(
    async (blockId: string, edit: BlockEdit, label: string): Promise<BlockChangeResult> => {
      const board = client.getQueryData<PlacementBoard>(boardKey);
      if (!board) return { ok: false, gone: true };
      const baseKey = baseKeyOfBlock(board, blockId);
      if (baseKey === undefined) return { ok: false, gone: true };
      const rows = rowsOfBlock(board, blockId);
      const before = rows.map(blockInputOf);
      const after = blockListAfter(blockId, rows, edit);
      if (after === null) return { ok: false, gone: true };
      const changedIndex = edit.kind === "add" ? after.length - 1 : edit.kind === "move" ? keysOfBlockRows(blockId, rows).indexOf(edit.key) : -1;
      let answer: PlacementsOfBlock;
      try {
        answer = await mutateBlockAsync({ blockId, list: after, baseKey });
      } catch (error) {
        throw new WriteFailure(error, after, changedIndex);
      }
      // A step is a write too, made on top of the key OUR last write of the block left; it carries the list it sent and no changed lesson.
      const step = (list: BlockPlacementInput[]) => async () => {
        const ourKey = ours.current.get(ourKeyOfBlock(blockId));
        try {
          // Without a key of ours somebody else has written the block since (reconcile has let go of it): the step is refused as a write on an old key is.
          if (ourKey === undefined) throw new ApiError(409, "The block has been changed", "BLOCK_PLACEMENTS_STALE");
          await mutateBlockAsync({ blockId, list, baseKey: ourKey });
        } catch (error) {
          throw new WriteFailure(error, list, -1);
        }
      };
      push({ label, undo: step(before), redo: step(after) });
      return { ok: true, answer, list: after };
    },
    [client, boardKey, mutateBlockAsync, push],
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
      for (const [name, key] of [...ours.current]) {
        // A post is named by its id, a block by `block:<id>`: the key the week holds for either.
        const now = name.startsWith("block:") ? baseKeyOfBlock(board, name.slice("block:".length)) : baseKeyOf(board, name);
        if (now !== undefined && now !== key) {
          ours.current.delete(name);
          someoneElse = true;
        }
      }
      if (someoneElse) clear();
      return someoneElse;
    },
    [clear],
  );

  return { change, changeBlock, saving: mutation.isPending || blockMutation.isPending, history, reconcile };
}
