"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";

/*
 * Släppta poster (src/staffing/engine-release.controller.ts): the timplansposter a school has released so that Föreslå
 * bemanning may give them to another teacher. GET lists a year's, PUT sets or takes back any number of them by post id.
 *
 * A module of its own for the bundle, as lib/staffing-queries.ts is: only the card on tjänstefördelningen reads these,
 * and that card is React.lazy, so this loads with it and no route names it. The key is not in lib/staffing-keys.ts for
 * the reason that file gives: nothing outside this card needs to invalidate it, and the dialog's apply leaves the
 * releases as they were.
 */

/** The prefix react-query invalidates on; the full key carries the läsår. */
export const ENGINE_RELEASE_KEY = ["engineReleases"] as const;

/** The gateway's code for a post named in a release that is not the year's (400, params `{ count }`). */
export const ENGINE_RELEASE_POST_NOT_IN_YEAR = "ENGINE_RELEASE_POST_NOT_IN_YEAR";

/** One released post: when, and by whom (null once the person has been removed). */
export interface EngineRelease {
  requirementId: string;
  releasedAt: string;
  releasedById: string | null;
}

export interface EngineReleaseList {
  releases: EngineRelease[];
}

export interface SetEngineReleaseBody {
  academicYearId: string;
  /** 1..5000 distinct post ids of that year. */
  requirementIds: string[];
  released: boolean;
}

export interface EngineReleaseResult {
  /** Posts whose state changed. */
  changed: number;
  /** Posts that were in the state asked for already. */
  unchanged: number;
}

export function useEngineReleases(academicYearId: string | null) {
  return useQuery({
    queryKey: [...ENGINE_RELEASE_KEY, academicYearId],
    enabled: academicYearId !== null,
    queryFn: () =>
      api.get<EngineReleaseList>(`/api/v1/staffing/engine-release?academicYearId=${encodeURIComponent(academicYearId!)}`),
  });
}

/**
 * Releases the posts, or takes the release back. Idempotent on the gateway, so a second press changes nothing.
 *
 * The list is read again whatever the outcome, and the mutation stays pending until it has been: a 400 means a post is
 * not the year's after all and a 409 that somebody else holds the year, and either way the card must not go on showing
 * what it believed. Returning the promise is what keeps the switches busy until the new list is in.
 */
export function useSetEngineRelease() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: SetEngineReleaseBody) => api.put<EngineReleaseResult>("/api/v1/staffing/engine-release", body),
    onSettled: () => queryClient.invalidateQueries({ queryKey: ENGINE_RELEASE_KEY }),
  });
}
