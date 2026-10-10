import { createServer, type Server } from 'node:https';
import type { AddressInfo } from 'node:net';
import { Logger } from '@nestjs/common';
import request from 'supertest';
import { Ss12000Service } from '../src/integration/ss12000.service';
import { adhocActivityId } from '../src/integration/ss12000-v2/ids';
import { verifySignature } from '../src/integration/ss12000-v2/signing';
import { Ss12000V2Guard } from '../src/integration/ss12000-v2/ss12000-v2.guard';
import { Ss12000WebhookDeliveryService } from '../src/integration/ss12000-v2/webhook-delivery.service';
import type { ClientOptions } from '../src/integration/ss12000-sync/client';
import { Ss12000Outbound } from '../src/integration/ss12000-sync/ss12000-sync.providers';
import { allKeys, checkSchema } from './utils/s1-contract';
import { ABSENCE_TEXT, ProviderWorld, W, keyOf } from './utils/ss12000-provider-world';
import { asUser, createTestApp, type TestHarness } from './utils/test-app';
import { makeTestTls } from './utils/test-tls';

/**
 * The SS12000 2.1 provider over HTTP (/ss12000/v2.0): authentication and
 * scopes, S1's paging and Error shape, the privacy invariants over whole
 * responses, subscriptions and their signed delivery to a local TLS mock
 * receiver (never a real consumer), and v1 unchanged beside it. The school
 * is test/utils/ss12000-provider-world.ts behind the harness's Prisma mock;
 * what Postgres enforces is scripts/test/rls-policies.sql §31 and the
 * adapter probe's sp-* checks.
 */

const tls = makeTestTls();

class TestOutbound extends Ss12000Outbound {
  override clientOptions(): ClientOptions {
    return { policy: { allowLoopback: true, ca: tls.ca } };
  }
}

const FULL = keyOf(1);
const V1_ONLY = keyOf(2);
const GROUPS_ONLY = keyOf(3);
const REVOKED = keyOf(4);
const NO_GUARDIANS = keyOf(5);
const WINDOW = 'startTime.onOrAfter=2026-10-01T00:00:00Z&startTime.onOrBefore=2026-10-31T00:00:00Z';

interface Received {
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

class Receiver {
  server: Server | null = null;
  received: Received[] = [];
  status = 200;
  url = '';
  async start(): Promise<void> {
    this.server = createServer({ key: tls.serverKey, cert: tls.serverCert }, (req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => {
        this.received.push({ headers: req.headers, body: Buffer.concat(chunks).toString('utf8') });
        res.statusCode = this.status;
        res.end(this.status === 200 ? 'ok' : 'nope');
      });
    });
    await new Promise<void>((resolve) => this.server!.listen(0, '127.0.0.1', resolve));
    this.url = `https://127.0.0.1:${(this.server.address() as AddressInfo).port}/hooks/ss12000?tenant=ekskolan`;
  }
  async stop(): Promise<void> {
    await new Promise<void>((resolve) => this.server?.close(() => resolve()));
  }
}

function captureLogs(): { lines: string[]; restore: () => void } {
  const lines: string[] = [];
  const spies = (['log', 'warn', 'error', 'debug', 'verbose'] as const).map((level) =>
    jest.spyOn(Logger.prototype, level).mockImplementation((...args: unknown[]) => void lines.push(args.map(String).join(' '))),
  );
  return { lines, restore: () => spies.forEach((spy) => spy.mockRestore()) };
}

describe('SS12000 v2.0 provider (e2e)', () => {
  let harness: TestHarness;
  let world: ProviderWorld;
  let logs: ReturnType<typeof captureLogs>;
  const receiver = new Receiver();
  const http = () => request(harness.app.getHttpServer());
  const v2 = (path: string, key: string | null = FULL) => {
    const call = http().get(`/ss12000/v2.0${path}`);
    return key ? call.set('Authorization', `Bearer ${key}`) : call;
  };
  const v2post = (path: string, body: unknown, key = FULL) => http().post(`/ss12000/v2.0${path}`).set('Authorization', `Bearer ${key}`).send(body as object);
  const admin = asUser({});

  beforeAll(async () => {
    logs = captureLogs();
    harness = await createTestApp({ configure: (builder) => builder.overrideProvider(Ss12000Outbound).useValue(new TestOutbound()) });
    await receiver.start();
  });

  afterAll(async () => {
    await receiver.stop();
    await harness.close();
    logs.restore();
  });

  beforeEach(() => {
    jest.clearAllMocks();
    Ss12000V2Guard.resetCounters();
    world = new ProviderWorld();
    world.install(harness.tx);
    receiver.received = [];
    receiver.status = 200;
    logs.lines.length = 0;
  });

  describe('who gets in', () => {
    it('401s with S1\'s Error and WWW-Authenticate: Bearer without a key, with a malformed one and with a revoked one', async () => {
      for (const key of [null, 'sp_nope', REVOKED]) {
        const res = await v2('/persons', key);
        expect(res.status).toBe(401);
        expect(res.headers['www-authenticate']).toBe('Bearer');
        expect(res.body).toEqual({ code: 'UNAUTHENTICATED', message: expect.any(String) });
        expect(checkSchema(res.body, 'Error')).toEqual([]);
      }
      // The revoked key is refused by v1 too, as before.
      await http().get('/ss12000/v1/organisation').set('x-api-key', REVOKED).expect(401);
    });

    it('takes the key as S1\'s bearer or as X-API-Key, and refuses two different ones', async () => {
      await v2('/rooms').expect(200);
      await http().get('/ss12000/v2.0/rooms').set('x-api-key', FULL).expect(200);
      await http().get('/ss12000/v2.0/rooms').set('Authorization', `Bearer ${FULL}`).set('x-api-key', V1_ONLY).expect(401);
      // A user's JWT is no key.
      await http().get('/ss12000/v2.0/rooms').set('x-test-user', admin).expect(401);
    });

    it('a v1-only key (every key that existed before scopes) reads v1 and is refused v2', async () => {
      await http().get('/ss12000/v1/organisation').set('x-api-key', V1_ONLY).expect(200);
      const res = await v2('/persons', V1_ONLY).expect(403);
      expect(res.body).toEqual({ code: 'SCOPE_MISSING', message: expect.stringContaining('persons.read') });
    });

    it('a v2-only key is refused v1 with the house\'s 403, and reads only what its scopes name', async () => {
      const v1 = await http().get('/ss12000/v1/groups').set('x-api-key', GROUPS_ONLY).expect(403);
      expect(v1.body).toMatchObject({ status: 403, detail: expect.stringContaining('ss12000.v1') });
      await v2('/groups', GROUPS_ONLY).expect(200);
      for (const path of ['/persons', '/duties', '/activities', '/rooms', '/syllabuses', '/organisations', `/calendarEvents?${WINDOW}`, '/subscriptions']) {
        const res = await v2(path, GROUPS_ONLY);
        expect({ path, status: res.status, code: res.body.code }).toEqual({ path, status: 403, code: 'SCOPE_MISSING' });
      }
    });

    it('the import needs ss12000.v1.import: a read-only v1 key is refused it, and still reads', async () => {
      world.keys.find((key) => key['id'] === W.keyV1)!['scopes'] = ['ss12000.v1'];
      await http().get('/ss12000/v1/organisation').set('x-api-key', V1_ONLY).expect(200);
      const res = await http().post('/ss12000/v1/import/persons').set('x-api-key', V1_ONLY).send({ persons: [{ email: 'a@b.se' }] }).expect(403);
      expect(res.body.detail).toContain('ss12000.v1.import');
    });

    it('limits per key, 120 a minute, with Retry-After', async () => {
      for (let n = 0; n < 120; n++) await v2('/rooms', GROUPS_ONLY).expect(403);
      const res = await v2('/rooms', GROUPS_ONLY).expect(429);
      expect(res.headers['retry-after']).toBeDefined();
      expect(res.body.code).toBe('TOO_MANY_REQUESTS');
      // Another key of the same address is not affected.
      await v2('/rooms', FULL).expect(200);
    });
  });

  describe('S1\'s paging, filters and errors', () => {
    it('walks /persons page by page to pageToken null, each object once', async () => {
      const seen: string[] = [];
      let token: string | null = null;
      let pages = 0;
      do {
        const query: string = token ? `limit=3&pageToken=${encodeURIComponent(token)}` : 'limit=3&sortkey=FamilyNameAsc';
        const res = await v2(`/persons?${query}`).expect(200);
        expect(checkSchema(res.body, 'PersonsExpanded')).toEqual([]);
        seen.push(...res.body.data.map((person: { id: string }) => person.id));
        token = res.body.pageToken;
        pages++;
      } while (token && pages < 10);
      const all = (await v2('/persons').expect(200)).body.data.map((person: { id: string }) => person.id);
      expect(pages).toBe(Math.ceil(all.length / 3));
      expect(new Set(seen).size).toBe(seen.length);
      expect([...seen].sort()).toEqual([...all].sort());
    });

    it('a token carries its filters: repeating them is fine, changing one is 400, another key\'s token is 400', async () => {
      const first = await v2('/persons?limit=1&relationship.entity.type=enrolment').expect(200);
      const token = encodeURIComponent(first.body.pageToken);
      await v2(`/persons?pageToken=${token}`).expect(200);
      await v2(`/persons?pageToken=${token}&limit=5&relationship.entity.type=enrolment`).expect(200);
      expect((await v2(`/persons?pageToken=${token}&relationship.entity.type=duty`).expect(400)).body.code).toBe('INVALID_PAGE_TOKEN');
      expect((await v2(`/persons?pageToken=${token}`, NO_GUARDIANS).expect(400)).body.code).toBe('INVALID_PAGE_TOKEN');
      expect((await v2('/persons?pageToken=not-a-token').expect(400)).body.code).toBe('INVALID_PAGE_TOKEN');
    });

    it('calendarEvents needs its window, which page 2 carries in the token (A1.1)', async () => {
      expect((await v2('/calendarEvents').expect(400)).body).toEqual({ code: 'INVALID_FILTER', message: expect.stringContaining('startTime.onOrAfter') });
      const first = await v2(`/calendarEvents?${WINDOW}&limit=1`).expect(200);
      expect(first.body.data).toHaveLength(1);
      const token = encodeURIComponent(first.body.pageToken);
      const second = await v2(`/calendarEvents?pageToken=${token}`).expect(200);
      const again = await v2(`/calendarEvents?pageToken=${token}&${WINDOW}`).expect(200);
      expect(again.body).toEqual(second.body);
      expect(second.body.data[0].id).not.toBe(first.body.data[0].id);
      await v2(`/calendarEvents?pageToken=${token}&startTime.onOrAfter=2026-10-02T00:00:00Z&startTime.onOrBefore=2026-10-31T00:00:00Z`).expect(400);
    });

    it('accepts every S1 filter: one on an attribute SchemaPro never holds answers an empty page; one S1 does not define is 400', async () => {
      for (const path of ['/persons?civicNo=199001011234', '/persons?identifier.value=x', '/persons?relationship.entity.type=placement.child', '/organisations?municipalityCode=0180', '/organisations?parent=aaaaaaaa-0000-4000-8000-000000000001']) {
        const res = await v2(path).expect(200);
        expect({ path, data: res.body.data }).toEqual({ path, data: [] });
      }
      expect((await v2('/persons?role=TEACHER').expect(400)).body.code).toBe('INVALID_FILTER');
      expect((await v2('/persons?sortkey=CivicNoAsc').expect(400)).body.code).toBe('SORTKEY_NOT_SUPPORTED');
      expect((await v2('/persons?meta.modified.after=yesterday').expect(400)).body.code).toBe('INVALID_FILTER');
      expect((await v2('/duties?dutyRole=Lärare&dutyRole=Rektor').expect(400)).body.code).toBe('INVALID_FILTER');
    });

    it('meta.modified.after is exclusive and narrows the answer to what moved', async () => {
      const res = await v2('/persons?meta.modified.after=2026-10-01T00:00:00Z').expect(200);
      expect(res.body.data.map((person: { id: string }) => person.id)).toEqual([W.p1Source]);
      const none = await v2('/persons?meta.modified.after=2026-10-10T09:00:00Z').expect(200);
      expect(none.body.data).toEqual([]);
    });

    it('404 has no body; a path id that is no uuid is 400 INVALID_ID; any uuid version is accepted', async () => {
      const missing = await v2('/persons/aaaaaaaa-0000-4000-8000-00000000dead').expect(404);
      expect(missing.text).toBe('');
      expect((await v2('/persons/not-a-uuid').expect(400)).body.code).toBe('INVALID_ID');
      expect((await v2(`/persons/${W.p1Source.toUpperCase()}`).expect(200)).body.id).toBe(W.p1Source);
    });

    it('logs the path and the status, never the query: no personnummer, name or email reaches a log line', async () => {
      await v2('/persons?civicNo=199001011234&nameContains=Girgensohn&sortkey=CivicNoDesc').expect(400);
      await v2('/persons?eduPersonPrincipalName=palle%40elev.ekskolan.se&unknown=1').expect(400);
      await v2('/persons?nameContains=Girgensohn&civicNo=199001011234').expect(200);
      const text = logs.lines.join('\n');
      expect(text).toContain('/ss12000/v2.0/persons');
      for (const secret of ['199001011234', 'Girgensohn', 'palle@elev', 'palle%40elev']) expect(text).not.toContain(secret);
    });

    it('lookups take S1\'s bodies, ids of any case, and refuse what S1 does not shape', async () => {
      const persons = await http().post('/ss12000/v2.0/persons/lookup').set('Authorization', `Bearer ${FULL}`).send({ ids: [W.p1Source.toUpperCase()], civicNos: ['199001011234'] }).expect(200);
      expect(persons.body.map((person: { id: string }) => person.id)).toEqual([W.p1Source]);
      const events = await v2post('/calendarEvents/lookup', { activities: [W.m1], student: [W.p2] }).expect(200);
      expect(events.body.length).toBeGreaterThan(0);
      for (const event of events.body) expect(checkSchema(event, 'CalendarEvent')).toEqual([]);
      expect((await v2post('/rooms/lookup', { ids: ['nope'] }).expect(400)).body.code).toBe('INVALID_BODY');
      expect((await v2post('/rooms/lookup', { roomIds: [W.r1] }).expect(400)).body.code).toBe('INVALID_BODY');
    });
  });

  describe('what leaves, and what never does', () => {
    it('every resource answers S1\'s list schema', async () => {
      const cases: Array<[string, string]> = [
        ['/organisations', 'Organisations'],
        ['/persons?expand=duties&expand=responsibleFor&expand=groupMemberships&expandReferenceNames=true', 'PersonsExpanded'],
        ['/groups?expand=assignmentRoles&expandReferenceNames=true', 'GroupsExpanded'],
        ['/duties?expand=person', 'Duties'],
        ['/activities?expand=groups&expand=teachers&expand=syllabus', 'Activities'],
        [`/calendarEvents?${WINDOW}&expand=activity&expandReferenceNames=true`, 'CalendarEvents'],
        ['/rooms', 'Rooms'],
        ['/syllabuses', 'Syllabuses'],
        ['/deletedEntities?after=2026-09-01T00:00:00Z', 'DeletedEntities'],
      ];
      for (const [path, schema] of cases) {
        const res = await v2(path).expect(200);
        expect({ path, violations: checkSchema(res.body, schema) }).toEqual({ path, violations: [] });
      }
    });

    it('no absence reason, note, cause, HR figure, personnummer, phone or EPPN in any v2 answer', async () => {
      const bodies: unknown[] = [];
      for (const path of [
        '/organisations', '/persons?expand=duties&expand=responsibleFor&expand=groupMemberships', '/groups?expand=assignmentRoles',
        '/duties?expand=person', '/activities?expand=teachers', `/calendarEvents?${WINDOW}&expand=activity`, '/rooms', '/syllabuses', '/deletedEntities',
      ]) {
        bodies.push((await v2(path).expect(200)).body);
      }
      const text = JSON.stringify(bodies);
      for (const forbidden of [ABSENCE_TEXT, 'Nedsättning', '070-1234567']) expect(text).not.toContain(forbidden);
      const keys = allKeys(bodies);
      for (const key of ['note', 'cancelCause', 'reductionPercent', 'dutyPercent', 'civicNo', 'eduPersonPrincipalNames', 'phoneNumbers', 'relationType', 'securityMarking']) {
        expect({ key, present: keys.has(key) }).toEqual({ key, present: false });
      }
    });

    it('a key without responsibles.read sees no guardian, no responsibles[], no private email', async () => {
      const res = await v2('/persons', NO_GUARDIANS).expect(200);
      expect(JSON.stringify(res.body)).not.toContain('gun@privat.se');
      expect(allKeys(res.body).has('responsibles')).toBe(false);
      expect((await v2(`/persons/${W.g1}`, NO_GUARDIANS)).status).toBe(404);
    });

    it('a groups.read key gets no pupil names through expandReferenceNames (A5.8)', async () => {
      const res = await v2('/groups?expandReferenceNames=true', GROUPS_ONLY).expect(200);
      expect(JSON.stringify(res.body)).not.toContain('Girgensohn');
      expect(JSON.stringify(res.body)).not.toContain('Ekskolan');
    });

    it('the ad-hoc lesson\'s Activity id is never the event\'s id, and expand=attendance is refused', async () => {
      const event = await v2(`/calendarEvents/${W.l3Adhoc}`).expect(200);
      expect(event.body.activity.id).toBe(adhocActivityId(W.l3Adhoc));
      expect(event.body.activity.id).not.toBe(W.l3Adhoc);
      await v2(`/activities/${event.body.activity.id}`).expect(200);
      expect((await v2(`/calendarEvents?${WINDOW}&expand=attendance`).expect(403)).body.code).toBe('SCOPE_MISSING');
    });

    it('deletedEntities answers with S1\'s own key spelling (activitites), per readable category', async () => {
      const res = await v2('/deletedEntities?entities=Activity&entities=Person&entities=Absence').expect(200);
      expect(Object.keys(res.body.data).sort()).toEqual(['activitites', 'persons']);
      expect(res.body.data.persons).toEqual([W.p5]);
      const groupsOnly = await v2('/deletedEntities', GROUPS_ONLY).expect(200);
      expect(Object.keys(groupsOnly.body.data)).toEqual(['groups']);
    });
  });

  describe('v1 beside it', () => {
    it('answers exactly what Ss12000Service builds — the scope guard adds and changes nothing', async () => {
      const service = harness.app.get(Ss12000Service);
      const cases: Array<[string, () => Promise<unknown>]> = [
        ['/ss12000/v1/organisation', () => service.organisation(W.school)],
        ['/ss12000/v1/persons', () => service.persons(W.school)],
        ['/ss12000/v1/groups', () => service.groups(W.school)],
        ['/ss12000/v1/duties', () => service.duties(W.school)],
      ];
      for (const [path, direct] of cases) {
        const res = await http().get(path).set('x-api-key', V1_ONLY);
        expect({ path, status: res.status }).toEqual({ path, status: 200 });
        expect(res.text).toBe(JSON.stringify(await direct()));
        const keys = allKeys(res.body);
        for (const added of ['ss12000Id', 'origin', 'scopes', 'pageToken']) expect({ path, added, present: keys.has(added) }).toEqual({ path, added, present: false });
      }
    });
  });

  describe('the admin\'s keys', () => {
    it('creates a key with chosen scopes, edits them, and lists the provider view without key, hash or secret', async () => {
      harness.tx['integrationApiKey']!['create']!.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => {
        world.keys.push({ id: 'a1111111-0000-4000-8000-000000000001', ...data, revokedAt: null, lastUsedAt: null, createdAt: new Date() });
        return { id: 'a1111111-0000-4000-8000-000000000001', name: data['name'], createdAt: new Date() };
      });
      const created = await http().post('/api/v1/integration-keys').set('x-test-user', admin).send({ name: 'Vklass', scopes: ['activities.read', 'calendarEvents.read', 'activities.read'] }).expect(201);
      expect(created.body.key).toMatch(/^sp_[0-9a-f]{48}$/);
      expect(world.keys.at(-1)!['scopes']).toEqual(['activities.read', 'calendarEvents.read']);
      await http().post('/api/v1/integration-keys').set('x-test-user', admin).send({ scopes: ['everything'] }).expect(400);
      await http().patch(`/api/v1/integration-keys/${W.keyGroups}`).set('x-test-user', admin).send({ scopes: ['groups.read', 'persons.read'] }).expect(200);
      expect(world.keys.find((key) => key['id'] === W.keyGroups)!['scopes']).toEqual(['persons.read', 'groups.read']);
      await http().patch(`/api/v1/integration-keys/${W.keyGroups}`).set('x-test-user', admin).send({ scopes: [] }).expect(400);
      const view = await http().get('/api/v1/integration-keys/provider').set('x-test-user', admin).expect(200);
      expect(view.body.find((key: { id: string }) => key.id === W.keyFull)).toMatchObject({ scopes: expect.arrayContaining(['persons.read']), webhookSecret: null, subscriptions: [] });
      expect(JSON.stringify(view.body)).not.toMatch(/keyHash|sp_[0-9a-f]{48}/);
    });

    it('refuses every key route to a TEACHER, a STUDENT and a GUARDIAN', async () => {
      for (const role of ['TEACHER', 'STUDENT', 'GUARDIAN'] as const) {
        const user = asUser({ role });
        await http().get('/api/v1/integration-keys/provider').set('x-test-user', user).expect(403);
        await http().patch(`/api/v1/integration-keys/${W.keyFull}`).set('x-test-user', user).send({ scopes: ['groups.read'] }).expect(403);
        await http().post(`/api/v1/integration-keys/${W.keyFull}/webhook-secret`).set('x-test-user', user).expect(403);
        await http().post(`/api/v1/integration-keys/${W.keyFull}/subscriptions/${W.keyFull}/pause`).set('x-test-user', user).expect(403);
      }
    });
  });

  describe('subscriptions', () => {
    const create = (body: unknown, key = FULL) => v2post('/subscriptions', body, key);
    const valid = () => ({ name: 'Vklass', target: receiver.url, resourceTypes: [{ resource: 'CalendarEvent' }, { resource: 'Activity' }] });
    const makeSecret = async () => (await http().post(`/api/v1/integration-keys/${W.keyFull}/webhook-secret`).set('x-test-user', admin).expect(201)).body.secret as string;

    it('needs subscriptions.write and a signing secret first (no unsigned notice is ever sent)', async () => {
      expect((await create(valid(), NO_GUARDIANS)).body.code).toBe('WEBHOOK_SECRET_MISSING');
      expect((await create(valid(), GROUPS_ONLY)).body.code).toBe('SCOPE_MISSING');
      const missing = await create(valid()).expect(409);
      expect(missing.body.code).toBe('WEBHOOK_SECRET_MISSING');
    });

    it('is S1\'s CRUD for the key\'s own subscriptions: 201, list, get, renew, 204', async () => {
      const secret = await makeSecret();
      expect(secret).toMatch(/^whsec_/);
      const made = await create(valid()).expect(201);
      expect(checkSchema(made.body, 'Subscription')).toEqual([]);
      expect(made.body.resourceTypes).toEqual([{ resource: 'CalendarEvent' }, { resource: 'Activity' }]);
      const list = await v2('/subscriptions').expect(200);
      expect(checkSchema(list.body, 'Subscriptions')).toEqual([]);
      expect(list.body.data.map((row: { id: string }) => row.id)).toEqual([made.body.id]);
      await v2(`/subscriptions/${made.body.id}`).expect(200);
      // Another key sees none of it.
      expect((await v2(`/subscriptions/${made.body.id}`, NO_GUARDIANS)).status).toBe(404);
      const renewed = await http().patch(`/ss12000/v2.0/subscriptions/${made.body.id}`).set('Authorization', `Bearer ${FULL}`).expect(200);
      expect(new Date(renewed.body.expires).getTime()).toBeGreaterThan(Date.now() + 29 * 86_400_000);
      const ended = await http().delete(`/ss12000/v2.0/subscriptions/${made.body.id}`).set('Authorization', `Bearer ${FULL}`).expect(204);
      expect(ended.text).toBe('');
      await v2(`/subscriptions/${made.body.id}`).expect(404);
      // The row stays, ended: a record, not a deletion.
      expect(world.subscriptions.find((row) => row['id'] === made.body.id)!['endedAt']).toBeInstanceOf(Date);
    });

    it('holds resourceTypes to S1\'s [{resource}] shape, the emitted resources and the key\'s scopes', async () => {
      await makeSecret();
      // S1's own (non-normative) example: plain strings, "Organsation" misspelt.
      expect((await create({ name: 'x', target: receiver.url, resourceTypes: ['Organsation', 'Person', 'Duty'] }).expect(400)).body.code).toBe('INVALID_BODY');
      expect((await create({ name: 'x', target: receiver.url, resourceTypes: [{ resource: 'Absence' }] }).expect(400)).body.code).toBe('INVALID_BODY');
      await http().patch(`/api/v1/integration-keys/${W.keyFull}`).set('x-test-user', admin).send({ scopes: ['subscriptions.write', 'rooms.read'] }).expect(200);
      expect((await create({ name: 'x', target: receiver.url, resourceTypes: [{ resource: 'Person' }] }).expect(403)).body.code).toBe('SCOPE_MISSING');
    });

    it('refuses a target that is not https or not a public address', async () => {
      await makeSecret();
      for (const target of ['http://example.com/hook', 'https://user:pw@example.com/hook', 'https://10.0.0.5/hook', 'https://169.254.169.254/latest', 'https://[fd00::1]/hook']) {
        const res = await create({ ...valid(), target });
        expect({ target, status: res.status, code: res.body.code }).toEqual({ target, status: 400, code: 'INVALID_BODY' });
      }
    });

    it('stops at ten live subscriptions per key', async () => {
      await makeSecret();
      for (let n = 0; n < 10; n++) await create({ ...valid(), name: `s${n}` }).expect(201);
      expect((await create(valid()).expect(409)).body.code).toBe('SUBSCRIPTION_LIMIT');
    });

    it('delivers S1\'s body, signed, to the target; a rotated secret signs with both for a day', async () => {
      const first = await makeSecret();
      const made = await create(valid()).expect(201);
      world.due = [{ subscription_id: made.body.id, school_id: W.school, key_id: W.keyFull, target: receiver.url, modified: ['CalendarEvent'], deleted: true, watermark_to: '1234', attempts: 0, failing_since: null }];
      await harness.app.get(Ss12000WebhookDeliveryService).tick();
      expect(receiver.received).toHaveLength(1);
      const [notice] = receiver.received;
      expect(JSON.parse(notice!.body)).toEqual({ modifiedEntites: ['CalendarEvent'], deletedEntities: true });
      expect(checkSchema(JSON.parse(notice!.body), '_subscriptions_get_request')).toEqual([]);
      const timestamp = Number(notice!.headers['x-schemapro-timestamp']);
      expect(verifySignature(String(notice!.headers['x-schemapro-signature']), first, timestamp, notice!.body)).toBe(true);
      expect(world.settled).toEqual([{ subscription: made.body.id, ok: true, status: 200, outcome: 'DELIVERED', watermark: '1234' }]);

      const second = await makeSecret();
      world.due = [{ subscription_id: made.body.id, school_id: W.school, key_id: W.keyFull, target: receiver.url, modified: [], deleted: true, watermark_to: '1240', attempts: 0, failing_since: null }];
      await harness.app.get(Ss12000WebhookDeliveryService).tick();
      const [, rotated] = receiver.received;
      const header = String(rotated!.headers['x-schemapro-signature']);
      expect(header.split(',')).toHaveLength(2);
      const at = Number(rotated!.headers['x-schemapro-timestamp']);
      expect(verifySignature(header, second, at, rotated!.body)).toBe(true);
      expect(verifySignature(header, first, at, rotated!.body)).toBe(true);
      // The notice is resource names only, and no secret ever reaches a log.
      expect(logs.lines.join('\n')).not.toContain(first);
      expect(logs.lines.join('\n')).not.toContain(second);
    });

    it('a failing receiver is settled as a retry with its status, and its answer is never read into a log', async () => {
      await makeSecret();
      const made = await create(valid()).expect(201);
      receiver.status = 500;
      world.due = [{ subscription_id: made.body.id, school_id: W.school, key_id: W.keyFull, target: receiver.url, modified: ['Activity'], deleted: false, watermark_to: '99', attempts: 2, failing_since: new Date() }];
      await harness.app.get(Ss12000WebhookDeliveryService).tick();
      expect(world.settled).toEqual([{ subscription: made.body.id, ok: false, status: 500, outcome: 'HTTP_500', watermark: '99' }]);
      expect(logs.lines.join('\n')).not.toContain('tenant=ekskolan');
      expect(logs.lines.join('\n')).not.toContain('nope');
    });

    it('the school pauses and resumes a key\'s subscription', async () => {
      await makeSecret();
      const made = await create(valid()).expect(201);
      await http().post(`/api/v1/integration-keys/${W.keyFull}/subscriptions/${made.body.id}/pause`).set('x-test-user', admin).expect(200);
      expect(world.subscriptions[0]).toMatchObject({ suspendedReason: 'ADMIN' });
      await http().post(`/api/v1/integration-keys/${W.keyFull}/subscriptions/${made.body.id}/resume`).set('x-test-user', admin).expect(200);
      expect(world.subscriptions[0]).toMatchObject({ suspendedReason: null, suspendedAt: null });
      await http().post(`/api/v1/integration-keys/${W.keyFull}/subscriptions/${made.body.id}/explode`).set('x-test-user', admin).expect(404);
    });
  });
});
