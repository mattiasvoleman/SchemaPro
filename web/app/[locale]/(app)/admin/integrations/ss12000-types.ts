/*
 * What the gateway answers on /admin/integrations, as the web reads it.
 *
 * The consumer (src/integration/ss12000-sync: api/v1/ss12000-source and
 * api/v1/ss12000-sync) and the provider's key view
 * (src/integration/integration.controller.ts: api/v1/integration-keys/provider).
 * Dates arrive as ISO strings. No secret is ever in any of these: a source
 * answers only WHEN each credential was set, a key never its hash, a webhook
 * secret only in the one answer that creates it.
 */

export type AuthKind = "OAUTH2_CLIENT_CREDENTIALS" | "BEARER_TOKEN" | "MTLS_CLIENT_CERT";
export type TokenAuthStyle = "BASIC" | "FORM";
export type SecretKind = "CLIENT_SECRET" | "BEARER_TOKEN" | "CLIENT_KEY_PEM" | "CLIENT_CERT_PEM";

export interface SourceView {
  id: string;
  name: string;
  baseUrl: string;
  authKind: AuthKind;
  tokenUrl: string | null;
  clientId: string | null;
  tokenScope: string | null;
  tokenAuthStyle: TokenAuthStyle;
  organisationIds: string[];
  schoolUnitCodes: string[];
  pageSize: number;
  enabled: boolean;
  scheduleEnabled: boolean;
  scheduleAutoApply: boolean;
  scheduleHourLocal: number;
  fullEveryDays: number;
  incrementalUnsupported: boolean;
  modifiedCursor: string | null;
  deletedCursor: string | null;
  lastFullAt: string | null;
  lastAppliedAt: string | null;
  lastTestedAt: string | null;
  lastTestOutcome: string | null;
  /** Whether and when each credential was set; never its value. */
  secrets: Partial<Record<SecretKind, { setAt: string }>>;
}

/** PUT /api/v1/ss12000-source (Ss12000SourceDto). */
export interface SourceInput {
  name: string;
  baseUrl: string;
  authKind: AuthKind;
  tokenUrl: string | null;
  clientId: string | null;
  tokenScope: string | null;
  tokenAuthStyle: TokenAuthStyle;
  organisationIds?: string[];
  pageSize?: number;
  enabled?: boolean;
  confirmRelink?: boolean;
}

export interface ScheduleInput {
  scheduleEnabled?: boolean;
  scheduleAutoApply?: boolean;
  scheduleHourLocal?: number;
  fullEveryDays?: number;
}

export interface TestedOrganisation {
  id: string;
  displayName: string;
  schoolUnitCode: string | null;
  organisationType: string;
}

/** POST /api/v1/ss12000-source/test: a code and the skolenheter, never what the far side said. */
export interface ConnectionTest {
  ok: boolean;
  code: string;
  tokenOk: boolean;
  organisations: TestedOrganisation[];
}

export type RunStatus =
  | "RUNNING"
  | "FETCH_FAILED"
  | "NO_CHANGES"
  | "DIFF_READY"
  | "APPLIED"
  | "APPLY_FAILED"
  | "DISCARDED"
  | "SUPERSEDED"
  | "SKIPPED";

export type RunMode = "FULL" | "INCREMENTAL";

/** {entity: {op|fetched|…: n}, codes: {CODE: n}, fetch: {requests, pages, retries, invalid}, applied: {…}} */
export type RunCounts = Record<string, Record<string, number> | undefined>;

export interface SyncRun {
  id: string;
  trigger: "MANUAL" | "SCHEDULED";
  mode: RunMode;
  status: RunStatus;
  statusCode: string | null;
  startedAt: string;
  fetchedAt: string | null;
  finishedAt: string | null;
  appliedAt: string | null;
  autoApplied: boolean;
  counts: RunCounts;
  errors: Array<{ code: string; entity?: string; externalId?: string | null }>;
  basisHash: string | null;
  autoApplyBlockedReason: string | null;
}

export type ChangeEntity =
  | "PERSON"
  | "GROUP"
  | "CLASS_MEMBERSHIP"
  | "GROUP_MEMBERSHIP"
  | "RESPONSIBLE"
  | "DUTY_LINK"
  | "ORGANISATION";

export type ChangeOp =
  | "CREATE"
  | "LINK"
  | "RELINK"
  | "UPDATE"
  | "MOVE"
  | "DEACTIVATE"
  | "REACTIVATE"
  | "ADD"
  | "END"
  | "CONFLICT"
  | "INFO";

export type Payload = Record<string, unknown>;

export interface SyncChange {
  id: string;
  seq: number;
  entity: ChangeEntity;
  op: ChangeOp;
  externalId: string | null;
  localId: string | null;
  /** Names and emails while the run is DIFF_READY; null on every other status. */
  before: Payload | null;
  after: Payload | null;
  conflictCode: string | null;
  selected: boolean;
  autoApplicable: boolean;
  protectedIdentity: boolean;
  applied: boolean;
}

export interface ChangesPage {
  data: SyncChange[];
  nextCursor: number | null;
}

/** POST /api/v1/ss12000-sync/runs/:id/apply (ApplyRunDto). */
export interface ApplyInput {
  basisHash: string;
  select: string[];
  deselect: string[];
  confirmMassDeactivation?: boolean;
}

export interface ProvisioningPerson {
  id: string;
  role: "STUDENT" | "TEACHER" | "GUARDIAN" | "SCHOOL_ADMIN";
  firstName: string;
  lastName: string;
  email: string;
  studentGroup: { id: string; name: string } | null;
}

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

/** The credentials each way of signing in sends (Ss12000SourceService.bindingFor). */
export function secretKindsFor(authKind: AuthKind, hasTokenUrl: boolean): SecretKind[] {
  switch (authKind) {
    case "OAUTH2_CLIENT_CREDENTIALS":
      return ["CLIENT_SECRET"];
    case "BEARER_TOKEN":
      return ["BEARER_TOKEN"];
    case "MTLS_CLIENT_CERT":
      return hasTokenUrl
        ? ["CLIENT_CERT_PEM", "CLIENT_KEY_PEM", "CLIENT_SECRET"]
        : ["CLIENT_CERT_PEM", "CLIENT_KEY_PEM", "BEARER_TOKEN"];
  }
}

/** The credentials a source cannot sign in without; a bearer on top of a client certificate is optional. */
export function requiredSecrets(authKind: AuthKind, hasTokenUrl: boolean): SecretKind[] {
  return secretKindsFor(authKind, hasTokenUrl).filter((kind) => !(authKind === "MTLS_CLIENT_CERT" && kind === "BEARER_TOKEN"));
}

/** The gateway's cap for "Bjud in valda" (InviteUsersDto's ArrayMaxSize). */
export const INVITE_CHUNK = 500;
/** At most this many skolenheter per school (Ss12000SourceDto's ArrayMaxSize). */
export const MAX_ORGANISATIONS = 5;
