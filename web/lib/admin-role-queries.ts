"use client";

import { useQuery } from "@tanstack/react-query";
import { ApiError, api } from "@/lib/api";
import type { AdminProfile } from "@/lib/admin-areas";
import type { UserRole } from "@/lib/types";

// ---------------------------------------------------------------------------
// Roller i skolan: the administrators' profiles and a person's role history,
// read through the gateway (src/users). A module of its own, like
// lib/staffing-queries.ts, so only /admin/people pays for it.
// ---------------------------------------------------------------------------

/** An administrator's profile, HR-läs and whether the person also teaches (Users.teaches). */
export interface AdministratorProfile {
  id: string;
  adminProfile: AdminProfile;
  hrRead: boolean;
  /** Optional: a gateway older than the web does not send it, and `undefined` is false. */
  teaches?: boolean;
}

/** One change of a person's role, profile, HR-läs or mark as teaching (UserRoleChanges). */
export interface RoleChange {
  id: string;
  fromRole: UserRole | null;
  toRole: UserRole;
  fromProfile: AdminProfile | null;
  toProfile: AdminProfile | null;
  fromHrRead: boolean | null;
  toHrRead: boolean;
  /**
   * The mark before and after. `fromTeaches` is null for a row written before
   * the mark existed and for a person's creation, and `toTeaches` is false on
   * every older row: neither says the mark was ever taken off, and the history
   * writes nothing about them (an audit log is not filled in afterwards).
   * Optional for a gateway that does not send them.
   */
  fromTeaches?: boolean | null;
  toTeaches?: boolean;
  /** Who made it; null for an import, an upgrade or a writer since removed. */
  actorName: string | null;
  createdAt: string;
}

export const ADMIN_ROLE_KEYS = {
  administrators: ["people", "administrators"] as const,
  roleChanges: (userId: string) => ["people", "roleChanges", userId] as const,
};

/** The school's administrators by id. Under ["people"], so saving a person refreshes it. */
export function useAdministrators() {
  return useQuery({
    queryKey: ADMIN_ROLE_KEYS.administrators,
    queryFn: async () => {
      const rows = await api.get<AdministratorProfile[]>("/api/v1/users/administrators");
      return new Map(rows.map((row) => [row.id, row]));
    },
  });
}

/** A person's role history, newest first, read when their row is opened. */
export function useRoleChanges(userId: string | null) {
  return useQuery({
    queryKey: ADMIN_ROLE_KEYS.roleChanges(userId ?? ""),
    enabled: userId !== null,
    queryFn: () => api.get<RoleChange[]>(`/api/v1/users/${encodeURIComponent(userId!)}/role-changes`),
  });
}

/**
 * What the mark can be refused with (PATCH /users/:id with `teaches`): the
 * codes the gateway answers it with, each of which has a text of its own in
 * adminAreas.teaches.errors. 409 TEACHES_NEEDS_A_POST for a person with no
 * tjänst (the post is written first, then the mark), 400 for a person who is
 * no administrator, a läsare or a teacher, and WRITE_CONFLICT for a deadlock
 * the gateway lost (try again).
 */
export const TEACHES_ERRORS = [
  "TEACHES_NEEDS_A_POST",
  "TEACHES_NEEDS_AN_ADMINISTRATOR",
  "A_READER_DOES_NOT_TEACH",
  "A_TEACHER_TEACHES_ALREADY",
  "A_TEACHING_ADMINISTRATORS_LAST_POST_STAYS",
  "WRITE_CONFLICT",
] as const;

export type TeachesError = (typeof TEACHES_ERRORS)[number];

/** The code of a refused mark, or null for any other failure (which says what it says). */
export function teachesErrorOf(error: unknown): TeachesError | null {
  if (!(error instanceof ApiError)) return null;
  return TEACHES_ERRORS.find((code) => code === error.code) ?? null;
}
