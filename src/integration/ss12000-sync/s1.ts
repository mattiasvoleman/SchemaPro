/*
 * SS12000 2.1.0 as the consumer reads it: the parts of the standard the sync
 * pulls (Organisation, Person, Group, Duty, DeletedEntities), transcribed,
 * and strict parsers that turn a provider's JSON into what the diff needs —
 * and nothing more.
 *
 * SOURCE (S1). SIS TK450, "SS12000 OpenAPI 3.0", openapi_ss12000_version2_1_0.yaml,
 * info.version 2.1.0 (korrigendum augusti 2022), openapi 3.0.2:
 * https://www.sis.se/globalassets/standardutveckling/tksidor/tk-450/openapi_ss12000_version2_1_0.yaml
 * retrieved 2026-10-10, 10 393 lines, sha256
 * aee9a95a4c5bd25cebaf357d266592f94e9388ae785ee9ac3b58e1992acccd28. The SIS
 * page for SS 12000 (https://www.sis.se/en/delta-och-paverka/tksidor/tk400499/
 * sistk450/ss-12000/) lists 2.0.0 and 2.1.0 only; 2.1.0 is the newest
 * machine-readable API. Every name, enum value and spelling below is S1's.
 *
 * What the parsers keep, per schema (required fields per S1 marked *):
 *
 *   Organisation  *id *displayName *organisationType, schoolUnitCode
 *   Person        *id *givenName *familyName, middleName,
 *                 eduPersonPrincipalNames, securityMarking, personStatus,
 *                 emails[{*value *type}], enrolments[{*enroledAt.id,
 *                 schoolYear, *schoolType, *startDate, endDate, cancelled}],
 *                 responsibles[{person.id, person.securityMarking,
 *                 relationType}], meta.modified
 *   Group         *id *displayName *startDate endDate *groupType
 *                 *organisation.id, groupMemberships[{*person.id,
 *                 startDate, endDate}] (a direct property: Group_allOf)
 *   Duty          *id person.id *dutyAt.id *dutyRole *startDate endDate
 *   DeletedEntities  data.persons, data.groups, data.duties
 *
 * DROPPED AT PARSE, never kept in memory past this module, never in a diff,
 * a log or the database: civicNo, birthDate, sex, addresses, phoneNumbers,
 * photo, externalIdentifiers, and Duty's dutyPercent, hoursPerYear,
 * signature, description and assignmentRole (HR data, Fas 3's opt-in owns
 * it). A record missing a required field, or carrying an id that is not a
 * uuid, is not parsed: the caller counts it as INVALID_RECORD by id where an
 * id could be read. Ids are lowercased (S1's ids are uuids; IST's are not
 * guaranteed to be version 4, so any RFC 4122 uuid is accepted). Unknown
 * keys are ignored. Dates are S1's RFC 3339 full-date; every endDate in
 * these schemas is inclusive ("Inkluderande").
 */

export const S1_SOURCE = {
  title: 'SS12000 OpenAPI 3.0 (SIS TK450)',
  version: '2.1.0',
  url: 'https://www.sis.se/globalassets/standardutveckling/tksidor/tk-450/openapi_ss12000_version2_1_0.yaml',
  sha256: 'aee9a95a4c5bd25cebaf357d266592f94e9388ae785ee9ac3b58e1992acccd28',
} as const;

/** S1 DutyRole, every value, spelled as S1 spells it. */
export const DUTY_ROLES = [
  'Rektor',
  'Lärare',
  'Förskollärare',
  'Barnskötare',
  'Bibliotekarie',
  'Lärarassistent',
  'Fritidspedagog',
  'Annan personal',
  'Studie- och yrkesvägledare',
  'Förstelärare',
  'Kurator',
  'Skolsköterska',
  'Skolläkare',
  'Skolpsykolog',
  'Speciallärare/specialpedagog',
  'Skoladministratör',
  'Övrig arbetsledning',
  'Övrig pedagogisk personal',
  'Förskolechef',
] as const;
export type DutyRole = (typeof DUTY_ROLES)[number];

/** S1 GroupTypesEnum. */
export const GROUP_TYPES = ['Undervisning', 'Klass', 'Mentor', 'Provgrupp', 'Schema', 'Avdelning', 'Personalgrupp', 'Övrigt'] as const;
export type GroupType = (typeof GROUP_TYPES)[number];

/** S1 Person.securityMarking and PersonReference.securityMarking. */
export const SECURITY_MARKINGS = ['Ingen', 'Sekretessmarkering', 'Skyddad folkbokföring'] as const;
/**
 * A marking as parsed: one of S1's values, or UNRECOGNISED for any other
 * value the source sent. Protection fails CLOSED: only "Ingen" (or no
 * marking at all) is unprotected, so a value in another Unicode form, case
 * or with stray whitespace — or one a later S1 adds — never makes a
 * protected person's changes automatic (A2.4).
 */
export type SecurityMarking = (typeof SECURITY_MARKINGS)[number] | 'UNRECOGNISED';

/** S1 Person.personStatus. */
export const PERSON_STATUSES = ['Aktiv', 'Utvandrad', 'Avliden'] as const;
export type PersonStatus = (typeof PERSON_STATUSES)[number];

/** S1 Email.type. */
export const EMAIL_TYPES = ['Privat', 'Skola elev', 'Skola personal', 'Arbete övrigt'] as const;
export type EmailType = (typeof EMAIL_TYPES)[number];

/** S1 RelationTypesEnum. Shown in the diff, never stored. */
export const RELATION_TYPES = ['Vårdnadshavare', 'Annan ansvarig', 'God man', 'Utsedd behörig'] as const;
export type RelationType = (typeof RELATION_TYPES)[number];

/** S1 OrganisationTypeEnum. */
export const ORGANISATION_TYPES = [
  'Huvudman',
  'Verksamhetsområde',
  'Förvaltning',
  'Rektorsområde',
  'Skola',
  'Skolenhet',
  'Varumärke',
  'Bolag',
  'Övrigt',
] as const;

/** S1 EndPointsEnum values the consumer asks /deletedEntities about. */
export const DELETED_ENTITY_TYPES = ['Person', 'Group', 'Duty'] as const;

/**
 * S1 /persons relationship.entity.type values the fetch plan uses (the enum
 * also has placement.child, placement.owner, responsibleFor.placement and
 * groupMembership).
 */
export const RELATIONSHIP_TYPES = {
  enrolment: 'enrolment',
  duty: 'duty',
  responsibleForEnrolment: 'responsibleFor.enrolment',
} as const;

export interface S1Organisation {
  id: string;
  displayName: string;
  organisationType: string;
  schoolUnitCode: string | null;
}

export interface S1Email {
  value: string;
  type: EmailType;
}

export interface S1Enrolment {
  organisationId: string;
  schoolYear: number | null;
  schoolType: string;
  startDate: string;
  endDate: string | null;
  cancelled: boolean;
}

export interface S1Responsible {
  personId: string;
  securityMarking: SecurityMarking | null;
  relationType: RelationType | null;
}

export interface S1Person {
  id: string;
  givenName: string;
  middleName: string | null;
  familyName: string;
  eduPersonPrincipalNames: string[];
  securityMarking: SecurityMarking | null;
  personStatus: PersonStatus | null;
  emails: S1Email[];
  enrolments: S1Enrolment[];
  responsibles: S1Responsible[];
  modified: string | null;
}

export interface S1GroupMembership {
  personId: string;
  personSecurityMarking: SecurityMarking | null;
  startDate: string | null;
  endDate: string | null;
}

export interface S1Group {
  id: string;
  displayName: string;
  startDate: string;
  endDate: string | null;
  groupType: GroupType;
  organisationId: string;
  memberships: S1GroupMembership[];
}

export interface S1Duty {
  id: string;
  personId: string | null;
  organisationId: string;
  dutyRole: DutyRole;
  startDate: string;
  endDate: string | null;
}

export interface S1DeletedEntities {
  persons: string[];
  groups: string[];
  duties: string[];
}

/** The outcome of parsing one record: the record, or why not (with its id if one could be read). */
export type Parsed<T> = { ok: true; value: T } | { ok: false; externalId: string | null };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const FULL_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** An RFC 4122 uuid of any version, lowercased; null for anything else. */
export function uuidOf(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const lowered = value.trim().toLowerCase();
  return UUID.test(lowered) ? lowered : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A non-empty string after trimming, at most `max` characters; null otherwise. */
function text(value: unknown, max = 200): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 && trimmed.length <= max ? trimmed : null;
}

/** An RFC 3339 full-date that is a real day; null otherwise. Date-times are cut to their date. */
export function dateOf(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const day = value.length > 10 && value[10] === 'T' ? value.slice(0, 10) : value;
  if (!FULL_DATE.test(day)) return null;
  const parsed = new Date(`${day}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === day ? day : null;
}

/** S1's marking for a present value (NFC, trimmed, case-insensitive), else UNRECOGNISED; null when absent. */
export function parseMarking(value: unknown): SecurityMarking | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') return 'UNRECOGNISED';
  const wanted = value.normalize('NFC').trim().toLocaleLowerCase('sv');
  return SECURITY_MARKINGS.find((marking) => marking.toLocaleLowerCase('sv') === wanted) ?? 'UNRECOGNISED';
}

function oneOf<T extends string>(values: readonly T[], value: unknown): T | null {
  return typeof value === 'string' && (values as readonly string[]).includes(value) ? (value as T) : null;
}

function referenceId(value: unknown): string | null {
  return isRecord(value) ? uuidOf(value['id']) : null;
}

function arrayOf(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

export function parseOrganisation(raw: unknown): Parsed<S1Organisation> {
  if (!isRecord(raw)) return { ok: false, externalId: null };
  const id = uuidOf(raw['id']);
  const displayName = text(raw['displayName'], 300);
  const organisationType = oneOf(ORGANISATION_TYPES, raw['organisationType']);
  if (!id || !displayName || !organisationType) return { ok: false, externalId: id };
  return { ok: true, value: { id, displayName, organisationType, schoolUnitCode: text(raw['schoolUnitCode'], 32) } };
}

export function parsePerson(raw: unknown): Parsed<S1Person> {
  if (!isRecord(raw)) return { ok: false, externalId: null };
  const id = uuidOf(raw['id']);
  const givenName = text(raw['givenName']);
  const familyName = text(raw['familyName']);
  if (!id || !givenName || !familyName) return { ok: false, externalId: id };

  const emails: S1Email[] = [];
  for (const entry of arrayOf(raw['emails'])) {
    if (!isRecord(entry)) continue;
    const value = text(entry['value'], 254);
    const type = oneOf(EMAIL_TYPES, entry['type']);
    if (value && type) emails.push({ value, type });
  }

  const enrolments: S1Enrolment[] = [];
  for (const entry of arrayOf(raw['enrolments'])) {
    if (!isRecord(entry)) continue;
    const organisationId = referenceId(entry['enroledAt']);
    const schoolType = text(entry['schoolType'], 16);
    const startDate = dateOf(entry['startDate']);
    if (!organisationId || !schoolType || !startDate) continue;
    const schoolYear = entry['schoolYear'];
    enrolments.push({
      organisationId,
      schoolYear: typeof schoolYear === 'number' && Number.isInteger(schoolYear) ? schoolYear : null,
      schoolType,
      startDate,
      endDate: dateOf(entry['endDate']),
      cancelled: entry['cancelled'] === true,
    });
  }

  const responsibles: S1Responsible[] = [];
  for (const entry of arrayOf(raw['responsibles'])) {
    if (!isRecord(entry)) continue;
    const person = entry['person'];
    const personId = referenceId(person);
    if (!personId) continue;
    responsibles.push({
      personId,
      securityMarking: isRecord(person) ? parseMarking(person['securityMarking']) : null,
      relationType: oneOf(RELATION_TYPES, entry['relationType']),
    });
  }

  const meta = raw['meta'];
  const eppn = arrayOf(raw['eduPersonPrincipalNames'])
    .map((value) => text(value, 254))
    .filter((value): value is string => value !== null);

  return {
    ok: true,
    value: {
      id,
      givenName,
      middleName: text(raw['middleName']),
      familyName,
      eduPersonPrincipalNames: eppn,
      securityMarking: parseMarking(raw['securityMarking']),
      personStatus: oneOf(PERSON_STATUSES, raw['personStatus']),
      emails,
      enrolments,
      responsibles,
      modified: isRecord(meta) && typeof meta['modified'] === 'string' ? meta['modified'] : null,
    },
  };
}

export function parseGroup(raw: unknown): Parsed<S1Group> {
  if (!isRecord(raw)) return { ok: false, externalId: null };
  const id = uuidOf(raw['id']);
  const displayName = text(raw['displayName'], 120);
  const startDate = dateOf(raw['startDate']);
  const groupType = oneOf(GROUP_TYPES, raw['groupType']);
  const organisationId = referenceId(raw['organisation']);
  if (!id || !displayName || !startDate || !groupType || !organisationId) return { ok: false, externalId: id };

  const memberships: S1GroupMembership[] = [];
  for (const entry of arrayOf(raw['groupMemberships'])) {
    if (!isRecord(entry)) continue;
    const person = entry['person'];
    const personId = referenceId(person);
    if (!personId) continue;
    memberships.push({
      personId,
      personSecurityMarking: isRecord(person) ? parseMarking(person['securityMarking']) : null,
      startDate: dateOf(entry['startDate']),
      endDate: dateOf(entry['endDate']),
    });
  }

  return {
    ok: true,
    value: { id, displayName, startDate, endDate: dateOf(raw['endDate']), groupType, organisationId, memberships },
  };
}

export function parseDuty(raw: unknown): Parsed<S1Duty> {
  if (!isRecord(raw)) return { ok: false, externalId: null };
  const id = uuidOf(raw['id']);
  const organisationId = referenceId(raw['dutyAt']);
  const dutyRole = oneOf(DUTY_ROLES, raw['dutyRole']);
  const startDate = dateOf(raw['startDate']);
  if (!id || !organisationId || !dutyRole || !startDate) return { ok: false, externalId: id };
  return {
    ok: true,
    value: {
      id,
      personId: referenceId(raw['person']),
      organisationId,
      dutyRole,
      startDate,
      endDate: dateOf(raw['endDate']),
    },
  };
}

/** S1 DeletedEntities.data: the three uuid lists the consumer asks for; other keys ignored. */
export function parseDeletedEntities(raw: unknown): S1DeletedEntities | null {
  if (!isRecord(raw)) return null;
  const ids = (value: unknown) =>
    arrayOf(value)
      .map(uuidOf)
      .filter((id): id is string => id !== null);
  return { persons: ids(raw['persons']), groups: ids(raw['groups']), duties: ids(raw['duties']) };
}

/** Whether a dated relation [start, end] (end inclusive, open when null) holds on `day`. */
export function activeOn(day: string, startDate: string | null, endDate: string | null): boolean {
  return (startDate === null || startDate <= day) && (endDate === null || endDate >= day);
}

/** Whether a protected identity: securityMarking set and not "Ingen" (UNRECOGNISED is protected). */
export function isProtected(marking: SecurityMarking | null): boolean {
  return marking !== null && marking !== 'Ingen';
}
