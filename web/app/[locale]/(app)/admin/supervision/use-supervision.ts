"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { STAFFING_KEYS } from "@/lib/staffing-keys";
import type { SupervisionArea, SupervisionRota, SupervisionShift } from "@/lib/supervision";

/**
 * Rastvaktsschema (migration 20261202090000), through the gateway: the tables
 * have no arm for a PostgREST session. Here and not in lib/queries, which is
 * in every app route's graph, for the one page that shows them.
 *
 * Every write reads the schedule again, and the load with it: a pass is an
 * uppdrag in the tjänstefördelning, and an area's countsAsTeaching moves
 * every pass on it into or out of the counted minutes.
 */
export const SUPERVISION_KEYS = {
  areas: ["supervisionAreas"],
  rota: ["supervisionRota"],
} as const;

export function useSupervisionAreas() {
  return useQuery({
    queryKey: SUPERVISION_KEYS.areas,
    queryFn: () => api.get<SupervisionArea[]>("/api/v1/supervision-areas"),
  });
}

export function useSupervisionRota(academicYearId: string | null) {
  return useQuery({
    queryKey: [...SUPERVISION_KEYS.rota, academicYearId],
    enabled: academicYearId !== null,
    queryFn: () =>
      api.get<SupervisionRota>(`/api/v1/supervision-rota?academicYearId=${encodeURIComponent(academicYearId!)}`),
  });
}

/** An area as the dialog saves it. */
export interface AreaBody {
  name: string;
  siteId: string | null;
  minGradeLevel: number | null;
  maxGradeLevel: number | null;
  duringRasts: boolean;
  duringLunch: boolean;
  guardsNeeded: number;
  countsAsTeaching: boolean;
}

/** A pass as the dialog saves it; the year only on a create. */
export interface ShiftBody {
  areaId: string;
  userId: string;
  dayOfWeek: number;
  startTime: string;
  endTime: string;
  validFrom: string | null;
  validTo: string | null;
  note: string | null;
}

function useInvalidate() {
  const queryClient = useQueryClient();
  return () => {
    for (const key of [SUPERVISION_KEYS.areas, SUPERVISION_KEYS.rota, STAFFING_KEYS.load]) {
      void queryClient.invalidateQueries({ queryKey: key });
    }
  };
}

export function useAreaMutations() {
  const invalidate = useInvalidate();
  const create = useMutation({
    mutationFn: (body: AreaBody) => api.post<SupervisionArea>("/api/v1/supervision-areas", body),
    onSuccess: invalidate,
  });
  const update = useMutation({
    mutationFn: ({ id, ...body }: AreaBody & { id: string }) =>
      api.patch<SupervisionArea>(`/api/v1/supervision-areas/${id}`, body),
    onSuccess: invalidate,
  });
  const remove = useMutation({
    mutationFn: (id: string) => api.delete(`/api/v1/supervision-areas/${id}`),
    onSuccess: invalidate,
  });
  return { create, update, remove };
}

export function useShiftMutations() {
  const invalidate = useInvalidate();
  const create = useMutation({
    mutationFn: (body: ShiftBody & { academicYearId: string }) =>
      api.post<SupervisionShift>("/api/v1/supervision-shifts", body),
    onSuccess: invalidate,
  });
  const update = useMutation({
    mutationFn: ({ id, ...body }: ShiftBody & { id: string }) =>
      api.patch<SupervisionShift>(`/api/v1/supervision-shifts/${id}`, body),
    onSuccess: invalidate,
  });
  const remove = useMutation({
    mutationFn: (id: string) => api.delete(`/api/v1/supervision-shifts/${id}`),
    onSuccess: invalidate,
  });
  return { create, update, remove };
}
