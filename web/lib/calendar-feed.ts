"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";

/*
 * Kalenderprenumeration (src/calendar-feed, 20261112091000): a person's own
 * calendar feeds, and the admin's count of them. A feed's address is a
 * secret drawn by the gateway and shown once, in the answer that made it;
 * the list never carries one. Beside the pages that use it, for the bundle.
 */

export type FeedAudience = "TEACHER" | "STUDENT" | "GUARDIAN";

export interface CalendarFeed {
  id: string;
  audience: FeedAudience;
  /** The pupil whose week it is: the pupil's own id, a guardian's child's; null for a teacher's. */
  studentId: string | null;
  locale: "sv" | "en";
  createdAt: string;
  /** When a calendar last asked (at most every five minutes); null before the first. */
  lastUsedAt: string | null;
}

/** GET /calendar-feeds. */
export interface CalendarFeeds {
  /** Whether the school has feeds on for the caller's audience. */
  enabled: boolean;
  feeds: CalendarFeed[];
}

/** POST /calendar-feeds: the feed and its address's token, this once. */
export interface CreatedCalendarFeed {
  feed: CalendarFeed;
  token: string;
}

export type FeedCounts = Record<FeedAudience, number>;

export const CALENDAR_FEED_KEYS = {
  mine: ["calendarFeeds"] as const,
  counts: ["calendarFeedCounts"] as const,
};

export function useCalendarFeeds() {
  return useQuery({
    queryKey: CALENDAR_FEED_KEYS.mine,
    retry: false,
    queryFn: () => api.get<CalendarFeeds>("/api/v1/calendar-feeds"),
  });
}

/** The admin's live feeds per audience. */
export function useCalendarFeedCounts(enabled = true) {
  return useQuery({
    queryKey: CALENDAR_FEED_KEYS.counts,
    enabled,
    retry: false,
    queryFn: () => api.get<FeedCounts>("/api/v1/calendar-feeds/counts"),
  });
}

function useRefreshFeeds() {
  const queryClient = useQueryClient();
  return () => {
    void queryClient.invalidateQueries({ queryKey: CALENDAR_FEED_KEYS.mine });
    void queryClient.invalidateQueries({ queryKey: CALENDAR_FEED_KEYS.counts });
  };
}

/**
 * The list as the gateway now has it, before it is read again: the made feed
 * in place of the one of the same week, or the revoked one gone. So the card
 * acts on the feed that is live even if the list's refetch fails (a stop
 * after a new address is the new one's). No token: the list never has one.
 */
function useWriteFeeds() {
  const queryClient = useQueryClient();
  return (change: (feeds: CalendarFeed[]) => CalendarFeed[]) =>
    queryClient.setQueryData<CalendarFeeds>(CALENDAR_FEED_KEYS.mine, (list) => (list ? { ...list, feeds: change(list.feeds) } : list));
}

/**
 * A new address for the caller's own week, or a guardian's child's; the old
 * one stops. The answer holds the token: the mutation keeps it no longer
 * than the page that asked (gcTime 0, and the page resets it at once).
 * Either way the list is read again, a refusal too: a 409 says the school
 * turned feeds off, and the page should show that, not the old switch.
 */
export function useCreateCalendarFeed() {
  const refresh = useRefreshFeeds();
  const write = useWriteFeeds();
  return useMutation({
    mutationFn: (input: { studentId?: string; locale: "sv" | "en" }) => api.post<CreatedCalendarFeed>("/api/v1/calendar-feeds", input),
    gcTime: 0,
    onSuccess: ({ feed }) => write((feeds) => [...feeds.filter((old) => old.studentId !== feed.studentId), feed]),
    onSettled: refresh,
  });
}

export function useRevokeCalendarFeed() {
  const refresh = useRefreshFeeds();
  const write = useWriteFeeds();
  return useMutation({
    mutationFn: (id: string) => api.delete<void>(`/api/v1/calendar-feeds/${encodeURIComponent(id)}`),
    onSuccess: (_answer, id) => write((feeds) => feeds.filter((feed) => feed.id !== id)),
    onSettled: refresh,
  });
}

/**
 * The address a calendar asks: the gateway's own (calendars ask it
 * directly, without the web), ending in .ics for the calendars that look at
 * the name.
 */
export function feedUrl(token: string, base = process.env.NEXT_PUBLIC_API_BASE_URL ?? ""): string {
  return `${base.replace(/\/+$/, "")}/public/v1/calendar-feeds/${encodeURIComponent(token)}.ics`;
}
