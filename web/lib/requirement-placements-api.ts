import type { QueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import {
  REQUIREMENT_PLACEMENTS_KEY,
  type PlacementInput,
  type PlacementsOfRequirement,
} from "@/lib/requirement-placements";

/*
 * One post's placed lessons, read and written: what only the dialog does
 * (components/timplan/placement-dialog.tsx), kept apart from the module the
 * timplan page imports for its mark (requirement-placements.ts), because the
 * page has no bytes to spare and the dialog is fetched on the first press of
 * Förlägg.
 */

/** The key of one post's read, under the prefix every write invalidates. */
export const placementsOfKey = (requirementId: string) =>
  [...REQUIREMENT_PLACEMENTS_KEY, "of", requirementId] as const;

/** One post's rows with their verdicts, judged now. */
export function fetchPlacementsOf(requirementId: string): Promise<PlacementsOfRequirement> {
  return api.get<PlacementsOfRequirement>(
    `/api/v1/teaching-requirements/${encodeURIComponent(requirementId)}/placements`,
  );
}

/**
 * Replaces the post's rows with these (none removes them all). Resolves with
 * the stored rows and their verdicts; a 409 rejects with an ApiError that
 * placementsRefusal reads, and then nothing was written.
 */
export function savePlacements(requirementId: string, placements: PlacementInput[]): Promise<PlacementsOfRequirement> {
  return api.put<PlacementsOfRequirement>(
    `/api/v1/teaching-requirements/${encodeURIComponent(requirementId)}/placements`,
    { placements },
  );
}

/** After a write: the year's marks and every post's read are read again. */
export function invalidatePlacements(client: QueryClient): Promise<void> {
  return client.invalidateQueries({ queryKey: REQUIREMENT_PLACEMENTS_KEY });
}
