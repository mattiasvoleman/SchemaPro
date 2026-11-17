import type { BoardPost } from "@/lib/placement-board";
import type { Brick } from "@/lib/placement-rows";

/*
 * What the page itself needs of a pair, apart from lib/placement-pair.ts: the names of a part and of a held half's card, and whether
 * a post can have a pair. Tiny and drawn with the page; everything else about pairs is fetched when the page is up (the route has no
 * bytes to spare: memory bundle-gate-measurement), so it is the part that only types and one-line names may be imported from.
 */

/** The weeks of one half of a pair. */
export type Half = "ODD_WEEKS" | "EVEN_WEEKS";

/** What the reader chose for the chosen brick: every week, or the weeks of the first half of a pair. */
export type WeeksChoice = "ALL_WEEKS" | Half;

/** The other half of a pair. */
export const otherHalf = (half: Half): Half => (half === "ODD_WEEKS" ? "EVEN_WEEKS" : "ODD_WEEKS");

/** The part a brick belongs to: its key without the count that tells the post's identical bricks apart (`post|teacher|minutes`). */
export const partKeyOfBrick = (brick: Pick<Brick, "key">): string => brick.key.replace(/#\d+$/, "");

/** Whether a post's lesson can be a pair: the post runs every week (an odd post or an even one has no other half), and is not in a block. */
export const canBePair = (post: Pick<BoardPost, "recurrence" | "cannotPlace">): boolean => post.recurrence === "ALL_WEEKS" && post.cannotPlace === null;

/** The card of a held half, named by its part: `pairhalf:<post|teacher|minutes>`. */
export const heldHalfCardId = (partKey: string): string => `pairhalf:${partKey}`;
