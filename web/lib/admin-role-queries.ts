"use client";

import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import type { AdminProfile } from "@/lib/admin-areas";
import type { UserRole } from "@/lib/types";

// ---------------------------------------------------------------------------
// Roller i skolan: the administrators' profiles and a person's role history,
// read through the gateway (src/users). A module of its own, like
// lib/staffing-queries.ts, so only /admin/people pays for it.
// ---------------------------------------------------------------------------

/** An administrator's profile and HR-läs. */
export interface AdministratorProfile {
  id: string;
  adminProfile: AdminProfile;
  hrRead: boolean;
}

/** One change of a person's role, profile or HR-läs (UserRoleChanges). */
export interface RoleChange {
  id: string;
  fromRole: UserRole | null;
  toRole: UserRole;
  fromProfile: AdminProfile | null;
  toProfile: AdminProfile | null;
  fromHrRead: boolean | null;
  toHrRead: boolean;
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
