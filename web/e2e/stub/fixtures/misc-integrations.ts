import type { SignInSettings } from "../../../app/[locale]/(app)/admin/integrations/sign-in-types";
import type {
  AttendanceSharing,
  ChangesPage,
  ProviderKey,
  ProvisioningPerson,
  SourceView,
  SyncChange,
  SyncRun,
} from "../../../app/[locale]/(app)/admin/integrations/ss12000-types";
import { KIND, uid } from "../sessions";
import { addDays, stockholmInstant, TODAY } from "./calendar";
import { ago } from "./misc-school";
import { ADMIN, ALL_PEOPLE, GROUP_LIST, GROUPS, STUDENTS, TEACHERS } from "./world";

/**
 * /admin/integrations: the kommun's SS12000 register as Exempelskolan's
 * source, its runs (one waiting for review), the keys other systems read
 * SchemaPro with, and "Logga in med skolkonto". Every host is on .example,
 * and no answer carries a secret — the gateway's never do: a source says only
 * when each credential was set. Ids are KIND.misc 9401–9499.
 */

/** The register's own ids for the people and groups the first full sync linked. */
const externalPerson = (id: string) => `ext-person-${String(ALL_PEOPLE.findIndex((person) => person.id === id) + 100).padStart(4, "0")}`;
const externalGroup = (id: string) => `ext-group-${String(GROUP_LIST.findIndex((group) => group.id === id) + 10).padStart(4, "0")}`;

// --- Runs, newest first -------------------------------------------------------------

const run = (n: number, extra: Partial<SyncRun> & Pick<SyncRun, "status" | "startedAt">): SyncRun => ({
  id: uid(KIND.misc, n),
  trigger: "SCHEDULED",
  mode: "INCREMENTAL",
  statusCode: null,
  fetchedAt: null,
  finishedAt: null,
  appliedAt: null,
  autoApplied: false,
  counts: {},
  errors: [],
  basisHash: null,
  autoApplyBlockedReason: null,
  ...extra,
});

/** Last night's: a new pupil, an address the school edited by hand, a group name already taken. */
const WAITING = run(9411, {
  status: "DIFF_READY",
  startedAt: ago(1, "04:00"),
  fetchedAt: ago(1, "04:01"),
  finishedAt: ago(1, "04:01"),
  counts: {
    // Incremental: only what the register changed since the cursor.
    PERSON: { fetched: 2, CREATE: 1, UPDATE: 1 },
    GROUP: { fetched: 1, CONFLICT: 1 },
    CLASS_MEMBERSHIP: { fetched: 1, MOVE: 1 },
  },
  basisHash: "stub-basis-9411",
});

/** The first full sync, applied by hand: every person and class linked, nothing created. */
const FIRST_FULL = run(9414, {
  trigger: "MANUAL",
  mode: "FULL",
  status: "APPLIED",
  startedAt: ago(8, "14:20"),
  fetchedAt: ago(8, "14:22"),
  finishedAt: ago(8, "14:31"),
  appliedAt: ago(8, "14:31"),
  counts: {
    PERSON: { fetched: ALL_PEOPLE.length, LINK: ALL_PEOPLE.length },
    GROUP: { fetched: GROUP_LIST.length, LINK: GROUP_LIST.length },
    applied: { admin: ALL_PEOPLE.length + GROUP_LIST.length, auto: 0, skipped: 0 },
  },
  basisHash: "stub-basis-9414",
});

export const SYNC_RUNS: SyncRun[] = [
  WAITING,
  run(9412, {
    status: "NO_CHANGES",
    startedAt: ago(3, "04:00"),
    fetchedAt: ago(3, "04:01"),
    finishedAt: ago(3, "04:01"),
    counts: { PERSON: { fetched: 0 }, GROUP: { fetched: 0 } },
  }),
  run(9413, {
    status: "FETCH_FAILED",
    statusCode: "SS12000_TIMEOUT",
    startedAt: ago(4, "04:00"),
    finishedAt: ago(4, "04:02"),
    counts: { fetch: { requests: 3, pages: 2, retries: 2, invalid: 0 } },
    errors: [{ code: "SS12000_TIMEOUT" }],
  }),
  FIRST_FULL,
];

/** The runs page: `limit` of them, started before `before` when it is given. */
export const syncRuns = (limit: number, before: string | null): SyncRun[] =>
  SYNC_RUNS.filter((entry) => before === null || entry.startedAt < before).slice(0, limit);

// --- A run's changes -------------------------------------------------------------------

const change = (n: number, extra: Partial<SyncChange> & Pick<SyncChange, "entity" | "op">): SyncChange => ({
  id: uid(KIND.misc, n),
  seq: n - 9440,
  externalId: null,
  localId: null,
  before: null,
  after: null,
  conflictCode: null,
  selected: false,
  autoApplicable: false,
  protectedIdentity: false,
  applied: false,
  ...extra,
});

/** Names and emails while the run is DIFF_READY, as the gateway sends them then. */
const WAITING_CHANGES: SyncChange[] = [
  change(9441, {
    entity: "PERSON",
    op: "CREATE",
    externalId: "ext-person-0193",
    after: { firstName: "Selma", lastName: "Granlund", role: "STUDENT", email: "selma.10@elev.exempelskolan.example" },
    selected: true,
    autoApplicable: true,
  }),
  change(9442, {
    entity: "CLASS_MEMBERSHIP",
    op: "MOVE",
    externalId: "ext-person-0193",
    after: { groupName: GROUPS.g7B.name },
    selected: true,
    autoApplicable: true,
  }),
  change(9443, {
    entity: "PERSON",
    op: "UPDATE",
    externalId: externalPerson(STUDENTS.klara.id),
    localId: STUDENTS.klara.id,
    before: { email: STUDENTS.klara.email },
    after: { email: "klara.dal@elev.exempelskolan.example" },
    conflictCode: "LOCAL_EDIT_SINCE_LAST_SYNC",
  }),
  change(9444, {
    entity: "GROUP",
    op: "CONFLICT",
    externalId: externalGroup(GROUPS.ma7.id),
    localId: GROUPS.ma7.id,
    after: { name: GROUPS.ma7.name, kind: "TEACHING_GROUP" },
    conflictCode: "GROUP_NAME_TAKEN",
  }),
];

/** Past DIFF_READY the payloads are gone; the rows read by op alone. */
const FIRST_FULL_CHANGES: SyncChange[] = [
  ...ALL_PEOPLE.map((person, index) =>
    change(9450 + index, { entity: "PERSON", op: "LINK", externalId: externalPerson(person.id), localId: person.id, applied: true }),
  ),
  ...GROUP_LIST.map((group, index) =>
    change(9480 + index, { entity: "GROUP", op: "LINK", externalId: externalGroup(group.id), localId: group.id, applied: true }),
  ),
];

/** One page holds them all, so there is no cursor. A run with no diff has no changes. */
export function runChanges(runId: string): ChangesPage | null {
  if (runId === WAITING.id) return { data: WAITING_CHANGES, nextCursor: null };
  if (runId === FIRST_FULL.id) return { data: FIRST_FULL_CHANGES, nextCursor: null };
  return SYNC_RUNS.some((entry) => entry.id === runId) ? { data: [], nextCursor: null } : null;
}

// --- The source --------------------------------------------------------------------------

export const SS12000_SOURCE: SourceView = {
  id: uid(KIND.misc, 9401),
  name: "Exempelkommunens elevregister",
  baseUrl: "https://ss12000.exempelkommunen.example/v2.1",
  authKind: "OAUTH2_CLIENT_CREDENTIALS",
  tokenUrl: "https://login.exempelkommunen.example/oauth2/token",
  clientId: "schemapro-exempelskolan",
  tokenScope: "ss12000.read",
  tokenAuthStyle: "BASIC",
  organisationIds: ["ext-org-exempelskolan"],
  schoolUnitCodes: ["99887766"],
  pageSize: 200,
  enabled: true,
  scheduleEnabled: true,
  scheduleAutoApply: false,
  scheduleHourLocal: 4,
  fullEveryDays: 7,
  incrementalUnsupported: false,
  modifiedCursor: FIRST_FULL.fetchedAt,
  deletedCursor: FIRST_FULL.fetchedAt,
  lastFullAt: FIRST_FULL.fetchedAt,
  lastAppliedAt: FIRST_FULL.appliedAt,
  lastTestedAt: ago(9, "13:05"),
  lastTestOutcome: "OK",
  // When the client secret was set; never the secret.
  secrets: { CLIENT_SECRET: { setAt: ago(9, "13:02") } },
};

/** "Nya personer": linked, active and never invited — Eva, in world.ts. */
export const PROVISIONING: ProvisioningPerson[] = [
  {
    id: TEACHERS.eva.id,
    role: "TEACHER",
    firstName: TEACHERS.eva.firstName,
    lastName: TEACHERS.eva.lastName,
    email: TEACHERS.eva.email,
    studentGroup: null,
  },
];

// --- API-nycklar -----------------------------------------------------------------------------

export const PROVIDER_KEYS: ProviderKey[] = [
  {
    id: uid(KIND.misc, 9421),
    name: "Lärplattformen",
    scopes: ["ss12000.v1", "ss12000.v1.import", "persons.read", "groups.read", "activities.read", "subscriptions.write"],
    lastUsedAt: ago(1, "22:10"),
    revokedAt: null,
    createdAt: ago(60, "10:00"),
    // When the signing secret was set; the secret itself is shown once, when it is made.
    webhookSecret: { setAt: ago(60, "10:05"), previousValidUntil: null },
    subscriptions: [
      {
        id: uid(KIND.misc, 9422),
        name: "Lärplattformens schemabevakning",
        targetHost: "hooks.larplattform.example",
        resourceTypes: ["Activity", "CalendarEvent"],
        expiresAt: stockholmInstant(addDays(TODAY, 25), "10:05"),
        suspendedAt: null,
        suspendedReason: null,
        lastNotifiedAt: ago(1, "16:40"),
        failingSince: null,
        attempts: 0,
        createdAt: ago(35, "10:05"),
      },
    ],
  },
  {
    id: uid(KIND.misc, 9423),
    name: "Gammal export till kommunen",
    scopes: ["ss12000.v1"],
    lastUsedAt: ago(200, "02:00"),
    revokedAt: ago(90, "09:15"),
    createdAt: ago(400, "14:00"),
    webhookSecret: null,
    subscriptions: [],
  },
  {
    id: uid(KIND.misc, 9424),
    name: "Kommunens frånvarostatistik",
    scopes: ["attendances.read", "absences.read"],
    lastUsedAt: ago(2, "03:00"),
    revokedAt: null,
    createdAt: ago(20, "09:30"),
    webhookSecret: null,
    subscriptions: [],
  },
];

// --- Närvaro och frånvaro till integrationer (SS12000-närvaro) --------------------------------

/** Shared since the admin decided it, after an earlier decision not to. */
export const ATTENDANCE_SHARING: AttendanceSharing = {
  current: { shares: true, reference: "Konsekvensbedömning 2026:12", decidedAt: ago(20, "09:00"), decidedBy: `${ADMIN.firstName} ${ADMIN.lastName}` },
  history: [
    { shares: true, reference: "Konsekvensbedömning 2026:12", decidedAt: ago(20, "09:00"), decidedBy: `${ADMIN.firstName} ${ADMIN.lastName}` },
    { shares: false, reference: null, decidedAt: ago(200, "11:00"), decidedBy: `${ADMIN.firstName} ${ADMIN.lastName}` },
  ],
};

// --- Logga in med skolkonto ------------------------------------------------------------------

/** Turned on for staff and pupils alike; the admin's own session is a password one. */
export const SIGN_IN_SETTINGS: SignInSettings = {
  available: true,
  method: {
    provider: "azure",
    domains: ["exempelskolan.example", "elev.exempelskolan.example"],
    entraTenantId: uid(KIND.misc, 9431),
    googleHostedDomain: null,
    ssoOnlyForStaff: false,
    updatedAt: ago(30, "09:30"),
  },
  session: { schoolAccount: null },
};
