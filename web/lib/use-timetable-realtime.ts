"use client";

// Realtime collaboration for the timetable editor.
//
// Connects to the NestJS socket.io gateway (Supabase access token in the
// handshake), announces what the current admin is editing (soft edit-locks),
// receives the school-wide presence roster, and refetches the master
// timetable whenever any collaborator changes it.

import { useCallback, useEffect, useRef, useState } from "react";
import type { Socket } from "socket.io-client";
import { useQueryClient } from "@tanstack/react-query";
import { createClient } from "@/utils/supabase/client";

// socket.io-client is ~12.9KB gzipped and only the timetable editor uses it.
// Importing it lazily inside the effect keeps it out of that route's initial
// payload — the connection is established after mount anyway, so nothing waits
// on it that was not already waiting. `import type` above erases at compile
// time and costs nothing.

export interface TimetablePeer {
  userId: string;
  /** Display label ("First L."), never an email. */
  label: string;
  editingLessonId: string | null;
}

const API_BASE_URL = process.env.NEXT_PUBLIC_API_BASE_URL;

export function useTimetableRealtime(): {
  peers: TimetablePeer[];
  setEditing: (editingLessonId: string | null) => void;
} {
  const queryClient = useQueryClient();
  const socketRef = useRef<Socket | null>(null);
  const [peers, setPeers] = useState<TimetablePeer[]>([]);

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
      // The dynamic import is a second await point, so re-check: the component
      // may have unmounted while the chunk was in flight.
      if (cancelled) return;

      socket = io(API_BASE_URL, {
        transports: ["websocket"],
        auth: { token },
      });
      socketRef.current = socket;

      socket.on("timetable_presence", (payload: { peers?: TimetablePeer[] }) => {
        setPeers(payload.peers ?? []);
      });
      socket.on("master_timetable_updated", () => {
        void queryClient.invalidateQueries({ queryKey: ["masterLessons"] });
        void queryClient.invalidateQueries({ queryKey: ["calendarLessons"] });
        void queryClient.invalidateQueries({ queryKey: ["scheduleVersions"] });
      });
      // Announce presence (no lesson open yet).
      socket.emit("timetable:presence", { editingLessonId: null });
    })();

    return () => {
      cancelled = true;
      socketRef.current = null;
      socket?.disconnect();
    };
  }, [queryClient]);

  const setEditing = useCallback((editingLessonId: string | null) => {
    socketRef.current?.emit("timetable:presence", { editingLessonId });
  }, []);

  return { peers, setEditing };
}
