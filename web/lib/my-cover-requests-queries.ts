"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { AFTER_COVER_WRITE } from "@/lib/cover-keys";
import type { MyCover } from "@/lib/cover-request-types";

/*
 * Vikariefrågan, the colleague's side (CoverRequestsTeacherController, role
 * TEACHER only): the questions they were asked, the passes they hold, a yes, a
 * no and the tap on a pass.
 *
 * The gateway never says who is away or why, and nothing here asks. Used by
 * /teacher/franvaro alone, so it is its own module: no other route carries it.
 *
 * NOTHING HERE RETRIES: COVER_REQUEST_TAKEN is an answer ("a colleague said
 * yes first"), and a yes refused by a hard rule (COVER_REQUEST_RULE) leaves the
 * request open for the others. Every answer, refused or not, reads the list
 * again, since a refusal almost always means it moved.
 */

const MINE = ["coverRequestsMine"] as const;

export function useMyCover() {
  return useQuery({
    queryKey: MINE,
    retry: false,
    // No socket reaches a teacher; a push or the bell sends them here, and
    // an open page asks again once a minute for the yes someone else gave.
    refetchInterval: 60_000,
    queryFn: () => api.get<MyCover>("/api/v1/cover-requests/mine"),
  });
}

function useRefresh() {
  const queryClient = useQueryClient();
  return (keys: readonly (readonly string[])[] = [MINE]) => {
    for (const queryKey of keys) void queryClient.invalidateQueries({ queryKey });
  };
}

export function useAnswerCoverRequest() {
  const refresh = useRefresh();
  // A yes that places the teacher moves their week; a no or a refusal only the list.
  const accept = useMutation({
    mutationFn: (requestId: string) =>
      api.post<{ requestId: string; lessons: number }>(`/api/v1/cover-requests/${requestId}/accept`),
    onSettled: (_data, error) => refresh(error ? [MINE] : [MINE, ...AFTER_COVER_WRITE]),
  });
  const decline = useMutation({
    mutationFn: (requestId: string) => api.post<{ requestId: string }>(`/api/v1/cover-requests/${requestId}/decline`),
    onSettled: () => refresh(),
  });
  return { accept, decline };
}

/** The tap on a pass: idempotent. */
export function useConfirmPass() {
  const refresh = useRefresh();
  return useMutation({
    mutationFn: (lessonId: string) =>
      api.post<{ lessonId: string; confirmed: number }>(`/api/v1/cover-requests/lessons/${lessonId}/confirm`),
    onSettled: () => refresh(),
  });
}
