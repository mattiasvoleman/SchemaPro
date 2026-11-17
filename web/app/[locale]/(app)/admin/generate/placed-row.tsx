"use client";

import { useEffect, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { Link } from "@/i18n/navigation";
import { usePlacementBoard } from "@/lib/placement-board-queries";
import { placedCountOf } from "@/lib/placed-count";
import { placementLinkOf } from "@/lib/placement-link";
import { REQUIREMENT_PLACEMENTS_KEY } from "@/lib/requirement-placements";

/*
 * BEFORE THE RUN: how many lessons lie fixed, and how many of those no longer hold (grafisk förläggning, A3).
 *
 * A help and never a gate. The week's board is read as the week reads it; a read that failed or has not come draws nothing,
 * and nothing here keeps a run from starting (the gateway says no to a förläggning that does not hold, by name, and the
 * refusal below links to its card). No förläggning, no row. The board is read again when a run ends, so that "no longer holds"
 * is true after a refusal that named one.
 */
export function PlacedRow({ yearId, yearIsActive, running }: { yearId: string | null; yearIsActive: boolean; running: boolean }) {
  const t = useTranslations("generate.placed");
  const queryClient = useQueryClient();
  const board = usePlacementBoard(yearId);

  const wasRunning = useRef(running);
  useEffect(() => {
    if (wasRunning.current && !running) void queryClient.invalidateQueries({ queryKey: REQUIREMENT_PLACEMENTS_KEY });
    wasRunning.current = running;
  }, [running, queryClient]);

  if (!board.data) return null;
  const { fixed, failing } = placedCountOf(board.data);
  if (fixed === 0 && failing === 0) return null;
  return (
    <p className="mr-auto max-w-prose text-sm text-foreground" data-testid="generate-placed">
      {fixed > 0 ? <>{t("fixed", { count: fixed })} </> : null}
      <Link href={placementLinkOf({ yearId: yearIsActive ? null : yearId })} className="underline underline-offset-4">
        {t("toWeek")}
      </Link>
      {failing > 0 ? <span className="mt-1 block font-medium" data-testid="generate-placed-failing">{t("failing", { count: failing })}</span> : null}
    </p>
  );
}
