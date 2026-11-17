import type { BoardBlock, BoardKept, BoardMeal, BoardPlacement, BoardPost } from "@/lib/placement-board";
import { runsInWeek } from "@/lib/placement-weeks";

/*
 * Förlägg i veckan, one week picked (D2): what the week holds is what RUNS that week. A lesson whose weeks are odd does not
 * stand in an even week, a lesson that stops on the 18th of December does not stand in January, and a lesson that starts on
 * Wednesday of its first week does not stand on the Monday and Tuesday before it (runsInWeek asks for the lesson's own day).
 *
 * Only the CARDS are narrowed. The bricks, the lists under the week, the figures and the mirror that judges a drop are all
 * the whole year's, because a lesson is laid for its weeks and not for the week shown: the picker is a way of looking.
 *
 * Pure.
 */

export interface WeekCards {
  placements: BoardPlacement[];
  kept: BoardKept[];
  meals: BoardMeal[];
  blocks: BoardBlock[];
}

/** What a card's lesson needs of its post: the dates the post runs (a förläggning has none of its own). */
type PostWindow = Pick<BoardPost, "startDate" | "endDate">;

/** The cards of the week that starts on `monday`; every other field of `view` as it is. */
export function narrowToWeek<T extends WeekCards>(view: T, posts: ReadonlyMap<string, PostWindow>, monday: string): T {
  // Only the DATES of the post: a post is itself a thing with weeks (`recurrence`), and a spread of it would answer for its rows.
  const windowOf = (requirementId: string | undefined): PostWindow => {
    const found = requirementId === undefined ? undefined : posts.get(requirementId);
    return { startDate: found?.startDate ?? null, endDate: found?.endDate ?? null };
  };
  return {
    ...view,
    placements: view.placements.filter((row) => runsInWeek({ recurrence: row.recurrence, ...windowOf(row.requirementId) }, row.dayOfWeek, monday)),
    kept: view.kept.filter((lesson) => runsInWeek(lesson, lesson.dayOfWeek, monday)),
    // A meal has dates and no parity.
    meals: view.meals.filter((meal) => runsInWeek({ recurrence: "ALL_WEEKS", startDate: meal.startDate, endDate: meal.endDate }, meal.dayOfWeek, monday)),
    // A block's posts run the same weeks (TB409): the first member's dates are the block's, as the block's own line reads them.
    blocks: view.blocks.map((block) => ({
      ...block,
      rows: block.rows.filter((row) => runsInWeek({ recurrence: row.recurrence, ...windowOf(block.memberIds[0]) }, row.dayOfWeek, monday)),
    })),
  };
}
