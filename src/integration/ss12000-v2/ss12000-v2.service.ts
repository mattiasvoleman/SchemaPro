import { Injectable } from '@nestjs/common';
import { inTurn } from './in-turn';
import type { PrismaClient } from '@prisma/client';
import { recordRead, type AccessKind } from '../../access-log/access-log';
import { PrismaService } from '../../database/prisma.service';
import { todayInZone } from '../../common/utils/time';
import { adhocActivityId, normaliseUuid } from './ids';
import { v2Errors } from './errors';
import {
  encodePageToken,
  flag,
  list,
  page,
  parseItemQuery,
  parseQuery,
  text,
  type Params,
  type ParsedQuery,
  type SortKey,
} from './query';
import { EMITTED_RESOURCES, SHARED_ONLY, type EmittedResource, type Scope } from './scopes';
import { dayOf, SchoolSlice, type ActivityRow, type LessonRow } from './slice';
import {
  ABSENCE_TYPE,
  absenceObject,
  attendanceObject,
  readAbsences,
  readAttendances,
  serviceEverSharedAttendance,
  serviceReadsAttendance,
  type AttendanceQuery,
} from './attendance';
import { EMAIL_TYPE, groupsOfPerson, metaOf, Model, type Meta, type Reach, type Ref, type Relation } from './model';

/**
 * The SS12000 2.1-shaped provider (/ss12000/v2.0): S1's resources for what
 * SchemaPro is the source of, with S1's paging, meta, filters, sortkeys,
 * expand and expandReferenceNames. One method per S1 operation; every one
 * runs under the service principal of the key's school AND key
 * (withServicePrincipal(schoolId, fn, {keyId})).
 *
 * A filter on an attribute SchemaPro never holds answers an empty page
 * (A1.3), a sortkey on one 400 SORTKEY_NOT_SUPPORTED. An expand or a
 * referenced name needs the scope of the resource it shows (A5.8): an
 * expand without it is 403 SCOPE_MISSING; a displayName without it is simply
 * not written, so a groups.read-only key never learns a pupil's name.
 */

export interface V2Caller {
  schoolId: string;
  keyId: string;
  scopes: ReadonlySet<Scope>;
}

export interface V2Page<T> {
  data: T[];
  pageToken: string | null;
}

type Obj = Record<string, unknown> & { id: string };

/**
 * What a v2 read handed out, per läslogg kind: the emitted person ids, and
 * the duty ids (a post or an uppdrag, which names its teacher) where the
 * response names a teacher only by their duty.
 */
export interface V2Seen {
  kind: AccessKind;
  persons?: string[];
  duties?: string[];
}
export type V2Read = (items: readonly Obj[]) => V2Seen[];

const isText = (id: unknown): id is string => typeof id === 'string';
const entriesOf = (value: unknown): Array<Record<string, unknown>> =>
  Array.isArray(value) ? (value as Array<Record<string, unknown>>) : [];

/** The ids under `key` of each entry of `entries`: `[{ person: { id } }]`. */
function refsIn(entries: unknown, key: 'person' | 'student' | 'duty'): string[] {
  return entriesOf(entries)
    .map((entry) => (entry[key] as { id?: unknown } | undefined)?.id)
    .filter(isText);
}

const embedded = (item: Obj): Record<string, unknown> => (item['_embedded'] as Record<string, unknown> | undefined) ?? {};

/**
 * What every resource's expands embed, read the same way for all of them:
 *
 *   person            (duties?expand=person)   the post's person, names and
 *                                              e-mail: PEOPLE;
 *   duties, teachers  (persons?expand=duties, activities?expand=teachers)
 *                                              posts with their person:
 *                                              EMPLOYMENT;
 *   assignmentRoles   (groups?expand=assignmentRoles) mentorships, by duty:
 *                                              EMPLOYMENT;
 *   groups            (activities?expand=groups) whole groups with their
 *                                              members: ROSTER;
 *   groupMemberships  (persons?expand=groupMemberships) which groups the
 *                                              listed person is in: ROSTER
 *                                              about that person;
 *   attendance        (calendarEvents?expand=attendance) the lesson's
 *                                              attendances: ATTENDANCE about
 *                                              each pupil.
 *
 * An embedded activity (calendarEvents?expand=activity) names its teachers by
 * duty only, as the event itself does, and is not read here.
 */
const EMBEDDED_READ: V2Read = (items) => {
  const inner = items.map((item) => ({ item, embedded: embedded(item) }));
  return [
    { kind: 'ATTENDANCE', persons: inner.flatMap(({ embedded: e }) => refsIn(e['attendance'], 'student')) },
    { kind: 'PEOPLE', persons: inner.map(({ embedded: e }) => (e['person'] as { id?: unknown } | undefined)?.id).filter(isText) },
    {
      kind: 'EMPLOYMENT',
      persons: inner.flatMap(({ embedded: e }) =>
        [...entriesOf(e['duties']), ...entriesOf(e['teachers'])].map((duty) => (duty['person'] as { id?: unknown } | undefined)?.id).filter(isText),
      ),
      duties: inner.flatMap(({ embedded: e }) => refsIn(e['assignmentRoles'], 'duty')),
    },
    {
      kind: 'ROSTER',
      persons: [
        ...inner.flatMap(({ embedded: e }) => entriesOf(e['groups']).flatMap((group) => refsIn(group['groupMemberships'], 'person'))),
        ...inner.filter(({ embedded: e }) => entriesOf(e['groupMemberships']).length > 0).map(({ item }) => item.id),
      ],
    },
  ];
};

/** A resource's own read, then what its expands embedded. */
const withEmbedded =
  (own: V2Read): V2Read =>
  (items) => [...own(items), ...EMBEDDED_READ(items)];

/**
 * Persons: everyone listed (names, e-mail); with responsibles.read, who is
 * whose guardian for each person whose relations the page carries.
 */
const PERSONS_READ: V2Read = withEmbedded((items) => [
  { kind: 'PEOPLE', persons: items.map((item) => item.id) },
  {
    kind: 'GUARDIANS',
    persons: items.flatMap((item) => {
      const related = [...refsIn(item['responsibles'], 'person'), ...refsIn(embedded(item)['responsibleFor'], 'person')];
      return related.length > 0 ? [item.id, ...related] : [];
    }),
  },
]);
/** Groups: their members. */
const GROUPS_READ: V2Read = withEmbedded((items) => [
  { kind: 'ROSTER', persons: items.flatMap((item) => refsIn(item['groupMemberships'], 'person')) },
]);
/** Duties: the person each post is, with their percentages when the school shares them. */
const DUTIES_READ: V2Read = withEmbedded((items) => [
  { kind: 'EMPLOYMENT', persons: items.map((item) => (item['person'] as { id?: unknown } | undefined)?.id).filter(isText) },
]);
/**
 * Activities name their groups and teachers by reference only, which is the
 * timetable; what an expand embeds (whole groups, posts) is read.
 */
const ACTIVITIES_READ: V2Read = withEmbedded(() => []);
/**
 * Calendar events: the pupils named on a lesson outside its groups (ROSTER),
 * and a planned teacher who does not take the lesson (a teacherException with
 * participates false): that tells the reader a member of staff was away from
 * it, with no reason, which is what the cover board shows and STAFF_ABSENCES
 * is. A teacher added (participates true) is the timetable, not an absence.
 */
const EVENTS_READ: V2Read = withEmbedded((items) => [
  { kind: 'ROSTER', persons: items.flatMap((item) => refsIn(item['studentExceptions'], 'student')) },
  {
    kind: 'STAFF_ABSENCES',
    duties: items.flatMap((item) =>
      entriesOf(item['teacherExceptions'])
        .filter((entry) => entry['participates'] === false)
        .map((entry) => (entry['duty'] as { id?: unknown } | undefined)?.id)
        .filter(isText),
    ),
  },
]);

/**
 * A read filtered to named pupils (activities?member=, calendarEvents?student=
 * and their lookups) answers which lessons those pupils take part in: their
 * timetable, recorded as SCHEDULE about them, as the family's week is. The
 * page itself names them only where they stand outside the groups, so
 * without this the read would name nobody it is about. Only a page that
 * carries something: an empty one says no more than that there is nothing
 * in the window. A teacher filter is the timetable, as everywhere, and is
 * not recorded.
 */
export const forPupils =
  (read: V2Read, pupils: readonly string[]): V2Read =>
  (items) => [...read(items), ...(items.length > 0 && pupils.length > 0 ? [{ kind: 'SCHEDULE' as const, persons: [...pupils] }] : [])];

/** Attendances: each pupil whose attendance at a lesson the page carries. */
const ATTENDANCES_READ: V2Read = (items) => [
  { kind: 'ATTENDANCE', persons: items.map((item) => (item['student'] as { id?: unknown } | undefined)?.id).filter(isText) },
];
/**
 * Absences: a reported absence (Anmäld frånvaro) is the pupil's
 * ABSENCE_REPORTS; a day of a granted leave (Beviljad ledighet) tells that a
 * leave was granted, LEAVE_REQUESTS. Never a reason, which is not read.
 */
const ABSENCES_READ: V2Read = (items) => {
  const of = (type: string) =>
    items.filter((item) => item['type'] === type).map((item) => (item['student'] as { id?: unknown } | undefined)?.id).filter(isText);
  return [
    { kind: 'ABSENCE_REPORTS', persons: of(ABSENCE_TYPE.reported) },
    { kind: 'LEAVE_REQUESTS', persons: of(ABSENCE_TYPE.granted) },
  ];
};

/** The reads by resource, for the läslogg's spec. */
export const V2_READS = {
  persons: PERSONS_READ,
  groups: GROUPS_READ,
  duties: DUTIES_READ,
  activities: ACTIVITIES_READ,
  calendarEvents: EVENTS_READ,
  attendances: ATTENDANCES_READ,
  absences: ABSENCES_READ,
} as const;

/** A lookup body may name at most this many ids in total. */
export const LOOKUP_MAX = 1000;
/** A calendar window may span at most this many days. */
export const WINDOW_MAX_DAYS = 400;
/** More events than this for one lookup is S1's 503 "Svaret är förstort". */
export const LOOKUP_EVENTS_MAX = 5000;
/** The same for the attendances one lookup answers with. */
export const LOOKUP_ATTENDANCES_MAX = 5000;

const iso = (value: Date) => value.toISOString();

/** One Duty of a post cut where its grad changes: its id and dates. */
interface Stretch {
  id: string;
  startDate: string;
  endDate: string;
}

function need(caller: V2Caller, scope: Scope): void {
  if (!caller.scopes.has(scope)) throw v2Errors.scopeMissing(scope);
}

function metaMatches(meta: Meta, params: Params): boolean {
  const cb = text(params, 'meta.created.before');
  const ca = text(params, 'meta.created.after');
  const mb = text(params, 'meta.modified.before');
  const ma = text(params, 'meta.modified.after');
  // S1: before is inclusive, after exclusive.
  if (cb && !(meta.created <= cb)) return false;
  if (ca && !(meta.created > ca)) return false;
  if (mb && !(meta.modified <= mb)) return false;
  if (ma && !(meta.modified > ma)) return false;
  return true;
}

/** startDate.* / endDate.*: a value not set is always included (S1, the endDate filters' own words). */
function datesMatch(start: string | undefined, end: string | undefined, params: Params, prefix = ''): boolean {
  const sb = text(params, `${prefix}startDate.onOrBefore`);
  const sa = text(params, `${prefix}startDate.onOrAfter`);
  const eb = text(params, `${prefix}endDate.onOrBefore`);
  const ea = text(params, `${prefix}endDate.onOrAfter`);
  if (start !== undefined) {
    if (sb && !(start <= sb)) return false;
    if (sa && !(start >= sa)) return false;
  }
  if (end !== undefined) {
    if (eb && !(end <= eb)) return false;
    if (ea && !(end >= ea)) return false;
  }
  return true;
}

function expands(params: Params): Set<string> {
  return new Set(list(params, 'expand') ?? []);
}

const byName: SortKey<Obj> = { value: (item) => String(item['displayName'] ?? ''), direction: 1, collate: true };
const byModified: SortKey<Obj> = { value: (item) => (item['meta'] as Meta).modified, direction: -1 };

function sortkey<T extends Obj>(params: Params, keys: Record<string, SortKey<T> | 'unsupported'>): SortKey<T> | null {
  const name = text(params, 'sortkey');
  if (!name) return null;
  const key = keys[name];
  if (!key) throw v2Errors.invalidFilter('sortkey');
  if (key === 'unsupported') throw v2Errors.sortkeyNotSupported();
  return key;
}

function lookupIds(body: unknown, keys: readonly string[]): Record<string, string[]> {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) throw v2Errors.invalidBody();
  const out: Record<string, string[]> = {};
  let total = 0;
  for (const [name, value] of Object.entries(body as Record<string, unknown>)) {
    if (!keys.includes(name) || !Array.isArray(value)) throw v2Errors.invalidBody();
    total += value.length;
    if (total > LOOKUP_MAX) throw v2Errors.invalidBody();
    out[name] = value.map((entry) => {
      if (name === 'civicNos' || name === 'schoolUnitCodes' || name === 'organisationCodes') {
        if (typeof entry !== 'string' || entry.length > 64) throw v2Errors.invalidBody();
        return entry;
      }
      const id = normaliseUuid(entry);
      if (!id) throw v2Errors.invalidBody();
      return id;
    });
  }
  return out;
}

@Injectable()
export class Ss12000V2Service {
  constructor(private readonly prisma: PrismaService) {}

  private async run<T>(caller: V2Caller, params: Params, fn: (model: Model) => Promise<T>): Promise<T> {
    return this.prisma.withServicePrincipal(
      caller.schoolId,
      async (tx) => {
        const school = await (tx as PrismaClient).school.findUnique({ where: { id: caller.schoolId }, select: { timezone: true } });
        const today = dayOf(todayInZone(school?.timezone ?? 'Europe/Stockholm'));
        const slice = new SchoolSlice(tx as PrismaClient, caller.schoolId, today);
        const reach: Reach = { scopes: caller.scopes, names: flag(params, 'expandReferenceNames') };
        return fn(await Model.load(slice, reach));
      },
      { keyId: caller.keyId, timeoutMs: 30_000 },
    );
  }

  /**
   * run() for a read that hands out people's data: what it returned is
   * recorded in the läslogg as the key that asked (app.personal_data_read,
   * in the same transaction), under the kinds `read` finds in it. The
   * emitted person ids (Users.ss12000Id ?? Users.id) are mapped back to the
   * Users rows they came from; a guardian the key may not see was never
   * emitted, and so is never recorded.
   */
  private async runRead<T extends Obj | Obj[] | V2Page<Obj>>(
    caller: V2Caller,
    params: Params,
    read: V2Read,
    fn: (model: Model) => Promise<T>,
  ): Promise<T> {
    return this.run(caller, params, async (model) => {
      const result = await fn(model);
      const items = Array.isArray(result) ? result : 'data' in result && Array.isArray(result.data) ? result.data : [result as Obj];
      // One statement per kind: a person and a duty of one kind are one record.
      const byKind = new Map<AccessKind, string[]>();
      for (const seen of read(items)) {
        const userIds = [
          ...(seen.persons ?? []).map((id) => model.ids.personFrom(id.toLowerCase())),
          ...(seen.duties ?? []).map((id) => model.ids.dutyRead(id.toLowerCase())?.userId ?? null),
        ].filter((id): id is string => id !== null);
        byKind.set(seen.kind, [...(byKind.get(seen.kind) ?? []), ...userIds]);
      }
      for (const [kind, userIds] of byKind) await recordRead(model.slice.tx, kind, userIds);
      return result;
    });
  }

  private token(caller: V2Caller, operation: string, query: ParsedQuery) {
    return (after: [string | number | null, string]) => encodePageToken(caller.keyId, operation, query.params, after);
  }

  private async versions(model: Model, resource: EmittedResource, ids?: readonly string[]) {
    return model.slice.versions(resource, ids);
  }

  // ===========================================================================
  // Organisations
  // ===========================================================================

  /**
   * One Organisation per skolenhet, of organisationType Skolenhet, or the
   * school itself when it has none, as before units (IdSpace). A unit's schoolTypes are
   * its own (the source's, once linked); a unit that lists none, and the
   * school without units, take the active year's timplans for the årskurser
   * it holds. meta.modified is the later of the unit's own version and the
   * school's: a timplan's skolform or the school's name still move what the
   * school's Organisation moved before units existed.
   */
  private async organisations(model: Model): Promise<Obj[]> {
    const units = model.ids.organisations.flatMap((organisation) => (organisation.unit ? [organisation.unit.id] : []));
    const versions = await this.versions(model, 'Organisation', [model.slice.schoolId, ...units]);
    const school = versions.get(model.slice.schoolId);
    const active = model.activeYearId;
    return model.ids.organisations.map((organisation) => {
      const unit = organisation.unit;
      const own = unit ? versions.get(unit.id) : undefined;
      const version = own && school ? (own.modifiedAt > school.modifiedAt ? own : { createdAt: own.createdAt, modifiedAt: school.modifiedAt }) : own ?? school;
      const derived = (): string[] => {
        if (!active) return [];
        if (!unit || unit.gradeFrom === null || unit.gradeTo === null) return unit && model.ids.organisations.length > 1 ? [] : model.types.ofYear(active);
        const types = new Set<string>();
        for (let grade = unit.gradeFrom; grade <= unit.gradeTo; grade++) {
          const type = model.types.of(active, grade);
          if (type) types.add(type);
        }
        return [...types].sort();
      };
      const schoolTypes = unit && unit.schoolTypes.length > 0 ? [...unit.schoolTypes] : derived();
      return {
        id: organisation.id,
        meta: unit ? metaOf(version, unit.createdAt, unit.updatedAt) : metaOf(school, model.school.createdAt, model.school.updatedAt),
        displayName: unit?.name ?? model.school.name,
        organisationType: organisation.organisationType,
        ...(organisation.schoolUnitCode ? { schoolUnitCode: organisation.schoolUnitCode } : {}),
        // S1 Organisation.schoolTypes: "Anges endast för organisationselement
        // typen Skolenhet" — never on the Skola several chosen skolenheter make.
        ...(schoolTypes.length > 0 && organisation.organisationType === 'Skolenhet' ? { schoolTypes } : {}),
      };
    });
  }

  private organisationFilter(item: Obj, params: Params): boolean {
    // Attributes SchemaPro never holds: no organisation matches a filter on them.
    if (list(params, 'parent') || list(params, 'organisationCode') || text(params, 'municipalityCode')) return false;
    const types = list(params, 'type');
    if (types && !types.includes(String(item['organisationType']))) return false;
    const codes = list(params, 'schoolUnitCode');
    if (codes && !codes.includes(String(item['schoolUnitCode'] ?? ''))) return false;
    const schoolTypes = list(params, 'schoolTypes');
    if (schoolTypes && !((item['schoolTypes'] as string[] | undefined) ?? []).some((type) => schoolTypes.includes(type))) return false;
    // No startDate/endDate is held: "tas alltid med".
    return metaMatches(item['meta'] as Meta, params);
  }

  async listOrganisations(caller: V2Caller, raw: Record<string, unknown>): Promise<V2Page<Obj>> {
    need(caller, 'organisations.read');
    const operation = 'GET /organisations';
    const query = parseQuery(operation, raw, caller.keyId);
    const key = sortkey<Obj>(query.params, { ModifiedDesc: byModified, DisplayNameAsc: byName });
    return this.run(caller, query.params, async (model) => {
      const items = (await this.organisations(model)).filter((item) => this.organisationFilter(item, query.params));
      return page(items, key, query, this.token(caller, operation, query));
    });
  }

  async getOrganisation(caller: V2Caller, id: string, raw: Record<string, unknown>): Promise<Obj> {
    need(caller, 'organisations.read');
    const wanted = this.pathId(id);
    const params = parseItemQuery('GET /organisations/{id}', raw);
    return this.run(caller, params, async (model) => {
      const found = (await this.organisations(model)).find((item) => item.id === wanted);
      if (!found) throw v2Errors.notFound();
      return found;
    });
  }

  async lookupOrganisations(caller: V2Caller, body: unknown, raw: Record<string, unknown>): Promise<Obj[]> {
    need(caller, 'organisations.read');
    const params = parseItemQuery('POST /organisations/lookup', raw);
    const ids = lookupIds(body, ['ids', 'schoolUnitCodes', 'organisationCodes']);
    return this.run(caller, params, async (model) =>
      (await this.organisations(model)).filter(
        (item) =>
          (ids['ids'] ?? []).includes(item.id) ||
          (item['schoolUnitCode'] !== undefined && (ids['schoolUnitCodes'] ?? []).includes(String(item['schoolUnitCode']))),
      ),
    );
  }

  // ===========================================================================
  // Persons
  // ===========================================================================

  private async persons(model: Model, expand: Set<string>): Promise<Obj[]> {
    const [versions, enrolments, links] = await inTurn(
      () => this.versions(model, 'Person'),
      () => model.enrolments(),
      () => model.slice.guardianLinks(),
    );
    const responsibles = model.can('responsibles.read');
    const duties = expand.has('duties') ? await model.duties() : [];
    const memberships = expand.has('groupMemberships') ? await model.memberships() : [];
    const groups = expand.has('groupMemberships') ? await this.groupFragments(model) : new Map<string, Obj>();
    return model.users.map((user) => {
      const id = model.ids.person(user.id)!;
      const enrolment = user.role === 'STUDENT' ? enrolments.get(user.id) : undefined;
      const theirs = responsibles && user.role === 'STUDENT'
        ? links
            .filter((link) => link.studentId === user.id)
            .map((link) => model.personRef(link.guardianId))
            .filter((ref): ref is Ref => ref !== null)
            .sort((a, b) => (a.id < b.id ? -1 : 1))
        : [];
      const person: Obj = {
        id,
        meta: metaOf(versions.get(user.id), user.createdAt, user.updatedAt),
        givenName: user.firstName,
        familyName: user.lastName,
        emails: [{ value: user.email, type: EMAIL_TYPE[user.role] }],
        ...(enrolment ? { enrolments: [enrolment] } : {}),
        ...(theirs.length > 0 ? { responsibles: theirs.map((person) => ({ person })) } : {}),
      };
      if (expand.size > 0) {
        const embedded: Record<string, unknown> = {};
        if (expand.has('duties')) embedded['duties'] = duties.filter((entry) => entry.post.userId === user.id).map((entry) => entry.duty);
        if (expand.has('responsibleFor')) {
          embedded['responsibleFor'] =
            user.role === 'GUARDIAN'
              ? links
                  .filter((link) => link.guardianId === user.id)
                  .map((link) => model.personRef(link.studentId))
                  .filter((ref): ref is Ref => ref !== null)
                  .map((person) => ({ person }))
              : [];
        }
        if (expand.has('placements')) embedded['placements'] = [];
        if (expand.has('ownedPlacements')) embedded['ownedPlacements'] = [];
        if (expand.has('groupMemberships')) {
          embedded['groupMemberships'] = memberships
            .filter((membership) => membership.userId === user.id && groups.has(membership.groupId))
            .map((membership) => ({
              group: groups.get(membership.groupId),
              ...(membership.startDate ? { startDate: membership.startDate } : {}),
              ...(membership.endDate ? { endDate: membership.endDate } : {}),
            }));
        }
        person['_embedded'] = embedded;
      }
      return person;
    });
  }

  private personExpandScopes(caller: V2Caller, expand: Set<string>): void {
    if (expand.has('duties')) need(caller, 'duties.read');
    if (expand.has('responsibleFor')) need(caller, 'responsibles.read');
    if (expand.has('groupMemberships')) need(caller, 'groups.read');
  }

  private async personFilter(model: Model, params: Params): Promise<(item: Obj) => boolean> {
    // Attributes SchemaPro never holds (civicNo, identifier.*) or v2 never
    // emits (eduPersonPrincipalNames, A1.9): no person matches.
    const never =
      text(params, 'civicNo') !== undefined ||
      text(params, 'identifier.value') !== undefined ||
      text(params, 'identifier.context') !== undefined ||
      text(params, 'eduPersonPrincipalName') !== undefined;
    const type = text(params, 'relationship.entity.type');
    const placement = type !== undefined && type.startsWith('placement') || type === 'responsibleFor.placement';
    const relationParams = ['relationship.entity.type', 'relationship.organisation', 'relationship.startDate.onOrBefore', 'relationship.startDate.onOrAfter', 'relationship.endDate.onOrBefore', 'relationship.endDate.onOrAfter'];
    const relational = relationParams.some((name) => params[name] !== undefined);
    const relations = relational ? await model.relations() : new Map<string, Relation[]>();
    const organisation = text(params, 'relationship.organisation');
    const names = (list(params, 'nameContains') ?? []).map((value) => value.toLocaleLowerCase('sv'));
    const inverse = new Map(model.users.map((user) => [model.ids.person(user.id)!, user]));
    return (item) => {
      if (never || placement) return false;
      const user = inverse.get(item.id)!;
      // S1: case-insensitive, anywhere in any name field; with several values
      // every value must match at least one field.
      if (names.length > 0) {
        const fields = [user.firstName, user.lastName].map((field) => field.toLocaleLowerCase('sv'));
        if (!names.every((value) => fields.some((field) => field.includes(value)))) return false;
      }
      if (relational) {
        const own = relations.get(user.id) ?? [];
        const ok = own.some(
          (relation) =>
            (type === undefined || relation.type === type) &&
            (organisation === undefined || relation.organisationId === organisation) &&
            datesMatch(relation.startDate, relation.endDate, params, 'relationship.'),
        );
        if (!ok) return false;
      }
      return metaMatches(item['meta'] as Meta, params);
    };
  }

  private personSort(params: Params): SortKey<Obj> | null {
    const given = (item: Obj) => String(item['givenName']);
    const family = (item: Obj) => String(item['familyName']);
    return sortkey<Obj>(params, {
      DisplayNameAsc: { value: (item) => `${given(item)} ${family(item)}`, direction: 1, collate: true },
      GivenNameAsc: { value: given, direction: 1, collate: true },
      GivenNameDesc: { value: given, direction: -1, collate: true },
      FamilyNameAsc: { value: family, direction: 1, collate: true },
      FamilyNameDesc: { value: family, direction: -1, collate: true },
      ModifiedDesc: byModified,
      CivicNoAsc: 'unsupported',
      CivicNoDesc: 'unsupported',
    });
  }

  async listPersons(caller: V2Caller, raw: Record<string, unknown>): Promise<V2Page<Obj>> {
    need(caller, 'persons.read');
    const operation = 'GET /persons';
    const query = parseQuery(operation, raw, caller.keyId);
    const expand = expands(query.params);
    this.personExpandScopes(caller, expand);
    const key = this.personSort(query.params);
    return this.runRead(caller, query.params, PERSONS_READ, async (model) => {
      const filter = await this.personFilter(model, query.params);
      const items = (await this.persons(model, expand)).filter(filter);
      return page(items, key, query, this.token(caller, operation, query));
    });
  }

  async getPerson(caller: V2Caller, id: string, raw: Record<string, unknown>): Promise<Obj> {
    need(caller, 'persons.read');
    const wanted = this.pathId(id);
    const params = parseItemQuery('GET /persons/{id}', raw);
    const expand = expands(params);
    this.personExpandScopes(caller, expand);
    return this.runRead(caller, params, PERSONS_READ, async (model) => {
      const found = (await this.persons(model, expand)).find((item) => item.id === wanted);
      if (!found) throw v2Errors.notFound();
      return found;
    });
  }

  async lookupPersons(caller: V2Caller, body: unknown, raw: Record<string, unknown>): Promise<Obj[]> {
    need(caller, 'persons.read');
    const params = parseItemQuery('POST /persons/lookup', raw);
    const expand = expands(params);
    this.personExpandScopes(caller, expand);
    // civicNos: SchemaPro holds no personnummer, so none matches (A1.3).
    const wanted = new Set(lookupIds(body, ['ids', 'civicNos'])['ids'] ?? []);
    return this.runRead(caller, params, PERSONS_READ, async (model) => (await this.persons(model, expand)).filter((item) => wanted.has(item.id)));
  }

  // ===========================================================================
  // Groups
  // ===========================================================================

  /** GroupFragment: a group without its memberships (Person's expand). */
  private async groupFragments(model: Model): Promise<Map<string, Obj>> {
    const versions = await this.versions(model, 'Group');
    const out = new Map<string, Obj>();
    for (const group of model.groups) {
      const bounds = model.yearBounds(group.academicYearId);
      if (!bounds) continue;
      const schoolType = model.types.of(group.academicYearId, group.gradeLevel);
      out.set(group.id, {
        id: model.ids.group(group.id)!,
        meta: metaOf(versions.get(group.id), group.createdAt, group.updatedAt),
        displayName: group.name,
        startDate: bounds.startDate,
        endDate: bounds.endDate,
        groupType: group.kind === 'CLASS' ? 'Klass' : 'Undervisning',
        ...(schoolType ? { schoolType } : {}),
        organisation: model.organisationRef(model.groupOrganisation(group.id)),
      });
    }
    return out;
  }

  private async groupObjects(model: Model, expand: Set<string>): Promise<Obj[]> {
    const [fragments, memberships] = await inTurn(() => this.groupFragments(model), () => model.memberships());
    const mentorships = expand.has('assignmentRoles') ? await model.slice.mentorships() : [];
    const cut = expand.has('assignmentRoles') ? await this.cutPosts(model) : new Map<string, Stretch[]>();
    const out: Obj[] = [];
    for (const group of model.groups) {
      const fragment = fragments.get(group.id);
      if (!fragment) continue;
      const members = memberships
        .filter((membership) => membership.groupId === group.id)
        .map((membership) => ({
          person: model.personRef(membership.userId)!,
          ...(membership.startDate ? { startDate: membership.startDate } : {}),
          ...(membership.endDate ? { endDate: membership.endDate } : {}),
        }))
        .filter((entry) => entry.person !== null)
        .sort((a, b) => (a.person.id < b.person.id ? -1 : a.person.id > b.person.id ? 1 : (a.startDate ?? '') < (b.startDate ?? '') ? -1 : 1));
      const item: Obj = { ...fragment, ...(members.length > 0 ? { groupMemberships: members } : {}) };
      if (expand.has('assignmentRoles')) {
        const bounds = model.yearBounds(group.academicYearId)!;
        item['_embedded'] = {
          // Each mentorship with its own Från and Till, the year's where it
          // has none (ss12000-duties.ts says why). A post cut where its grad
          // changes carries it on each Duty it falls in, clipped to that
          // Duty, as the Duties' own assignmentRole do; only a key with
          // duties.read expands this.
          assignmentRoles: mentorships
            .filter((duty) => duty.studentGroupId === group.id && duty.academicYearId === group.academicYearId)
            .map((duty) => ({ ref: model.dutyRef(duty.userId, group.academicYearId), duty }))
            .filter((entry): entry is { ref: Ref; duty: (typeof mentorships)[number] } => entry.ref !== null)
            .flatMap(({ ref, duty }) => {
              const startDate = duty.validFrom ? dayOf(duty.validFrom) : bounds.startDate;
              const endDate = duty.validTo ? dayOf(duty.validTo) : bounds.endDate;
              const stretches = cut.get(`${duty.userId}:${group.academicYearId}`);
              if (!stretches) return [{ duty: ref, assignmentRoleType: 'Mentor', startDate, endDate }];
              return stretches
                .filter((stretch) => stretch.startDate <= endDate && stretch.endDate >= startDate)
                .map((stretch) => ({
                  duty: { ...ref, id: stretch.id },
                  assignmentRoleType: 'Mentor',
                  startDate: stretch.startDate > startDate ? stretch.startDate : startDate,
                  endDate: stretch.endDate < endDate ? stretch.endDate : endDate,
                }));
            }),
        };
      }
      out.push(item);
    }
    return out;
  }

  private groupFilter(params: Params): (item: Obj) => boolean {
    const types = list(params, 'groupType');
    const schoolTypes = list(params, 'schoolTypes');
    const organisations = list(params, 'organisation');
    return (item) => {
      if (types && !types.includes(String(item['groupType']))) return false;
      if (schoolTypes && !schoolTypes.includes(String(item['schoolType'] ?? ''))) return false;
      if (organisations && !organisations.includes((item['organisation'] as Ref).id)) return false;
      if (!datesMatch(item['startDate'] as string, item['endDate'] as string | undefined, params)) return false;
      return metaMatches(item['meta'] as Meta, params);
    };
  }

  async listGroups(caller: V2Caller, raw: Record<string, unknown>): Promise<V2Page<Obj>> {
    need(caller, 'groups.read');
    const operation = 'GET /groups';
    const query = parseQuery(operation, raw, caller.keyId);
    const expand = expands(query.params);
    if (expand.has('assignmentRoles')) need(caller, 'duties.read');
    const start = (item: Obj) => String(item['startDate']);
    const end = (item: Obj) => (item['endDate'] as string | undefined) ?? null;
    const key = sortkey<Obj>(query.params, {
      ModifiedDesc: byModified,
      DisplayNameAsc: byName,
      StartDateAsc: { value: start, direction: 1 },
      StartDateDesc: { value: start, direction: -1 },
      EndDateAsc: { value: end, direction: 1 },
      EndDateDesc: { value: end, direction: -1 },
    });
    return this.runRead(caller, query.params, GROUPS_READ, async (model) => {
      const items = (await this.groupObjects(model, expand)).filter(this.groupFilter(query.params));
      return page(items, key, query, this.token(caller, operation, query));
    });
  }

  async getGroup(caller: V2Caller, id: string, raw: Record<string, unknown>): Promise<Obj> {
    need(caller, 'groups.read');
    const wanted = this.pathId(id);
    const params = parseItemQuery('GET /groups/{id}', raw);
    const expand = expands(params);
    if (expand.has('assignmentRoles')) need(caller, 'duties.read');
    return this.runRead(caller, params, GROUPS_READ, async (model) => {
      const found = (await this.groupObjects(model, expand)).find((item) => item.id === wanted);
      if (!found) throw v2Errors.notFound();
      return found;
    });
  }

  async lookupGroups(caller: V2Caller, body: unknown, raw: Record<string, unknown>): Promise<Obj[]> {
    need(caller, 'groups.read');
    const params = parseItemQuery('POST /groups/lookup', raw);
    const expand = expands(params);
    if (expand.has('assignmentRoles')) need(caller, 'duties.read');
    const wanted = new Set(lookupIds(body, ['ids'])['ids'] ?? []);
    return this.runRead(caller, params, GROUPS_READ, async (model) => (await this.groupObjects(model, expand)).filter((item) => wanted.has(item.id)));
  }

  // ===========================================================================
  // Duties
  // ===========================================================================

  /** The posts emitted as more than one Duty, by teacher and year: each Duty's id and dates. */
  private async cutPosts(model: Model): Promise<Map<string, Stretch[]>> {
    const byPost = new Map<string, { key: string; stretches: Stretch[] }>();
    for (const { duty, post } of await model.duties()) {
      const entry = byPost.get(post.id) ?? { key: `${post.userId}:${post.academicYearId}`, stretches: [] };
      entry.stretches.push({ id: duty.id, startDate: duty.startDate, endDate: duty.endDate });
      byPost.set(post.id, entry);
    }
    return new Map([...byPost.values()].filter((entry) => entry.stretches.length > 1).map((entry) => [entry.key, entry.stretches]));
  }

  private async dutyObjects(model: Model, expand: Set<string>): Promise<Obj[]> {
    const duties = await model.duties();
    const persons = expand.has('person') ? new Map((await this.persons(model, new Set())).map((person) => [person.id, person])) : null;
    return duties.map(({ duty }) => {
      const item = { ...duty } as unknown as Obj;
      if (persons) {
        const person = persons.get(duty.person.id);
        item['_embedded'] = person ? { person } : {};
      }
      return item;
    });
  }

  private dutyFilter(params: Params): (item: Obj) => boolean {
    const organisation = text(params, 'organisation');
    const role = text(params, 'dutyRole');
    const person = text(params, 'person');
    return (item) => {
      if (organisation !== undefined && organisation !== (item['dutyAt'] as Ref).id) return false;
      if (role !== undefined && item['dutyRole'] !== role) return false;
      if (person !== undefined && (item['person'] as Ref).id !== person) return false;
      if (!datesMatch(item['startDate'] as string, item['endDate'] as string | undefined, params)) return false;
      return metaMatches(item['meta'] as Meta, params);
    };
  }

  async listDuties(caller: V2Caller, raw: Record<string, unknown>): Promise<V2Page<Obj>> {
    need(caller, 'duties.read');
    const operation = 'GET /duties';
    const query = parseQuery(operation, raw, caller.keyId);
    const expand = expands(query.params);
    if (expand.has('person')) need(caller, 'persons.read');
    const start = (item: Obj) => String(item['startDate']);
    const key = sortkey<Obj>(query.params, {
      StartDateDesc: { value: start, direction: -1 },
      StartDateAsc: { value: start, direction: 1 },
      ModifiedDesc: byModified,
    });
    return this.runRead(caller, query.params, DUTIES_READ, async (model) => {
      const items = (await this.dutyObjects(model, expand)).filter(this.dutyFilter(query.params));
      return page(items, key, query, this.token(caller, operation, query));
    });
  }

  async getDuty(caller: V2Caller, id: string, raw: Record<string, unknown>): Promise<Obj> {
    need(caller, 'duties.read');
    const wanted = this.pathId(id);
    const params = parseItemQuery('GET /duties/{id}', raw);
    const expand = expands(params);
    if (expand.has('person')) need(caller, 'persons.read');
    return this.runRead(caller, params, DUTIES_READ, async (model) => {
      const found = (await this.dutyObjects(model, expand)).find((item) => item.id === wanted);
      if (!found) throw v2Errors.notFound();
      return found;
    });
  }

  async lookupDuties(caller: V2Caller, body: unknown, raw: Record<string, unknown>): Promise<Obj[]> {
    need(caller, 'duties.read');
    const params = parseItemQuery('POST /duties/lookup', raw);
    const expand = expands(params);
    if (expand.has('person')) need(caller, 'persons.read');
    const wanted = new Set(lookupIds(body, ['ids'])['ids'] ?? []);
    return this.runRead(caller, params, DUTIES_READ, async (model) => (await this.dutyObjects(model, expand)).filter((item) => wanted.has(item.id)));
  }

  // ===========================================================================
  // Rooms
  // ===========================================================================

  private async roomObjects(model: Model): Promise<Obj[]> {
    const [rooms, versions] = await inTurn(() => model.slice.rooms(), () => this.versions(model, 'Room'));
    return rooms.map((room) => ({
      id: room.id,
      meta: metaOf(versions.get(room.id), room.createdAt, room.updatedAt),
      displayName: room.name,
      ...(room.capacity !== null ? { seats: room.capacity } : {}),
      // A room is the school's: the first skolenhet owns it.
      owner: model.organisationRef(),
    }));
  }

  async listRooms(caller: V2Caller, raw: Record<string, unknown>): Promise<V2Page<Obj>> {
    need(caller, 'rooms.read');
    const operation = 'GET /rooms';
    const query = parseQuery(operation, raw, caller.keyId);
    const key = sortkey<Obj>(query.params, { ModifiedDesc: byModified, DisplayNameAsc: byName });
    const organisation = text(query.params, 'organisation');
    return this.run(caller, query.params, async (model) => {
      const items = (await this.roomObjects(model)).filter(
        (item) => (organisation === undefined || organisation === (item['owner'] as Ref).id) && metaMatches(item['meta'] as Meta, query.params),
      );
      return page(items, key, query, this.token(caller, operation, query));
    });
  }

  async getRoom(caller: V2Caller, id: string, raw: Record<string, unknown>): Promise<Obj> {
    need(caller, 'rooms.read');
    const wanted = this.pathId(id);
    const params = parseItemQuery('GET /rooms/{id}', raw);
    return this.run(caller, params, async (model) => {
      const found = (await this.roomObjects(model)).find((item) => item.id === wanted);
      if (!found) throw v2Errors.notFound();
      return found;
    });
  }

  async lookupRooms(caller: V2Caller, body: unknown, raw: Record<string, unknown>): Promise<Obj[]> {
    need(caller, 'rooms.read');
    const params = parseItemQuery('POST /rooms/lookup', raw);
    const wanted = new Set(lookupIds(body, ['ids'])['ids'] ?? []);
    return this.run(caller, params, async (model) => (await this.roomObjects(model)).filter((item) => wanted.has(item.id)));
  }

  // ===========================================================================
  // Syllabuses
  // ===========================================================================

  /**
   * A Syllabus needs a schoolType (required by S1): the school's one school
   * form in the active year's timplans. A school with none, or with several
   * (grundskola beside anpassad grundskola), emits no Syllabus, and its
   * activities carry no syllabus reference.
   */
  private async syllabusObjects(model: Model): Promise<Obj[]> {
    const forms = model.activeYearId ? model.types.formsOf(model.activeYearId) : [];
    if (forms.length !== 1) return [];
    const [subjects, versions] = await inTurn(() => model.slice.subjects(), () => this.versions(model, 'Syllabus'));
    return subjects.map((subject) => ({
      id: subject.id,
      meta: metaOf(versions.get(subject.id), subject.createdAt, subject.updatedAt),
      schoolType: forms[0]!,
      subjectName: subject.name,
      ...(subject.nationalCode ? { subjectDesignation: subject.nationalCode } : {}),
      official: subject.nationalCode !== null,
    }));
  }

  async listSyllabuses(caller: V2Caller, raw: Record<string, unknown>): Promise<V2Page<Obj>> {
    need(caller, 'syllabuses.read');
    const operation = 'GET /syllabuses';
    const query = parseQuery(operation, raw, caller.keyId);
    const name = (item: Obj) => String(item['subjectName']);
    const designation = (item: Obj) => (item['subjectDesignation'] as string | undefined) ?? null;
    const key = sortkey<Obj>(query.params, {
      ModifiedDesc: byModified,
      SubjectNameAsc: { value: name, direction: 1, collate: true },
      SubjectNameDesc: { value: name, direction: -1, collate: true },
      SubjectDesignationAsc: { value: designation, direction: 1 },
      SubjectDesignationDesc: { value: designation, direction: -1 },
      SubjectCodeAsc: 'unsupported',
      SubjectCodeDesc: 'unsupported',
      CourseNameAsc: 'unsupported',
      CourseNameDesc: 'unsupported',
      CourseCodeAsc: 'unsupported',
      CourseCodeDesc: 'unsupported',
    });
    return this.run(caller, query.params, async (model) => {
      const items = (await this.syllabusObjects(model)).filter((item) => metaMatches(item['meta'] as Meta, query.params));
      return page(items, key, query, this.token(caller, operation, query));
    });
  }

  async getSyllabus(caller: V2Caller, id: string, raw: Record<string, unknown>): Promise<Obj> {
    need(caller, 'syllabuses.read');
    const wanted = this.pathId(id);
    const params = parseItemQuery('GET /syllabuses/{id}', raw);
    return this.run(caller, params, async (model) => {
      const found = (await this.syllabusObjects(model)).find((item) => item.id === wanted);
      if (!found) throw v2Errors.notFound();
      return found;
    });
  }

  async lookupSyllabuses(caller: V2Caller, body: unknown, raw: Record<string, unknown>): Promise<Obj[]> {
    need(caller, 'syllabuses.read');
    const params = parseItemQuery('POST /syllabuses/lookup', raw);
    const wanted = new Set(lookupIds(body, ['ids'])['ids'] ?? []);
    return this.run(caller, params, async (model) => (await this.syllabusObjects(model)).filter((item) => wanted.has(item.id)));
  }

  // ===========================================================================
  // Activities
  // ===========================================================================

  private async activityObjects(model: Model, expand: Set<string>): Promise<Array<{ item: Obj; row: ActivityRow }>> {
    const [rows, subjects, masterVersions, syllabuses] = await inTurn(
      () => model.slice.activities(),
      () => model.slice.subjects(),
      () => this.versions(model, 'Activity'),
      () => this.syllabusObjects(model),
    );
    const subjectById = new Map(subjects.map((subject) => [subject.id, subject]));
    const syllabusById = new Map(syllabuses.map((syllabus) => [syllabus.id, syllabus]));
    const groupObjects = expand.has('groups') ? new Map((await this.groupObjects(model, new Set())).map((group) => [group.id, group])) : null;
    const dutyObjects = expand.has('teachers') ? new Map((await this.dutyObjects(model, new Set())).map((duty) => [duty.id, duty])) : null;
    const out: Array<{ item: Obj; row: ActivityRow }> = [];
    for (const row of rows) {
      const subject = subjectById.get(row.subjectId);
      const group = model.groupsById.get(row.studentGroupId);
      const primary = model.groupRef(row.studentGroupId);
      if (!subject || !group || !primary) continue;
      const groups = [primary, ...row.extraGroupIds.map((id) => model.groupRef(id)).filter((ref): ref is Ref => ref !== null)];
      const teachers = model.activityTeachers(row);
      const syllabus = syllabusById.get(subject.id);
      const item: Obj = {
        id: row.id,
        meta: metaOf(masterVersions.get(row.entityId), row.createdAt, row.updatedAt),
        displayName: `${subject.name} — ${group.name}`,
        calendarEventsRequired: !row.adhoc,
        startDate: row.startDate,
        endDate: row.endDate,
        activityType: subject.countsTowardTimplan ? 'Undervisning' : 'Elevaktivitet',
        groups,
        ...(teachers.length > 0 ? { teachers: teachers.map((duty) => ({ duty })) } : {}),
        ...(syllabus
          ? { syllabus: model.reach.names && model.can('syllabuses.read') ? { id: subject.id, displayName: subject.name } : { id: subject.id } }
          : {}),
        organisation: model.organisationRef(model.groupOrganisation(row.studentGroupId)),
      };
      if (expand.size > 0) {
        const embedded: Record<string, unknown> = {};
        if (groupObjects) embedded['groups'] = groups.map((ref) => groupObjects.get(ref.id)).filter(Boolean);
        if (dutyObjects) embedded['teachers'] = teachers.map((ref) => dutyObjects.get(ref.id)).filter(Boolean);
        if (expand.has('syllabus') && syllabus) embedded['syllabus'] = syllabus;
        item['_embedded'] = embedded;
      }
      out.push({ item, row });
    }
    return out;
  }

  private activityExpandScopes(caller: V2Caller, expand: Set<string>): void {
    if (expand.has('groups')) need(caller, 'groups.read');
    if (expand.has('teachers')) need(caller, 'duties.read');
    if (expand.has('syllabus')) need(caller, 'syllabuses.read');
  }

  /** The people of a group now: its class members (Users.studentGroupId) and teaching members. */
  private async groupMembersNow(model: Model): Promise<Map<string, Set<string>>> {
    const teaching = await model.slice.teachingMembers();
    const out = new Map<string, Set<string>>();
    for (const user of model.users) {
      for (const groupId of groupsOfPerson(user, teaching)) {
        out.set(groupId, (out.get(groupId) ?? new Set()).add(user.id));
      }
    }
    return out;
  }

  private async activityFilter(model: Model, params: Params): Promise<(entry: { item: Obj; row: ActivityRow }) => boolean> {
    const member = text(params, 'member');
    const teacher = text(params, 'teacher');
    const organisation = text(params, 'organisation');
    const group = text(params, 'group');
    const members = member ? await this.groupMembersNow(model) : null;
    const memberId = member ? model.ids.personFrom(member) : null;
    const groupId = group ? model.ids.groupFrom(group) : null;
    return ({ item, row }) => {
      if (organisation !== undefined && organisation !== (item['organisation'] as Ref).id) return false;
      if (group !== undefined && !(groupId && [row.studentGroupId, ...row.extraGroupIds].includes(groupId))) return false;
      if (teacher !== undefined && !((item['teachers'] as Array<{ duty: Ref }> | undefined) ?? []).some((entry) => entry.duty.id === teacher)) return false;
      if (member !== undefined) {
        if (!memberId) return false;
        if (![row.studentGroupId, ...row.extraGroupIds].some((id) => members!.get(id)?.has(memberId))) return false;
      }
      if (!datesMatch(item['startDate'] as string, item['endDate'] as string | undefined, params)) return false;
      return metaMatches(item['meta'] as Meta, params);
    };
  }

  async listActivities(caller: V2Caller, raw: Record<string, unknown>): Promise<V2Page<Obj>> {
    need(caller, 'activities.read');
    const operation = 'GET /activities';
    const query = parseQuery(operation, raw, caller.keyId);
    const expand = expands(query.params);
    this.activityExpandScopes(caller, expand);
    const key = sortkey<Obj>(query.params, { ModifiedDesc: byModified, DisplayNameAsc: byName });
    const member = text(query.params, 'member');
    return this.runRead(caller, query.params, forPupils(ACTIVITIES_READ, member ? [member] : []), async (model) => {
      const filter = await this.activityFilter(model, query.params);
      const items = (await this.activityObjects(model, expand)).filter(filter).map((entry) => entry.item);
      return page(items, key, query, this.token(caller, operation, query));
    });
  }

  async getActivity(caller: V2Caller, id: string, raw: Record<string, unknown>): Promise<Obj> {
    need(caller, 'activities.read');
    const wanted = this.pathId(id);
    const params = parseItemQuery('GET /activities/{id}', raw);
    const expand = expands(params);
    this.activityExpandScopes(caller, expand);
    return this.runRead(caller, params, ACTIVITIES_READ, async (model) => {
      const found = (await this.activityObjects(model, expand)).find((entry) => entry.item.id === wanted);
      if (!found) throw v2Errors.notFound();
      return found.item;
    });
  }

  async lookupActivities(caller: V2Caller, body: unknown, raw: Record<string, unknown>): Promise<Obj[]> {
    need(caller, 'activities.read');
    const params = parseItemQuery('POST /activities/lookup', raw);
    const expand = expands(params);
    this.activityExpandScopes(caller, expand);
    const ids = lookupIds(body, ['ids', 'teachers', 'members']);
    return this.runRead(caller, params, forPupils(ACTIVITIES_READ, ids['members'] ?? []), async (model) => {
      const members = (ids['members'] ?? []).length > 0 ? await this.groupMembersNow(model) : new Map<string, Set<string>>();
      const memberIds = (ids['members'] ?? []).map((id) => model.ids.personFrom(id)).filter((id): id is string => id !== null);
      return (await this.activityObjects(model, expand))
        .filter(({ item, row }) => {
          if ((ids['ids'] ?? []).includes(item.id)) return true;
          const teachers = ((item['teachers'] as Array<{ duty: Ref }> | undefined) ?? []).map((entry) => entry.duty.id);
          if ((ids['teachers'] ?? []).some((id) => teachers.includes(id))) return true;
          return memberIds.some((userId) => [row.studentGroupId, ...row.extraGroupIds].some((groupId) => members.get(groupId)?.has(userId)));
        })
        .map((entry) => entry.item);
    });
  }

  // ===========================================================================
  // CalendarEvents
  // ===========================================================================

  /**
   * Calendar lessons as S1 CalendarEvents. CalendarLessons ARE the published
   * calendar (a DRAFT school's edits reach them only through a publish).
   * Only lessons of the active and past years' groups (A5.7).
   *
   * teacherExceptions compares the event's teachers with its activity's:
   * the event's are every CalendarLessonTeachers row. A cover removes only
   * the leaving teacher's row and adds the vikarie's (assignInTransaction),
   * so a co-teacher still on the lesson beside a SUBSTITUTE teaches it and
   * is not reported absent. A teacher of
   * the event but not the activity participates; one of the activity but not
   * the event does not. Only the fact — never a reason, a note or a cause.
   * A teacher without a Duty to reference is left out (A5.6).
   */
  private async eventObjects(model: Model, lessons: LessonRow[], expand: Set<string>): Promise<Obj[]> {
    return (await this.events(model, lessons, expand)).map((entry) => entry.item);
  }

  private async events(
    model: Model,
    lessons: LessonRow[],
    expand: Set<string>,
  ): Promise<Array<{ item: Obj; lesson: LessonRow; groups: string[]; named: string[]; activityDuties: string[] }>> {
    if (lessons.length === 0) return [];
    const ids = lessons.map((lesson) => lesson.id);
    const [parts, versions, activities, rooms, teaching] = await inTurn(
      () => model.slice.lessonParts(ids),
      () => this.versions(model, 'CalendarEvent', ids),
      () => model.slice.activities(),
      () => model.slice.rooms(),
      () => model.slice.teachingMembers(),
    );
    const activityById = new Map(activities.map((row) => [row.id, row]));
    const roomById = new Map(rooms.map((room) => [room.id, room]));
    const groupMembers = new Map<string, Set<string>>();
    for (const user of model.users) {
      for (const groupId of groupsOfPerson(user, teaching)) groupMembers.set(groupId, (groupMembers.get(groupId) ?? new Set()).add(user.id));
    }
    const embedded = expand.has('activity') ? new Map((await this.activityObjects(model, new Set())).map((entry) => [entry.item.id, entry.item])) : null;
    return lessons.map((lesson) => {
      const yearId = model.lessonYear(lesson)!;
      const activityId = lesson.masterLessonId ?? parts.pendingKey.get(lesson.id) ?? adhocActivityId(lesson.id);
      const rows = parts.teachers.get(lesson.id) ?? [];
      // Every row is a teacher on the lesson: a cover replaces only the
      // leaving teacher's row (CalendarLessonsService.assignInTransaction),
      // so a co-teacher beside a substitute still teaches it.
      const present = new Set(rows.map((row) => row.teacherId));
      const planned = new Set(activityById.get(activityId)?.teacherIds ?? []);
      const teacherExceptions = [
        ...[...present].filter((id) => !planned.has(id)).map((id) => ({ id, participates: true })),
        ...[...planned].filter((id) => !present.has(id)).map((id) => ({ id, participates: false })),
      ]
        .map(({ id, participates }) => {
          const duty = model.dutyRef(id, yearId);
          return duty ? { duty, participates } : null;
        })
        .filter((entry): entry is NonNullable<typeof entry> => entry !== null)
        .sort((a, b) => (a.duty.id < b.duty.id ? -1 : 1));
      const groups = [lesson.studentGroupId, ...(parts.extraGroups.get(lesson.id) ?? []).map((row) => row.studentGroupId)];
      const studentExceptions = (parts.students.get(lesson.id) ?? [])
        .filter((row) => !groups.some((groupId) => groupMembers.get(groupId)?.has(row.studentId)))
        .map((row) => model.personRef(row.studentId))
        .filter((ref): ref is Ref => ref !== null)
        .sort((a, b) => (a.id < b.id ? -1 : 1))
        .map((student) => ({ student, participates: true }));
      const room = lesson.roomId ? roomById.get(lesson.roomId) : undefined;
      const item: Obj = {
        id: lesson.id,
        meta: metaOf(versions.get(lesson.id), lesson.createdAt, lesson.updatedAt),
        activity:
          model.reach.names && model.can('activities.read') && embedded?.get(activityId)
            ? { id: activityId, displayName: String(embedded.get(activityId)!['displayName']) }
            : { id: activityId },
        startTime: iso(lesson.startsAt),
        endTime: iso(lesson.endsAt),
        cancelled: lesson.status === 'CANCELLED',
        ...(studentExceptions.length > 0 ? { studentExceptions } : {}),
        ...(teacherExceptions.length > 0 ? { teacherExceptions } : {}),
        ...(room ? { rooms: [model.reach.names && model.can('rooms.read') ? { id: room.id, displayName: room.name } : { id: room.id }] } : {}),
      };
      if (embedded) {
        const activity = embedded.get(activityId);
        item['_embedded'] = activity ? { activity } : {};
      }
      const activityRow = activityById.get(activityId);
      return {
        item,
        lesson,
        groups,
        named: (parts.students.get(lesson.id) ?? []).map((row) => row.studentId),
        activityDuties: activityRow ? model.activityTeachers(activityRow).map((ref) => ref.id) : [],
      };
    });
  }

  private eventExpandScopes(caller: V2Caller, expand: Set<string>): void {
    if (expand.has('attendance')) need(caller, 'attendances.read');
    if (expand.has('activity')) need(caller, 'activities.read');
  }

  /**
   * expand=attendance: each event's attendances under `_embedded.attendance`,
   * read for the events of the page only, once the school's decision has
   * been asked (403 NOT_SHARED without it).
   */
  private async embedAttendance(model: Model, expand: Set<string>, items: readonly Obj[]): Promise<void> {
    if (!expand.has('attendance')) return;
    await this.shared(model, 'attendances.read');
    const rows = items.length === 0 ? [] : await readAttendances(model.slice.tx, { lessons: items.map((item) => item.id) });
    const byLesson = new Map<string, Obj[]>();
    for (const row of rows) {
      const attendance = attendanceObject(model, row);
      if (attendance) byLesson.set(row.calendarLessonId, [...(byLesson.get(row.calendarLessonId) ?? []), attendance]);
    }
    for (const item of items) item['_embedded'] = { ...embedded(item), attendance: byLesson.get(item.id) ?? [] };
  }

  /**
   * S1's filters on events: activity; student ("activity.group =>
   * group.groupMemberships.person.id eller studentExceptions.student.id");
   * teacher ("activity.teachers.duty.id samt teacherExceptions.duty.id");
   * group (through the activity); organisation; endTime.*; meta.*.
   */
  private eventFilter(
    model: Model,
    params: Params,
    teaching: { studentGroupId: string; studentId: string }[],
  ): (entry: { item: Obj; groups: string[]; named: string[]; activityDuties: string[] }) => boolean {
    const activity = text(params, 'activity');
    const student = text(params, 'student');
    const teacher = text(params, 'teacher');
    const organisation = text(params, 'organisation');
    const group = text(params, 'group');
    const eb = text(params, 'endTime.onOrBefore');
    const ea = text(params, 'endTime.onOrAfter');
    const studentUser = student ? model.usersById.get(model.ids.personFrom(student) ?? '') : undefined;
    const studentGroups = studentUser ? groupsOfPerson(studentUser, teaching) : new Set<string>();
    const groupId = group ? model.ids.groupFrom(group) : null;
    return ({ item, groups, named, activityDuties }) => {
      // An event's organisation is its activity's: the lesson's own group's skolenhet.
      if (organisation !== undefined && organisation !== model.groupOrganisation(groups[0]!)) return false;
      if (activity !== undefined && (item['activity'] as Ref).id !== activity) return false;
      if (eb && !(String(item['endTime']) <= eb)) return false;
      if (ea && !(String(item['endTime']) >= ea)) return false;
      if (group !== undefined && !(groupId && groups.includes(groupId))) return false;
      if (student !== undefined) {
        if (!studentUser) return false;
        if (!named.includes(studentUser.id) && !groups.some((id) => studentGroups.has(id))) return false;
      }
      if (teacher !== undefined) {
        const exceptions = (item['teacherExceptions'] as Array<{ duty: Ref }> | undefined) ?? [];
        if (!activityDuties.includes(teacher) && !exceptions.some((entry) => entry.duty.id === teacher)) return false;
      }
      return metaMatches(item['meta'] as Meta, params);
    };
  }

  async listCalendarEvents(caller: V2Caller, raw: Record<string, unknown>): Promise<V2Page<Obj>> {
    need(caller, 'calendarEvents.read');
    const operation = 'GET /calendarEvents';
    const query = parseQuery(operation, raw, caller.keyId);
    const expand = expands(query.params);
    this.eventExpandScopes(caller, expand);
    const from = new Date(String(query.params['startTime.onOrAfter']));
    const to = new Date(String(query.params['startTime.onOrBefore']));
    if (to.getTime() < from.getTime() || to.getTime() - from.getTime() > WINDOW_MAX_DAYS * 86_400_000) {
      throw v2Errors.invalidFilter('startTime.onOrBefore');
    }
    const start = (item: Obj) => String(item['startTime']);
    const key = sortkey<Obj>(query.params, {
      ModifiedDesc: byModified,
      StartTimeAsc: { value: start, direction: 1 },
      StartTimeDesc: { value: start, direction: -1 },
    });
    const student = text(query.params, 'student');
    return this.runRead(caller, query.params, forPupils(EVENTS_READ, student ? [student] : []), async (model) => {
      const lessons = await model.slice.lessons(from, to);
      const filter = this.eventFilter(model, query.params, await model.slice.teachingMembers());
      const items = (await this.events(model, lessons, expand)).filter(filter).map((entry) => entry.item);
      const result = page(items, key, query, this.token(caller, operation, query));
      await this.embedAttendance(model, expand, result.data);
      return result;
    });
  }

  async getCalendarEvent(caller: V2Caller, id: string, raw: Record<string, unknown>): Promise<Obj> {
    need(caller, 'calendarEvents.read');
    const wanted = this.pathId(id);
    const params = parseItemQuery('GET /calendarEvents/{id}', raw);
    const expand = expands(params);
    this.eventExpandScopes(caller, expand);
    return this.runRead(caller, params, EVENTS_READ, async (model) => {
      const lessons = await model.slice.lessonsById([wanted]);
      const [found] = await this.eventObjects(model, lessons, expand);
      if (!found) throw v2Errors.notFound();
      await this.embedAttendance(model, expand, [found]);
      return found;
    });
  }

  /**
   * POST /calendarEvents/lookup {ids, activities, student, teacher} — S1's
   * spelling: `student` and `teacher` are arrays under singular names. S1
   * types its answer AttendancesArray, an evident slip; this answers the
   * CalendarEvents it was asked for. More than LOOKUP_EVENTS_MAX is 503
   * TOO_LARGE (S1's 503 "Svaret är förstort").
   */
  async lookupCalendarEvents(caller: V2Caller, body: unknown, raw: Record<string, unknown>): Promise<Obj[]> {
    need(caller, 'calendarEvents.read');
    const params = parseItemQuery('POST /calendarEvents/lookup', raw);
    const ids = lookupIds(body, ['ids', 'activities', 'student', 'teacher']);
    return this.runRead(caller, params, forPupils(EVENTS_READ, ids['student'] ?? []), async (model) => {
      const wanted = new Set<string>(ids['ids'] ?? []);
      const activities = await model.slice.activities();
      const teachers = (ids['teacher'] ?? []).map((id) => model.ids.dutyFrom(id)?.userId).filter((id): id is string => !!id);
      // S1's teacher: "activity.teachers.duty.id samt teacherExceptions.duty.id" —
      // the events of the teacher's activities, and those the teacher stood in.
      const activityIds = new Set(ids['activities'] ?? []);
      const asked = activities.filter((row) => activityIds.has(row.id) || row.teacherIds.some((id) => teachers.includes(id)));
      const masterIds = asked.map((row) => (row.adhoc ? null : row.entityId));
      asked.filter((row) => row.adhoc).forEach((row) => wanted.add(row.entityId));
      const students = (ids['student'] ?? []).map((id) => model.ids.personFrom(id)).filter((id): id is string => !!id);
      const extra = await this.lessonIdsFor(model, masterIds.filter((id): id is string => id !== null), teachers, students);
      extra.forEach((id) => wanted.add(id));
      if (wanted.size > LOOKUP_EVENTS_MAX) throw v2Errors.tooLarge();
      const lessons = await model.slice.lessonsById([...wanted]);
      return this.eventObjects(model, lessons, new Set());
    });
  }

  private async lessonIdsFor(model: Model, masters: string[], teachers: string[], students: string[]): Promise<string[]> {
    const tx = model.slice.tx;
    const out = new Set<string>();
    if (masters.length > 0) {
      (await tx.calendarLesson.findMany({ where: { schoolId: model.slice.schoolId, masterLessonId: { in: masters } }, select: { id: true } })).forEach((row) => out.add(row.id));
    }
    if (teachers.length > 0) {
      (await tx.calendarLessonTeacher.findMany({ where: { schoolId: model.slice.schoolId, teacherId: { in: teachers } }, select: { calendarLessonId: true } })).forEach((row) =>
        out.add(row.calendarLessonId),
      );
    }
    if (students.length > 0) {
      const teaching = await model.slice.teachingMembers();
      const groups = new Set<string>();
      for (const id of students) {
        const user = model.usersById.get(id);
        if (user) groupsOfPerson(user, teaching).forEach((groupId) => groups.add(groupId));
      }
      if (groups.size > 0) {
        (await tx.calendarLesson.findMany({ where: { schoolId: model.slice.schoolId, studentGroupId: { in: [...groups] } }, select: { id: true } })).forEach((row) => out.add(row.id));
        (await tx.calendarLessonGroup.findMany({ where: { schoolId: model.slice.schoolId, studentGroupId: { in: [...groups] } }, select: { calendarLessonId: true } })).forEach((row) =>
          out.add(row.calendarLessonId),
        );
      }
      (await tx.calendarLessonStudent.findMany({ where: { schoolId: model.slice.schoolId, studentId: { in: students } }, select: { calendarLessonId: true } })).forEach((row) =>
        out.add(row.calendarLessonId),
      );
    }
    return [...out];
  }

  // ===========================================================================
  // Attendances and Absences (SS12000-närvaro, 20261114090000)
  // ===========================================================================

  /**
   * The school's decision, asked after the scope: a key with the scope at a
   * school that does not share is 403 NOT_SHARED. The database asks the same
   * (app.service_reads_attendance) in its two read functions, so a read that
   * slipped past this one would find no row.
   */
  private async shared(model: Model, scope: 'attendances.read' | 'absences.read'): Promise<void> {
    if (!(await serviceReadsAttendance(model.slice.tx, scope))) throw v2Errors.notShared();
  }

  /**
   * S1's filters on /attendances, as an AttendanceQuery: student (the
   * pupil), calendarEvent (the lesson), organisation (the lesson's own
   * group's skolenhet, as an event's), meta.*. Null when a filter names
   * nothing SchemaPro emits, which is an empty page.
   */
  private attendanceQuery(model: Model, params: Params): AttendanceQuery | null {
    const out: AttendanceQuery = {
      createdBefore: text(params, 'meta.created.before'),
      createdAfter: text(params, 'meta.created.after'),
      modifiedBefore: text(params, 'meta.modified.before'),
      modifiedAfter: text(params, 'meta.modified.after'),
    };
    const student = text(params, 'student');
    if (student !== undefined) {
      const userId = model.ids.personFrom(student);
      if (!userId || model.usersById.get(userId)?.role !== 'STUDENT') return null;
      out.students = [userId];
    }
    const lesson = text(params, 'calendarEvent');
    if (lesson !== undefined) out.lessons = [lesson];
    const organisation = text(params, 'organisation');
    if (organisation !== undefined) {
      out.groups = model.groups.filter((group) => model.groupOrganisation(group.id) === organisation).map((group) => group.id);
      if (out.groups.length === 0) return null;
    }
    return out;
  }

  /** GET /attendances: by id, in pages read in SQL (S1 has no sortkey here). */
  async listAttendances(caller: V2Caller, raw: Record<string, unknown>): Promise<V2Page<Obj>> {
    need(caller, 'attendances.read');
    const operation = 'GET /attendances';
    const query = parseQuery(operation, raw, caller.keyId);
    // Tokens are not signed: the position goes into SQL as a uuid, so a token
    // whose position is not ours is 400 here, not a 500 from Postgres.
    const after = query.after ? normaliseUuid(query.after[1]) : undefined;
    if (query.after && (after === null || query.after[0] !== null)) throw v2Errors.invalidPageToken();
    return this.runRead(caller, query.params, ATTENDANCES_READ, async (model) => {
      await this.shared(model, 'attendances.read');
      const filter = this.attendanceQuery(model, query.params);
      if (!filter) return { data: [], pageToken: null };
      const rows = await readAttendances(model.slice.tx, {
        ...filter,
        after: after ?? undefined,
        limit: query.limit + 1,
      });
      const shown = rows.slice(0, query.limit);
      const last = shown[shown.length - 1];
      const data = shown.map((row) => attendanceObject(model, row)).filter((item): item is Obj => item !== null);
      return { data, pageToken: rows.length > shown.length && last ? this.token(caller, operation, query)([null, last.id]) : null };
    });
  }

  async getAttendance(caller: V2Caller, id: string, raw: Record<string, unknown>): Promise<Obj> {
    need(caller, 'attendances.read');
    const wanted = this.pathId(id);
    const params = parseItemQuery('GET /attendances/{id}', raw);
    return this.runRead(caller, params, ATTENDANCES_READ, async (model) => {
      await this.shared(model, 'attendances.read');
      const [row] = await readAttendances(model.slice.tx, { ids: [wanted] });
      const found = row ? attendanceObject(model, row) : null;
      if (!found) throw v2Errors.notFound();
      return found;
    });
  }

  /**
   * POST /attendances/lookup {ids, activities, students, calendareEvents} —
   * S1's own spelling, calendareEvents. The attendances named by any of
   * them, once each, by id. More than LOOKUP_ATTENDANCES_MAX is 503
   * TOO_LARGE.
   */
  async lookupAttendances(caller: V2Caller, body: unknown, raw: Record<string, unknown>): Promise<Obj[]> {
    need(caller, 'attendances.read');
    const params = parseItemQuery('POST /attendances/lookup', raw);
    const asked = lookupIds(body, ['ids', 'activities', 'students', 'calendareEvents']);
    return this.runRead(caller, params, ATTENDANCES_READ, async (model) => {
      await this.shared(model, 'attendances.read');
      const lessons = new Set<string>(asked['calendareEvents'] ?? []);
      if ((asked['activities'] ?? []).length > 0) {
        const wanted = new Set(asked['activities']);
        const activities = (await model.slice.activities()).filter((row) => wanted.has(row.id));
        activities.filter((row) => row.adhoc).forEach((row) => lessons.add(row.entityId));
        const masters = activities.filter((row) => !row.adhoc).map((row) => row.entityId);
        (await this.lessonIdsFor(model, masters, [], [])).forEach((id) => lessons.add(id));
      }
      const students = (asked['students'] ?? [])
        .map((id) => model.ids.personFrom(id))
        .filter((id): id is string => id !== null && model.usersById.get(id)?.role === 'STUDENT');
      const found = new Map<string, Obj>();
      const read = async (query: Omit<AttendanceQuery, 'limit'>) => {
        const rows = await readAttendances(model.slice.tx, { ...query, limit: LOOKUP_ATTENDANCES_MAX + 1 });
        for (const row of rows) {
          const item = attendanceObject(model, row);
          if (item) found.set(item.id, item);
        }
        if (found.size > LOOKUP_ATTENDANCES_MAX) throw v2Errors.tooLarge();
      };
      if ((asked['ids'] ?? []).length > 0) await read({ ids: asked['ids'] });
      if (lessons.size > 0) await read({ lessons: [...lessons] });
      if (students.length > 0) await read({ students });
      return [...found.values()].sort((a, b) => (a.id < b.id ? -1 : 1));
    });
  }

  /** The school's absences as S1 objects, meta as the database reckons it; only those ids, or one pupil's, when asked. */
  private async absenceObjects(model: Model, only: { ids?: readonly string[]; students?: readonly string[] } = {}): Promise<Obj[]> {
    const rows = await readAbsences(model.slice.tx, only);
    return rows.map((row) => absenceObject(model, row)).filter((item): item is Obj => item !== null);
  }

  /**
   * S1's filters on /absences: organisation (the pupil's own class's
   * skolenhet, as their enrolment says), student, type, startTime.*,
   * endTime.*, meta.*. registeredBy names an attribute SchemaPro never
   * emits (who filed it), so it answers an empty page. The *.onOrAfter
   * filters are inclusive, as their names and calendarEvents' say (S1's
   * text for /absences says "Exkluderande").
   */
  private absenceFilter(model: Model, params: Params): (item: Obj) => boolean {
    const organisation = text(params, 'organisation');
    const student = text(params, 'student');
    const type = text(params, 'type');
    const registeredBy = text(params, 'registeredBy');
    const window = (name: string) => text(params, name);
    return (item) => {
      if (registeredBy !== undefined) return false;
      const pupil = (item['student'] as Ref).id;
      if (student !== undefined && pupil !== student) return false;
      if (type !== undefined && item['type'] !== type) return false;
      if (organisation !== undefined) {
        const user = model.usersById.get(model.ids.personFrom(pupil) ?? '');
        if (!user || model.groupOrganisation(user.studentGroupId ?? '') !== organisation) return false;
      }
      const start = String(item['startTime']);
      const end = String(item['endTime']);
      const sb = window('startTime.onOrBefore');
      const sa = window('startTime.onOrAfter');
      const eb = window('endTime.onOrBefore');
      const ea = window('endTime.onOrAfter');
      if (sb && !(start <= sb)) return false;
      if (sa && !(start >= sa)) return false;
      if (eb && !(end <= eb)) return false;
      if (ea && !(end >= ea)) return false;
      return metaMatches(item['meta'] as Meta, params);
    };
  }

  async listAbsences(caller: V2Caller, raw: Record<string, unknown>): Promise<V2Page<Obj>> {
    need(caller, 'absences.read');
    const operation = 'GET /absences';
    const query = parseQuery(operation, raw, caller.keyId);
    const start = (item: Obj) => String(item['startTime']);
    const key = sortkey<Obj>(query.params, {
      ModifiedDesc: byModified,
      StartTimeAsc: { value: start, direction: 1 },
      StartTimeDesc: { value: start, direction: -1 },
    });
    return this.runRead(caller, query.params, ABSENCES_READ, async (model) => {
      await this.shared(model, 'absences.read');
      // One pupil's absences are read as such; the rest of S1's filters on the school's.
      const student = text(query.params, 'student');
      const pupil = student === undefined ? undefined : model.ids.personFrom(student);
      if (pupil === null) return { data: [], pageToken: null };
      const items = (await this.absenceObjects(model, pupil ? { students: [pupil] } : {})).filter(this.absenceFilter(model, query.params));
      return page(items, key, query, this.token(caller, operation, query));
    });
  }

  async getAbsence(caller: V2Caller, id: string, raw: Record<string, unknown>): Promise<Obj> {
    need(caller, 'absences.read');
    const wanted = this.pathId(id);
    const params = parseItemQuery('GET /absences/{id}', raw);
    return this.runRead(caller, params, ABSENCES_READ, async (model) => {
      await this.shared(model, 'absences.read');
      const [found] = await this.absenceObjects(model, { ids: [wanted] });
      if (!found) throw v2Errors.notFound();
      return found;
    });
  }

  /** POST /absences/lookup {ids} (S1's IdLookup). */
  async lookupAbsences(caller: V2Caller, body: unknown, raw: Record<string, unknown>): Promise<Obj[]> {
    need(caller, 'absences.read');
    const params = parseItemQuery('POST /absences/lookup', raw);
    const ids = lookupIds(body, ['ids'])['ids'] ?? [];
    return this.runRead(caller, params, ABSENCES_READ, async (model) => {
      await this.shared(model, 'absences.read');
      if (ids.length === 0) return [];
      return (await this.absenceObjects(model, { ids })).sort((a, b) => (a.id < b.id ? -1 : 1));
    });
  }

  // ===========================================================================
  // DeletedEntities
  // ===========================================================================

  /**
   * S1 DeletedEntities_data, keyed by S1's own names — `activitites` is the
   * standard's spelling — with the ids buried after `after` (exclusive), of
   * the categories asked for (all the key may read when none is), and of a
   * category only when the key holds its read scope. Attendance and Absence
   * also need the school's decision in force (SHARED_ONLY). At a school that
   * has never shared they are left out (there is nothing of them to
   * delete), and a key that could read nothing else is 403 NOT_SHARED. At a
   * school that has stopped, a request that names them, or names nothing,
   * is 403 NOT_SHARED: left out, they would let the integration's cursor
   * move past the tombstones it was not shown, and it would never see them
   * when the school shares again. Paged by (removedAt, category:id).
   */
  async deletedEntities(caller: V2Caller, raw: Record<string, unknown>): Promise<{ data: Record<string, string[]>; pageToken: string | null }> {
    const operation = 'GET /deletedEntities';
    const query = parseQuery(operation, raw, caller.keyId);
    const scoped = (Object.keys(EMITTED_RESOURCES) as EmittedResource[]).filter((resource) => caller.scopes.has(EMITTED_RESOURCES[resource]));
    if (scoped.length === 0) throw v2Errors.scopeMissing('<resurs>.read');
    const asked = list(query.params, 'entities');
    const after = text(query.params, 'after');
    const KEY: Record<EmittedResource, string> = {
      Organisation: 'organisations',
      Person: 'persons',
      Group: 'groups',
      Duty: 'duties',
      Activity: 'activitites',
      CalendarEvent: 'calendarEvents',
      Room: 'rooms',
      Syllabus: 'syllabuses',
      Attendance: 'attendances',
      Absence: 'absences',
    };
    return this.run(caller, query.params, async (model) => {
      const readable: EmittedResource[] = [];
      const withheld: EmittedResource[] = [];
      for (const resource of scoped) {
        const scope = EMITTED_RESOURCES[resource];
        if (!SHARED_ONLY.has(resource) || (await serviceReadsAttendance(model.slice.tx, scope as 'attendances.read' | 'absences.read'))) {
          readable.push(resource);
        } else {
          withheld.push(resource);
        }
      }
      const askedWithheld = withheld.some((resource) => asked === undefined || asked.includes(resource));
      if (askedWithheld && (await serviceEverSharedAttendance(model.slice.tx))) throw v2Errors.notShared();
      if (readable.length === 0) throw v2Errors.notShared();
      const categories = (asked ?? readable).filter((entity): entity is EmittedResource => readable.includes(entity as EmittedResource));
      const stored = categories.flatMap((category) => (category === 'Activity' ? ['Activity', 'AdhocActivity'] : [category]));
      const rows = await model.slice.tombstones(after ? new Date(after) : null, stored);
      const items = rows
        .map((row) => {
          const resource = (row.resource === 'AdhocActivity' ? 'Activity' : row.resource) as EmittedResource;
          const emitted = row.resource === 'AdhocActivity' ? adhocActivityId(row.emittedId) : row.emittedId;
          return { id: `${resource}:${emitted}`, resource, emitted, removedAt: iso(row.removedAt) };
        })
        .filter((row) => categories.includes(row.resource));
      const result = page(items, { value: (item) => item.removedAt, direction: 1 }, query, this.token(caller, operation, query));
      const data: Record<string, string[]> = {};
      for (const category of categories) data[KEY[category]] = [];
      for (const item of result.data) data[KEY[item.resource]]!.push(item.emitted);
      return { data, pageToken: result.pageToken };
    });
  }

  private pathId(id: string): string {
    const normal = normaliseUuid(id);
    if (!normal) throw v2Errors.invalidId();
    return normal;
  }
}

