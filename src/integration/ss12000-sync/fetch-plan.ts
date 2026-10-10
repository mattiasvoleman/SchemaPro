import type { Ss12000Client, Query } from './client';
import { Ss12000SourceError } from './errors';
import {
  DELETED_ENTITY_TYPES,
  RELATIONSHIP_TYPES,
  parseDeletedEntities,
  parseDuty,
  parseGroup,
  parseOrganisation,
  parsePerson,
  type S1DeletedEntities,
  type S1Duty,
  type S1Group,
  type S1Organisation,
  type S1Person,
} from './s1';

/**
 * What a run reads from the source, in S1's terms (paths and parameters of
 * openapi_ss12000_version2_1_0.yaml). For each organisation id of the
 * source (the school's skolenheter, 1..5), with T the school's local today:
 *
 *   1. GET /organisations/{id}
 *   2. GET /persons?relationship.organisation={id}
 *        &relationship.entity.type=enrolment&relationship.endDate.onOrAfter=T
 *   3. … &relationship.entity.type=duty&relationship.endDate.onOrAfter=T
 *   4. … &relationship.entity.type=responsibleFor.enrolment
 *        &relationship.endDate.onOrAfter=T — S1: with an endDate filter it
 *        keeps the guardians of pupils with an active enrolment. A provider
 *        that answers 400 to that type is not an error: the guardians come
 *        through /persons/lookup below instead.
 *   5. GET /groups?organisation={id}&groupType=Klass&groupType=Undervisning
 *        &endDate.onOrAfter=T (groupMemberships is a direct property of
 *        Group, Group_allOf; "Poster med ett endDate som ej är satt, tas
 *        alltid med")
 *   6. GET /duties?organisation={id}&endDate.onOrAfter=T
 *
 * persons are unioned by id across organisations. An INCREMENTAL run adds
 * meta.modified.after={modifiedCursor} to 2–6 (allowed: only pageToken
 * excludes filters, and the first page has none) and reads
 * GET /deletedEntities?after={deletedCursor}&entities=Person&entities=Group
 * &entities=Duty once.
 *
 * Then every person a fetched pupil (responsibles), duty or group membership
 * names, who is neither fetched nor linked locally, is read through
 * POST /persons/lookup {ids} in batches of 500: duties are expand-only on
 * Person, so S1's meta does not move a person when a duty is added, a
 * guardian is newly attached, or a group names somebody outside the
 * fetched set.
 *
 * If the provider refuses an incremental filter (HTTP 400 on
 * meta.modified.after or /deletedEntities) or the lookup, the run starts
 * over FULL and says so (incrementalUnsupported), so later runs are FULL.
 * Any other failure throws its code, and the run produces no diff:
 * a half-read roster never turns into deactivations.
 */
export interface FetchPlanInput {
  organisationIds: string[];
  today: string;
  mode: 'FULL' | 'INCREMENTAL';
  modifiedCursor: Date | null;
  deletedCursor: Date | null;
  /** Source ids already linked locally: never looked up. */
  linkedPersonIds: ReadonlySet<string>;
  pageSize: number;
}

export interface InvalidRecord {
  entity: 'PERSON' | 'GROUP' | 'DUTY' | 'ORGANISATION';
  externalId: string | null;
}

export interface FetchedRoster {
  mode: 'FULL' | 'INCREMENTAL';
  incrementalUnsupported: boolean;
  organisations: S1Organisation[];
  persons: Map<string, S1Person>;
  /** Ids returned by fetch 2, 3 and 4 respectively. */
  enrolmentIds: Set<string>;
  dutyPersonIds: Set<string>;
  responsibleIds: Set<string>;
  groups: S1Group[];
  duties: S1Duty[];
  deleted: S1DeletedEntities | null;
  invalid: InvalidRecord[];
}

const LOOKUP_BATCH = 500;

class RefusedIncremental extends Error {}

export async function fetchRoster(client: Ss12000Client, input: FetchPlanInput): Promise<FetchedRoster> {
  if (input.mode === 'INCREMENTAL' && input.modifiedCursor && input.deletedCursor) {
    try {
      return await fetchOnce(client, input, 'INCREMENTAL');
    } catch (error) {
      if (!(error instanceof RefusedIncremental)) throw error;
      const full = await fetchOnce(client, input, 'FULL');
      return { ...full, incrementalUnsupported: true };
    }
  }
  return fetchOnce(client, input, 'FULL');
}

async function fetchOnce(client: Ss12000Client, input: FetchPlanInput, mode: 'FULL' | 'INCREMENTAL'): Promise<FetchedRoster> {
  const incremental = mode === 'INCREMENTAL';
  const changedSince: Query = incremental && input.modifiedCursor ? [['meta.modified.after', input.modifiedCursor.toISOString()]] : [];
  /** A 400 to a filter only an incremental run sends: start over FULL. */
  const guarded = async <T>(body: () => Promise<T>): Promise<T> => {
    try {
      return await body();
    } catch (error) {
      if (incremental && error instanceof Ss12000SourceError && error.status === 400) throw new RefusedIncremental();
      throw error;
    }
  };

  const roster: FetchedRoster = {
    mode,
    incrementalUnsupported: false,
    organisations: [],
    persons: new Map(),
    enrolmentIds: new Set(),
    dutyPersonIds: new Set(),
    responsibleIds: new Set(),
    groups: [],
    duties: [],
    deleted: null,
    invalid: [],
  };
  const addPersons = (raw: unknown[], into?: Set<string>) => {
    for (const item of raw) {
      const parsed = parsePerson(item);
      if (!parsed.ok) {
        roster.invalid.push({ entity: 'PERSON', externalId: parsed.externalId });
        continue;
      }
      roster.persons.set(parsed.value.id, parsed.value);
      into?.add(parsed.value.id);
    }
  };
  const groupIds = new Set<string>();
  const dutyIds = new Set<string>();

  for (const organisationId of input.organisationIds) {
    const organisation = parseOrganisation(await client.call('GET', `/organisations/${encodeURIComponent(organisationId)}`));
    if (!organisation.ok) {
      roster.invalid.push({ entity: 'ORGANISATION', externalId: organisation.externalId });
      throw new Ss12000SourceError('SS12000_ORGANISATION_INVALID');
    }
    roster.organisations.push(organisation.value);

    const related = (type: string): Query => [
      ['relationship.organisation', organisationId],
      ['relationship.entity.type', type],
      ['relationship.endDate.onOrAfter', input.today],
      ...changedSince,
    ];
    addPersons(await guarded(() => client.list('/persons', related(RELATIONSHIP_TYPES.enrolment), input.pageSize)), roster.enrolmentIds);
    addPersons(await guarded(() => client.list('/persons', related(RELATIONSHIP_TYPES.duty), input.pageSize)), roster.dutyPersonIds);
    try {
      addPersons(
        await client.list('/persons', related(RELATIONSHIP_TYPES.responsibleForEnrolment), input.pageSize),
        roster.responsibleIds,
      );
    } catch (error) {
      // A provider without responsibleFor.enrolment: the guardians are looked up below.
      if (!(error instanceof Ss12000SourceError && error.status === 400)) throw error;
    }

    const groups = await guarded(() =>
      client.list(
        '/groups',
        [
          ['organisation', organisationId],
          ['groupType', 'Klass'],
          ['groupType', 'Undervisning'],
          ['endDate.onOrAfter', input.today],
          ...changedSince,
        ],
        input.pageSize,
      ),
    );
    for (const item of groups) {
      const parsed = parseGroup(item);
      if (!parsed.ok) {
        roster.invalid.push({ entity: 'GROUP', externalId: parsed.externalId });
      } else if (!groupIds.has(parsed.value.id)) {
        groupIds.add(parsed.value.id);
        roster.groups.push(parsed.value);
      }
    }

    const duties = await guarded(() =>
      client.list('/duties', [['organisation', organisationId], ['endDate.onOrAfter', input.today], ...changedSince], input.pageSize),
    );
    for (const item of duties) {
      const parsed = parseDuty(item);
      if (!parsed.ok) {
        roster.invalid.push({ entity: 'DUTY', externalId: parsed.externalId });
      } else if (!dutyIds.has(parsed.value.id)) {
        dutyIds.add(parsed.value.id);
        roster.duties.push(parsed.value);
      }
    }
  }

  if (incremental && input.deletedCursor) {
    const after = input.deletedCursor;
    const pages = await guarded(() => client.deletedEntities(after, DELETED_ENTITY_TYPES, input.pageSize));
    const merged: S1DeletedEntities = { persons: [], groups: [], duties: [] };
    for (const page of pages) {
      const parsed = parseDeletedEntities(page);
      if (!parsed) continue;
      merged.persons.push(...parsed.persons);
      merged.groups.push(...parsed.groups);
      merged.duties.push(...parsed.duties);
    }
    roster.deleted = merged;
  }

  // Everyone referenced but not read: guardians, duty holders, group members.
  const referenced = new Set<string>();
  for (const person of roster.persons.values()) {
    for (const responsible of person.responsibles) referenced.add(responsible.personId);
  }
  for (const duty of roster.duties) if (duty.personId) referenced.add(duty.personId);
  for (const group of roster.groups) for (const membership of group.memberships) referenced.add(membership.personId);
  const missing = [...referenced].filter((id) => !roster.persons.has(id) && !input.linkedPersonIds.has(id)).sort();
  for (let at = 0; at < missing.length; at += LOOKUP_BATCH) {
    const batch = missing.slice(at, at + LOOKUP_BATCH);
    let found: unknown[];
    try {
      found = await client.lookupPersons(batch);
    } catch (error) {
      const refused = error instanceof Ss12000SourceError && [400, 403, 404, 405, 501].includes(error.status ?? 0);
      if (incremental && refused) throw new RefusedIncremental();
      if (refused) break;
      throw error;
    }
    addPersons(found);
  }

  return roster;
}
