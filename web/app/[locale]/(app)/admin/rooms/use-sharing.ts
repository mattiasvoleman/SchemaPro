"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";

/**
 * What the school shares with the other schools of its huvudman (Delade
 * lokaler och lärare, migration 20261217090000), through the gateway: the
 * minutes between the schools, the teachers they share and the room loans.
 * Here and not in lib/queries, which is in every app route's graph, for a
 * card one page shows (as use-sites.ts).
 */
export interface SiblingSchool {
  id: string;
  name: string;
  /** Minutes between the two schools, or null when neither has said. */
  travelMinutes: number | null;
  /** Whether this school wrote the figure last; null without one. */
  travelSetByUs: boolean | null;
}

export interface SharedTeacher {
  /** This school's own row of the teacher. */
  teacherId: string;
  firstName: string;
  lastName: string;
  schools: { id: string; name: string }[];
}

export interface Sharing {
  /** The other schools of the huvudman; empty for a school without one. */
  schools: SiblingSchool[];
  teachers: SharedTeacher[];
}

export type RoomLoanStatus = "PENDING" | "APPROVED" | "DECLINED" | "WITHDRAWN" | "REVOKED";

export interface RoomLoan {
  id: string;
  status: RoomLoanStatus;
  dayOfWeek: number;
  /** 'HH:MM'. */
  startTime: string;
  endTime: string;
  /** 'YYYY-MM-DD'. */
  startDate: string;
  endDate: string;
  note: string | null;
  createdAt: string;
  decidedAt: string | null;
  endedAt: string | null;
  /** The school's own room: the one lent, or the school's room for the one borrowed. */
  room: { id: string; name: string };
  /** The other school. */
  school: { id: string; name: string };
  /** For a borrowed room: the owner's name for it. */
  ownerRoomName: string | null;
  /** For a borrowed room: the owner's room, to ask for it again. */
  ownerRoomId: string | null;
}

export interface RoomLoans {
  lent: RoomLoan[];
  borrowed: RoomLoan[];
}

export interface LendableRoom {
  id: string;
  name: string;
  capacity: number | null;
  roomTypeName: string | null;
  /** The school's own room for it, when it has borrowed the room before. */
  localRoomId: string | null;
}

export interface LendableSchool {
  id: string;
  name: string;
  rooms: LendableRoom[];
}

export interface RoomLoanRequest {
  roomId: string;
  windows: { dayOfWeek: number; startTime: string; endTime: string }[];
  startDate: string;
  endDate: string;
  note?: string;
  localRoomName?: string;
}

export const SHARING_KEY = ["sharing"];
export const ROOM_LOANS_KEY = ["room-loans"];
export const LENDABLE_ROOMS_KEY = ["room-loans", "rooms"];

export function useSharing() {
  return useQuery({ queryKey: SHARING_KEY, queryFn: () => api.get<Sharing>("/api/v1/sharing") });
}

/** The loans, asked for only by a school with another school to share with. */
export function useRoomLoans(enabled: boolean) {
  return useQuery({ queryKey: ROOM_LOANS_KEY, queryFn: () => api.get<RoomLoans>("/api/v1/room-loans"), enabled });
}

/** The rooms the school may ask for, read when the dialog opens. */
export function useLendableRooms(enabled: boolean) {
  return useQuery({
    queryKey: LENDABLE_ROOMS_KEY,
    queryFn: () => api.get<LendableSchool[]>("/api/v1/room-loans/rooms"),
    enabled,
  });
}

/** The minutes to one other school; null removes the figure. */
export function useSaveSchoolTravel() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ schoolId, minutes }: { schoolId: string; minutes: number | null }) =>
      api.put<Sharing>(`/api/v1/sharing/travel/${schoolId}`, { minutes }),
    onSettled: () => void queryClient.invalidateQueries({ queryKey: SHARING_KEY }),
  });
}

export type RoomLoanAction = "approve" | "decline" | "withdraw" | "revoke";

/** An answer to a loan, or its end. The loans are read again either way. */
export function useRoomLoanAction() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, action }: { id: string; action: RoomLoanAction }) =>
      api.post<RoomLoans>(`/api/v1/room-loans/${id}/${action}`, {}),
    onSettled: () => void queryClient.invalidateQueries({ queryKey: ROOM_LOANS_KEY }),
  });
}

/**
 * A request: one loan per window. The first request for a room makes the
 * school's own room for it, so the rooms are read again too.
 */
export function useRequestRoomLoan() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: RoomLoanRequest) => api.post<RoomLoans>("/api/v1/room-loans", body),
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: ROOM_LOANS_KEY });
      void queryClient.invalidateQueries({ queryKey: ["rooms"] });
    },
  });
}

/** The statuses a loan still holds or asks for a room in. */
export const LIVE_STATUSES: readonly RoomLoanStatus[] = ["PENDING", "APPROVED"];

/** Pending first, then approved, then the ended ones; the newest first within each. */
export function byStatus(a: RoomLoan, b: RoomLoan): number {
  const rank = (loan: RoomLoan) => ["PENDING", "APPROVED", "DECLINED", "WITHDRAWN", "REVOKED"].indexOf(loan.status);
  return rank(a) - rank(b) || b.createdAt.localeCompare(a.createdAt);
}
