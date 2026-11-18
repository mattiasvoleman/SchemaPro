import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import type { BoardBlock, BoardHold, LatestSchedule, PlacementBoard } from "@/lib/placement-board";
import { REQUIREMENT_PLACEMENTS_KEY, type PlacementWarning } from "@/lib/requirement-placements";

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
      const board = await api.get<
        Omit<PlacementBoard, "blocks" | "warnings" | "holds"> & { blocks?: BoardBlock[]; warnings?: PlacementWarning[]; holds?: BoardHold[] }
      >(`/api/v1/teaching-requirements/placements/board?academicYearId=${encodeURIComponent(academicYearId!)}`);
      // A gateway deployed before the blocks, the warnings or the holds were on the board has no such field: none, nothing to draw.
      return { ...board, blocks: board.blocks ?? [], warnings: board.warnings ?? [], holds: board.holds ?? [] };
    },
  });
}

/**
 * The latest schedule, behind the week when the school asks to see it (GET /teaching-requirements/placements/latest): the year's whole
 * machine-made schedule, so read only while "Visa senaste schemat" is on. Its own key, outside the prefix a write of förläggningar
 * invalidates: laying a lesson changes nothing in what the last Generera laid.
 */
export const latestScheduleKey = (academicYearId: string | null) => ["placementLatest", academicYearId] as const;

export function useLatestSchedule(academicYearId: string | null, wanted: boolean) {
  return useQuery({
    queryKey: latestScheduleKey(academicYearId),
    enabled: wanted && academicYearId !== null,
    // Turned off and on again within the minute draws from what was read: the year's whole schedule is not read at every press.
    staleTime: 60_000,
    queryFn: () => api.get<LatestSchedule>(`/api/v1/teaching-requirements/placements/latest?academicYearId=${encodeURIComponent(academicYearId!)}`),
  });
}
