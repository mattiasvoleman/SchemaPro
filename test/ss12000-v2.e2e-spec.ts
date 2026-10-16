import { createServer, type Server } from 'node:https';
import type { AddressInfo } from 'node:net';
import { Logger } from '@nestjs/common';
import request from 'supertest';
import { Role } from '../src/auth/enums/role.enum';
import { Ss12000Service } from '../src/integration/ss12000.service';
import { adhocActivityId } from '../src/integration/ss12000-v2/ids';
import { verifySignature } from '../src/integration/ss12000-v2/signing';
import { Ss12000V2Guard } from '../src/integration/ss12000-v2/ss12000-v2.guard';
import { Ss12000WebhookDeliveryService } from '../src/integration/ss12000-v2/webhook-delivery.service';
import type { ClientOptions } from '../src/integration/ss12000-sync/client';
import { Ss12000Outbound } from '../src/integration/ss12000-sync/ss12000-sync.providers';
import { allKeys, checkSchema } from './utils/s1-contract';
import { ABSENCE_TEXT, ProviderWorld, W, keyOf } from './utils/ss12000-provider-world';
import { recordedReads } from './utils/recorded-reads';
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

    it('the ad-hoc lesson\'s Activity id is never the event\'s id, and expand=attendance needs the scope and the school\'s decision', async () => {
      const event = await v2(`/calendarEvents/${W.l3Adhoc}`).expect(200);
      expect(event.body.activity.id).toBe(adhocActivityId(W.l3Adhoc));
      expect(event.body.activity.id).not.toBe(W.l3Adhoc);
      await v2(`/activities/${event.body.activity.id}`).expect(200);
      // The key holds attendances.read; the school has not decided to share.
      expect((await v2(`/calendarEvents?${WINDOW}&expand=attendance`).expect(403)).body.code).toBe('NOT_SHARED');
      await http()
        .patch(`/api/v1/integration-keys/${W.keyFull}`)
        .set('x-test-user', admin)
        .send({ scopes: ['calendarEvents.read'] })
        .expect(200);
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

  describe('attendance and absence (SS12000-närvaro)', () => {
    const share = () => {
      world.attendanceShared = true;
    };
    const ids = (body: { data: Array<{ id: string }> } | Array<{ id: string }>) =>
      (Array.isArray(body) ? body : body.data).map((item) => item.id).sort();

    it('is off by default: a key with the scopes is 403 NOT_SHARED, and deletedEntities has no category of it', async () => {
      for (const path of ['/attendances', `/attendances/${W.attPresent}`, '/absences', `/absences/${W.absSick}`]) {
        expect({ path, code: (await v2(path).expect(403)).body.code }).toEqual({ path, code: 'NOT_SHARED' });
      }
      expect((await v2post('/attendances/lookup', { ids: [W.attPresent] }).expect(403)).body.code).toBe('NOT_SHARED');
      expect((await v2post('/absences/lookup', { ids: [W.absSick] }).expect(403)).body.code).toBe('NOT_SHARED');
      const deleted = await v2('/deletedEntities?entities=Attendance&entities=Absence&entities=Person').expect(200);
      expect(Object.keys(deleted.body.data)).toEqual(['persons']);
    });

    it('once the school has stopped, /deletedEntities still answers every category, the two with their removals', async () => {
      world.everShared = true;
      world.tombstones.push(
        { schoolId: W.school, resource: 'Attendance', emittedId: 'a0000000-0000-4000-8000-0000000000fe', removedAt: new Date('2026-10-06T08:00:00Z') },
        { schoolId: W.school, resource: 'Absence', emittedId: 'ab000000-0000-4000-8000-0000000000fe', removedAt: new Date('2026-10-06T09:00:00Z') },
      );
      // S1's default, no entities: a person who left and an attendance and absence that went, ids only.
      const all = await v2('/deletedEntities').expect(200);
      expect(all.body.data).toMatchObject({
        persons: [W.p5],
        attendances: ['a0000000-0000-4000-8000-0000000000fe'],
        absences: ['ab000000-0000-4000-8000-0000000000fe'],
      });
      expect(Object.keys((await v2('/deletedEntities?entities=Attendance').expect(200)).body.data)).toEqual(['attendances']);
      // Everything else about them is still closed.
      expect((await v2('/attendances').expect(403)).body.code).toBe('NOT_SHARED');
      // A key without either scope never had them.
      expect(Object.keys((await v2('/deletedEntities', GROUPS_ONLY).expect(200)).body.data)).toEqual(['groups']);
    });

    it('needs its own scope whatever the school decided', async () => {
      share();
      expect((await v2('/attendances', GROUPS_ONLY).expect(403)).body.code).toBe('SCOPE_MISSING');
      expect((await v2('/absences', GROUPS_ONLY).expect(403)).body.code).toBe('SCOPE_MISSING');
      expect((await v2('/attendances', REVOKED).expect(401)).body.code).toBe('UNAUTHENTICATED');
      await http().patch(`/api/v1/integration-keys/${W.keyFull}`).set('x-test-user', admin).send({ scopes: ['absences.read'] }).expect(200);
      expect((await v2('/attendances').expect(403)).body.code).toBe('SCOPE_MISSING');
      await v2('/absences').expect(200);
    });

    it('answers S1\'s Attendances and Absences, with minutes by the närvarorapport\'s rule and nothing else', async () => {
      share();
      const attendances = await v2('/attendances?expandReferenceNames=true').expect(200);
      expect(checkSchema(attendances.body, 'Attendances')).toEqual([]);
      // Not the future year's lesson, not the pupil who left.
      expect(ids(attendances.body)).toEqual([W.attPresent, W.attLate, W.attExcused, W.attAbsent, W.attUnknown].sort());
      const byId = new Map<string, Record<string, unknown>>(attendances.body.data.map((item: { id: string }) => [item.id, item]));
      expect(byId.get(W.attPresent)).toMatchObject({ isReported: true, attendanceMinutes: 60, validAbsenceMinutes: 0, invalidAbsenceMinutes: 0 });
      expect(byId.get(W.attLate)).toMatchObject({ attendanceMinutes: 45, validAbsenceMinutes: 0, invalidAbsenceMinutes: 15 });
      expect(byId.get(W.attExcused)).toMatchObject({ attendanceMinutes: 0, validAbsenceMinutes: 60, invalidAbsenceMinutes: 0 });
      expect(byId.get(W.attAbsent)).toMatchObject({ attendanceMinutes: 0, validAbsenceMinutes: 0, invalidAbsenceMinutes: 60 });
      expect(byId.get(W.attUnknown)).toEqual({
        id: W.attUnknown,
        meta: expect.any(Object),
        calendarEvent: { id: W.l3Adhoc },
        student: { id: W.p4, displayName: 'Pia Nivå' },
        isReported: false,
      });
      // A linked pupil under the source's id; modified when the school began sharing, until a change gives it a version.
      expect(byId.get(W.attPresent)).toMatchObject({
        student: { id: W.p1Source },
        meta: { created: '2026-10-12T09:00:00.000Z', modified: '2026-10-12T09:30:00.000Z' },
      });

      const absences = await v2('/absences').expect(200);
      expect(checkSchema(absences.body, 'Absences')).toEqual([]);
      expect(ids(absences.body)).toEqual([W.absSick, W.absHours, W.absGranted, W.absForged].sort());
      const absence = new Map<string, Record<string, unknown>>(absences.body.data.map((item: { id: string }) => [item.id, item]));
      // A whole day is the school's local day (Europe/Stockholm, summer time).
      expect(absence.get(W.absSick)).toEqual({
        id: W.absSick, meta: expect.any(Object), startTime: '2026-10-12T22:00:00.000Z', endTime: '2026-10-13T22:00:00.000Z',
        type: 'Anmäld frånvaro', student: { id: W.p1Source },
      });
      expect(absence.get(W.absHours)).toMatchObject({ startTime: '2026-10-12T06:00:00.000Z', endTime: '2026-10-12T08:00:00.000Z', type: 'Anmäld frånvaro' });
      expect(absence.get(W.absGranted)).toMatchObject({ type: 'Beviljad ledighet', student: { id: W.p4 } });
      // A guardian's "Approved leave" note is not a decision.
      expect(absence.get(W.absForged)).toMatchObject({ type: 'Anmäld frånvaro' });

      const text = JSON.stringify([attendances.body, absences.body]);
      for (const forbidden of [ABSENCE_TEXT, 'Tandläkare', 'Approved leave', 'SICK', 'APPOINTMENT']) expect(text).not.toContain(forbidden);
      const keys = allKeys([attendances.body, absences.body]);
      for (const key of ['note', 'absenceReason', 'reporter', 'registeredBy', 'otherAttendanceMinutes', 'reportedTimestamp', 'organisation']) {
        expect({ key, present: keys.has(key) }).toEqual({ key, present: false });
      }
    });

    it('filters, pages and looks up as S1 says', async () => {
      share();
      expect(ids((await v2(`/attendances?student=${W.p1Source}`).expect(200)).body)).toEqual([W.attPresent, W.attExcused].sort());
      expect(ids((await v2(`/attendances?calendarEvent=${W.l1}`).expect(200)).body)).toEqual([W.attPresent, W.attLate].sort());
      expect((await v2(`/attendances?student=${W.g1}`).expect(200)).body.data).toEqual([]);
      // An incremental read from after sharing began is the rows changed since: those with a version after the mark.
      expect((await v2('/attendances?meta.modified.after=2026-10-12T10:00:00Z').expect(200)).body.data).toEqual([]);
      world.versions.push({ schoolId: W.school, resource: 'Attendance', entityId: W.attLate, createdAt: new Date('2026-10-12T09:00:00Z'), modifiedAt: new Date('2026-10-13T07:00:00Z') });
      const changed = await v2('/attendances?meta.modified.after=2026-10-12T10:00:00Z').expect(200);
      expect(changed.body.data).toEqual([expect.objectContaining({ id: W.attLate, meta: { created: '2026-10-12T09:00:00.000Z', modified: '2026-10-13T07:00:00.000Z' } })]);
      expect(ids((await v2('/attendances?meta.modified.before=2026-10-12T09:30:00Z').expect(200)).body)).toEqual([W.attPresent, W.attExcused, W.attAbsent, W.attUnknown].sort());
      expect((await v2('/attendances?meta.modified.before=2026-10-12T09:29:59.999Z').expect(200)).body.data).toEqual([]);
      // One from before sharing began (a term's first sync) is everything, each row saying it was modified in that window.
      const term = await v2('/attendances?meta.modified.after=2026-08-15T00:00:00Z').expect(200);
      expect(ids(term.body)).toEqual([W.attPresent, W.attLate, W.attExcused, W.attAbsent, W.attUnknown].sort());
      expect(term.body.data.every((item: { meta: { modified: string } }) => item.meta.modified > '2026-08-15T00:00:00Z')).toBe(true);
      expect(ids((await v2('/absences?meta.modified.after=2026-08-15T00:00:00Z').expect(200)).body)).toEqual([W.absSick, W.absHours, W.absGranted, W.absForged].sort());
      const first = await v2('/attendances?limit=2').expect(200);
      expect(first.body.data).toHaveLength(2);
      const second = await v2(`/attendances?limit=2&pageToken=${first.body.pageToken}`).expect(200);
      const third = await v2(`/attendances?pageToken=${second.body.pageToken}`).expect(200);
      expect(third.body.pageToken).toBeNull();
      expect([...ids(first.body), ...ids(second.body), ...ids(third.body)].sort()).toEqual(
        [W.attPresent, W.attLate, W.attExcused, W.attAbsent, W.attUnknown].sort(),
      );
      await v2(`/attendances/${W.attFutureYear}`).expect(404);
      await v2(`/attendances/${W.attInactivePupil}`).expect(404);
      expect((await v2('/attendances/not-a-uuid').expect(400)).body.code).toBe('INVALID_ID');
      expect(ids((await v2post('/attendances/lookup', { students: [W.p2], calendareEvents: [W.l1] }).expect(200)).body)).toEqual(
        [W.attLate, W.attAbsent, W.attPresent].sort(),
      );
      expect(ids((await v2post('/attendances/lookup', { activities: [adhocActivityId(W.l3Adhoc)] }).expect(200)).body)).toEqual([W.attUnknown]);
      expect((await v2post('/attendances/lookup', { calendarEvents: [W.l1] }).expect(400)).body.code).toBe('INVALID_BODY');

      expect(ids((await v2('/absences?type=Beviljad%20ledighet').expect(200)).body)).toEqual([W.absGranted]);
      expect((await v2(`/absences?registeredBy=${W.g1}`).expect(200)).body.data).toEqual([]);
      // 20 October in Stockholm begins at 22:00Z the day before; onOrAfter is inclusive.
      expect(ids((await v2('/absences?startTime.onOrAfter=2026-10-19T22:00:00Z').expect(200)).body)).toEqual([W.absGranted, W.absForged].sort());
      expect(ids((await v2('/absences?startTime.onOrAfter=2026-10-19T22:00:00.001Z').expect(200)).body)).toEqual([W.absForged]);
      const sorted = await v2('/absences?sortkey=StartTimeAsc').expect(200);
      expect(sorted.body.data.map((item: { id: string }) => item.id)).toEqual([W.absHours, W.absSick, W.absGranted, W.absForged]);
      await v2(`/absences/${W.absInactivePupil}`).expect(404);
      expect(ids((await v2post('/absences/lookup', { ids: [W.absSick, W.absInactivePupil] }).expect(200)).body)).toEqual([W.absSick]);
    });

    it('calendarEvents?expand=attendance embeds each lesson\'s attendances once the school shares', async () => {
      share();
      const res = await v2(`/calendarEvents?${WINDOW}&expand=attendance`).expect(200);
      expect(checkSchema(res.body, 'CalendarEvents')).toEqual([]);
      const embedded = new Map<string, string[]>(
        res.body.data.map((event: { id: string; _embedded: { attendance: Array<{ id: string }> } }) => [event.id, event._embedded.attendance.map((a) => a.id).sort()]),
      );
      expect(embedded.get(W.l1)).toEqual([W.attPresent, W.attLate].sort());
      expect(embedded.get(W.l5Cancelled)).toEqual([]);
      expect(JSON.stringify(res.body)).not.toContain(ABSENCE_TEXT);
    });

    it('records every read in the läslogg: attendance, a reported absence, a granted leave', async () => {
      share();
      await v2('/attendances').expect(200);
      await v2('/absences').expect(200);
      const reads = recordedReads(harness.tx);
      expect(reads.find((read) => read.kind === 'ATTENDANCE')?.ids.sort()).toEqual([W.p1, W.p2, W.p4].sort());
      expect(reads.find((read) => read.kind === 'ABSENCE_REPORTS')?.ids.sort()).toEqual([W.p1, W.p2].sort());
      expect(reads.find((read) => read.kind === 'LEAVE_REQUESTS')?.ids).toEqual([W.p4]);
    });

    it('deletedEntities answers attendances and absences by S1\'s keys once the school shares', async () => {
      share();
      world.tombstones.push(
        { schoolId: W.school, resource: 'Attendance', emittedId: 'a0000000-0000-4000-8000-0000000000ff', removedAt: new Date('2026-10-05T08:00:00Z') },
        { schoolId: W.school, resource: 'Absence', emittedId: 'ab000000-0000-4000-8000-0000000000ff', removedAt: new Date('2026-10-05T09:00:00Z') },
      );
      const res = await v2('/deletedEntities?entities=Attendance&entities=Absence').expect(200);
      expect(res.body.data).toEqual({ attendances: ['a0000000-0000-4000-8000-0000000000ff'], absences: ['ab000000-0000-4000-8000-0000000000ff'] });
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
      for (const role of [Role.TEACHER, Role.STUDENT, Role.GUARDIAN]) {
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
      expect((await create({ name: 'x', target: receiver.url, resourceTypes: [{ resource: 'Grade' }] }).expect(400)).body.code).toBe('INVALID_BODY');
      // Emitted since SS12000-närvaro, but only at a school that shares it.
      expect((await create({ name: 'x', target: receiver.url, resourceTypes: [{ resource: 'Absence' }] }).expect(403)).body.code).toBe('NOT_SHARED');
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
