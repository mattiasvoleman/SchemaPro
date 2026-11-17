/*
 * HOW MANY LESSONS LIE FIXED, AND HOW MANY OF THEM NO LONGER HOLD (Generera's row before a run, A3).
 *
 * Read off the week's own board, structurally, so that this file does not import the week's types (placement-board.ts moves
 * with the block card). The count is the week's: the sum of every part's `placed`, which is how the week's summary says it,
 * and which counts a block's lesson for each of its members, as the grundschema does. A row "no longer holds" when the judge
 * says no to it; a block's lesson is one row and fails when any member's verdict does.
 *
 * A help and never a gate: nothing here stops a run, and a board that is not read gives no figure.
 */

export interface PlacedCountBoard {
  posts: readonly { parts: readonly { placed: number }[] }[];
  placements: readonly { verdict: { ok: boolean } }[];
  blocks?: readonly { rows: readonly { verdicts: readonly { ok: boolean }[] }[] }[];
}

export function placedCountOf(board: PlacedCountBoard): { fixed: number; failing: number } {
  const fixed = board.posts.reduce((sum, post) => sum + post.parts.reduce((inPost, part) => inPost + part.placed, 0), 0);
  const failingRows = board.placements.filter((row) => !row.verdict.ok).length;
  const failingBlockRows = (board.blocks ?? []).reduce((sum, block) => sum + block.rows.filter((row) => row.verdicts.some((verdict) => !verdict.ok)).length, 0);
  return { fixed, failing: failingRows + failingBlockRows };
}
