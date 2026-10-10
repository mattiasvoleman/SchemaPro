"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import type { BulkInvitationReport } from "@/lib/queries";
import { AFTER_APPLY, INTEGRATION_KEYS } from "./query-keys";
import {
  INVITE_CHUNK,
  type ApplyInput,
  type ChangesPage,
  type ProvisioningPerson,
  type RunMode,
  type SyncChange,
  type SyncRun,
} from "./ss12000-types";

/*
 * The sync's runs, their diffs, the apply and the provisioning list
 * (src/integration/ss12000-sync/ss12000-sync.service.ts). Nothing here
 * changes a person or a class except useApplyRun, which is the admin's
 * explicit apply of a diff they reviewed, and useInviteSelected, which is the
 * existing invitation endpoint the people register uses.
 */

/** How often the history is re-read while a run is fetching. */
export const RUN_POLL_MS = 3000;

export function useSyncRuns(enabled: boolean) {
  return useQuery({
    queryKey: INTEGRATION_KEYS.runs,
    enabled,
    retry: false,
    queryFn: () => api.get<SyncRun[]>("/api/v1/ss12000-sync/runs?limit=20"),
    // A manual run answers 202 and fetches in the background: poll until it lands.
    refetchInterval: (query) =>
      (query.state.data ?? []).some((run) => run.status === "RUNNING") ? RUN_POLL_MS : false,
  });
}

export function useStartRun() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (mode: RunMode) =>
      api.post<{ runId: string; mode: RunMode }>("/api/v1/ss12000-sync/runs", { mode }),
    onSettled: () => void queryClient.invalidateQueries({ queryKey: INTEGRATION_KEYS.runs }),
  });
}

/** The most pages one review reads (500 a page): the DTO's own ceiling of 20 000 changes. */
const MAX_CHANGE_PAGES = 40;

/**
 * Every change of a run, page after page (500 a page) in one query, so the
 * review counts and selects over the whole diff and not over what happened
 * to be loaded: nothing can be applied by default that the admin did not
 * have in front of them. `onProgress` hears the running count.
 *
 * One query that loops, not useInfiniteQuery: the infinite behaviour lands
 * in the react-query chunk every route shares (+0.1KB gzipped on each,
 * measured 2026-10-11), for a page no other route has.
 */
export function useRunChanges(runId: string | null, onProgress?: (loaded: number) => void) {
  return useQuery({
    queryKey: [...INTEGRATION_KEYS.changes, runId],
    enabled: runId !== null,
    retry: false,
    queryFn: async () => {
      const all: SyncChange[] = [];
      let cursor: number | null = null;
      for (let page = 0; page < MAX_CHANGE_PAGES; page += 1) {
        const answer: ChangesPage = await api.get<ChangesPage>(
          `/api/v1/ss12000-sync/runs/${runId}/changes?limit=500${cursor !== null ? `&cursor=${cursor}` : ""}`,
        );
        all.push(...answer.data);
        onProgress?.(all.length);
        cursor = answer.nextCursor;
        if (cursor === null) break;
      }
      return all;
    },
  });
}

export function useApplyRun(runId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: ApplyInput) => api.post<SyncRun>(`/api/v1/ss12000-sync/runs/${runId}/apply`, input),
    onSettled: () => {
      for (const key of [INTEGRATION_KEYS.runs, INTEGRATION_KEYS.changes, INTEGRATION_KEYS.provisioning, INTEGRATION_KEYS.source]) {
        void queryClient.invalidateQueries({ queryKey: key });
      }
    },
    onSuccess: () => {
      for (const key of AFTER_APPLY) void queryClient.invalidateQueries({ queryKey: key });
    },
  });
}

export function useDiscardRun(runId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => api.post<SyncRun>(`/api/v1/ss12000-sync/runs/${runId}/discard`),
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: INTEGRATION_KEYS.runs });
      void queryClient.invalidateQueries({ queryKey: INTEGRATION_KEYS.changes });
    },
  });
}

/** "Nya personer": linked, active, never invited. */
export function useProvisioning(enabled: boolean) {
  return useQuery({
    queryKey: INTEGRATION_KEYS.provisioning,
    enabled,
    retry: false,
    queryFn: () => api.get<ProvisioningPerson[]>("/api/v1/ss12000-sync/provisioning"),
  });
}

/**
 * "Bjud in valda": the existing POST /api/v1/users/invitations, at most 500
 * ids a call (InviteUsersDto), one call after another, the reports summed.
 * A chunk that fails as a whole is counted against each of its ids, so the
 * total always accounts for every person chosen.
 */
export async function inviteInChunks(
  userIds: string[],
  post: (ids: string[]) => Promise<BulkInvitationReport>,
): Promise<BulkInvitationReport> {
  const merged: BulkInvitationReport = { sent: 0, alreadyRegistered: 0, errors: [] };
  for (let at = 0; at < userIds.length; at += INVITE_CHUNK) {
    const chunk = userIds.slice(at, at + INVITE_CHUNK);
    try {
      const report = await post(chunk);
      merged.sent += report.sent;
      merged.alreadyRegistered += report.alreadyRegistered;
      merged.errors.push(...report.errors);
    } catch (error) {
      const message = error instanceof Error ? error.message : "";
      merged.errors.push(...chunk.map((userId) => ({ userId, message })));
    }
  }
  return merged;
}

export function useInviteSelected() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (userIds: string[]) =>
      inviteInChunks(userIds, (ids) =>
        api.post<BulkInvitationReport>("/api/v1/users/invitations", { userIds: ids }),
      ),
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: INTEGRATION_KEYS.provisioning });
      void queryClient.invalidateQueries({ queryKey: ["people"] });
    },
  });
}
