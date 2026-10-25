import { Injectable } from '@nestjs/common';
import type { KeyHuvudman } from '../integration-key';
import { Ss12000V2Error, v2Errors } from './errors';
import { DEFAULT_LIMIT, MAX_LIMIT, parseQuery, type Params } from './query';
import type { Scope } from './scopes';
import { Ss12000V2Guard } from './ss12000-v2.guard';
import { Ss12000V2Service, type V2Caller, type V2Page } from './ss12000-v2.service';

type Raw = Record<string, unknown>;
type Obj = Record<string, unknown> & { id: string };

/** A huvudman's key as the guard resolved it (Huvudman, 20261212090000). */
export interface HuvudmanCaller {
  keyId: string;
  scopes: ReadonlySet<Scope>;
  huvudman: KeyHuvudman;
  /** The schools the huvudman owns now, by id. */
  schools: readonly string[];
}

export type ListMethod =
  | 'listOrganisations' | 'listPersons' | 'listGroups' | 'listDuties' | 'listActivities'
  | 'listCalendarEvents' | 'listRooms' | 'listSyllabuses' | 'listAttendances' | 'listAbsences';
export type GetMethod =
  | 'getOrganisation' | 'getPerson' | 'getGroup' | 'getDuty' | 'getActivity'
  | 'getCalendarEvent' | 'getRoom' | 'getSyllabus' | 'getAttendance' | 'getAbsence';
export type LookupMethod =
  | 'lookupOrganisations' | 'lookupPersons' | 'lookupGroups' | 'lookupDuties' | 'lookupActivities'
  | 'lookupCalendarEvents' | 'lookupRooms' | 'lookupSyllabuses' | 'lookupAttendances' | 'lookupAbsences';

const OPERATION: Record<ListMethod | 'deletedEntities', string> = {
  listOrganisations: 'GET /organisations',
  listPersons: 'GET /persons',
  listGroups: 'GET /groups',
  listDuties: 'GET /duties',
  listActivities: 'GET /activities',
  listCalendarEvents: 'GET /calendarEvents',
  listRooms: 'GET /rooms',
  listSyllabuses: 'GET /syllabuses',
  listAttendances: 'GET /attendances',
  listAbsences: 'GET /absences',
  deletedEntities: 'GET /deletedEntities',
};

/** The scope each resource's reads need, as the provider asks it. */
const SCOPE_OF = {
  Organisations: 'organisations.read',
  Organisation: 'organisations.read',
  Persons: 'persons.read',
  Person: 'persons.read',
  Groups: 'groups.read',
  Group: 'groups.read',
  Duties: 'duties.read',
  Duty: 'duties.read',
  Activities: 'activities.read',
  Activity: 'activities.read',
  CalendarEvents: 'calendarEvents.read',
  CalendarEvent: 'calendarEvents.read',
  Rooms: 'rooms.read',
  Room: 'rooms.read',
  Syllabuses: 'syllabuses.read',
  Syllabus: 'syllabuses.read',
  Attendances: 'attendances.read',
  Attendance: 'attendances.read',
  Absences: 'absences.read',
  Absence: 'absences.read',
} as const satisfies Record<string, Scope>;

/**
 * Empty schools a list walks past before it answers with an empty page and a
 * token for the next school: each school read is its own model and
 * transaction, so a filter that most schools answer nothing to costs at most
 * this many of them per request.
 */
export const MAX_EMPTY_SCHOOLS = 5;

interface OuterToken {
  v: 1;
  /** The huvudman's key the token was given. */
  h: string;
  /** The operation. */
  r: string;
  /** The school the next page starts in. */
  s: string;
  /** The query as first asked, limit and pageToken aside. */
  q: Raw;
  /** The provider's own token within the school, or null for its first page. */
  t: string | null;
}

/** A sortkey cannot be held across schools a huvudman's key reads one at a time. */
const sortkeyAcrossSchools = () =>
  new Ss12000V2Error(400, 'SORTKEY_NOT_SUPPORTED', 'En huvudmans nyckel läser en skola i taget och sorterar inte över skolorna.');

const sorted = (value: unknown): unknown =>
  Array.isArray(value)
    ? value.map(sorted)
    : value !== null && typeof value === 'object'
      ? Object.fromEntries(Object.keys(value as Raw).sort().map((key) => [key, sorted((value as Raw)[key])]))
      : value;
const same = (a: unknown, b: unknown) => JSON.stringify(sorted(a)) === JSON.stringify(sorted(b));

function without(raw: Raw, ...names: string[]): Raw {
  return Object.fromEntries(Object.entries(raw).filter(([name]) => !names.includes(name)));
}

/**
 * One SS12000 key for all of a huvudman's schools (Huvudman, 20261212090000):
 * the provider's own reads, unchanged, one school at a time. Each school is
 * read as that school's service principal opened for the key
 * (PrismaService.withHuvudmanKeyPrincipal, which the database refuses for a
 * school the huvudman does not own), with the läslogg written in that
 * school's log; no transaction ever holds two schools.
 *
 *   * a list walks the schools in their id order, and a page comes from one
 *     school: pageToken carries the school and the provider's own token
 *     within it, bound to the key and the operation; an empty school is
 *     passed over (at most MAX_EMPTY_SCHOOLS per request). The order cannot
 *     be one across schools, so a sortkey is 400 SORTKEY_NOT_SUPPORTED;
 *   * /x/{id} asks school after school, and /x/lookup asks every school;
 *   * each school a request reads after its first counts as one more
 *     request of the key's (Ss12000V2Guard.chargeSchool), so a read across
 *     forty schools costs what forty would;
 *   * /organisations begins with the huvudman, an Organisation of type
 *     Huvudman, and every school's Organisation names it as its
 *     parentOrganisation.
 *
 * A school that leaves the huvudman is gone from the next request on; a
 * token whose school has left continues with the next school in the order.
 */
@Injectable()
export class Ss12000HuvudmanReads {
  constructor(private readonly provider: Ss12000V2Service) {}

  async list(method: ListMethod, caller: HuvudmanCaller, raw: Raw): Promise<V2Page<Obj>> {
    return this.walk(method, caller, raw, (school, query) => this.provider[method](this.at(caller, school), query), (page) => page.data.length === 0,
      (page) => (method === 'listOrganisations' ? { ...page, data: page.data.map((item) => this.parented(caller, item)) } : page),
      (query, first) => (method === 'listOrganisations' && first ? this.huvudmanOrganisation(caller, query) : []));
  }

  async deletedEntities(caller: HuvudmanCaller, raw: Raw): Promise<{ data: Record<string, string[]>; pageToken: string | null }> {
    return this.walk('deletedEntities', caller, raw, (school, query) => this.provider.deletedEntities(this.at(caller, school), query),
      (page) => Object.values(page.data).every((ids) => ids.length === 0), (page) => page, () => []);
  }

  async get(method: GetMethod, caller: HuvudmanCaller, id: string, raw: Raw): Promise<Obj> {
    if (method === 'getOrganisation' && id.toLowerCase() === caller.huvudman.id) {
      // The provider's own checks of the request, on its first school.
      if (!caller.scopes.has('organisations.read')) throw v2Errors.scopeMissing('organisations.read');
      return this.huvudmanObject(caller);
    }
    for (const [index, school] of caller.schools.entries()) {
      if (index > 0) await Ss12000V2Guard.chargeSchool(caller.keyId);
      try {
        const found = await this.provider[method](this.at(caller, school), id, raw);
        return method === 'getOrganisation' ? this.parented(caller, found) : found;
      } catch (error) {
        if (error instanceof Ss12000V2Error && error.status === 404) continue;
        throw error;
      }
    }
    if (caller.schools.length === 0) {
      // Nothing to ask: still a 404 for a request the provider would take,
      // and the provider's 400 or 403 for one it would not.
      this.checkShape(method, caller);
    }
    throw v2Errors.notFound();
  }

  async lookup(method: LookupMethod, caller: HuvudmanCaller, body: unknown, raw: Raw): Promise<Obj[]> {
    const out: Obj[] = [];
    if (method === 'lookupOrganisations') {
      if (!caller.scopes.has('organisations.read')) throw v2Errors.scopeMissing('organisations.read');
      const ids = body !== null && typeof body === 'object' && Array.isArray((body as Raw)['ids']) ? ((body as Raw)['ids'] as unknown[]) : [];
      if (ids.some((id) => typeof id === 'string' && id.toLowerCase() === caller.huvudman.id)) out.push(this.huvudmanObject(caller));
    }
    for (const [index, school] of caller.schools.entries()) {
      if (index > 0) await Ss12000V2Guard.chargeSchool(caller.keyId);
      const found = await this.provider[method](this.at(caller, school), body, raw);
      out.push(...(method === 'lookupOrganisations' ? found.map((item) => this.parented(caller, item)) : found));
    }
    if (caller.schools.length === 0) this.checkShape(method, caller);
    return out;
  }

  /** The provider's caller for one school of the huvudman's. */
  private at(caller: HuvudmanCaller, school: string): V2Caller {
    return { schoolId: school, keyId: caller.keyId, scopes: caller.scopes, viaHuvudman: true };
  }

  private async walk<P extends { pageToken: string | null }>(
    method: ListMethod | 'deletedEntities',
    caller: HuvudmanCaller,
    raw: Raw,
    read: (school: string, query: Raw) => Promise<P>,
    empty: (page: P) => boolean,
    decorate: (page: P) => P,
    lead: (query: Raw, first: boolean) => Obj[],
  ): Promise<P> {
    const operation = OPERATION[method];
    const limit = raw['limit'];
    let outer: OuterToken | null = null;
    let query: Raw;
    if (raw['pageToken'] !== undefined) {
      outer = this.decode(raw['pageToken'], caller.keyId, operation);
      const given = without(raw, 'limit', 'pageToken');
      // As the provider's own tokens: only limit may change between pages,
      // and a parameter that is repeated must be the token's.
      for (const [name, value] of Object.entries(given)) {
        if (!same(value, outer.q[name])) throw v2Errors.invalidPageToken();
      }
      query = outer.q;
    } else {
      query = without(raw, 'limit', 'pageToken');
    }
    if (query['sortkey'] !== undefined) throw sortkeyAcrossSchools();
    const withLimit = (extra: Raw): Raw => ({ ...query, ...(limit !== undefined ? { limit } : {}), ...extra });

    const schools = caller.schools;
    let index = outer ? schools.findIndex((school) => school >= outer!.s) : 0;
    let inner = outer && index >= 0 && schools[index] === outer.s ? outer.t : null;
    const leading = lead(query, outer === null);

    if (index < 0 || schools.length === 0) {
      // No school left to read: the provider's checks of the request still
      // answer (scope, parameters), on nothing.
      this.checkShape(method, caller, query);
      return { ...(await this.none(method)), ...(leading.length > 0 ? { data: leading } : {}) } as unknown as P;
    }

    // The huvudman leads the first page of /organisations within its limit:
    // the school gives one item fewer, and a limit of one is the huvudman's
    // alone, with the first school's first page next.
    let firstLimit: Raw = {};
    if (leading.length > 0) {
      const asked = limit === undefined ? DEFAULT_LIMIT : /^[1-9][0-9]*$/.test(String(limit)) ? Math.min(Number(limit), MAX_LIMIT) : null;
      if (asked !== null && asked <= leading.length) {
        return { ...(await this.none(method)), data: leading.slice(0, asked), pageToken: this.encode(caller.keyId, operation, schools[index]!, query, null) } as unknown as P;
      }
      if (asked !== null) firstLimit = { limit: String(asked - leading.length) };
    }

    let passed = 0;
    for (let reads = 0; index < schools.length; index++, reads++) {
      const school = schools[index]!;
      if (reads > 0) await Ss12000V2Guard.chargeSchool(caller.keyId);
      const page = decorate(await read(school, withLimit({ ...(reads === 0 ? firstLimit : {}), ...(inner ? { pageToken: inner } : {}) })));
      inner = null;
      if (!empty(page) || page.pageToken || leading.length > 0) {
        const next = page.pageToken
          ? this.encode(caller.keyId, operation, school, query, page.pageToken)
          : index + 1 < schools.length
            ? this.encode(caller.keyId, operation, schools[index + 1]!, query, null)
            : null;
        const data = leading.length > 0 ? [...leading, ...((page as unknown as V2Page<Obj>).data ?? [])] : (page as unknown as { data: unknown }).data;
        return { ...page, data, pageToken: next } as P;
      }
      passed += 1;
      if (passed >= MAX_EMPTY_SCHOOLS && index + 1 < schools.length) {
        return { ...page, pageToken: this.encode(caller.keyId, operation, schools[index + 1]!, query, null) };
      }
      if (index + 1 === schools.length) return { ...page, pageToken: null };
    }
    return { ...(await this.none(method)) } as unknown as P;
  }

  /** An empty answer of the operation's shape. */
  private async none(method: ListMethod | 'deletedEntities'): Promise<{ data: unknown; pageToken: null }> {
    return { data: method === 'deletedEntities' ? {} : [], pageToken: null };
  }

  /**
   * The provider's own refusals of a request, when there is no school to
   * ask: the scope the operation needs and its parameters.
   */
  private checkShape(method: ListMethod | GetMethod | LookupMethod | 'deletedEntities', caller: HuvudmanCaller, query?: Raw): void {
    if (method === 'deletedEntities') {
      if (![...caller.scopes].some((scope) => scope.endsWith('.read'))) throw v2Errors.scopeMissing('<resurs>.read');
    } else {
      const scope = SCOPE_OF[method.replace(/^(list|get|lookup)/, '') as keyof typeof SCOPE_OF];
      if (!caller.scopes.has(scope)) throw v2Errors.scopeMissing(scope);
    }
    if (query && method in OPERATION) parseQuery(OPERATION[method as ListMethod], query, caller.keyId);
  }

  private encode(keyId: string, operation: string, school: string, query: Raw, inner: string | null): string {
    const body: OuterToken = { v: 1, h: keyId, r: operation, s: school, q: query, t: inner };
    return Buffer.from(JSON.stringify(body), 'utf8').toString('base64url');
  }

  private decode(token: unknown, keyId: string, operation: string): OuterToken {
    if (typeof token !== 'string' || token.length === 0 || token.length > 16384 || !/^[A-Za-z0-9_-]+$/.test(token)) {
      throw v2Errors.invalidPageToken();
    }
    let body: unknown;
    try {
      body = JSON.parse(Buffer.from(token, 'base64url').toString('utf8'));
    } catch {
      throw v2Errors.invalidPageToken();
    }
    const b = body as Partial<OuterToken> | null;
    if (
      !b || typeof b !== 'object' || b.v !== 1 || b.h !== keyId || b.r !== operation
      || typeof b.s !== 'string' || !/^[0-9a-f-]{36}$/.test(b.s)
      || !b.q || typeof b.q !== 'object' || Array.isArray(b.q)
      || !(b.t === null || typeof b.t === 'string')
    ) {
      throw v2Errors.invalidPageToken();
    }
    return b as OuterToken;
  }

  /** The huvudman as S1's Organisation of type Huvudman. */
  private huvudmanObject(caller: HuvudmanCaller): Obj {
    const h = caller.huvudman;
    return {
      id: h.id,
      meta: { created: h.createdAt.toISOString(), modified: (h.updatedAt < h.createdAt ? h.createdAt : h.updatedAt).toISOString() },
      displayName: h.name,
      organisationType: 'Huvudman',
      ...(h.organisationNumber ? { organisationNumber: h.organisationNumber } : {}),
      ...(h.municipalityCode ? { municipalityCode: h.municipalityCode } : {}),
    };
  }

  /** The huvudman, first on the first page of /organisations, when the query's filters hold it. */
  private huvudmanOrganisation(caller: HuvudmanCaller, query: Raw): Obj[] {
    if (!caller.scopes.has('organisations.read')) throw v2Errors.scopeMissing('organisations.read');
    const params: Params = parseQuery('GET /organisations', query, caller.keyId).params;
    const item = this.huvudmanObject(caller);
    const list = (name: string) => (params[name] === undefined ? null : ([] as string[]).concat(params[name] as string | string[]));
    const one = (name: string) => (typeof params[name] === 'string' ? (params[name] as string) : null);
    const types = list('type');
    if (types && !types.includes('Huvudman')) return [];
    // Attributes of a skolenhet, or a parent the huvudman has none of.
    if (list('parent') || list('schoolUnitCode') || list('schoolTypes') || list('organisationCode')) return [];
    const municipality = one('municipalityCode');
    if (municipality && municipality !== caller.huvudman.municipalityCode) return [];
    const meta = item['meta'] as { created: string; modified: string };
    const cb = one('meta.created.before');
    const ca = one('meta.created.after');
    const mb = one('meta.modified.before');
    const ma = one('meta.modified.after');
    if ((cb && !(meta.created <= cb)) || (ca && !(meta.created > ca)) || (mb && !(meta.modified <= mb)) || (ma && !(meta.modified > ma))) {
      return [];
    }
    return [item];
  }

  /** A school's Organisation names its huvudman as its parent. */
  private parented(caller: HuvudmanCaller, item: Obj): Obj {
    return { ...item, parentOrganisation: { id: caller.huvudman.id, displayName: caller.huvudman.name } };
  }
}
