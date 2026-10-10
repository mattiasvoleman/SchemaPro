"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";

/**
 * What a person lets leave SchemaPro: per notice type, whether it is also
 * sent as e-mail and push (NotificationOptOuts, 20261013100000). The inbox
 * row is written whatever is chosen — it is the school's record.
 *
 * Own only: GET and PUT /api/v1/notification-preferences answer the caller's
 * own set and nobody else's, and the list is per role (a guardian is offered
 * the lesson notices and leave decisions; staff the lesson notices, their
 * cover bookings and their room bookings). A type the school must deliver is
 * `required`: shown switched on, and refused by the gateway if chosen.
 *
 * Imported only by app/[locale]/(app)/notifications/page.tsx.
 */

export type NotificationTypeName =
  | "ABSENCE_UNREPORTED"
  | "LEAVE_DECIDED"
  | "LESSON_CANCELLED"
  | "LESSON_SUBSTITUTE"
  | "LESSON_ROOM_CHANGED"
  | "SCHEDULE_CHANGED"
  | "ROOM_BOOKING_DECIDED"
  | "TEACHER_ABSENCE_REPORTED"
  | "LESSON_COVER_WITHDRAWN";

export interface NotificationPreference {
  type: NotificationTypeName;
  /** Sent outside the app (e-mail and push). */
  enabled: boolean;
  /** The school must send it; shown on and not switchable. */
  required: boolean;
}

const KEY = ["notificationPreferences"] as const;

export function useNotificationPreferences() {
  return useQuery({
    queryKey: KEY,
    queryFn: () => api.get<{ types: NotificationPreference[] }>("/api/v1/notification-preferences"),
  });
}

/** The types a PUT names: everything switched off that the school does not require. */
export function optOutOf(types: readonly NotificationPreference[]): NotificationTypeName[] {
  return types.filter((entry) => !entry.enabled && !entry.required).map((entry) => entry.type);
}

/** One switch changed: the whole set goes back, as the gateway replaces it. */
export function withChoice(
  types: readonly NotificationPreference[],
  type: NotificationTypeName,
  enabled: boolean,
): NotificationPreference[] {
  return types.map((entry) => (entry.type === type && !entry.required ? { ...entry, enabled } : entry));
}

export function useSaveNotificationPreferences() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (types: readonly NotificationPreference[]) =>
      api.put<{ types: NotificationPreference[] }>("/api/v1/notification-preferences", { optOut: optOutOf(types) }),
    onSuccess: (saved) => queryClient.setQueryData(KEY, saved),
  });
}
