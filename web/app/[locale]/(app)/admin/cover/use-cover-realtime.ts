"use client";

import { useEffect, useRef } from "react";
import type { Socket } from "socket.io-client";
import { useQueryClient } from "@tanstack/react-query";
import { createClient } from "@/utils/supabase/client";
import { ALL_COVER, COVER_KEYS } from "@/lib/cover-keys";
import { windowsOverlap } from "@/lib/cover-view";

/*
 * The board's realtime: two admins covering the same morning see each
 * other's decisions without reloading.
 *
 * The gateway emits `cover_board_updated` to admin:<school> after every cover
 * write, absence write and calendar-lesson operation has COMMITTED (review
 * amendment F), with the dates it touched and nothing else — no ids, no
 * names, no reason. The board refetches when those dates touch the window on
 * screen. `master_timetable_updated`, which admins already hear for a
 * publish, a regeneration and a DIRECT edit, can move lessons onto or off
 * the board, so it refetches too.
 *
 * socket.io-client is imported inside the effect, as use-timetable-realtime.ts
 * does: ~13KB gzipped that no route's first load should carry. The board polls
 * every two minutes as well (cover-queries.ts), so a socket that never
 * connects costs freshness, not correctness.
 */

const API_BASE_URL = process.env.NEXT_PUBLIC_API_BASE_URL;

export const COVER_BOARD_UPDATED_EVENT = "cover_board_updated";

/**
 * What an event refetches: the board, the register's counts and the counter
 * (one prefix), and an open "Tillsätt vikarie" list — another admin's
 * booking can take one of its candidates.
 */
export const REFETCHED_ON_EVENT = [ALL_COVER, COVER_KEYS.candidates] as const;
export const MASTER_TIMETABLE_UPDATED_EVENT = "master_timetable_updated";

/** What an event means for a board showing `window`: refetch, or not. */
export function shouldRefetch(
  event: string,
  payload: unknown,
  range: { from: string; to: string },
): boolean {
  if (event === MASTER_TIMETABLE_UPDATED_EVENT) return true;
  if (event !== COVER_BOARD_UPDATED_EVENT) return false;
  const changed = payload as { from?: unknown; to?: unknown } | null;
  if (!changed || typeof changed.from !== "string" || typeof changed.to !== "string") return true;
  return windowsOverlap({ from: changed.from, to: changed.to }, range);
}

export function useCoverRealtime(range: { from: string; to: string }): void {
  const queryClient = useQueryClient();
  // The listener outlives a change of day; it reads the window it shows now.
  const current = useRef(range);
  current.current = range;

  useEffect(() => {
    if (!API_BASE_URL) return undefined;
    let cancelled = false;
    let socket: Socket | null = null;

    void (async () => {
      const supabase = createClient();
      const { data } = await supabase.auth.getSession();
      const token = data.session?.access_token;
      if (!token || cancelled) return;

      const { io } = await import("socket.io-client");
      if (cancelled) return;

      socket = io(API_BASE_URL, { transports: ["websocket"], auth: { token } });
      for (const event of [COVER_BOARD_UPDATED_EVENT, MASTER_TIMETABLE_UPDATED_EVENT]) {
        socket.on(event, (payload: unknown) => {
          if (shouldRefetch(event, payload, current.current)) {
            for (const queryKey of REFETCHED_ON_EVENT) void queryClient.invalidateQueries({ queryKey });
          }
        });
      }
    })();

    return () => {
      cancelled = true;
      socket?.disconnect();
    };
  }, [queryClient]);
}
