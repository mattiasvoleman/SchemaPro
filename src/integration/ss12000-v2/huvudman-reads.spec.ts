import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Ss12000V2Error } from './errors';
import { MAX_EMPTY_SCHOOLS, Ss12000HuvudmanReads, type HuvudmanCaller } from './huvudman-reads';
import { PER_KEY, Ss12000V2Guard } from './ss12000-v2.guard';
import { HUVUDMAN_SCOPES, SCOPES, type Scope } from './scopes';
import type { Ss12000V2Service, V2Caller } from './ss12000-v2.service';

const S1 = '10000000-0000-4000-8000-000000000001';
const S2 = '20000000-0000-4000-8000-000000000002';
const S3 = '30000000-0000-4000-8000-000000000003';
const H = '90000000-0000-4000-8000-000000000009';

const caller = (schools: string[] = [S1, S2, S3], scopes: Scope[] = [...HUVUDMAN_SCOPES]): HuvudmanCaller => ({
  keyId: 'k-1',
  scopes: new Set(scopes),
  huvudman: {
    id: H,
    name: 'Vimmerby kommun',
    organisationNumber: '2120000688',
    municipalityCode: '0884',
    createdAt: new Date('2026-01-01T00:00:00Z'),
    updatedAt: new Date('2026-02-01T00:00:00Z'),
  },
  schools,
});

/** A provider whose schools hold the given items, a page of `per` at a time, the token the index. */
function provider(bySchool: Record<string, string[]>, per = 2) {
  const seen: Array<{ school: string; query: Record<string, unknown>; via: boolean | undefined; key: string }> = [];
  const listing = async (c: V2Caller, query: Record<string, unknown>) => {
    seen.push({ school: c.schoolId, query, via: c.viaHuvudman, key: c.keyId });
    const items = (bySchool[c.schoolId] ?? []).map((id) => ({ id }));
    const from = typeof query['pageToken'] === 'string' ? Number(query['pageToken']) : 0;
    const size = typeof query['limit'] === 'string' ? Math.min(Number(query['limit']), per) : per;
    const data = items.slice(from, from + size);
    return { data, pageToken: from + size < items.length ? String(from + size) : null };
  };
  const service = {
    listPersons: jest.fn(listing),
    listOrganisations: jest.fn(listing),
    getPerson: jest.fn(async (c: V2Caller, id: string) => {
      if (!(bySchool[c.schoolId] ?? []).includes(id)) throw new Ss12000V2Error(404, 'NOT_FOUND', '');
      return { id, school: c.schoolId };
    }),
    lookupPersons: jest.fn(async (c: V2Caller, body: { ids: string[] }) =>
      (bySchool[c.schoolId] ?? []).filter((id) => body.ids.includes(id)).map((id) => ({ id }))),
    deletedEntities: jest.fn(async (c: V2Caller) => ({ data: { persons: bySchool[c.schoolId] ?? [] }, pageToken: null })),
  };
  return { service, seen, reads: new Ss12000HuvudmanReads(service as unknown as Ss12000V2Service) };
}

const decode = (token: string) => JSON.parse(Buffer.from(token, 'base64url').toString('utf8')) as Record<string, unknown>;

describe('Ss12000HuvudmanReads (Huvudman, 20261212090000)', () => {
  beforeEach(() => Ss12000V2Guard.resetCounters());
  afterEach(() => jest.restoreAllMocks());

  it("reads each school as that school's principal opened for the huvudman's key", async () => {
    const { reads, seen } = provider({ [S1]: ['a'] });
    await reads.list('listPersons', caller(), {});
    expect(seen[0]).toMatchObject({ school: S1, via: true, key: 'k-1' });
  });

  it('walks the schools in order, a page from one school, the token carrying the school and its own token', async () => {
    const { reads } = provider({ [S1]: ['a', 'b', 'c'], [S2]: ['d'], [S3]: ['e'] });
    const pages: string[][] = [];
    let token: string | null = null;
    const raw = { 'meta.modified.after': '2026-01-01T00:00:00Z' };
    do {
      const page: { data: Array<{ id: string }>; pageToken: string | null } =
        await reads.list('listPersons', caller(), token ? { ...raw, pageToken: token } : raw);
      pages.push(page.data.map((item) => item.id));
      token = page.pageToken;
    } while (token);
    expect(pages).toEqual([['a', 'b'], ['c'], ['d'], ['e']]);
  });

  it('passes the query and limit on, and nothing changed between pages but limit', async () => {
    const { reads, seen } = provider({ [S1]: ['a', 'b', 'c'] });
    const first = await reads.list('listPersons', caller([S1]), { nameContains: 'x', limit: '2' });
    await reads.list('listPersons', caller([S1]), { pageToken: first.pageToken!, limit: '1' });
    expect(seen[1]!.query).toEqual({ nameContains: 'x', limit: '1', pageToken: '2' });
    await expect(reads.list('listPersons', caller([S1]), { pageToken: first.pageToken!, nameContains: 'y' })).rejects.toMatchObject({
      code: 'INVALID_PAGE_TOKEN',
    });
    // Repeated as it was: allowed, as the provider's own tokens allow it.
    await expect(reads.list('listPersons', caller([S1]), { pageToken: first.pageToken!, nameContains: 'x' })).resolves.toBeDefined();
  });

  it("refuses another key's token, another operation's, and one that does not parse", async () => {
    const { reads } = provider({ [S1]: ['a', 'b', 'c'] });
    const first = await reads.list('listPersons', caller([S1]), {});
    await expect(reads.list('listPersons', { ...caller([S1]), keyId: 'k-2' }, { pageToken: first.pageToken! })).rejects.toMatchObject({
      code: 'INVALID_PAGE_TOKEN',
    });
    await expect(reads.list('listOrganisations', caller([S1]), { pageToken: first.pageToken! })).rejects.toMatchObject({
      code: 'INVALID_PAGE_TOKEN',
    });
    await expect(reads.list('listPersons', caller([S1]), { pageToken: 'not a token' })).rejects.toMatchObject({ code: 'INVALID_PAGE_TOKEN' });
  });

  it('refuses a sortkey: no order holds across schools read one at a time', async () => {
    const { reads } = provider({ [S1]: ['a'] });
    await expect(reads.list('listPersons', caller(), { sortkey: 'DisplayNameAsc' })).rejects.toMatchObject({
      status: 400,
      code: 'SORTKEY_NOT_SUPPORTED',
    });
  });

  it(`passes over empty schools, at most ${MAX_EMPTY_SCHOOLS} a request, then answers an empty page and the next school`, async () => {
    const schools = Array.from({ length: 8 }, (_, i) => `${i}0000000-0000-4000-8000-00000000000${i}`);
    const { reads, seen } = provider({ [schools[7]!]: ['z'] });
    const first = await reads.list('listPersons', caller(schools), {});
    expect(first.data).toEqual([]);
    expect(seen).toHaveLength(MAX_EMPTY_SCHOOLS);
    expect(decode(first.pageToken!)['s']).toBe(schools[MAX_EMPTY_SCHOOLS]);
    const second = await reads.list('listPersons', caller(schools), { pageToken: first.pageToken! });
    expect(second.data).toEqual([{ id: 'z' }]);
    expect(second.pageToken).toBeNull();
  });

  it('goes on with the next school when the school of a token has left the huvudman', async () => {
    const { reads } = provider({ [S1]: ['a', 'b', 'c'], [S3]: ['e'] });
    const first = await reads.list('listPersons', caller([S1, S3]), {});
    expect(decode(first.pageToken!)['s']).toBe(S1);
    const after = await reads.list('listPersons', caller([S3]), { pageToken: first.pageToken! });
    // Not S1's page two against S3: S3 from its start.
    expect(after.data).toEqual([{ id: 'e' }]);
  });

  it('answers an empty list for a huvudman that owns no school, and still asks the scope', async () => {
    const { reads } = provider({});
    await expect(reads.list('listPersons', caller([]), {})).resolves.toEqual({ data: [], pageToken: null });
    await expect(reads.list('listPersons', caller([], ['groups.read']), {})).rejects.toMatchObject({ code: 'SCOPE_MISSING' });
  });

  it('begins /organisations with the huvudman, and every school names it as its parent', async () => {
    const { reads } = provider({ [S1]: ['o1'], [S2]: ['o2'] });
    const first = await reads.list('listOrganisations', caller([S1, S2]), {});
    expect(first.data[0]).toMatchObject({ id: H, organisationType: 'Huvudman', displayName: 'Vimmerby kommun', organisationNumber: '2120000688', municipalityCode: '0884' });
    expect(first.data[1]).toMatchObject({ id: 'o1', parentOrganisation: { id: H, displayName: 'Vimmerby kommun' } });
    const second = await reads.list('listOrganisations', caller([S1, S2]), { pageToken: first.pageToken! });
    expect(second.data).toEqual([{ id: 'o2', parentOrganisation: { id: H, displayName: 'Vimmerby kommun' } }]);
  });

  it('keeps the first page of /organisations within its limit: the school gives one fewer, and a limit of one is the huvudman', async () => {
    const { reads, seen } = provider({ [S1]: ['o1', 'o2', 'o3'] }, 5);
    const first = await reads.list('listOrganisations', caller([S1]), { limit: '2' });
    expect(first.data.map((item) => item.id)).toEqual([H, 'o1']);
    expect(seen[0]!.query['limit']).toBe('1');
    const rest = await reads.list('listOrganisations', caller([S1]), { limit: '2', pageToken: first.pageToken! });
    expect(rest.data.map((item) => item.id)).toEqual(['o2', 'o3']);

    const alone = await reads.list('listOrganisations', caller([S1]), { limit: '1' });
    expect(alone.data.map((item) => item.id)).toEqual([H]);
    const next = await reads.list('listOrganisations', caller([S1]), { limit: '1', pageToken: alone.pageToken! });
    expect(next.data.map((item) => item.id)).toEqual(['o1']);
  });

  it("leaves the huvudman out of /organisations when the query's filters do", async () => {
    const { reads } = provider({ [S1]: ['o1'] });
    for (const query of [{ type: 'Skolenhet' }, { schoolUnitCode: '12345678' }, { municipalityCode: '0180' }, { 'meta.modified.after': '2026-03-01T00:00:00Z' }]) {
      const page = await reads.list('listOrganisations', caller([S1]), query);
      expect(page.data.map((item) => item.id)).not.toContain(H);
    }
    const typed = await reads.list('listOrganisations', caller([S1]), { type: 'Huvudman' });
    expect(typed.data[0]!.id).toBe(H);
  });

  it('finds /x/{id} school after school, and 404s one no school holds', async () => {
    const { reads, service } = provider({ [S1]: ['a'], [S2]: ['b'] });
    await expect(reads.get('getPerson', caller([S1, S2]), 'b', {})).resolves.toEqual({ id: 'b', school: S2 });
    expect(service.getPerson).toHaveBeenCalledTimes(2);
    await expect(reads.get('getPerson', caller([S1, S2]), 'c', {})).rejects.toMatchObject({ status: 404 });
  });

  it('counts each school a request reads after its first as one more request of the key', async () => {
    const charge = jest.spyOn(Ss12000V2Guard, 'chargeSchool');
    const { reads } = provider({ [S3]: ['c'] });
    await reads.get('getPerson', caller(), 'c', {});
    expect(charge).toHaveBeenCalledTimes(2);
    charge.mockClear();
    await reads.lookup('lookupPersons', caller(), { ids: ['c'] }, {});
    expect(charge).toHaveBeenCalledTimes(2);
    charge.mockClear();
    // A list pays for the empty schools it walks past, and a page from the
    // first school costs nothing more.
    await reads.list('listPersons', caller(), {});
    expect(charge).toHaveBeenCalledTimes(2);
    expect(charge).toHaveBeenCalledWith('k-1');
    charge.mockClear();
    await provider({ [S1]: ['a'] }).reads.list('listPersons', caller(), {});
    expect(charge).not.toHaveBeenCalled();
  });

  it('stops a read across the schools at the bound of the key, as 429', async () => {
    for (let i = 0; i < PER_KEY.limit; i++) await Ss12000V2Guard.chargeSchool('k-1');
    const { reads, service } = provider({ [S3]: ['c'] });
    await expect(reads.get('getPerson', caller(), 'c', {})).rejects.toMatchObject({ status: 429 });
    expect(service.getPerson).toHaveBeenCalledTimes(1);
  });

  it('answers /organisations/{huvudman} with the huvudman', async () => {
    const { reads } = provider({});
    await expect(reads.get('getOrganisation', caller([S1]), H, {})).resolves.toMatchObject({ id: H, organisationType: 'Huvudman' });
  });

  it('asks every school a lookup and puts the answers together', async () => {
    const { reads } = provider({ [S1]: ['a'], [S2]: ['b'], [S3]: ['c'] });
    await expect(reads.lookup('lookupPersons', caller(), { ids: ['a', 'c'] }, {})).resolves.toEqual([{ id: 'a' }, { id: 'c' }]);
  });

  it('walks /deletedEntities as a list, a school at a time', async () => {
    const { reads } = provider({ [S1]: ['a'], [S3]: ['c'] });
    const first = await reads.deletedEntities(caller(), {});
    expect(first.data).toEqual({ persons: ['a'] });
    const second = await reads.deletedEntities(caller(), { pageToken: first.pageToken! });
    // S2 is empty and passed over.
    expect(second).toEqual({ data: { persons: ['c'] }, pageToken: null });
  });
});

describe('HUVUDMAN_SCOPES', () => {
  const migration = readFileSync(
    join(__dirname, '../../../prisma/migrations/20261212090000_en_huvudman_ager_skolor/migration.sql'),
    'utf8',
  );

  it("is the CHECK HuvudmanApiKeys_scopes_are_reads, in the provider's order", () => {
    const check = /HuvudmanApiKeys_scopes_are_reads" CHECK \(([\s\S]*?)\n    \),/.exec(migration)?.[1] ?? '';
    const listed = [...check.matchAll(/'([a-zA-Z.]+)'/g)].map((m) => m[1]);
    expect(listed).toEqual([...HUVUDMAN_SCOPES]);
    expect(HUVUDMAN_SCOPES.every((scope) => (SCOPES as readonly string[]).includes(scope))).toBe(true);
  });

  it("reads only: no attendance or absence, no subscription, nothing of v1's", () => {
    for (const scope of ['attendances.read', 'absences.read', 'subscriptions.write', 'ss12000.v1', 'ss12000.v1.import']) {
      expect(HUVUDMAN_SCOPES as readonly string[]).not.toContain(scope);
    }
  });
});
