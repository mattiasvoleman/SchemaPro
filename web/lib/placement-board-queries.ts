import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import type { BoardBlock, PlacementBoard } from "@/lib/placement-board";
import { REQUIREMENT_PLACEMENTS_KEY } from "@/lib/requirement-placements";

/*
 * The year's week of förläggningar, read (GET /teaching-requirements/
 * placements/board). Its own file, beside lib/queries.ts, which is in every
 * route's chunk graph and has nothing to spare.
 *
 * The key sits under the prefix every write of a post's förläggningar
 * invalidates (REQUIREMENT_PLACEMENTS_KEY), so a save in the dialog on the
 * timplan reads the week again when the page is open beside it.
 */

export const placementBoardKey = (academicYearId: string | null) =>
  [...REQUIREMENT_PLACEMENTS_KEY, "board", academicYearId] as const;

export function usePlacementBoard(academicYearId: string | null) {
  return useQuery({
    queryKey: placementBoardKey(academicYearId),
    enabled: academicYearId !== null,
    queryFn: async (): Promise<PlacementBoard> => {
      const board = await api.get<Omit<PlacementBoard, "blocks"> & { blocks?: BoardBlock[] }>(
        `/api/v1/teaching-requirements/placements/board?academicYearId=${encodeURIComponent(academicYearId!)}`,
      );
      // A gateway deployed before the blocks were on the board has no such field: no block, nothing to draw.
      return { ...board, blocks: board.blocks ?? [] };
    },
  });
}
