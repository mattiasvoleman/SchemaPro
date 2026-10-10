/**
 * The adapter probe's checks for the SS12000 consumer (20261014090000–
 * 20261014110000), against real Postgres as CI runs it and a local TLS mock
 * provider (never a real IST or Edlevo host): the admin's source and sealed
 * credential (ss-a), a FULL run's diff written by the sync principal and
 * nothing else changed (ss-b), the admin's apply in one transaction —
 * catalogue rows with no identity, a link by email, a class with its P4
 * segment, a guardian link, a duty link, cursors, the diff minimised —
 * (ss-c), the same roster again is NO_CHANGES (ss-d), the nightly
 * auto-apply under the sync principal's guards: a rename and a class move
 * yes, a create and a teacher's deactivation never (ss-e), the admin's rest
 * and the reactivation rule (ss-f), a stale basis refused (ss-g), and no
 * credential in any table but the sealed one, or in a log line (ss-h). In a
 * school of its own (slug <marker>-ss12000), swept whole before and after.
 *
 * Imported by prisma-adapter-probe.ts, which hands in its `check`.
 */
import { strict as assert } from 'node:assert';
import { ConsoleLogger, Logger } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import type { Client } from 'pg';
import { Role } from '../../src/auth/enums/role.enum';
import type { AuthenticatedUser } from '../../src/auth/interfaces/authenticated-user.interface';
import type { PrismaService } from '../../src/database/prisma.service';
import { clearTokenCache, type ClientOptions } from '../../src/integration/ss12000-sync/client';
import { Ss12000SourceService } from '../../src/integration/ss12000-sync/ss12000-source.service';
import { Ss12000Outbound, Ss12000Secrets } from '../../src/integration/ss12000-sync/ss12000-sync.providers';
import { Ss12000SyncService } from '../../src/integration/ss12000-sync/ss12000-sync.service';
import {
  MockSs12000Provider,
  isoDay,
  s1Adult,
  s1Duty,
  s1Group,
  s1Organisation,
  s1Pupil,
} from '../../test/utils/ss12000-mock-provider';
import { makeTestTls } from '../../test/utils/test-tls';

type Check = (label: string, body: () => Promise<void>) => Promise<void>;

const ORG = 'aaaaaaaa-5500-4000-8000-000000000001';
const P1 = 'bbbbbbbb-5500-4000-8000-000000000001';
const P2 = 'bbbbbbbb-5500-4000-8000-000000000002';
const P3 = 'bbbbbbbb-5500-4000-8000-000000000003';
const G1 = 'cccccccc-5500-4000-8000-000000000001';
const T1 = 'dddddddd-5500-4000-8000-000000000001';
const T2 = 'dddddddd-5500-4000-8000-000000000002';
const C7A = 'eeeeeeee-5500-4000-8000-00000000007a';
const C7B = 'eeeeeeee-5500-4000-8000-00000000007b';
const TG = 'eeeeeeee-5500-4000-8000-0000000000aa';
const D1 = 'ffffffff-5500-4000-8000-000000000001';
const D2 = 'ffffffff-5500-4000-8000-000000000002';
const SECRET = 'probe-client-secret-never-in-a-row-0001';

export function ss12000Slug(marker: string): string {
  return `${marker}-ss12000`;
}

export async function sweepSs12000School(owner: Client, marker: string): Promise<void> {
  await owner.query(`DELETE FROM "Schools" WHERE slug = $1`, [ss12000Slug(marker)]);
}

class ProbeOutbound extends Ss12000Outbound {
  constructor(private readonly ca: string) {
    super();
  }
  override clientOptions(): ClientOptions {
    return { policy: { allowLoopback: true, ca: this.ca }, retryDelaysMs: [1, 1, 1], sleep: async () => undefined };
  }
}

export async function ss12000SyncChecks(owner: Client, api: PrismaService, marker: string, check: Check): Promise<void> {
  await sweepSs12000School(owner, marker);
  const one = async <T extends object>(sql: string, params: unknown[] = []): Promise<T> => (await owner.query<T>(sql, params)).rows[0]!;
  const all = async <T extends object>(sql: string, params: unknown[] = []): Promise<T[]> => (await owner.query<T>(sql, params)).rows;

  const school = await one<{ id: string }>(
    `INSERT INTO "Schools" (name, slug, timezone, "updatedAt") VALUES ($1, $2, 'Europe/Stockholm', now()) RETURNING id`,
    [`${marker} ss12000`, ss12000Slug(marker)],
  );
  const year = await one<{ id: string }>(
    `INSERT INTO "AcademicYears" ("schoolId", name, "startDate", "endDate", "isActive", "updatedAt")
     VALUES ($1, $2, $3::date, $4::date, true, now()) RETURNING id`,
    [school.id, `${marker} ss12000`, isoDay(-120), isoDay(240)],
  );
  const person = (role: string, email: string, first: string, last: string) =>
    one<{ id: string; authId: string }>(
      `INSERT INTO "Users" ("schoolId", email, "firstName", "lastName", role, "authId", "isActive", "invitedAt", "updatedAt")
       VALUES ($1, $2, $3, $4, $5::"UserRole", gen_random_uuid(), true, now(), now() - interval '1 day') RETURNING id, "authId"`,
      [school.id, email, first, last, role],
    );
  const adminRow = await person('SCHOOL_ADMIN', `${marker}-ss-admin@example.invalid`, 'Probe', 'Admin');
  // A teacher already in the catalogue, by the address the source gives: a LINK, not a create.
  const teacherRow = await person('TEACHER', 'tor.lund@ekskolan.example', 'Tor', 'Lund');
  const admin: AuthenticatedUser = { authId: adminRow.authId, userId: adminRow.id, schoolId: school.id, role: Role.SCHOOL_ADMIN };

  const tls = makeTestTls();
  const provider = new MockSs12000Provider(tls, { id: 'probe', secret: SECRET });
  await provider.start();
  const lines: string[] = [];
  Logger.overrideLogger({
    log: (m: unknown) => void lines.push(String(m)),
    warn: (m: unknown) => void lines.push(String(m)),
    error: (m: unknown) => void lines.push(String(m)),
    debug: (m: unknown) => void lines.push(String(m)),
    verbose: (m: unknown) => void lines.push(String(m)),
  });
  const config = { get: () => ({ secretsKey: Buffer.alloc(32, 5), background: false, allowInsecureLocal: true }) } as unknown as ConfigService;
  const secrets = new Ss12000Secrets(config);
  const outbound = new ProbeOutbound(tls.ca);
  const sources = new Ss12000SourceService(api, secrets, outbound);
  const sync = new Ss12000SyncService(api, secrets, outbound);
  clearTokenCache();

  provider.world = {
    organisations: [s1Organisation(ORG, `${marker} ss12000`, '55000001')],
    persons: [
      s1Pupil(P1, 'Ella', 'Ek', 'ella.ek@ekskolan.example', ORG, { responsibles: [{ id: G1 }] }),
      s1Pupil(P2, 'Olle', 'Ek', 'olle.ek@ekskolan.example', ORG),
      s1Adult(G1, 'Gun', 'Ek', 'gun.ek@hem.example', 'Privat'),
      s1Adult(T1, 'Tor', 'Lund', 'tor.lund@ekskolan.example', 'Skola personal'),
      s1Adult(T2, 'Tea', 'Berg', 'tea.berg@ekskolan.example', 'Skola personal'),
    ],
    groups: [s1Group(C7A, '7A', 'Klass', ORG, [P1, P2]), s1Group(C7B, '7B', 'Klass', ORG, []), s1Group(TG, 'Spanska 7', 'Undervisning', ORG, [P1])],
    duties: [s1Duty(D1, T1, ORG), s1Duty(D2, T2, ORG)],
    deleted: { persons: [], groups: [], duties: [] },
  };
  const latestRun = () =>
    one<{ id: string; status: string; statusCode: string | null; basisHash: string; autoApplied: boolean; trigger: string }>(
      `SELECT id, status::text, "statusCode", "basisHash", "autoApplied", trigger::text FROM "Ss12000SyncRuns" WHERE "schoolId" = $1 ORDER BY "startedAt" DESC LIMIT 1`,
      [school.id],
    );
  const manualRun = async (mode: 'FULL' | 'INCREMENTAL' = 'FULL') => {
    await sync.startManualRun(admin, mode);
    await sync.whenIdle();
    return latestRun();
  };
  const userByExt = (ext: string) =>
    one<{ id: string; firstName: string; isActive: boolean; studentGroupId: string | null; invitedAt: Date | null; authId: string; role: string }>(
      `SELECT id, "firstName", "isActive", "studentGroupId", "invitedAt", "authId", role::text FROM "Users" WHERE "schoolId" = $1 AND "ss12000Id" = $2`,
      [school.id, ext],
    );
  const groupByExt = (ext: string) => one<{ id: string; name: string }>(`SELECT id, name FROM "StudentGroups" WHERE "schoolId" = $1 AND "ss12000Id" = $2`, [school.id, ext]);

  try {
    await check('(ss-a) the admin configures the source; the credential is sealed, bound and only presence comes back', async () => {
      await sources.put(admin, { name: 'IST probe', baseUrl: provider.baseUrl, authKind: 'OAUTH2_CLIENT_CREDENTIALS', tokenUrl: provider.tokenUrl, clientId: 'probe' });
      const set = await sources.putSecret(admin, 'CLIENT_SECRET', SECRET);
      assert.deepEqual(Object.keys(set).sort(), ['kind', 'setAt']);
      const row = await one<{ ciphertext: Buffer; iv: Buffer; authTag: Buffer; keyId: string }>(
        `SELECT ciphertext, iv, "authTag", "keyId" FROM "Ss12000SourceSecrets" WHERE "schoolId" = $1`,
        [school.id],
      );
      assert.equal(row.iv.length, 12);
      assert.equal(row.authTag.length, 16);
      assert.ok(!row.ciphertext.toString('utf8').includes(SECRET), 'the stored credential is the plaintext');
      const view = await sources.get(admin);
      assert.deepEqual(Object.keys(view.secrets), ['CLIENT_SECRET']);
      assert.ok(!JSON.stringify(view).includes(SECRET));
      const tested = await sources.test(admin);
      assert.equal(tested.code, 'OK');
      assert.deepEqual(tested.organisations.map((o) => o.id), [ORG]);
      await sources.put(admin, { name: 'IST probe', baseUrl: provider.baseUrl, authKind: 'OAUTH2_CLIENT_CREDENTIALS', tokenUrl: provider.tokenUrl, clientId: 'probe', organisationIds: [ORG] });
    });

    await check('(ss-b) a FULL run writes a diff under the sync principal and changes nothing in the school', async () => {
      const before = await one<{ n: number }>(`SELECT count(*)::int AS n FROM "Users" WHERE "schoolId" = $1`, [school.id]);
      const run = await manualRun();
      assert.equal(run.status, 'DIFF_READY', `the run ended ${run.status} ${run.statusCode ?? ''}`);
      assert.match(run.basisHash, /^[0-9a-f]{64}$/);
      const ops = await all<{ k: string }>(
        `SELECT entity::text || ':' || op::text || ':' || coalesce("externalId"::text, '') AS k FROM "Ss12000SyncChanges" WHERE "runId" = $1 ORDER BY seq`,
        [run.id],
      );
      const keys = ops.map((o) => o.k);
      for (const expected of [`PERSON:CREATE:${P1}`, `PERSON:CREATE:${G1}`, `PERSON:LINK:${T1}`, `PERSON:CREATE:${T2}`, `GROUP:CREATE:${C7A}`, `CLASS_MEMBERSHIP:MOVE:${P1}`, `GROUP_MEMBERSHIP:ADD:${P1}`, `RESPONSIBLE:ADD:${P1}`, `DUTY_LINK:ADD:${D1}`]) {
        assert.ok(keys.includes(expected), `the diff lacks ${expected}: ${keys.join(' ')}`);
      }
      const after = await one<{ n: number }>(`SELECT count(*)::int AS n FROM "Users" WHERE "schoolId" = $1`, [school.id]);
      assert.equal(after.n, before.n, 'a run wrote users before any apply');
      const leaked = await one<{ n: number }>(
        `SELECT count(*)::int AS n FROM "Ss12000SyncChanges" WHERE "runId" = $1 AND ("before"::text || "after"::text) ~ '201001012384|Hemliga|070-0000000|dutyPercent'`,
        [run.id],
      );
      assert.equal(leaked.n, 0, 'a civicNo, address, phone or HR figure reached the diff');
    });

    await check('(ss-c) the admin applies in one transaction: catalogue rows, a link, a class with its history, cursors; the diff minimised', async () => {
      const run = await latestRun();
      const applied = await sync.apply(admin, run.id, { basisHash: run.basisHash });
      assert.equal(applied.status, 'APPLIED');
      const ella = await userByExt(P1);
      assert.equal(ella.invitedAt, null, 'a created person was invited');
      assert.equal(ella.role, 'STUDENT');
      const c7a = await groupByExt(C7A);
      assert.equal(ella.studentGroupId, c7a.id, 'the pupil was not moved into the class created beside her');
      const segment = await one<{ n: number }>(
        `SELECT count(*)::int AS n FROM "StudentEnrollments" WHERE "studentId" = $1 AND "studentGroupId" = $2 AND "validTo" IS NULL`,
        [ella.id, c7a.id],
      );
      assert.equal(segment.n, 1, 'P4 recorded no open segment for the move');
      const tor = await userByExt(T1);
      assert.equal(tor.id, teacherRow.id, 'the catalogue teacher was not linked by email');
      const link = await one<{ origin: string }>(`SELECT origin::text FROM "GuardianStudents" WHERE "studentId" = $1`, [ella.id]);
      assert.equal(link.origin, 'SS12000');
      const member = await one<{ n: number }>(`SELECT count(*)::int AS n FROM "StudentGroupMembers" WHERE "studentId" = $1`, [ella.id]);
      assert.equal(member.n, 1);
      const duty = await one<{ n: number }>(
        `SELECT count(*)::int AS n FROM "Ss12000DutyLinks" WHERE "schoolId" = $1 AND "ss12000DutyId" = $2 AND "academicYearId" = $3`,
        [school.id, D1, year.id],
      );
      assert.equal(duty.n, 1);
      const payloads = await one<{ n: number }>(
        `SELECT count(*)::int AS n FROM "Ss12000SyncChanges" WHERE "runId" = $1 AND ("before" IS NOT NULL OR "after" IS NOT NULL)`,
        [run.id],
      );
      assert.equal(payloads.n, 0, 'an applied run kept names and emails');
      const source = await one<{ modifiedCursor: Date | null; lastAppliedAt: Date | null }>(
        `SELECT "modifiedCursor", "lastAppliedAt" FROM "Ss12000Sources" WHERE "schoolId" = $1`,
        [school.id],
      );
      assert.ok(source.modifiedCursor && source.lastAppliedAt, 'the cursors did not move with the apply');
      // Identity safety: the created rows have placeholder identities.
      const placeholders = await one<{ n: number }>(
        `SELECT count(*)::int AS n FROM "Users" WHERE "schoolId" = $1 AND "ss12000Id" IS NOT NULL AND "invitedAt" IS NULL`,
        [school.id],
      );
      assert.ok(placeholders.n >= 3);
      const provisioning = await sync.provisioning(admin);
      assert.ok(provisioning.some((u) => u.email === 'ella.ek@ekskolan.example'));
      assert.ok(!provisioning.some((u) => u.id === teacherRow.id), 'an invited teacher is on the provisioning list');
    });

    await check('(ss-d) the same roster again is NO_CHANGES: the apply is idempotent', async () => {
      const run = await manualRun('FULL');
      assert.equal(run.status, 'NO_CHANGES', `the second run is ${run.status} ${run.statusCode ?? ''}`);
    });

    await check('(ss-e) the nightly auto-apply renames and moves under the sync principal, and never creates or deactivates staff', async () => {
      await sources.patchSchedule(admin, { scheduleEnabled: true, scheduleAutoApply: true });
      const source = await one<{ id: string }>(`SELECT id FROM "Ss12000Sources" WHERE "schoolId" = $1`, [school.id]);
      provider.world.persons[0] = s1Pupil(P1, 'Elin', 'Ek', 'ella.ek@ekskolan.example', ORG, { responsibles: [{ id: G1 }] });
      provider.world.persons.push(s1Pupil(P3, 'Ny', 'Elev', 'ny.elev@ekskolan.example', ORG));
      provider.world.groups[0] = s1Group(C7A, '7A', 'Klass', ORG, [P2]);
      provider.world.groups[1] = s1Group(C7B, '7B', 'Klass', ORG, [P1, P3]);
      provider.world.duties = [s1Duty(D1, T1, ORG)];
      const c7aBefore = await groupByExt(C7A);
      const runId = await sync.startScheduledRun(source.id, school.id, true);
      assert.ok(runId, 'the scheduled run did not start');
      const run = await latestRun();
      assert.equal(run.trigger, 'SCHEDULED');
      assert.equal(run.status, 'DIFF_READY', 'the create and the staff deactivation should still wait for the admin');
      assert.equal(run.autoApplied, true);
      const ella = await userByExt(P1);
      assert.equal(ella.firstName, 'Elin', 'the rename was not auto-applied');
      // 7B was linked by the first apply, so the move is the sync's to make — through P4.
      const c7b = await groupByExt(C7B);
      assert.notEqual(c7b.id, c7aBefore.id);
      assert.equal(ella.studentGroupId, c7b.id, 'the class move was not auto-applied');
      const open = await one<{ g: string }>(`SELECT "studentGroupId" AS g FROM "StudentEnrollments" WHERE "studentId" = $1 AND "validTo" IS NULL`, [ella.id]);
      assert.equal(open.g, c7b.id, 'P4 did not follow the sync\'s move');
      const tea = await userByExt(T2);
      assert.equal(tea.isActive, true, 'the nightly run deactivated a teacher');
      const ny = await owner.query(`SELECT 1 FROM "Users" WHERE "schoolId" = $1 AND "ss12000Id" = $2`, [school.id, P3]);
      assert.equal(ny.rowCount, 0, 'the nightly run created a person');
    });

    await check('(ss-f) the admin applies the rest; a sync deactivation is reactivated by a sync, an admin\'s is not', async () => {
      const run = await latestRun();
      await sync.apply(admin, run.id, { basisHash: run.basisHash });
      const ella = await userByExt(P1);
      const c7b = await groupByExt(C7B);
      assert.equal(ella.studentGroupId, c7b.id);
      const segments = await one<{ n: number }>(`SELECT count(*)::int AS n FROM "StudentEnrollments" WHERE "studentId" = $1`, [ella.id]);
      assert.ok(segments.n >= 1);
      const tea = await userByExt(T2);
      assert.equal(tea.isActive, false, 'the admin\'s apply did not deactivate the teacher who left');

      // Tea returns at the source: her deactivation was the sync's, so REACTIVATE is proposed.
      provider.world.duties.push(s1Duty(D2, T2, ORG));
      // Olle is deactivated by the admin by hand, and the source still lists him.
      const olle = await userByExt(P2);
      await api.withRls(admin, (tx) => tx.user.update({ where: { id: olle.id }, data: { isActive: false } }));
      const next = await manualRun('FULL');
      assert.equal(next.status, 'DIFF_READY');
      const notes = await all<{ k: string }>(
        `SELECT op::text || ':' || coalesce("conflictCode", '') || ':' || "localId"::text AS k FROM "Ss12000SyncChanges" WHERE "runId" = $1`,
        [next.id],
      );
      const keys = notes.map((n) => n.k);
      assert.ok(keys.includes(`REACTIVATE::${tea.id}`), `no REACTIVATE for the sync's deactivation: ${keys.join(' ')}`);
      assert.ok(keys.includes(`CONFLICT:PERSON_DEACTIVATED_LOCALLY:${olle.id}`), `the admin's deactivation was not left alone: ${keys.join(' ')}`);
    });

    await check('(ss-g) a diff the school changed underneath is refused whole (SS12000_DIFF_STALE)', async () => {
      const run = await latestRun();
      const ella = await userByExt(P1);
      await api.withRls(admin, (tx) => tx.user.update({ where: { id: ella.id }, data: { lastName: 'Ändrad' } }));
      await assert.rejects(sync.apply(admin, run.id, { basisHash: run.basisHash }), (error: unknown) => {
        const body = (error as { getResponse?: () => { code?: string } }).getResponse?.();
        return body?.code === 'SS12000_DIFF_STALE';
      });
      const still = await latestRun();
      assert.equal(still.status, 'DIFF_READY', 'a refused apply changed the run');
    });

    await check('(ss-h) no credential in any row but the sealed one, and none in a log line', async () => {
      const hits = await all<{ t: string }>(
        `SELECT 'runs' AS t FROM "Ss12000SyncRuns" WHERE "schoolId" = $1 AND (counts::text || errors::text) LIKE '%' || $2 || '%'
         UNION ALL SELECT 'changes' FROM "Ss12000SyncChanges" WHERE "schoolId" = $1 AND (coalesce("before"::text, '') || coalesce("after"::text, '')) LIKE '%' || $2 || '%'
         UNION ALL SELECT 'sources' FROM "Ss12000Sources" s WHERE "schoolId" = $1 AND row_to_json(s)::text LIKE '%' || $2 || '%'`,
        [school.id, SECRET],
      );
      assert.deepEqual(hits, []);
      assert.ok(lines.length > 0, 'no log line was captured, so nothing was proved');
      assert.ok(!lines.some((line) => line.includes(SECRET)), 'a log line carried the credential');
      assert.ok(!lines.some((line) => /ella\.ek@|Ella|Elin/.test(line)), 'a log line carried a name or an email');
    });
  } finally {
    Logger.overrideLogger(new ConsoleLogger());
    await provider.stop();
    await sweepSs12000School(owner, marker);
  }
}
