"use client";

import { useMutation, useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { api, ApiError } from "@/lib/api";
import { pageSchool, schoolHeaders } from "@/lib/school-choice";
import { createClient } from "@/utils/supabase/client";
import {
  utilisationFilename,
  utilisationQuery,
  type ExternalBookingDetail,
  type ExternalBookingResult,
  type ExternalBookingSummary,
  type ExternalClashResponse,
  type ExternalCreateBody,
  type ExternalPreviewResponse,
  type ExternalRuleBody,
  type ExternalState,
  type ExternalUpdateBody,
  type ResourceAvailabilityResponse,
  type ResourceBody,
  type ResourceBookingBody,
  type ResourceBookingResponse,
  type ResourceBookingResult,
  type ResourceResponse,
  type ResourceTypeBody,
  type ResourceTypeResponse,
  type UtilisationParams,
  type UtilisationResponse,
} from "@/lib/local";
import type { RoomBookingStatus } from "@/lib/types";

// ---------------------------------------------------------------------------
// Lokal: resurser, externa bokare and utnyttjande, through the gateway.
//
// Not PostgREST: the tables are read and written by the gateway's role alone
// (`authenticated` and `anon` have no grant on them), and a series carries the
// contact of somebody who has no login.
//
// A module of its own, not lib/queries.ts: that one is shared by 37 routes and
// sits on the chunker's merge edge, so a hook added to it is a cost on all of
// them (the reason lib/ack-queries.ts gives, whose shape this follows: its own
// key roots, plain useQuery, no useInfiniteQuery).
//
// What each reader gets is the gateway's say, and the database's under it: the
// resource lists are the staff's, a resource and a type are written by Planering,
// a booking by a teacher (their own) or Drift, a series and the report by an
// administrator.
//
// The contact of a series is personal data about somebody who has no login. Its
// reads are not kept once nothing shows them (gcTime 0), and no error, toast or
// key here ever carries a value of it.
// ---------------------------------------------------------------------------

const ROOT = ["local"] as const;
export const LOCAL_KEYS = {
  all: ROOT,
  resourceTypes: [...ROOT, "resource-types"] as const,
  resources: [...ROOT, "resources"] as const,
  /** The root of every availability window; a window is `[...availability, from, to]`. */
  availability: [...ROOT, "availability"] as const,
  /** The root of every list of resource bookings. */
  resourceBookings: [...ROOT, "resource-bookings"] as const,
  resourceBookingsByStatus: (status: RoomBookingStatus) => [...ROOT, "resource-bookings", "status", status] as const,
  myResourceBookings: [...ROOT, "resource-bookings", "mine"] as const,
  /** The root of everything about the series: the lists, a series, the flags. */
  external: [...ROOT, "external"] as const,
  externalList: (state: ExternalState) => [...ROOT, "external", "list", state] as const,
  externalDetail: (id: string) => [...ROOT, "external", "detail", id] as const,
  externalClashes: [...ROOT, "external", "clashes"] as const,
  utilisation: [...ROOT, "utilisation"] as const,
};

const enc = encodeURIComponent;

// ---- Resource types and resources

/** The school's own kinds of resource, with how many resources each has. */
export function useResourceTypes() {
  return useQuery({
    queryKey: LOCAL_KEYS.resourceTypes,
    queryFn: () => api.get<ResourceTypeResponse[]>("/api/v1/resource-types"),
  });
}

export function useResources() {
  return useQuery({
    queryKey: LOCAL_KEYS.resources,
    queryFn: () => api.get<ResourceResponse[]>("/api/v1/resources"),
  });
}

/**
 * The resources, and how many of each nobody holds at any minute of the window.
 * Read when both ends are known; read again whenever the page asks (a booking
 * by somebody else moves the figure, so nothing is kept fresh for long).
 */
export function useResourceAvailability(from: string | null, to: string | null) {
  return useQuery({
    queryKey: [...LOCAL_KEYS.availability, from, to],
    enabled: from !== null && to !== null,
    staleTime: 0,
    queryFn: () =>
      api.get<ResourceAvailabilityResponse[]>(`/api/v1/resources/availability?from=${enc(from ?? "")}&to=${enc(to ?? "")}`),
  });
}

/**
 * A kind or a resource changed: both lists (a type's count is its resources'),
 * what is free in a window, and the report, which names the resources.
 */
function invalidateResources(queryClient: QueryClient) {
  for (const key of [LOCAL_KEYS.resourceTypes, LOCAL_KEYS.resources, LOCAL_KEYS.availability, LOCAL_KEYS.utilisation]) {
    void queryClient.invalidateQueries({ queryKey: key });
  }
}

export function useResourceTypeActions() {
  const queryClient = useQueryClient();
  const settled = () => invalidateResources(queryClient);
  const create = useMutation({
    mutationFn: (body: ResourceTypeBody) => api.post<ResourceTypeResponse>("/api/v1/resource-types", body),
    onSettled: settled,
  });
  const update = useMutation({
    mutationFn: ({ id, ...body }: ResourceTypeBody & { id: string }) =>
      api.patch<ResourceTypeResponse>(`/api/v1/resource-types/${enc(id)}`, body),
    onSettled: settled,
  });
  const remove = useMutation({
    mutationFn: (id: string) => api.delete<void>(`/api/v1/resource-types/${enc(id)}`),
    onSettled: settled,
  });
  return { create, update, remove };
}

export function useResourceActions() {
  const queryClient = useQueryClient();
  const settled = () => invalidateResources(queryClient);
  const create = useMutation({
    mutationFn: (body: ResourceBody) => api.post<ResourceResponse>("/api/v1/resources", body),
    onSettled: settled,
  });
  const update = useMutation({
    mutationFn: ({ id, ...body }: ResourceBody & { id: string }) =>
      api.patch<ResourceResponse>(`/api/v1/resources/${enc(id)}`, body),
    onSettled: settled,
  });
  const remove = useMutation({
    mutationFn: (id: string) => api.delete<void>(`/api/v1/resources/${enc(id)}`),
    onSettled: settled,
  });
  return { create, update, remove };
}

// ---- Bookings of resources

/** An administrator's list of bookings in one state, the newest 200, with the booker's name. */
export function useResourceBookings(status: RoomBookingStatus) {
  return useQuery({
    queryKey: LOCAL_KEYS.resourceBookingsByStatus(status),
    queryFn: () => api.get<ResourceBookingResponse[]>(`/api/v1/resource-bookings?status=${enc(status)}`),
  });
}

/** The reader's own bookings. */
export function useMyResourceBookings() {
  return useQuery({
    queryKey: LOCAL_KEYS.myResourceBookings,
    queryFn: () => api.get<ResourceBookingResponse[]>("/api/v1/resource-bookings?mine=true"),
  });
}

export function useResourceBookingActions() {
  const queryClient = useQueryClient();
  // Settled, not succeeded: a refusal for a quantity that was taken says the figure on screen is old.
  const settled = () => {
    for (const key of [LOCAL_KEYS.resourceBookings, LOCAL_KEYS.availability, LOCAL_KEYS.utilisation]) {
      void queryClient.invalidateQueries({ queryKey: key });
    }
  };
  const book = useMutation({
    mutationFn: (body: ResourceBookingBody) => api.post<ResourceBookingResult>("/api/v1/resource-bookings", body),
    onSettled: settled,
  });
  const cancel = useMutation({
    mutationFn: (id: string) => api.patch<ResourceBookingResult>(`/api/v1/resource-bookings/${enc(id)}/cancel`, {}),
    onSettled: settled,
  });
  const decide = useMutation({
    mutationFn: ({ id, status, note }: { id: string; status: "APPROVED" | "REJECTED"; note?: string }) =>
      api.patch<ResourceBookingResult>(`/api/v1/resource-bookings/${enc(id)}/decide`, {
        status,
        ...(note ? { note } : {}),
      }),
    onSettled: settled,
  });
  return { book, cancel, decide };
}

// ---- External bookings

/** The series in one state, with the contact of each. Not kept once nothing shows them. */
export function useExternalBookings(state: ExternalState) {
  return useQuery({
    queryKey: LOCAL_KEYS.externalList(state),
    gcTime: 0,
    queryFn: () => api.get<ExternalBookingSummary[]>(`/api/v1/external-bookings?state=${enc(state)}`),
  });
}

/** One series with its days. Read when opened, and not kept. */
export function useExternalBooking(id: string | null) {
  return useQuery({
    queryKey: LOCAL_KEYS.externalDetail(id ?? ""),
    enabled: id !== null,
    gcTime: 0,
    staleTime: 0,
    queryFn: () => api.get<ExternalBookingDetail>(`/api/v1/external-bookings/${enc(id ?? "")}`),
  });
}

/** The days that stand in a room that has a lesson: the expedition's flag list. */
export function useExternalClashes() {
  return useQuery({
    queryKey: LOCAL_KEYS.externalClashes,
    gcTime: 0,
    queryFn: () => api.get<ExternalClashResponse[]>("/api/v1/external-bookings/clashes"),
  });
}

/**
 * A series, or a day of one, changed. A day is a booking of a lokal or of a
 * resource: the lists the teachers and Lokalbokningar read, what is free and
 * the report move with it. The room bookings are lib/queries.ts's, whose roots
 * are named here and not imported, so this module does not pull that one in.
 */
function invalidateExternal(queryClient: QueryClient) {
  for (const key of [
    LOCAL_KEYS.external,
    LOCAL_KEYS.resourceBookings,
    LOCAL_KEYS.availability,
    LOCAL_KEYS.utilisation,
    ["roomBookings"],
    ["myRoomBookings"],
  ]) {
    void queryClient.invalidateQueries({ queryKey: key });
  }
}

export function useExternalBookingActions() {
  const queryClient = useQueryClient();
  const settled = () => invalidateExternal(queryClient);
  /** Writes nothing: what the days of a rule would meet. */
  const preview = useMutation({
    mutationFn: (rule: ExternalRuleBody) => api.post<ExternalPreviewResponse>("/api/v1/external-bookings/preview", rule),
  });
  const create = useMutation({
    mutationFn: (body: ExternalCreateBody) => api.post<ExternalBookingResult>("/api/v1/external-bookings", body),
    onSettled: settled,
  });
  const update = useMutation({
    mutationFn: ({ id, ...body }: ExternalUpdateBody & { id: string }) =>
      api.patch<ExternalBookingSummary>(`/api/v1/external-bookings/${enc(id)}`, body),
    onSettled: settled,
  });
  const cancelSeries = useMutation({
    mutationFn: (id: string) => api.patch<ExternalBookingSummary>(`/api/v1/external-bookings/${enc(id)}/cancel`, {}),
    onSettled: settled,
  });
  const cancelDay = useMutation({
    mutationFn: ({ id, dayId }: { id: string; dayId: string }) =>
      api.patch<unknown>(`/api/v1/external-bookings/${enc(id)}/days/${enc(dayId)}/cancel`, {}),
    onSettled: settled,
  });
  /** Removes a series that is over or cancelled, with its days; the gateway refuses one that is running. */
  const remove = useMutation({
    mutationFn: (id: string) => api.delete<void>(`/api/v1/external-bookings/${enc(id)}`),
    onSettled: settled,
  });
  return { preview, create, update, cancelSeries, cancelDay, remove };
}

// ---- Utnyttjande

/** The report. A period of a term across every room is a heavy read: only the applied form is asked. */
export function useUtilisation(params: UtilisationParams | null) {
  return useQuery({
    queryKey: [...LOCAL_KEYS.utilisation, params],
    enabled: params !== null,
    staleTime: 60_000,
    queryFn: () => api.get<UtilisationResponse>(`/api/v1/utilisation?${utilisationQuery(params as UtilisationParams)}`),
  });
}

/**
 * The report as a file, saved by the browser under the name the gateway gives
 * it. The body is CSV, not the JSON the rest of the client carries, so this
 * sends what the client sends (the session's token, the school the page was
 * drawn for) and reads the answer as a Blob, as lib/school-export.ts does for
 * its file. The web is another origin, so Content-Disposition cannot be read:
 * the name is composed here the same way.
 */
export async function downloadUtilisationCsv(params: UtilisationParams): Promise<void> {
  const base = process.env.NEXT_PUBLIC_API_BASE_URL?.replace(/\/+$/, "");
  if (!base) throw new ApiError(0, "NEXT_PUBLIC_API_BASE_URL is not configured.");
  const {
    data: { session },
  } = await createClient().auth.getSession();
  if (!session) throw new ApiError(401, "Not authenticated.");
  const response = await fetch(`${base}/api/v1/utilisation/csv?${utilisationQuery(params)}`, {
    headers: { Authorization: `Bearer ${session.access_token}`, ...schoolHeaders(pageSchool()) },
  });
  if (!response.ok) {
    let detail = `HTTP ${response.status}`;
    let code: string | undefined;
    try {
      const problem = (await response.json()) as { detail?: string; message?: string; code?: unknown };
      detail = problem.detail ?? problem.message ?? detail;
      if (typeof problem.code === "string") code = problem.code;
    } catch {
      // A body that is not JSON: keep the status.
    }
    throw new ApiError(response.status, detail, code);
  }
  const blob = await response.blob();
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = utilisationFilename(params.from, params.to);
  anchor.click();
  URL.revokeObjectURL(url);
}
