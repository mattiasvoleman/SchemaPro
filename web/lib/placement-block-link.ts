import { blockKeyByRowId, blockCardId } from "@/lib/placement-block-rows";
import type { BoardBlock, BoardBlockRow } from "@/lib/placement-board";

/*
 * Förlägg i veckan, the address that names a lesson of a parallel block: `?year=…&post=<a post of the block>&day=<1..5>&start=<HH:MM>&block=<the
 * block's id>`. The other pages (Generera, the grundschema) build such a link to the lesson a refusal or a locked row is about; a post of a block
 * has no rows of its own, so the link names the block as well, and this page marks the block's card.
 *
 * Read from `window.location.search` by the caller (never useSearchParams: it would put the page behind a Suspense boundary and cost the page its
 * first paint), so this takes a string. Nothing of the address is ever made into a selector: the lesson is found by comparing what it names with
 * what the week holds, and the card is found by the id the week gave it.
 *
 * Pure.
 */

/** What the address names. */
export interface BlockLink {
  blockId: string;
  dayOfWeek: number;
  startTime: string;
}

/** The lesson the address names, or null when it does not name one (no `block`, or a day or a start that is none). */
export function blockLinkFromAddress(search: string): BlockLink | null {
  const params = new URLSearchParams(search);
  const blockId = params.get("block");
  const day = params.get("day");
  const start = params.get("start");
  if (!blockId || day === null || start === null) return null;
  if (!/^[1-5]$/.test(day) || !/^([01]\d|2[0-3]):[0-5]\d$/.test(start)) return null;
  return { blockId, dayOfWeek: Number(day), startTime: start };
}

/**
 * The lesson of the block that stands where the link says: found by block, day and start. The first of two that are the same (they are one
 * lesson twice and interchangeable). Null when the block has no lesson there any more (it was moved or taken away since the link was made).
 */
export function lessonOfBlockLink(blocks: readonly BoardBlock[], link: BlockLink): { block: BoardBlock; row: BoardBlockRow; card: string } | null {
  const block = blocks.find((entry) => entry.id === link.blockId);
  const row = block?.rows.find((entry) => entry.dayOfWeek === link.dayOfWeek && entry.startTime === link.startTime);
  if (!block || !row) return null;
  return { block, row, card: blockCardId(blockKeyByRowId(blocks).get(row.id) ?? row.id) };
}
