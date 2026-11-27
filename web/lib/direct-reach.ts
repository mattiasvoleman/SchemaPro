import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api, ApiError } from "@/lib/api";
import { PUBLICATION_KEYS } from "@/lib/publication-keys";
import type { PublishMode } from "@/lib/publication-types";

/*
 * FRÅGAN FÖRE EN ÄNDRING I DIREKT SOM NÅR FAMILJER (P5, beslut 8): the web's half of src/publication/direct-reach.ts.
 *
 * In Direkt an edit of the grundschema moves the published lessons in the calendar at once, and the pupils of the lesson and their
 * guardians get a notice. The school is asked once, before the first change that can reach them, and the answer is kept by the
 * gateway (PublicationSettings.directReachAcknowledgedAt) until the school switches mode.
 *
 * `ask` is what the page reads before a drag (use-direct-reach-ask.tsx asks the question); the gateway asks again on its own
 * when an edit reached published lessons and the school had not answered (DIRECT_REACH_UNANSWERED, a 409 that rolls the edit back), so a
 * stale page or a second tab is asked too, never let past. This file is data and no component: the question's dialog is its own chunk.
 */

/** The gateway's code for a change that reached published lessons before the school had answered (src/publication/direct-reach.ts). */
export const DIRECT_REACH_UNANSWERED = "DIRECT_REACH_UNANSWERED";

export interface DirectReach {
  academicYearId: string | null;
  mode: PublishMode;
  /** The publication that still holds, as the question names it. */
  period: { from: string; to: string } | null;
  acknowledgedAt: string | null;
  /** Direkt, a publication that still holds, and no answer yet. */
  ask: boolean;
  /** How many can get a notice, counted: the school's pupils and the guardians of an active pupil. Null when nothing is asked. */
  audience: { pupils: number; guardians: number } | null;
}

export const DIRECT_REACH_KEY = PUBLICATION_KEYS.directReach;

/** The reader said no: Avbryt, or the dialog was closed. Not a failure, so nothing says it. */
export class DirectReachDeclined extends Error {
  constructor() {
    super("DIRECT_REACH_DECLINED");
    this.name = "DirectReachDeclined";
  }
}

export const isDirectReachRefusal = (error: unknown): error is ApiError =>
  error instanceof ApiError && error.status === 409 && error.code === DIRECT_REACH_UNANSWERED;

export function fetchDirectReach(): Promise<DirectReach> {
  return api.get<DirectReach>("/api/v1/publication-settings/direct-reach");
}

/** "Fortsätt i Direkt": the school answers for itself. Needs the area Publicering, which the gateway says when it is missing. */
export function useAcknowledgeDirectReach() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (academicYearId: string | null) =>
      api.post<DirectReach>("/api/v1/publication-settings/direct-reach/acknowledge", academicYearId ? { academicYearId } : {}),
    onSuccess: (view) => queryClient.setQueryData(DIRECT_REACH_KEY, view),
  });
}
