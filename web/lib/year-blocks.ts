import { useQuery } from "@tanstack/react-query";
import { createClient } from "@/utils/supabase/client";
import type { TeachingBlock } from "@/lib/types";

/**
 * The year's parallel blocks, for the timplan dialog of a post in one.
 *
 * Under the key and with the columns the Block panel
 * (components/timplan/teaching-blocks.tsx) and the grundschema's block cards
 * (components/schedule/block-cards.tsx) read them with, so the three share
 * one cache and every write's invalidation of ["teachingBlocks", year]. A
 * module of its own, imported by the requirements page alone: in lib/queries
 * it would be copied into every route that chunk is split into.
 *
 * `enabled` false asks nothing.
 */
export function useYearBlocks(academicYearId: string | null, enabled: boolean) {
  return useQuery({
    queryKey: ["teachingBlocks", academicYearId],
    enabled: enabled && academicYearId !== null,
    queryFn: async () => {
      const { data, error } = await createClient()
        .from("TeachingBlocks")
        .select("id, academicYearId, name, sameTimesAsBlockId")
        .eq("academicYearId", academicYearId!)
        .order("name");
      if (error) throw error;
      return (data ?? []) as TeachingBlock[];
    },
  });
}

/**
 * A block and the block on the same times as it, either way round (Dela i
 * halvklass: the second period's block names the first's), by name; null
 * when it has none or is not in the list.
 */
export function blockPair(blocks: readonly TeachingBlock[], blockId: string): { block: string; other: string } | null {
  const own = blocks.find((block) => block.id === blockId);
  const other = own
    ? blocks.find((block) => block.id === own.sameTimesAsBlockId || block.sameTimesAsBlockId === own.id)
    : undefined;
  return own && other ? { block: own.name, other: other.name } : null;
}
