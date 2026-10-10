import { MockSs12000Provider, s1Adult, s1Duty, s1Group, s1Organisation, s1Pupil } from '../../../test/utils/ss12000-mock-provider';
import { makeTestTls } from '../../../test/utils/test-tls';
import { Ss12000Client, clearTokenCache } from './client';
import { fetchRoster, type FetchPlanInput } from './fetch-plan';

const ORG = 'aaaaaaaa-0000-4000-8000-000000000001';
const ORG2 = 'aaaaaaaa-0000-4000-8000-000000000002';
const PUPIL = 'bbbbbbbb-0000-4000-8000-000000000001';
const PUPIL2 = 'bbbbbbbb-0000-4000-8000-000000000002';
const GUARDIAN = 'cccccccc-0000-4000-8000-000000000001';
const TEACHER = 'dddddddd-0000-4000-8000-000000000001';
const OUTSIDER = 'dddddddd-0000-4000-8000-000000000009';
const CLASS = 'eeeeeeee-0000-4000-8000-000000000001';
const DUTY = 'ffffffff-0000-4000-8000-000000000001';

describe('fetchRoster: the fetch plan against a local TLS mock provider', () => {
  const tls = makeTestTls();
  let provider: MockSs12000Provider;
  let client: Ss12000Client;
  const input = (patch: Partial<FetchPlanInput> = {}): FetchPlanInput => ({
    organisationIds: [ORG],
    today: '2026-10-10',
    mode: 'FULL',
    modifiedCursor: null,
    deletedCursor: null,
    linkedPersonIds: new Set(),
    pageSize: 100,
    ...patch,
  });

  beforeEach(async () => {
    clearTokenCache();
    provider = new MockSs12000Provider(tls, { id: 'schemapro', secret: 'secret-0123456789' });
    await provider.start();
    provider.world = {
      organisations: [s1Organisation(ORG, 'Ekskolan', '11111111'), s1Organisation(ORG2, 'Ekskolan 4-9', '22222222')],
      persons: [
        s1Pupil(PUPIL, 'Ella', 'Ek', 'ella@skola.se', ORG, { responsibles: [{ id: GUARDIAN }], modified: '2026-10-09T10:00:00Z' }),
        s1Pupil(PUPIL2, 'Olle', 'Ek', 'olle@skola.se', ORG2, { modified: '2026-01-01T10:00:00Z' }),
        s1Adult(GUARDIAN, 'Gun', 'Ek', 'gun@hem.se', 'Privat'),
        s1Adult(TEACHER, 'Tor', 'Lund', 'tor@skola.se', 'Skola personal'),
        s1Adult(OUTSIDER, 'Ute', 'Sida', 'ute@annan.se', 'Skola personal'),
      ],
      groups: [s1Group(CLASS, '7A', 'Klass', ORG, [PUPIL, OUTSIDER])],
      duties: [s1Duty(DUTY, TEACHER, ORG)],
      deleted: { persons: ['bbbbbbbb-0000-4000-8000-0000000000dd'], groups: [], duties: [] },
    };
    client = new Ss12000Client(
      {
        sourceId: '11111111-1111-4111-8111-111111111111',
        baseUrl: provider.baseUrl,
        authKind: 'OAUTH2_CLIENT_CREDENTIALS',
        tokenUrl: provider.tokenUrl,
        clientId: 'schemapro',
        tokenScope: null,
        tokenAuthStyle: 'BASIC',
        secrets: { CLIENT_SECRET: 'secret-0123456789' },
      },
      { policy: { allowLoopback: true, ca: tls.ca }, retryDelaysMs: [1], sleep: async () => undefined },
    );
  });

  afterEach(async () => {
    await provider.stop();
  });

  it('FULL: asks for pupils, staff and guardians by relationship, Klass and Undervisning groups and duties, with T as the end bound', async () => {
    const roster = await fetchRoster(client, input());
    const persons = provider.dataRequests('/persons').map((r) => Object.fromEntries(r.query));
    expect(persons.map((q) => q['relationship.entity.type'])).toEqual(['enrolment', 'duty', 'responsibleFor.enrolment']);
    for (const q of persons) {
      expect(q).toMatchObject({ 'relationship.organisation': ORG, 'relationship.endDate.onOrAfter': '2026-10-10' });
      expect(q['meta.modified.after']).toBeUndefined();
    }
    expect(provider.dataRequests('/groups')[0]!.query).toEqual([
      ['organisation', ORG],
      ['groupType', 'Klass'],
      ['groupType', 'Undervisning'],
      ['endDate.onOrAfter', '2026-10-10'],
      ['limit', '100'],
    ]);
    expect(provider.dataRequests('/duties')[0]!.query).toEqual([['organisation', ORG], ['endDate.onOrAfter', '2026-10-10'], ['limit', '100']]);
    expect(provider.dataRequests('/deletedEntities')).toHaveLength(0);

    expect(roster.mode).toBe('FULL');
    expect([...roster.enrolmentIds]).toEqual([PUPIL]);
    expect([...roster.dutyPersonIds]).toEqual([TEACHER]);
    expect([...roster.responsibleIds]).toEqual([GUARDIAN]);
    expect(roster.organisations.map((o) => o.schoolUnitCode)).toEqual(['11111111']);
    expect(roster.deleted).toBeNull();
  });

  it('looks up a person a group names who is neither fetched nor linked, and never a linked one', async () => {
    const roster = await fetchRoster(client, input());
    const lookups = provider.requests.filter((r) => r.path.endsWith('/persons/lookup'));
    expect(lookups).toHaveLength(1);
    expect(roster.persons.has(OUTSIDER)).toBe(true);

    provider.requests.length = 0;
    await fetchRoster(client, input({ linkedPersonIds: new Set([OUTSIDER]) }));
    expect(provider.requests.filter((r) => r.path.endsWith('/persons/lookup'))).toHaveLength(0);
  });

  it('unions persons across the source organisations of one school', async () => {
    const roster = await fetchRoster(client, input({ organisationIds: [ORG, ORG2] }));
    expect(roster.organisations).toHaveLength(2);
    expect([...roster.enrolmentIds].sort()).toEqual([PUPIL, PUPIL2]);
  });

  it('INCREMENTAL: meta.modified.after on the first page only, and deletedEntities for Person, Group, Duty', async () => {
    const roster = await fetchRoster(
      client,
      input({ mode: 'INCREMENTAL', modifiedCursor: new Date('2026-10-01T00:00:00Z'), deletedCursor: new Date('2026-10-01T00:00:00Z'), pageSize: 100 }),
    );
    expect(roster.mode).toBe('INCREMENTAL');
    expect(roster.persons.has(PUPIL)).toBe(true);
    expect([...roster.enrolmentIds]).toEqual([PUPIL]);
    for (const request of provider.dataRequests().filter((r) => r.method === 'GET' && !r.path.includes('/organisations') && !r.path.endsWith('/deletedEntities'))) {
      expect(Object.fromEntries(request.query)['meta.modified.after']).toBe('2026-10-01T00:00:00.000Z');
    }
    const deleted = provider.dataRequests('/deletedEntities')[0]!;
    expect(deleted.query).toEqual([
      ['after', '2026-10-01T00:00:00.000Z'],
      ['entities', 'Person'],
      ['entities', 'Group'],
      ['entities', 'Duty'],
      ['limit', '100'],
    ]);
    expect(roster.deleted?.persons).toEqual(['bbbbbbbb-0000-4000-8000-0000000000dd']);
  });

  it('starts over FULL when the provider refuses meta.modified.after, and says so', async () => {
    provider.faults.refuseModifiedAfter = true;
    const roster = await fetchRoster(
      client,
      input({ mode: 'INCREMENTAL', modifiedCursor: new Date('2026-10-01T00:00:00Z'), deletedCursor: new Date('2026-10-01T00:00:00Z') }),
    );
    expect(roster.mode).toBe('FULL');
    expect(roster.incrementalUnsupported).toBe(true);
    expect(roster.deleted).toBeNull();
  });

  it('starts over FULL when an incremental run cannot look a person up', async () => {
    provider.faults.refuseLookup = true;
    const roster = await fetchRoster(
      client,
      input({ mode: 'INCREMENTAL', modifiedCursor: new Date('2020-01-01T00:00:00Z'), deletedCursor: new Date('2020-01-01T00:00:00Z') }),
    );
    expect(roster).toMatchObject({ mode: 'FULL', incrementalUnsupported: true });
  });

  it('finds the guardians through /persons/lookup when responsibleFor.enrolment is refused', async () => {
    provider.faults.refuseResponsibleFor = true;
    const roster = await fetchRoster(client, input());
    expect(roster.responsibleIds.size).toBe(0);
    expect(roster.persons.has(GUARDIAN)).toBe(true);
  });

  it('counts a record it cannot parse as INVALID_RECORD by id, and keeps the rest', async () => {
    provider.world.persons.push({ id: 'bbbbbbbb-0000-4000-8000-0000000000ee', givenName: 'Utan', enrolments: [{ enroledAt: { id: ORG }, schoolType: 'GR', startDate: '2026-08-01' }] });
    const roster = await fetchRoster(client, input());
    expect(roster.invalid).toEqual([{ entity: 'PERSON', externalId: 'bbbbbbbb-0000-4000-8000-0000000000ee' }]);
    expect(roster.persons.has(PUPIL)).toBe(true);
  });

  it('throws the code of a failure, so no diff is made from a half-read roster', async () => {
    await client.authenticate();
    provider.faults.serverError = true;
    await expect(fetchRoster(client, input())).rejects.toThrow('SS12000_HTTP_500');
  });
});
