"use client";

import { useMutation, useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { ALL_COVER, COVER_KEYS } from "@/lib/cover-keys";
import type { BoardRequest, CoverRequestInput, Fairness } from "@/lib/cover-request-types";
import type { Candidates } from "@/lib/cover-types";

/*
 * Vikariefrågan, the school's side (src/cover/cover-requests.controller.ts,
 * CoverRequestsAdminController): ask colleagues, take the question back, the
 * fairness view, and the ranked colleagues for several lessons at once.
 *
 * A request itself is read off the board (GET /cover/board: requests,
 * confirmations), so it travels with the board's own key and the board's
 * realtime refetch. Beside lib/cover-queries.ts rather than in it, for the
 * bundle: /admin/cover is the only route that sends a request, and
 * /teacher/franvaro, which shares cover-queries.ts, must not carry these.
 *
 * NOTHING HERE RETRIES A WRITE OR A 409: COVER_REQUEST_EXISTS and
 * COVER_REQUEST_LESSON_COVERED mean "the board has moved, read it again", and
 * a write that settles in either direction does read it again.
 */

function useInvalidateBoard() {
  const queryClient = useQueryClient();
  return () => {
    // The board (with its requests), the register's counts and the counter
    // share a prefix; the candidates a request was chosen from move with them.
    for (const queryKey of [ALL_COVER, COVER_KEYS.candidates]) void queryClient.invalidateQueries({ queryKey });
  };
}

export function useCoverRequestActions() {
  const invalidate = useInvalidateBoard();
  const create = useMutation({
    mutationFn: (input: CoverRequestInput) => api.post<BoardRequest>("/api/v1/cover/requests", input),
    onSettled: invalidate,
  });
  const withdraw = useMutation({
    mutationFn: (requestId: string) => api.post<BoardRequest>(`/api/v1/cover/requests/${requestId}/withdraw`),
    onSettled: invalidate,
  });
  return { create, withdraw };
}

/**
 * "Rättvisa": per colleague, how many requests they were asked, said yes and
 * no to over a period. Under the board's `coverBoard` prefix, so a request
 * sent or answered refreshes it with the board.
 */
export function useCoverFairness(from: string, to: string, enabled = true) {
  return useQuery({
    queryKey: ["coverBoard", "fairness", from, to],
    enabled,
    retry: false,
    queryFn: () => api.get<Fairness>(`/api/v1/cover/fairness?from=${from}&to=${to}`),
  });
}

/**
 * The ranked colleagues of each lesson of a request, under the same keys as
 * the candidates dialog (so a list it has just read is not asked for again).
 */
export function useLessonsCandidates(lessonIds: readonly string[]) {
  return useQueries({
    queries: lessonIds.map((lessonId) => ({
      queryKey: [...COVER_KEYS.candidates, lessonId],
      retry: false,
      queryFn: () => api.get<Candidates>(`/api/v1/cover/lessons/${lessonId}/candidates`),
    })),
  });
}
