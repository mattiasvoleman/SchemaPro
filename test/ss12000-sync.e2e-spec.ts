import { Logger } from '@nestjs/common';
import request from 'supertest';
import { clearTokenCache } from '../src/integration/ss12000-sync/client';
import { Ss12000SchedulerService } from '../src/integration/ss12000-sync/ss12000-scheduler.service';
import { Ss12000Outbound } from '../src/integration/ss12000-sync/ss12000-sync.providers';
import { Ss12000SyncService } from '../src/integration/ss12000-sync/ss12000-sync.service';
import type { ClientOptions } from '../src/integration/ss12000-sync/client';
import {
  MockSs12000Provider,
  isoDay,
  s1Adult,
  s1Duty,
  s1Group,
  s1Organisation,
  s1Pupil,
} from './utils/ss12000-mock-provider';
import { SyncWorld } from './utils/ss12000-sync-world';
import { asUser, createTestApp, type TestHarness } from './utils/test-app';
import { makeTestTls } from './utils/test-tls';

/**
 * The SS12000 consumer over HTTP: the admin's source, its write-only
 * credentials, "Testa anslutning", "Synka nu", the diff, the apply, the
 * provisioning list and the nightly tick — against a local TLS mock
 * provider (never a real IST or Edlevo host), with the school behind the
 * harness's Prisma mock (test/utils/ss12000-sync-world.ts). What Postgres
 * enforces under it is scripts/test/rls-policies.sql §30 and the adapter
 * probe's ss-* checks.
 */

const SCHOOL = '33333333-3333-4333-8333-333333333333';
const ADMIN = asUser({});
const ORG = 'aaaaaaaa-0000-4000-8000-000000000001';
const PUPIL = 'bbbbbbbb-0000-4000-8000-000000000001';
const PROTECTED = 'bbbbbbbb-0000-4000-8000-000000000002';
const GUARDIAN = 'cccccccc-0000-4000-8000-000000000001';
const TEACHER = 'dddddddd-0000-4000-8000-000000000001';
const CLASS = 'eeeeeeee-0000-4000-8000-000000000001';
const SECRET = 'the-real-client-secret-of-ist-0001';
const WRONG = 'a-wrong-secret-the-provider-echoes-0002';

const tls = makeTestTls();

class TestOutbound extends Ss12000Outbound {
  override clientOptions(): ClientOptions {
    return { policy: { allowLoopback: true, ca: tls.ca }, retryDelaysMs: [1, 1, 1], sleep: async () => undefined };
  }
}

function captureLogs(): { lines: string[]; restore: () => void } {
  const lines: string[] = [];
  const spies = (['log', 'warn', 'error', 'debug', 'verbose'] as const).map((level) =>
    jest.spyOn(Logger.prototype, level).mockImplementation((...args: unknown[]) => void lines.push(args.map(String).join(' '))),
  );
  return { lines, restore: () => spies.forEach((spy) => spy.mockRestore()) };
}

function world(): SyncWorld {
  const w = new SyncWorld(SCHOOL);
  w.years.push({ id: 'a0000000-0000-4000-8000-000000000001', schoolId: SCHOOL, startDate: new Date(`${isoDay(-120)}T00:00:00Z`), endDate: new Date(`${isoDay(240)}T00:00:00Z`), isActive: true });
  w.users.push({
    id: '22222222-2222-4222-8222-222222222222', schoolId: SCHOOL, role: 'SCHOOL_ADMIN', firstName: 'Ada', lastName: 'Admin', email: 'admin@skola.se',
    isActive: true, studentGroupId: null, ss12000Id: null, invitedAt: new Date(), updatedAt: new Date(),
  });
  return w;
}

function roster(provider: MockSs12000Provider): void {
  provider.world = {
    organisations: [s1Organisation(ORG, 'Ekskolan', '12345678')],
    persons: [
      s1Pupil(PUPIL, 'Ella', 'Ek', 'ella.ek@skola.se', ORG, { responsibles: [{ id: GUARDIAN }] }),
      s1Pupil(PROTECTED, 'Skyddad', 'Elev', 'skyddad@skola.se', ORG, { securityMarking: 'Skyddad folkbokföring' }),
      s1Adult(GUARDIAN, 'Gun', 'Ek', 'gun.ek@hem.se', 'Privat'),
      s1Adult(TEACHER, 'Tor', 'Lund', 'tor.lund@skola.se', 'Skola personal'),
    ],
    groups: [s1Group(CLASS, '7A', 'Klass', ORG, [PUPIL, PROTECTED])],
    duties: [s1Duty('ffffffff-0000-4000-8000-000000000001', TEACHER, ORG)],
    deleted: { persons: [], groups: [], duties: [] },
  };
}

describe('SS12000 sync (e2e)', () => {
  let harness: TestHarness;
  let provider: MockSs12000Provider;
  let w: SyncWorld;
  let logs: ReturnType<typeof captureLogs>;
  const responses: string[] = [];
  const http = () => request(harness.app.getHttpServer());
  const as = (user = ADMIN) => ({
    get: (url: string) => http().get(url).set('x-test-user', user).then(record),
    put: (url: string, body?: object) => http().put(url).set('x-test-user', user).send(body).then(record),
    post: (url: string, body?: object) => http().post(url).set('x-test-user', user).send(body).then(record),
    patch: (url: string, body?: object) => http().patch(url).set('x-test-user', user).send(body).then(record),
    delete: (url: string) => http().delete(url).set('x-test-user', user).then(record),
  });
  const record = (res: request.Response) => {
    responses.push(res.text ?? '');
    return res;
  };
  const sync = () => harness.app.get(Ss12000SyncService);
  const sourceBody = (patch: object = {}) => ({
    name: 'IST Ekskolan',
    baseUrl: provider.baseUrl,
    authKind: 'OAUTH2_CLIENT_CREDENTIALS',
    tokenUrl: provider.tokenUrl,
    clientId: 'schemapro',
    ...patch,
  });

  beforeAll(async () => {
    logs = captureLogs();
    harness = await createTestApp({ configure: (builder) => builder.overrideProvider(Ss12000Outbound).useValue(new TestOutbound()) });
    provider = new MockSs12000Provider(tls, { id: 'schemapro', secret: SECRET });
    await provider.start();
  });

  afterAll(async () => {
    await provider.stop();
    await harness.close();
    logs.restore();
  });

  beforeEach(() => {
    // Calls recorded by an earlier test are not this one's; implementations stay.
    jest.clearAllMocks();
    provider.requests.length = 0;
    clearTokenCache();
    w = world();
    w.install(harness.tx);
    roster(provider);
    provider.faults = {};
  });

  describe('the source and its credentials', () => {
    it('answers 404 before a source exists, then round-trips the configuration with no secret in it', async () => {
      expect((await as().get('/api/v1/ss12000-source')).body).toMatchObject({ status: 404, code: 'SS12000_SOURCE_NOT_FOUND' });
      const put = await as().put('/api/v1/ss12000-source', sourceBody());
      expect(put.status).toBe(200);
      expect(put.body).toMatchObject({ schoolId: SCHOOL, authKind: 'OAUTH2_CLIENT_CREDENTIALS', clientId: 'schemapro', secrets: {} });
      expect(put.body).not.toHaveProperty('schedulerClaimedAt');
      const secret = await as().put('/api/v1/ss12000-source/secrets/CLIENT_SECRET', { value: SECRET });
      expect(secret.status).toBe(200);
      expect(Object.keys(secret.body).sort()).toEqual(['kind', 'setAt']);
      const got = await as().get('/api/v1/ss12000-source');
      expect(got.body.secrets).toEqual({ CLIENT_SECRET: { setAt: expect.any(String) } });
      // Sealed: the stored row is not the secret.
      expect(w.secrets.get('CLIENT_SECRET')!.ciphertext.toString('utf8')).not.toContain(SECRET);
    });

    it.each([
      ['plain http', { baseUrl: 'http://api.ist.com/v2.0' }, 'SS12000_URL_INVALID'],
      ['credentials in the URL', { baseUrl: 'https://user:pw@api.ist.com/v2.0' }, 'SS12000_URL_INVALID'],
      ['a token URL with a query', { tokenUrl: 'https://skolid.se/connect/token?client_secret=x' }, 'SS12000_URL_INVALID'],
      ['OAuth2 without a token URL', { tokenUrl: null, clientId: null }, 'SS12000_CLIENT_INCOMPLETE'],
      ['a static token beside a client', { authKind: 'BEARER_TOKEN' }, 'SS12000_CLIENT_INCOMPLETE'],
    ])('refuses %s with a code', async (_label, patch, code) => {
      const res = await as().put('/api/v1/ss12000-source', sourceBody(patch));
      expect(res.status).toBe(400);
      expect(res.body.code).toBe(code);
      expect(w.sources).toHaveLength(0);
    });

    it('refuses a credential that is not what its kind says, without echoing it', async () => {
      await as().put('/api/v1/ss12000-source', sourceBody());
      const badKey = '-----BEGIN PRIVATE KEY-----\nTOPSECRETKEYMATERIAL\n-----END PRIVATE KEY-----';
      const res = await as().put('/api/v1/ss12000-source/secrets/CLIENT_KEY_PEM', { value: badKey });
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('SS12000_KEY_PEM_INVALID');
      expect(res.text).not.toContain('TOPSECRETKEYMATERIAL');
      expect((await as().put('/api/v1/ss12000-source/secrets/NOT_A_KIND', { value: 'x' })).status).toBe(400);
    });

    it('"Testa anslutning": a refused secret is a code, and what the provider echoed reaches no response, row or log', async () => {
      await as().put('/api/v1/ss12000-source', sourceBody());
      await as().put('/api/v1/ss12000-source/secrets/CLIENT_SECRET', { value: WRONG });
      const refused = await as().post('/api/v1/ss12000-source/test');
      expect(refused.status).toBe(200);
      expect(refused.body).toEqual({ ok: false, code: 'SS12000_TOKEN_REFUSED', tokenOk: false, organisations: [] });
      expect(w.source!['lastTestOutcome']).toBe('SS12000_TOKEN_REFUSED');

      await as().put('/api/v1/ss12000-source/secrets/CLIENT_SECRET', { value: SECRET });
      const ok = await as().post('/api/v1/ss12000-source/test');
      expect(ok.body).toEqual({
        ok: true,
        code: 'OK',
        tokenOk: true,
        organisations: [{ id: ORG, displayName: 'Ekskolan', schoolUnitCode: '12345678', organisationType: 'Skolenhet' }],
      });
      for (const text of [...responses, ...logs.lines, JSON.stringify(w.sources), JSON.stringify(w.runs)]) {
        expect(text).not.toContain(WRONG);
        expect(text).not.toContain(SECRET);
      }
    });

    it('clears a credential when the host it is bound to changes, and asks to confirm a relink once people are linked', async () => {
      await as().put('/api/v1/ss12000-source', sourceBody({ organisationIds: [ORG] }));
      await as().put('/api/v1/ss12000-source/secrets/CLIENT_SECRET', { value: SECRET });
      await as().put('/api/v1/ss12000-source/secrets/BEARER_TOKEN', { value: 'static-token-123' });
      w.users.push({ id: '10000001-0000-4000-8000-000000000000', schoolId: SCHOOL, role: 'STUDENT', ss12000Id: PUPIL, email: 'e@s.se', isActive: true });
      Object.assign(w.source!, { modifiedCursor: new Date(), deletedCursor: new Date(), lastFullAt: new Date() });

      const other = 'bbbbbbbb-9999-4000-8000-000000000000';
      const refused = await as().put('/api/v1/ss12000-source', sourceBody({ organisationIds: [other] }));
      expect(refused.status).toBe(409);
      expect(refused.body).toMatchObject({ code: 'SS12000_SOURCE_RELINK_REQUIRED', params: { linked: 1 } });
      expect(w.source!['organisationIds']).toEqual([ORG]);

      const moved = await as().put('/api/v1/ss12000-source', sourceBody({ organisationIds: [other], confirmRelink: true }));
      expect(moved.status).toBe(200);
      expect(w.source).toMatchObject({ organisationIds: [other], modifiedCursor: null, deletedCursor: null, lastFullAt: null });
      expect(w.secrets.has('CLIENT_SECRET')).toBe(true);

      // Another base host: the bearer bound to it goes; the token URL's secret stays.
      const elsewhere = await as().put(
        '/api/v1/ss12000-source',
        sourceBody({ organisationIds: [other], baseUrl: provider.baseUrl.replace('127.0.0.1', 'localhost'), confirmRelink: true }),
      );
      expect(elsewhere.status).toBe(200);
      expect([...w.secrets.keys()]).toEqual(['CLIENT_SECRET']);
      expect(elsewhere.body.secrets).toEqual({ CLIENT_SECRET: { setAt: expect.any(String) } });
    });

    it('turns the schedule on for the coming night, and never auto-applies without it', async () => {
      await as().put('/api/v1/ss12000-source', sourceBody());
      const lone = await as().patch('/api/v1/ss12000-source/schedule', { scheduleAutoApply: true });
      expect(lone.body).toMatchObject({ scheduleEnabled: false, scheduleAutoApply: false });
      const on = await as().patch('/api/v1/ss12000-source/schedule', { scheduleEnabled: true, scheduleAutoApply: true, scheduleHourLocal: 3, fullEveryDays: 7 });
      expect(on.body).toMatchObject({ scheduleEnabled: true, scheduleAutoApply: true, scheduleHourLocal: 3 });
      expect(w.source!['lastScheduledLocalDate']).toBeInstanceOf(Date);
      expect((await as().patch('/api/v1/ss12000-source/schedule', { scheduleHourLocal: 24 })).status).toBe(400);
    });
  });

  describe('a run, its diff and the apply', () => {
    const configured = async () => {
      await as().put('/api/v1/ss12000-source', sourceBody({ organisationIds: [ORG] }));
      await as().put('/api/v1/ss12000-source/secrets/CLIENT_SECRET', { value: SECRET });
    };
    const runOnce = async (mode: 'FULL' | 'INCREMENTAL' = 'FULL') => {
      const started = await as().post('/api/v1/ss12000-sync/runs', { mode });
      expect(started.status).toBe(202);
      await sync().whenIdle();
      return (await as().get(`/api/v1/ss12000-sync/runs/${started.body.runId}`)).body;
    };

    it('"Synka nu" answers 202, then a DIFF_READY run proposes the roster — and nothing has changed yet', async () => {
      await configured();
      const run = await runOnce();
      expect(run).toMatchObject({ status: 'DIFF_READY', trigger: 'MANUAL', mode: 'FULL', basisHash: expect.stringMatching(/^[0-9a-f]{64}$/) });
      expect(run.counts.fetch.requests).toBeGreaterThan(0);
      const changes = (await as().get(`/api/v1/ss12000-sync/runs/${run.id}/changes`)).body.data as Array<Record<string, unknown>>;
      const ops = changes.map((c) => `${c['entity']}:${c['op']}:${c['externalId']}`);
      expect(ops).toEqual(
        expect.arrayContaining([
          `PERSON:CREATE:${PUPIL}`,
          `PERSON:CREATE:${GUARDIAN}`,
          `PERSON:CREATE:${TEACHER}`,
          `PERSON:CREATE:${PROTECTED}`,
          `GROUP:CREATE:${CLASS}`,
          `CLASS_MEMBERSHIP:MOVE:${PUPIL}`,
          `RESPONSIBLE:ADD:${PUPIL}`,
          'DUTY_LINK:ADD:ffffffff-0000-4000-8000-000000000001',
        ]),
      );
      const protectedCreate = changes.find((c) => c['externalId'] === PROTECTED && c['op'] === 'CREATE')!;
      expect(protectedCreate).toMatchObject({ selected: false, autoApplicable: false, protectedIdentity: true });
      // Nothing written to the school, and nothing of what the source sent beyond what a diff needs.
      expect(harness.tx.user.createMany).not.toHaveBeenCalled();
      const stored = JSON.stringify(w.changes);
      for (const leaked of ['201001012384', '198001012381', 'Hemliga vägen', '070-0000000', 'Skyddad folkbokföring', 'dutyPercent', '1440']) {
        expect(stored).not.toContain(leaked);
      }
      expect(w.source!['schoolUnitCodes']).toEqual(['12345678']);
    });

    it('applies the selected changes in one transaction: catalogue rows, no identity, no mail; cursors move', async () => {
      await configured();
      const run = await runOnce();
      expect((await as().post(`/api/v1/ss12000-sync/runs/${run.id}/apply`, { basisHash: 'f'.repeat(64) })).body.code).toBe('SS12000_DIFF_STALE');

      const applied = await as().post(`/api/v1/ss12000-sync/runs/${run.id}/apply`, { basisHash: run.basisHash });
      expect(applied.status).toBe(200);
      expect(applied.body).toMatchObject({ status: 'APPLIED', appliedById: '22222222-2222-4222-8222-222222222222', autoApplied: false });
      const created = w.users.filter((u) => u['ss12000Id']);
      expect(created.map((u) => u['ss12000Id']).sort()).toEqual([GUARDIAN, PUPIL, TEACHER].sort());
      for (const person of created) {
        expect(person).toMatchObject({ invitedAt: null, schoolId: SCHOOL });
        expect(person['authId']).not.toBe(person['id']);
      }
      expect(harness.supabase.inviteUser).not.toHaveBeenCalled();
      // The protected pupil stayed out: deselected by default.
      expect(created.some((u) => u['ss12000Id'] === PROTECTED)).toBe(false);
      expect(w.source).toMatchObject({ modifiedCursor: run.cursorTo ? new Date(run.cursorTo) : expect.any(Date), lastAppliedAt: expect.any(Date) });
      expect(w.links).toEqual([expect.objectContaining({ origin: 'SS12000' })]);
      expect(w.rawStatements.some((sql) => sql.includes(`"studentGroupId" = v.group_id`) && sql.includes(`u."role" = 'STUDENT'`))).toBe(true);

      expect((await as().post(`/api/v1/ss12000-sync/runs/${run.id}/apply`, { basisHash: run.basisHash })).body).toMatchObject({
        status: 409,
        code: 'SS12000_RUN_NOT_APPLICABLE',
      });
      const provisioning = await as().get('/api/v1/ss12000-sync/provisioning');
      expect(provisioning.body.map((u: { email: string }) => u.email).sort()).toEqual(['ella.ek@skola.se', 'gun.ek@hem.se', 'tor.lund@skola.se']);
    });

    it('applies an admin\'s explicit choice: a deselected change stays out, a selected one goes in', async () => {
      await configured();
      const run = await runOnce();
      const changes = (await as().get(`/api/v1/ss12000-sync/runs/${run.id}/changes?op=CREATE`)).body.data as Array<{ id: string; externalId: string }>;
      const teacher = changes.find((c) => c.externalId === TEACHER)!;
      const protectedPupil = changes.find((c) => c.externalId === PROTECTED)!;
      await as().post(`/api/v1/ss12000-sync/runs/${run.id}/apply`, { basisHash: run.basisHash, deselect: [teacher.id], select: [protectedPupil.id] });
      const created = w.users.filter((u) => u['ss12000Id']).map((u) => u['ss12000Id']);
      expect(created).toContain(PROTECTED);
      expect(created).not.toContain(TEACHER);
      expect(w.changes.find((c) => c['id'] === teacher.id)).toMatchObject({ selected: false, applied: false });
    });

    it('records a failed fetch as FETCH_FAILED with its code, writes no diff and moves no cursor', async () => {
      await configured();
      provider.faults.serverError = true;
      const run = await runOnce();
      expect(run).toMatchObject({ status: 'FETCH_FAILED', statusCode: 'SS12000_HTTP_500' });
      expect(w.changes).toHaveLength(0);
      expect(w.source).toMatchObject({ modifiedCursor: null, deletedCursor: null });
    });

    it('produces no diff from a FULL fetch that comes back without pupils while linked ones exist', async () => {
      await configured();
      w.users.push({ id: '10000001-0000-4000-8000-000000000000', schoolId: SCHOOL, role: 'STUDENT', firstName: 'A', lastName: 'B', email: 'a@b.se', ss12000Id: PUPIL, isActive: true });
      provider.faults.emptyPersons = true;
      const run = await runOnce();
      expect(run).toMatchObject({ status: 'FETCH_FAILED', statusCode: 'SS12000_SOURCE_EMPTY' });
      expect(w.changes).toHaveLength(0);
    });

    it('calls a run with nothing but notes NO_CHANGES and moves the cursors, keeping the note without its payload', async () => {
      await configured();
      provider.world.persons = [s1Pupil(PUPIL, 'Ny', 'Elev', 'ny@skola.se', ORG, { startDate: isoDay(30) })];
      provider.world.groups = [];
      provider.world.duties = [];
      const run = await runOnce();
      expect(run).toMatchObject({ status: 'NO_CHANGES' });
      expect(w.changes).toEqual([expect.objectContaining({ op: 'INFO', conflictCode: 'PERSON_NOT_YET_ENROLLED', externalId: PUPIL })]);
      expect(w.source!['modifiedCursor']).toBeInstanceOf(Date);
    });

    it('refuses a second "Synka nu" while one runs, and a run without a chosen skolenhet', async () => {
      await configured();
      w.runs.push({ id: '99999999-0000-4000-8000-000000000001', schoolId: SCHOOL, sourceId: w.source!['id'], status: 'RUNNING', trigger: 'MANUAL', mode: 'FULL', startedAt: new Date() });
      expect((await as().post('/api/v1/ss12000-sync/runs', { mode: 'FULL' })).body).toMatchObject({ status: 409, code: 'SS12000_RUN_IN_PROGRESS' });
      w.runs.length = 0;
      w.source!['organisationIds'] = [];
      expect((await as().post('/api/v1/ss12000-sync/runs', { mode: 'FULL' })).body).toMatchObject({ status: 409, code: 'SS12000_SOURCE_NO_ORGANISATION' });
    });

    it('brakes a mass deactivation until the admin confirms it', async () => {
      await configured();
      for (let i = 0; i < 8; i++) {
        w.users.push({
          id: `10000${String(i).padStart(3, '0')}-0000-4000-8000-000000000000`, schoolId: SCHOOL, role: 'STUDENT', firstName: 'Gammal', lastName: String(i),
          email: `gammal${i}@skola.se`, ss12000Id: `bbbbbbbb-1111-4000-8000-00000000000${i}`, isActive: true, updatedAt: new Date(0),
        });
      }
      const run = await runOnce();
      expect(w.changes.filter((c) => c['op'] === 'DEACTIVATE')).toHaveLength(8);
      const refused = await as().post(`/api/v1/ss12000-sync/runs/${run.id}/apply`, { basisHash: run.basisHash });
      expect(refused.body).toMatchObject({ status: 409, code: 'SS12000_MASS_DEACTIVATION', params: { deactivations: 8, limit: 5 } });
      expect(w.rawStatements.some((sql) => sql.includes('SET "isActive" = false'))).toBe(false);
      const confirmed = await as().post(`/api/v1/ss12000-sync/runs/${run.id}/apply`, { basisHash: run.basisHash, confirmMassDeactivation: true });
      expect(confirmed.body.status).toBe('APPLIED');
      expect(w.rawStatements.some((sql) => sql.includes('SET "isActive" = false') && sql.includes(`"role" <> 'SCHOOL_ADMIN'`))).toBe(true);
    });

    it('discards a diff, and pages the history newest first', async () => {
      await configured();
      const run = await runOnce();
      expect((await as().post(`/api/v1/ss12000-sync/runs/${run.id}/discard`)).body.status).toBe('DISCARDED');
      expect((await as().post(`/api/v1/ss12000-sync/runs/${run.id}/discard`)).body.code).toBe('SS12000_RUN_NOT_APPLICABLE');
      const history = await as().get('/api/v1/ss12000-sync/runs?limit=5');
      expect(history.body.map((r: { id: string }) => r.id)).toEqual([run.id]);
      expect((await as().get('/api/v1/ss12000-sync/runs?limit=0')).status).toBe(400);
      expect((await as().get(`/api/v1/ss12000-sync/runs/${run.id}/changes?entity=NOPE`)).status).toBe(400);
    });
  });

  describe('the nightly run', () => {
    const scheduled = async (autoApply: boolean) => {
      await as().put('/api/v1/ss12000-source', sourceBody({ organisationIds: [ORG] }));
      await as().put('/api/v1/ss12000-source/secrets/CLIENT_SECRET', { value: SECRET });
      await as().patch('/api/v1/ss12000-source/schedule', { scheduleEnabled: true, scheduleAutoApply: autoApply });
      w.due = [{ source_id: w.source!['id'] as string, school_id: SCHOOL, full_due: true }];
    };

    it('auto-applies only the safe changes: names, never a create, never a staff deactivation', async () => {
      await scheduled(true);
      const groupId = '20000001-0000-4000-8000-000000000000';
      w.groups.push({ id: groupId, schoolId: SCHOOL, academicYearId: 'a0000000-0000-4000-8000-000000000001', name: '7A', kind: 'CLASS', gradeLevel: 7, ss12000Id: CLASS, updatedAt: new Date(0) });
      w.users.push(
        { id: '10000001-0000-4000-8000-000000000000', schoolId: SCHOOL, role: 'STUDENT', firstName: 'Elle', lastName: 'Ek', email: 'ella.ek@skola.se', ss12000Id: PUPIL, isActive: true, studentGroupId: groupId, invitedAt: null, updatedAt: new Date(0) },
        { id: '10000002-0000-4000-8000-000000000000', schoolId: SCHOOL, role: 'TEACHER', firstName: 'Gone', lastName: 'Teacher', email: 'gone@skola.se', ss12000Id: 'dddddddd-9999-4000-8000-000000000000', isActive: true, studentGroupId: null, invitedAt: null, updatedAt: new Date(0) },
      );
      await harness.app.get(Ss12000SchedulerService).tick();
      const run = w.runs.find((r) => r['trigger'] === 'SCHEDULED')!;
      expect(run).toMatchObject({ status: 'DIFF_READY', autoApplied: true });
      const applied = w.changes.filter((c) => c['applied']);
      expect(applied.map((c) => `${c['entity']}:${c['op']}`)).toEqual(['PERSON:UPDATE']);
      expect(w.changes.find((c) => c['op'] === 'DEACTIVATE')).toMatchObject({ applied: false, autoApplicable: false, localId: '10000002-0000-4000-8000-000000000000' });
      expect(harness.tx.user.createMany).not.toHaveBeenCalled();
      expect(w.rawStatements.some((sql) => sql.includes('SET "isActive" = false'))).toBe(false);
      // The cursors wait for the admin's part; the rows the sync wrote are not "local edits".
      expect(w.source).toMatchObject({ modifiedCursor: null, lastAppliedAt: expect.any(Date) });
    });

    it('waits with a diff when auto-apply is off', async () => {
      await scheduled(false);
      await harness.app.get(Ss12000SchedulerService).tick();
      expect(w.runs).toEqual([expect.objectContaining({ trigger: 'SCHEDULED', status: 'DIFF_READY', autoApplied: false })]);
      expect(w.changes.some((c) => c['applied'])).toBe(false);
    });

    it('records SKIPPED (REVIEW_PENDING) rather than supersede a manual diff an admin is reviewing', async () => {
      await scheduled(true);
      w.runs.push({ id: '99999999-0000-4000-8000-000000000002', schoolId: SCHOOL, sourceId: w.source!['id'], status: 'DIFF_READY', trigger: 'MANUAL', mode: 'FULL', startedAt: new Date() });
      await harness.app.get(Ss12000SchedulerService).tick();
      expect(w.runs.map((r) => [r['trigger'], r['status'], r['statusCode'] ?? null])).toEqual([
        ['MANUAL', 'DIFF_READY', null],
        ['SCHEDULED', 'SKIPPED', 'REVIEW_PENDING'],
      ]);
      expect(provider.dataRequests()).toHaveLength(0);
    });
  });

  it('never let a credential out: no response and no log line of this file carried one', () => {
    expect(responses.length).toBeGreaterThan(20);
    for (const text of [...responses, ...logs.lines]) {
      expect(text).not.toContain(SECRET);
      expect(text).not.toContain(WRONG);
      expect(text).not.toContain('static-token-123');
    }
  });

  describe('who may', () => {
    const routes: Array<[string, string, object?]> = [
      ['get', '/api/v1/ss12000-source'],
      ['put', '/api/v1/ss12000-source', {}],
      ['put', '/api/v1/ss12000-source/secrets/CLIENT_SECRET', { value: 'x' }],
      ['delete', '/api/v1/ss12000-source/secrets/CLIENT_SECRET'],
      ['post', '/api/v1/ss12000-source/test'],
      ['patch', '/api/v1/ss12000-source/schedule', {}],
      ['post', '/api/v1/ss12000-sync/runs', { mode: 'FULL' }],
      ['get', '/api/v1/ss12000-sync/runs'],
      ['get', '/api/v1/ss12000-sync/runs/99999999-0000-4000-8000-000000000001'],
      ['get', '/api/v1/ss12000-sync/runs/99999999-0000-4000-8000-000000000001/changes'],
      ['post', '/api/v1/ss12000-sync/runs/99999999-0000-4000-8000-000000000001/apply', { basisHash: 'f'.repeat(64) }],
      ['post', '/api/v1/ss12000-sync/runs/99999999-0000-4000-8000-000000000001/discard'],
      ['get', '/api/v1/ss12000-sync/provisioning'],
    ];

    it.each(['TEACHER', 'STUDENT', 'GUARDIAN'])('refuses a %s on every route with 403, touching nothing', async (role) => {
      for (const [method, url, body] of routes) {
        const res = await (http() as unknown as Record<string, (u: string) => request.Test>)[method]!(url).set('x-test-user', asUser({ role: role as never })).send(body);
        expect([method, url, res.status]).toEqual([method, url, 403]);
      }
      expect(w.sources).toHaveLength(0);
      expect(w.runs).toHaveLength(0);
    });

    it('refuses an integration key (these are JWT routes) and no principal at all with 401', async () => {
      for (const [method, url, body] of routes) {
        const res = await (http() as unknown as Record<string, (u: string) => request.Test>)[method]!(url).set('x-api-key', 'sp_0123456789abcdef').send(body);
        expect([method, url, res.status]).toEqual([method, url, 401]);
      }
    });
  });
});
