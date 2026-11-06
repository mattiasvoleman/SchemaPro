"use client";

import { useEffect } from "react";
import type { Socket } from "socket.io-client";
import { useQueryClient } from "@tanstack/react-query";
import { createClient } from "@/utils/supabase/client";
import { pageSchool } from "@/lib/school-choice";
import { CRISIS_KEYS } from "@/lib/crisis-keys";

/*
 * Krisläge's realtime, for the administration's live view and the teacher's
 * list alike.
 *
 * The gateway emits `crisis_updated` { alarmId, changedAt } to the staff room
 * when an alarm starts or ends and to the administrators' room at every mark
 * (src/realtime/realtime.types.ts). It names no pupil, no group and no
 * teacher, not even what changed: the page asks again, and the gateway answers
 * each reader by their own row-level security. So the whole handler is
 * "refetch every mounted read of the alarm".
 *
 * A socket that was gone and is back (`connect` after the first) may have
 * missed events, so it refetches too. socket.io-client is imported inside the
 * effect, as use-cover-realtime.ts does: ~13 KB gzipped that no route's first
 * load should carry. The pages poll as well (5 s while an alarm is open), so a
 * socket that never connects costs freshness, not correctness.
 */

const API_BASE_URL = process.env.NEXT_PUBLIC_API_BASE_URL;

export const CRISIS_UPDATED_EVENT = "crisis_updated";

/** The page's school, for a socket of a session with more than one (lib/school-choice.ts). */
const socketSchool = (): { school?: string } => {
  const school = pageSchool();
  return school ? { school } : {};
};

export function useCrisisRealtime(): void {
  const queryClient = useQueryClient();

  useEffect(() => {
    if (!API_BASE_URL) return undefined;
    let cancelled = false;
    let socket: Socket | null = null;

    void (async () => {
      try {
        const supabase = createClient();
        const { data } = await supabase.auth.getSession();
        const token = data.session?.access_token;
        if (!token || cancelled) return;

        const { io } = await import("socket.io-client");
        if (cancelled) return;

        const refetch = () => void queryClient.invalidateQueries({ queryKey: CRISIS_KEYS.all });
        socket = io(API_BASE_URL, { transports: ["websocket"], auth: { token, ...socketSchool() } });
        socket.on(CRISIS_UPDATED_EVENT, refetch);
        let connected = false;
        socket.on("connect", () => {
          if (connected) refetch();
          connected = true;
        });
      } catch {
        // No session, no network, no chunk: the polling carries the page.
      }
    })();

    return () => {
      cancelled = true;
      socket?.disconnect();
    };
  }, [queryClient]);
}
