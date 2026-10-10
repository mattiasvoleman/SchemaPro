"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { PUBLICATION_KEYS } from "@/lib/publication-keys";
import type { PublicLink, PublicLinkInput } from "@/lib/publication-types";

/*
 * Schemavisaren's share links and the teachers it never shows
 * (src/publication/public-links.controller.ts). Beside the one page that
 * uses them, for the bundle (lib/year-keys.ts says why).
 *
 * A link's token is in the create answer and nowhere else: the gateway keeps
 * only its sha256. So the list carries no address, and a lost link is revoked
 * and made again.
 */

export function usePublicLinks(academicYearId: string | null) {
  return useQuery({
    queryKey: [...PUBLICATION_KEYS.links, academicYearId],
    enabled: academicYearId !== null,
    retry: false,
    queryFn: () => api.get<PublicLink[]>(`/api/v1/public-links?academicYearId=${academicYearId}`),
  });
}

export function useCreatePublicLink() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: PublicLinkInput) =>
      api.post<{ link: PublicLink; token: string }>("/api/v1/public-links", input),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: PUBLICATION_KEYS.links }),
  });
}

export function useRevokePublicLink() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.post<PublicLink>(`/api/v1/public-links/${id}/revoke`),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: PUBLICATION_KEYS.links }),
  });
}

/** The ids of the teachers the viewer never names (TeacherPublicLabels.hidden). */
export function useHiddenTeachers() {
  return useQuery({
    queryKey: PUBLICATION_KEYS.hiddenTeachers,
    retry: false,
    queryFn: () => api.get<string[]>("/api/v1/teacher-public-labels"),
  });
}

export function useSetTeacherHidden() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ userId, hidden }: { userId: string; hidden: boolean }) =>
      api.put<{ userId: string; hidden: boolean }>(`/api/v1/teacher-public-labels/${userId}`, { hidden }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: PUBLICATION_KEYS.hiddenTeachers });
      // A hidden teacher's links stop resolving; the list says so (notShownBecause) after a refetch.
      void queryClient.invalidateQueries({ queryKey: PUBLICATION_KEYS.links });
    },
  });
}
