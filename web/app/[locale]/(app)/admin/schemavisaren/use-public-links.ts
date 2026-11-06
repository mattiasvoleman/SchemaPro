"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { PUBLICATION_KEYS } from "@/lib/publication-keys";
import type { HiddenKind, HiddenTargets, PublicLink, PublicLinkInput } from "@/lib/publication-types";

/*
 * Schemavisaren's codes and links, and the schedules it never shows
 * (src/publication/public-links.controller.ts). Beside the one page that uses
 * them, for the bundle (lib/year-keys.ts says why).
 *
 * A link's code is in the create answer and nowhere else: the gateway keeps
 * only its sha256. So the list carries no address, and a lost code is revoked
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

/** The ids of the classes, groups, rooms and pupils hidden from the viewer one by one (PublicTimetableHidden). */
export function useHiddenTargets() {
  return useQuery({
    queryKey: PUBLICATION_KEYS.hiddenTargets,
    retry: false,
    queryFn: () => api.get<HiddenTargets>("/api/v1/viewer-hidden"),
  });
}

export function useSetTargetHidden() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ kind, id, hidden }: { kind: HiddenKind; id: string; hidden: boolean }) =>
      api.put<{ kind: HiddenKind; id: string; hidden: boolean }>(`/api/v1/viewer-hidden/${kind}/${id}`, { hidden }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: PUBLICATION_KEYS.hiddenTargets });
      void queryClient.invalidateQueries({ queryKey: PUBLICATION_KEYS.links });
    },
  });
}
