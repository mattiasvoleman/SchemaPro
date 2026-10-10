/**
 * What an integration key may reach (migration 20261014120000, whose CHECK
 * IntegrationApiKeys_scopes_are_known is this list).
 *
 * ss12000.v1 and ss12000.v1.import are the house-shaped /ss12000/v1 and its
 * import; every key that existed before the migration holds both, so v1
 * behaves for them exactly as before. The rest are the v2.0 provider's, one
 * per resource it emits (S1 path), plus responsibles.read (guardians and
 * every responsibles[]: a library system needs no parents) and
 * subscriptions.write.
 */
export const SCOPES = [
  'ss12000.v1',
  'ss12000.v1.import',
  'organisations.read',
  'persons.read',
  'responsibles.read',
  'groups.read',
  'duties.read',
  'activities.read',
  'calendarEvents.read',
  'rooms.read',
  'syllabuses.read',
  'subscriptions.write',
] as const;
export type Scope = (typeof SCOPES)[number];

/** The scopes a key created without a choice gets: today's v1 reach. */
export const DEFAULT_SCOPES: readonly Scope[] = ['ss12000.v1', 'ss12000.v1.import'];

export function isScope(value: unknown): value is Scope {
  return typeof value === 'string' && (SCOPES as readonly string[]).includes(value);
}

/**
 * The scopes of a request body, de-duplicated and in SCOPES order, or null
 * when it is not a non-empty array of known scopes (the DTO's rule and the
 * CHECK's).
 */
export function parseScopes(value: unknown): Scope[] | null {
  if (!Array.isArray(value) || value.length === 0 || value.length > 50) return null;
  if (!value.every(isScope)) return null;
  const chosen = new Set<Scope>(value);
  return SCOPES.filter((scope) => chosen.has(scope));
}

/** S1 EndPointsEnum values the provider emits, and the scope that reads each. */
export const EMITTED_RESOURCES = {
  Organisation: 'organisations.read',
  Person: 'persons.read',
  Group: 'groups.read',
  Duty: 'duties.read',
  Activity: 'activities.read',
  CalendarEvent: 'calendarEvents.read',
  Room: 'rooms.read',
  Syllabus: 'syllabuses.read',
} as const satisfies Record<string, Scope>;
export type EmittedResource = keyof typeof EMITTED_RESOURCES;

export const EMITTED_RESOURCE_NAMES = Object.keys(EMITTED_RESOURCES) as EmittedResource[];
