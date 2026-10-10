import { Injectable } from '@nestjs/common';
import { inTurn } from './in-turn';
import type { PrismaClient } from '@prisma/client';
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
import { EMITTED_RESOURCES, type EmittedResource, type Scope } from './scopes';
import { dayOf, SchoolSlice, type ActivityRow, type LessonRow } from './slice';
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

/** A lookup body may name at most this many ids in total. */
export const LOOKUP_MAX = 1000;
/** A calendar window may span at most this many days. */
export const WINDOW_MAX_DAYS = 400;
/** More events than this for one lookup is S1's 503 "Svaret är förstort". */
export const LOOKUP_EVENTS_MAX = 5000;

const iso = (value: Date) => value.toISOString();

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

  private token(caller: V2Caller, operation: string, query: ParsedQuery) {
    return (after: [string | number | null, string]) => encodePageToken(caller.keyId, operation, query.params, after);
  }

  private async versions(model: Model, resource: EmittedResource, ids?: readonly string[]) {
    return model.slice.versions(resource, ids);
  }

  // ===========================================================================
  // Organisations
  // ===========================================================================

  private async organisations(model: Model): Promise<Obj[]> {
    const versions = await this.versions(model, 'Organisation', [model.slice.schoolId]);
    const active = model.activeYearId;
    const schoolTypes = active ? model.types.ofYear(active) : [];
    return [
      {
        id: model.ids.organisationId,
        meta: metaOf(versions.get(model.slice.schoolId), model.school.createdAt, model.school.updatedAt),
        displayName: model.school.name,
        organisationType: model.ids.organisationType,
        ...(model.ids.schoolUnitCode ? { schoolUnitCode: model.ids.schoolUnitCode } : {}),
        ...(schoolTypes.length > 0 ? { schoolTypes } : {}),
      },
    ];
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
    return this.run(caller, query.params, async (model) => {
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
    return this.run(caller, params, async (model) => {
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
    return this.run(caller, params, async (model) => (await this.persons(model, expand)).filter((item) => wanted.has(item.id)));
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
        organisation: model.organisationRef(),
      });
    }
    return out;
  }

  private async groupObjects(model: Model, expand: Set<string>): Promise<Obj[]> {
    const [fragments, memberships] = await inTurn(() => this.groupFragments(model), () => model.memberships());
    const mentorships = expand.has('assignmentRoles') ? await model.slice.mentorships() : [];
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
          assignmentRoles: mentorships
            .filter((duty) => duty.studentGroupId === group.id && duty.academicYearId === group.academicYearId)
            .map((duty) => model.dutyRef(duty.userId, group.academicYearId))
            .filter((duty): duty is Ref => duty !== null)
            .map((duty) => ({ duty, assignmentRoleType: 'Mentor', startDate: bounds.startDate, endDate: bounds.endDate })),
        };
      }
      out.push(item);
    }
    return out;
  }

  private groupFilter(model: Model, params: Params): (item: Obj) => boolean {
    const types = list(params, 'groupType');
    const schoolTypes = list(params, 'schoolTypes');
    const organisations = list(params, 'organisation');
    return (item) => {
      if (types && !types.includes(String(item['groupType']))) return false;
      if (schoolTypes && !schoolTypes.includes(String(item['schoolType'] ?? ''))) return false;
      if (organisations && !organisations.includes(model.ids.organisationId)) return false;
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
    return this.run(caller, query.params, async (model) => {
      const items = (await this.groupObjects(model, expand)).filter(this.groupFilter(model, query.params));
      return page(items, key, query, this.token(caller, operation, query));
    });
  }

  async getGroup(caller: V2Caller, id: string, raw: Record<string, unknown>): Promise<Obj> {
    need(caller, 'groups.read');
    const wanted = this.pathId(id);
    const params = parseItemQuery('GET /groups/{id}', raw);
    const expand = expands(params);
    if (expand.has('assignmentRoles')) need(caller, 'duties.read');
    return this.run(caller, params, async (model) => {
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
    return this.run(caller, params, async (model) => (await this.groupObjects(model, expand)).filter((item) => wanted.has(item.id)));
  }

  // ===========================================================================
  // Duties
  // ===========================================================================

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

  private dutyFilter(model: Model, params: Params): (item: Obj) => boolean {
    const organisation = text(params, 'organisation');
    const role = text(params, 'dutyRole');
    const person = text(params, 'person');
    return (item) => {
      if (organisation !== undefined && organisation !== model.ids.organisationId) return false;
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
    return this.run(caller, query.params, async (model) => {
      const items = (await this.dutyObjects(model, expand)).filter(this.dutyFilter(model, query.params));
      return page(items, key, query, this.token(caller, operation, query));
    });
  }

  async getDuty(caller: V2Caller, id: string, raw: Record<string, unknown>): Promise<Obj> {
    need(caller, 'duties.read');
    const wanted = this.pathId(id);
    const params = parseItemQuery('GET /duties/{id}', raw);
    const expand = expands(params);
    if (expand.has('person')) need(caller, 'persons.read');
    return this.run(caller, params, async (model) => {
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
    return this.run(caller, params, async (model) => (await this.dutyObjects(model, expand)).filter((item) => wanted.has(item.id)));
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
        (item) => (organisation === undefined || organisation === model.ids.organisationId) && metaMatches(item['meta'] as Meta, query.params),
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
        organisation: model.organisationRef(),
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
      if (organisation !== undefined && organisation !== model.ids.organisationId) return false;
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
    return this.run(caller, query.params, async (model) => {
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
    return this.run(caller, params, async (model) => {
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
    return this.run(caller, params, async (model) => {
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
   * the event's are the SUBSTITUTE rows when the lesson has one (a vikarie
   * stood in front of the class; a LEAD or ASSISTANT beside it is displaced,
   * as the staffing reconciliation reads it), else every row. A teacher of
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
      const substitutes = rows.filter((row) => row.role === 'SUBSTITUTE').map((row) => row.teacherId);
      const present = new Set(substitutes.length > 0 ? substitutes : rows.map((row) => row.teacherId));
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
    if (expand.has('attendance')) throw v2Errors.scopeMissing('attendance');
    if (expand.has('activity')) need(caller, 'activities.read');
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
      if (organisation !== undefined && organisation !== model.ids.organisationId) return false;
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
    return this.run(caller, query.params, async (model) => {
      const lessons = await model.slice.lessons(from, to);
      const filter = this.eventFilter(model, query.params, await model.slice.teachingMembers());
      const items = (await this.events(model, lessons, expand)).filter(filter).map((entry) => entry.item);
      return page(items, key, query, this.token(caller, operation, query));
    });
  }

  async getCalendarEvent(caller: V2Caller, id: string, raw: Record<string, unknown>): Promise<Obj> {
    need(caller, 'calendarEvents.read');
    const wanted = this.pathId(id);
    const params = parseItemQuery('GET /calendarEvents/{id}', raw);
    const expand = expands(params);
    this.eventExpandScopes(caller, expand);
    return this.run(caller, params, async (model) => {
      const lessons = await model.slice.lessonsById([wanted]);
      const [found] = await this.eventObjects(model, lessons, expand);
      if (!found) throw v2Errors.notFound();
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
    return this.run(caller, params, async (model) => {
      const wanted = new Set<string>(ids['ids'] ?? []);
      const activities = await model.slice.activities();
      const activityIds = new Set(ids['activities'] ?? []);
      const masterIds = activities.filter((row) => activityIds.has(row.id)).map((row) => (row.adhoc ? null : row.entityId));
      const adhocLessons = activities.filter((row) => activityIds.has(row.id) && row.adhoc).map((row) => row.entityId);
      adhocLessons.forEach((id) => wanted.add(id));
      const teachers = (ids['teacher'] ?? []).map((id) => model.ids.dutyFrom(id)?.userId).filter((id): id is string => !!id);
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
  // DeletedEntities
  // ===========================================================================

  /**
   * S1 DeletedEntities_data, keyed by S1's own names — `activitites` is the
   * standard's spelling — with the ids buried after `after` (exclusive), of
   * the categories asked for (all the key may read when none is), and of a
   * category only when the key holds its read scope. Paged by (removedAt,
   * category:id).
   */
  async deletedEntities(caller: V2Caller, raw: Record<string, unknown>): Promise<{ data: Record<string, string[]>; pageToken: string | null }> {
    const operation = 'GET /deletedEntities';
    const query = parseQuery(operation, raw, caller.keyId);
    const readable = (Object.keys(EMITTED_RESOURCES) as EmittedResource[]).filter((resource) => caller.scopes.has(EMITTED_RESOURCES[resource]));
    if (readable.length === 0) throw v2Errors.scopeMissing('<resurs>.read');
    const asked = list(query.params, 'entities');
    const categories = (asked ?? readable).filter((entity): entity is EmittedResource => readable.includes(entity as EmittedResource));
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
    };
    return this.run(caller, query.params, async (model) => {
      const rows = await model.slice.tombstones(after ? new Date(after) : null);
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

