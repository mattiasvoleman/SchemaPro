/*
 * What the gateway answers on /admin/integrations, as the web reads it: the
 * provider's key view (src/integration/integration.controller.ts:
 * api/v1/integration-keys/provider). Dates arrive as ISO strings. A key
 * never answers its hash, a webhook secret only in the one answer that
 * creates it.
 */

export interface ProviderSubscription {
  id: string;
  name: string;
  /** The target's host only, never its path or query. */
  targetHost: string;
  resourceTypes: string[];
  expiresAt: string;
  suspendedAt: string | null;
  /** FAILING (72 h of failed deliveries) or ADMIN (the school paused it). */
  suspendedReason: string | null;
  lastNotifiedAt: string | null;
  failingSince: string | null;
  attempts: number;
  createdAt: string;
}

export interface ProviderKey {
  id: string;
  name: string;
  scopes: string[];
  lastUsedAt: string | null;
  revokedAt: string | null;
  createdAt: string;
  webhookSecret: { setAt: string; previousValidUntil: string | null } | null;
  subscriptions: ProviderSubscription[];
}

/**
 * The scopes a key may hold (src/integration/ss12000-v2/scopes.ts, and the
 * CHECK IntegrationApiKeys_scopes_are_known of migration 20261014120000), in
 * the gateway's order.
 */
export const SCOPES = [
  "ss12000.v1",
  "ss12000.v1.import",
  "organisations.read",
  "persons.read",
  "responsibles.read",
  "groups.read",
  "duties.read",
  "activities.read",
  "calendarEvents.read",
  "rooms.read",
  "syllabuses.read",
  "subscriptions.write",
] as const;
export type Scope = (typeof SCOPES)[number];

/** What a key created without a choice gets: today's v1 reach. */
export const DEFAULT_SCOPES: readonly Scope[] = ["ss12000.v1", "ss12000.v1.import"];
