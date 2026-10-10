import { apiRequest } from './api';
import type { NotificationType } from '../types';

/**
 * What the signed-in person lets leave SchemaPro, per notice type: e-mail and
 * push together (NotificationOptOuts, 20261013100000). The inbox row is
 * written whatever is chosen. Own only — the gateway answers the caller's own
 * set by role — and a `required` type (the unreported absence for a guardian,
 * a withdrawn cover lesson for staff) is shown on and refused if chosen.
 * Mirrors web/lib/notification-preferences-queries.ts.
 */

export interface NotificationPreference {
  readonly type: NotificationType;
  readonly enabled: boolean;
  readonly required: boolean;
}

export async function fetchPreferences(): Promise<NotificationPreference[]> {
  const answer = await apiRequest<{ types: NotificationPreference[] }>('/api/v1/notification-preferences');
  return answer.types;
}

/** The types a PUT names: everything switched off that the school does not require. */
export function optOutOf(types: readonly NotificationPreference[]): NotificationType[] {
  return types.filter((entry) => !entry.enabled && !entry.required).map((entry) => entry.type);
}

/** One switch changed; a required type never moves. */
export function withChoice(
  types: readonly NotificationPreference[],
  type: NotificationType,
  enabled: boolean,
): NotificationPreference[] {
  return types.map((entry) => (entry.type === type && !entry.required ? { ...entry, enabled } : entry));
}

/** The whole set goes back, as the gateway replaces it. */
export async function savePreferences(types: readonly NotificationPreference[]): Promise<NotificationPreference[]> {
  const answer = await apiRequest<{ types: NotificationPreference[] }>('/api/v1/notification-preferences', {
    method: 'PUT',
    body: { optOut: optOutOf(types) },
  });
  return answer.types;
}
