import type { QueryClient } from "@tanstack/react-query";
import { ApiError, api } from "@/lib/api";
import type { MessageLookup } from "@/lib/engine-message";
import { REQUIREMENT_PLACEMENTS_KEY, type PlacementRecurrence } from "@/lib/requirement-placements";

/*
 * Förlägg blocket, read and written: the lessons a school has placed on a
 * PARALLEL BLOCK by hand before Generera, one lesson of the block at a day and
 * a start that every post of the block sits, and, per post, a room of its own
 * or none (the engine then chooses the room at every Generera). The gateway's
 * routes are /teaching-blocks/:id/placements (GET the lessons with a verdict
 * for each lesson and post; PUT replaces them).
 *
 * ITS OWN MODULE, for the timplan page's bundle: only the dialog
 * (components/timplan/block-placement-dialog.tsx, which teaching-blocks.tsx
 * holds and the page fetches on the first press of "Block") imports it. The
 * page's own module of förlagda poster (requirement-placements.ts) has no
 * bytes to spare and is left as it is.
 */

/** One post's room for one lesson of the block. A post that is not named has its room chosen by the engine. */
export interface BlockPlacementRoom {
  requirementId: string;
  roomId: string;
  roomName: string;
}

/** One lesson of a block as the gateway answers it. */
export interface BlockPlacement {
  id: string;
  blockId: string;
  /** 1..5, Monday to Friday. */
  dayOfWeek: number;
  /** HH:MM. */
  startTime: string;
  endTime: string;
  minutes: number;
  /** The block's own weeks: the gateway sets them, the request does not. */
  recurrence: PlacementRecurrence;
  rooms: BlockPlacementRoom[];
}

/** The judge's verdict on lesson `index` for one post of the block; `reason` and `params` only when it does not hold. */
export interface BlockVerdict {
  index: number;
  requirementId: string;
  ok: boolean;
  reason?: string;
  params?: Record<string, string | number>;
}

/** GET /teaching-blocks/:id/placements and the 200 of the PUT. */
export interface PlacementsOfBlock {
  placements: BlockPlacement[];
  /** One per lesson and post, in lesson order. */
  verdicts: BlockVerdict[];
  /** The key of the lessons as read: a save that carries it as `baseKey` is refused when they have changed since. */
  rowsKey: string;
  /** The block's lesson lengths, longest first, one per lesson: what the dialog offers, and how many lessons it can place of each. */
  lengths: number[];
}

/** One lesson as the PUT takes it. */
export interface BlockPlacementInput {
  dayOfWeek: number;
  startTime: string;
  minutes: number;
  /** Only the posts that chose a room; a post left out has its room chosen by the engine. */
  rooms: { requirementId: string; roomId: string }[];
}

/** The key of one block's read, under the prefix every write of förlagda lektioner invalidates (the week's board too). */
export const blockPlacementsKey = (blockId: string) => [...REQUIREMENT_PLACEMENTS_KEY, "block", blockId] as const;

export function fetchPlacementsOfBlock(blockId: string): Promise<PlacementsOfBlock> {
  return api.get<PlacementsOfBlock>(`/api/v1/teaching-blocks/${encodeURIComponent(blockId)}/placements`);
}

/**
 * Replaces the block's lessons with these (none removes them all). `baseKey` is the key the lessons were read with: the
 * gateway refuses (409 BLOCK_PLACEMENTS_STALE) when the block has been changed since, and nothing is written.
 */
export function saveBlockPlacements(
  blockId: string,
  placements: BlockPlacementInput[],
  baseKey: string,
): Promise<PlacementsOfBlock> {
  return api.put<PlacementsOfBlock>(`/api/v1/teaching-blocks/${encodeURIComponent(blockId)}/placements`, {
    placements,
    baseKey,
  });
}

/** After a write: the week's board, the marks and every read of a post's or a block's lessons are read again. */
export function invalidateBlockPlacements(client: QueryClient): Promise<void> {
  return client.invalidateQueries({ queryKey: REQUIREMENT_PLACEMENTS_KEY });
}

/**
 * Why a block cannot be placed at all, said before anything is saved (the gateway's BP409 rules that are about the block and not
 * about a lesson): FOLLOWER, the block takes another block's times and is placed through that one; EMPTY, no post sits a
 * lesson; SHARES, a post shares its lessons between teachers, which a block cannot do yet. In the order the trigger judges them.
 */
export type BlockCannotPlace = "FOLLOWER" | "EMPTY" | "SHARES";

export function blockCannotPlace(
  block: { sameTimesAsBlockId?: string | null },
  members: readonly { shares?: readonly unknown[] | null }[],
): BlockCannotPlace | null {
  if ((block.sameTimesAsBlockId ?? null) !== null) return "FOLLOWER";
  if (members.length === 0) return "EMPTY";
  if (members.some((member) => (member.shares ?? []).length > 0)) return "SHARES";
  return null;
}

/** The block's lengths as parts, longest first: [80, 40, 40] is 1 × 80 and 2 × 40. */
export function partsOfLengths(lengths: readonly number[]): { minutes: number; count: number }[] {
  const parts: { minutes: number; count: number }[] = [];
  for (const minutes of lengths) {
    const part = parts.find((one) => one.minutes === minutes);
    if (part) part.count += 1;
    else parts.push({ minutes, count: 1 });
  }
  return parts.sort((a, b) => b.minutes - a.minutes);
}

/**
 * What a 409 on a block's lessons says, or null for any other error:
 *
 *   - FIT: the lessons do not fit the block (BLOCK_PLACEMENTS_DO_NOT_FIT). `reason` is one of BP409's: FOLLOWER, EMPTY, SHARES,
 *     LENGTH, WEEKS, COUNT, MEMBER; `index` is the lesson's place in the list that was sent, for a rule that is about a lesson.
 *   - ROW: the first lesson of the first post the week does not hold (BLOCK_PLACEMENT_REFUSED): `index` is the lesson,
 *     `requirementId` the post of the block that clashes, `reason` the judge's and `params` the rest of what the sentence is
 *     written from.
 *   - STALE: the block's lessons have been changed since they were read (BLOCK_PLACEMENTS_STALE).
 */
export type BlockPlacementsRefusal =
  | { kind: "FIT"; reason: string; index: number | null }
  | { kind: "ROW"; index: number; requirementId: string; reason: string; params: Record<string, string | number> }
  | { kind: "STALE" };

export function blockPlacementsRefusal(error: unknown): BlockPlacementsRefusal | null {
  if (!(error instanceof ApiError) || error.status !== 409) return null;
  const params = error.params;
  if (error.code === "BLOCK_PLACEMENTS_STALE") return { kind: "STALE" };
  if (error.code === "BLOCK_PLACEMENTS_DO_NOT_FIT") {
    if (typeof params?.reason !== "string") return null;
    return { kind: "FIT", reason: params.reason, index: typeof params.index === "number" ? params.index : null };
  }
  if (error.code === "BLOCK_PLACEMENT_REFUSED") {
    if (typeof params?.reason !== "string" || typeof params.index !== "number" || typeof params.requirementId !== "string") {
      return null;
    }
    const { index, requirementId, reason, ...rest } = params;
    return { kind: "ROW", index, requirementId, reason: String(reason), params: rest };
  }
  return null;
}

/**
 * Why a set of lessons does not fit the block (or why the block cannot be placed at all: FOLLOWER, EMPTY, SHARES), in the
 * reader's language. `t` is the requirements.blockPlacements translator; `other` is the block this one follows, by name, for the
 * sentence that points at it. A rule this build has no sentence for (the gateway is deployed apart from the web) reads as the
 * general one.
 */
export function blockFitSentence(t: MessageLookup, reason: string, other = ""): string {
  const key = `fit.${reason}`;
  return t.has(key) ? t(key, { other }) : t("fit.UNKNOWN");
}
