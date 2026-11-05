import { ConsoleLogger, Logger } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import { Client } from 'pg';
import { Role } from '../src/auth/enums/role.enum';
import type { AuthenticatedUser } from '../src/auth/interfaces/authenticated-user.interface';
import { PrismaService } from '../src/database/prisma.service';
import { clearTokenCache, type ClientOptions } from '../src/integration/ss12000-sync/client';
import { Ss12000SourceService } from '../src/integration/ss12000-sync/ss12000-source.service';
import { Ss12000Outbound, Ss12000Secrets } from '../src/integration/ss12000-sync/ss12000-sync.providers';
import { Ss12000SyncService } from '../src/integration/ss12000-sync/ss12000-sync.service';
import { PersonProtectionsService } from '../src/users/person-protections';
import { MockSs12000Provider, isoDay, s1Adult, s1Duty, s1Group, s1Organisation, s1Pupil } from './utils/ss12000-mock-provider';
import { makeTestTls } from './utils/test-tls';

/**
 * Skyddad identitet (20270107090000), the SS12000 sync end to end: a mock
 * register, the real sync service (a manual run, the night with auto-apply,
 * the administrator's apply) and a real database under row security. The
 * review of #263 wrote this flow; here it asserts what the release does:
 *
 *   F2 the night marks a linked pupil the register protects;
 *   F3 the register's "Ingen" proposes lifting the mark, deselected: the
 *      night and the administrator's default apply leave it, a tick lifts it;
 *   F4 a mark by hand stands through the register's "Ingen" (L1);
 *   F5 a pupil typed in by hand whom the register protects is marked by the
 *      night, though the link waits for the administrator (M2);
 *   F7 a new protected pupil ticked to be created is marked with it;
 *   N1 (round 2) a row with the protected pupil's address but another name is
 *      proposed unticked and never marked at night; a mark an administrator
 *      removed does not come back; once the address is corrected the sync
 *      proposes lifting the mark, unticked, and a tick lifts it for good;
 *   N2 (round 3) names compare loosely: José García in the register marks
 *      Jose Garcia at night; Kalle for Karl is proposed and the night waits
 *      for the administrator (PROTECTION_REVIEW) with the proposal there;
 *   F8 no finished run, log line or count names a protected person;
 *   and the history says who set and removed each mark (M3).
 *
 * Runs only with SKYDDAD_DATABASE_URL (the API role's URL) and
 * SKYDDAD_OWNER_URL (the owner's, to plant and remove its own school); CI's
 * Database job sets both, the e2e job skips it.
 */

const DATABASE = process.env['SKYDDAD_DATABASE_URL'];
const OWNER = process.env['SKYDDAD_OWNER_URL'];
const SLUG = 'skyddad-synk-probe';
const ORG = 'aaaaaaaa-6300-4000-8000-000000000001';
const P1 = 'bbbbbbbb-6300-4000-8000-000000000001';
const P2 = 'bbbbbbbb-6300-4000-8000-000000000002';
const P3 = 'bbbbbbbb-6300-4000-8000-000000000003';
const P4 = 'bbbbbbbb-6300-4000-8000-000000000004';
const P5 = 'bbbbbbbb-6300-4000-8000-000000000005';
const P6 = 'bbbbbbbb-6300-4000-8000-000000000006';
const T1 = 'dddddddd-6300-4000-8000-000000000001';
const C7A = 'eeeeeeee-6300-4000-8000-00000000007a';
const D1 = 'ffffffff-6300-4000-8000-000000000001';

class LoopbackOutbound extends Ss12000Outbound {
  constructor(private readonly ca: string) {
    super();
  }
  override clientOptions(): ClientOptions {
    return { policy: { allowLoopback: true, ca: this.ca }, retryDelaysMs: [1, 1, 1], sleep: async () => undefined };
  }
}

const maybe = DATABASE && OWNER ? describe : describe.skip;

maybe('Skyddad identitet: the SS12000 sync sets, keeps and lifts the mark (a real database)', () => {
  let owner: Client;
  let api: PrismaService;
  let provider: MockSs12000Provider;
  let admin: AuthenticatedUser;
  let school: string;
  let sync: Ss12000SyncService;
  let sources: Ss12000SourceService;
  let marks: PersonProtectionsService;
  let handTyped: string;
  const lines: string[] = [];

  const one = async <T extends object>(sql: string, params: unknown[] = []): Promise<T> => (await owner.query<T>(sql, params)).rows[0]!;
  const all = async <T extends object>(sql: string, params: unknown[] = []): Promise<T[]> => (await owner.query<T>(sql, params)).rows;
  const latest = () =>
    one<{ id: string; status: string; basisHash: string }>(
      `SELECT id, status::text, "basisHash" FROM "Ss12000SyncRuns" WHERE "schoolId" = $1 ORDER BY "startedAt" DESC LIMIT 1`,
      [school],
    );
  const manual = async () => {
    await sync.startManualRun(admin, 'FULL');
    await sync.whenIdle();
    return latest();
  };
  const night = async () => {
    const source = await one<{ id: string }>(`SELECT id FROM "Ss12000Sources" WHERE "schoolId" = $1`, [school]);
    await sync.startScheduledRun(source.id, school, true);
    return latest();
  };
  const userOf = (ext: string) => one<{ id: string }>(`SELECT id FROM "Users" WHERE "schoolId" = $1 AND "ss12000Id" = $2`, [school, ext]);
  const marksOf = async (userId: string) =>
    (await all<{ source: string }>(`SELECT source::text FROM "PersonProtections" WHERE "userId" = $1 ORDER BY source`, [userId])).map((m) => m.source);
  const protectionChanges = (runId: string) =>
    all<{ op: string; selected: boolean; auto: boolean; applied: boolean; id: string }>(
      `SELECT op::text, selected, "autoApplicable" AS auto, applied, id FROM "Ss12000SyncChanges" WHERE "runId" = $1 AND entity = 'PROTECTION' ORDER BY seq`,
      [runId],
    );
  /** The run's marks matched on an address alone, by their code: a finished run keeps no after. */
  const addressChanges = (runId: string) =>
    all<{ op: string; selected: boolean; auto: boolean; applied: boolean; code: string; id: string }>(
      `SELECT op::text, selected, "autoApplicable" AS auto, applied, "conflictCode" AS code, id FROM "Ss12000SyncChanges"
        WHERE "runId" = $1 AND entity = 'PROTECTION' AND "conflictCode" LIKE 'PROTECTION\\_ADDRESS\\_%' ORDER BY seq`,
      [runId],
    );
  const reasonOf = async (runId: string) =>
    (await one<{ reason: string | null }>(`SELECT "autoApplyBlockedReason" AS reason FROM "Ss12000SyncRuns" WHERE id = $1`, [runId])).reason;
  const world = (p1: string, extra: unknown[] = []) => {
    provider.world = {
      organisations: [s1Organisation(ORG, 'Skyddad synk', '63000001')],
      persons: [
        s1Pupil(P1, 'Pia', 'Ett', 'p1.ett@ekskolan.example', ORG, { securityMarking: p1 }),
        s1Adult(T1, 'Tor', 'Lund', 'tor@ekskolan.example', 'Skola personal'),
        ...extra,
      ],
      groups: [s1Group(C7A, '7A', 'Klass', ORG, [P1])],
      duties: [s1Duty(D1, T1, ORG)],
      deleted: { persons: [], groups: [], duties: [] },
    } as never;
  };

  beforeAll(async () => {
    owner = new Client({ connectionString: OWNER });
    await owner.connect();
    process.env['DATABASE_URL'] = DATABASE;
    api = new PrismaService();
    await api.$connect();
    await owner.query(`DELETE FROM "Schools" WHERE slug = $1`, [SLUG]);
    school = (await one<{ id: string }>(
      `INSERT INTO "Schools" (name, slug, timezone, "updatedAt") VALUES ('Skyddad synk', $1, 'Europe/Stockholm', now()) RETURNING id`,
      [SLUG],
    )).id;
    await owner.query(
      `INSERT INTO "AcademicYears" ("schoolId", name, "startDate", "endDate", "isActive", "gradeNumbering", "updatedAt")
       VALUES ($1, 'Skyddad', $2::date, $3::date, true, 'NIOARIG', now())`,
      [school, isoDay(-120), isoDay(240)],
    );
    const person = (role: string, email: string, first: string, last: string) =>
      one<{ id: string; authId: string }>(
        `INSERT INTO "Users" ("schoolId", email, "firstName", "lastName", role, "authId", "isActive", "invitedAt", "updatedAt")
         VALUES ($1, $2, $3, $4, $5::"UserRole", gen_random_uuid(), true, now(), now() - interval '1 day') RETURNING id, "authId"`,
        [school, email, first, last, role],
      );
    const adminRow = await person('SCHOOL_ADMIN', 'skyddad-synk-admin@example.invalid', 'Synk', 'Admin');
    admin = { authId: adminRow.authId, userId: adminRow.id, schoolId: school, role: Role.SCHOOL_ADMIN, adminProfile: 'FULL' };
    // A pupil typed in by hand before the register protected her.
    handTyped = (await person('STUDENT', 'p2.hand@ekskolan.example', 'Hand', 'Skriven')).id;

    const tls = makeTestTls();
    provider = new MockSs12000Provider(tls, { id: 'probe', secret: 'skyddad-secret-never-in-a-row' });
    await provider.start();
    Logger.overrideLogger({
      log: (m: unknown) => void lines.push(String(m)),
      warn: (m: unknown) => void lines.push(String(m)),
      error: (m: unknown) => void lines.push(String(m)),
      debug: () => undefined,
      verbose: () => undefined,
    });
    const config = { get: () => ({ secretsKey: Buffer.alloc(32, 5), background: false, allowInsecureLocal: true }) } as unknown as ConfigService;
    const secrets = new Ss12000Secrets(config);
    const outbound = new LoopbackOutbound(tls.ca);
    sources = new Ss12000SourceService(api, secrets, outbound);
    sync = new Ss12000SyncService(api, secrets, outbound, undefined as never);
    marks = new PersonProtectionsService(api);
    clearTokenCache();
    const connection = { name: 'Skyddad', baseUrl: provider.baseUrl, authKind: 'OAUTH2_CLIENT_CREDENTIALS' as const, tokenUrl: provider.tokenUrl, clientId: 'probe' };
    await sources.put(admin, connection);
    await sources.putSecret(admin, 'CLIENT_SECRET', 'skyddad-secret-never-in-a-row');
    await sources.put(admin, { ...connection, organisationIds: [ORG] });
    await sources.patchSchedule(admin, { scheduleEnabled: true, scheduleAutoApply: true });
  });

  afterAll(async () => {
    Logger.overrideLogger(new ConsoleLogger());
    await provider?.stop();
    if (owner) {
      await owner.query(`DELETE FROM "Schools" WHERE slug = $1`, [SLUG]);
      await owner.end();
    }
    await api?.$disconnect();
  });

  it('F1–F3: the night marks a linked pupil the register protects, and the register\'s "Ingen" lifts it only when ticked', async () => {
    world('Ingen');
    let run = await manual();
    await sync.apply(admin, run.id, { basisHash: run.basisHash });
    const p1 = (await userOf(P1)).id;
    expect(await marksOf(p1)).toEqual([]);

    world('Sekretessmarkering');
    run = await night();
    expect(run.status).toBe('APPLIED');
    expect(await protectionChanges(run.id)).toEqual([expect.objectContaining({ op: 'ADD', selected: true, auto: true, applied: true })]);
    expect(await marksOf(p1)).toEqual(['SS12000']);

    world('Ingen');
    run = await night();
    const lift = await protectionChanges(run.id);
    expect(lift).toEqual([expect.objectContaining({ op: 'END', selected: false, auto: false, applied: false })]);
    // The administrator's apply with the defaults never lifts a protection (L2).
    if (run.status === 'DIFF_READY') await sync.apply(admin, run.id, { basisHash: run.basisHash });
    expect(await marksOf(p1)).toEqual(['SS12000']);
    // Ticked, it does.
    run = await manual();
    const end = (await protectionChanges(run.id)).find((change) => change.op === 'END')!;
    await sync.apply(admin, run.id, { basisHash: run.basisHash, select: [end.id] });
    expect(await marksOf(p1)).toEqual([]);

    // The history: set by the night (nobody), lifted by the administrator (M3).
    const history = await marks.one(p1, admin);
    expect(history.events.map((event) => [event.action, event.source, event.actorName])).toEqual([
      ['REMOVED', 'SS12000', 'Synk Admin'],
      ['ADDED', 'SS12000', null],
    ]);
  });

  it('F4: a mark by hand stands through the register\'s "Ingen", which lifts only the register\'s own (L1)', async () => {
    const p1 = (await userOf(P1)).id;
    world('Skyddad folkbokföring');
    await night();
    expect(await marksOf(p1)).toEqual(['SS12000']);
    await marks.set(p1, admin);
    expect(await marksOf(p1)).toEqual(['MANUAL', 'SS12000']);

    world('Ingen');
    const run = await manual();
    const end = (await protectionChanges(run.id)).find((change) => change.op === 'END')!;
    await sync.apply(admin, run.id, { basisHash: run.basisHash, select: [end.id] });
    expect(await marksOf(p1)).toEqual(['MANUAL']);
    await marks.remove(p1, admin);
    expect(await marksOf(p1)).toEqual([]);
  });

  it('F5: a pupil typed in by hand whom the register protects is marked by the night, though her link waits (M2)', async () => {
    const p2 = s1Pupil(P2, 'Hand', 'Skriven', 'p2.hand@ekskolan.example', ORG, { securityMarking: 'Skyddad folkbokföring' });
    world('Ingen', [p2]);
    const run = await night();
    const link = await one<{ selected: boolean; applied: boolean }>(
      `SELECT selected, applied FROM "Ss12000SyncChanges" WHERE "runId" = $1 AND op = 'LINK' AND "externalId" = $2`,
      [run.id, P2],
    );
    expect(link).toEqual({ selected: false, applied: false });
    expect(await protectionChanges(run.id)).toEqual([expect.objectContaining({ op: 'ADD', auto: true, applied: true })]);
    expect(await marksOf(handTyped)).toEqual(['SS12000']);
    // Not linked: the administrator still decides that.
    expect((await one<{ ss12000Id: string | null }>(`SELECT "ss12000Id" FROM "Users" WHERE id = $1`, [handTyped])).ss12000Id).toBeNull();
  });

  it('F7: a new protected pupil the administrator ticks to be created is marked with it', async () => {
    const p2 = s1Pupil(P2, 'Hand', 'Skriven', 'p2.hand@ekskolan.example', ORG, { securityMarking: 'Skyddad folkbokföring' });
    const p3 = s1Pupil(P3, 'Ny', 'Skyddad', 'p3.ny@ekskolan.example', ORG, { securityMarking: 'Sekretessmarkering' });
    world('Ingen', [p2, p3]);
    const run = await manual();
    const create = await one<{ id: string; selected: boolean }>(
      `SELECT id, selected FROM "Ss12000SyncChanges" WHERE "runId" = $1 AND op = 'CREATE' AND "externalId" = $2`,
      [run.id, P3],
    );
    expect(create.selected).toBe(false);
    await sync.apply(admin, run.id, { basisHash: run.basisHash, select: [create.id] });
    expect(await marksOf((await userOf(P3)).id)).toEqual(['SS12000']);
  });

  it('N1: a row with the address but another name is proposed unticked, never marked at night, and a removed mark stays removed', async () => {
    // Lisa holds the address the register now gives a protected pupil, Sara.
    const lisa = (await one<{ id: string }>(
      `INSERT INTO "Users" ("schoolId", email, "firstName", "lastName", role, "authId", "isActive", "updatedAt")
       VALUES ($1, 'delad@ekskolan.example', 'Lisa', 'Lund', 'STUDENT', gen_random_uuid(), true, now() - interval '1 day') RETURNING id`,
      [school],
    )).id;
    const sara = s1Pupil(P4, 'Sara', 'Skydd', 'delad@ekskolan.example', ORG, { securityMarking: 'Sekretessmarkering' });
    const p2 = s1Pupil(P2, 'Hand', 'Skriven', 'p2.hand@ekskolan.example', ORG, { securityMarking: 'Skyddad folkbokföring' });
    const p3 = s1Pupil(P3, 'Ny', 'Skyddad', 'p3.ny@ekskolan.example', ORG, { securityMarking: 'Sekretessmarkering' });
    world('Ingen', [p2, p3, sara]);

    let run = await night();
    // The night makes no mark on a name that differs, and waits for the administrator (N2).
    expect(run.status).toBe('DIFF_READY');
    expect(await reasonOf(run.id)).toBe('PROTECTION_REVIEW');
    expect(await addressChanges(run.id)).toEqual([
      expect.objectContaining({ op: 'ADD', selected: false, auto: false, applied: false, code: 'PROTECTION_ADDRESS_NAME_DIFFERS' }),
    ]);
    expect(await marksOf(lisa)).toEqual([]);
    // The pupil typed in by hand, same address and name, keeps her mark (F5).
    expect(await marksOf(handTyped)).toEqual(['SS12000']);

    // An administrator ticks it (the wrong person), and one who decides removes it again.
    run = await manual();
    const [add] = await addressChanges(run.id);
    await sync.apply(admin, run.id, { basisHash: run.basisHash, select: [add!.id] });
    expect(await marksOf(lisa)).toEqual(['SS12000']);
    await marks.remove(lisa, admin);
    run = await night();
    expect(await addressChanges(run.id)).toEqual([expect.objectContaining({ op: 'ADD', applied: false })]);
    expect(await marksOf(lisa)).toEqual([]);
  });

  it('N1: once the address is corrected the sync proposes lifting a mark it made on it, unticked; ticked, it stays lifted', async () => {
    const lisa = (await one<{ id: string }>(`SELECT id FROM "Users" WHERE "schoolId" = $1 AND "firstName" = 'Lisa'`, [school])).id;
    let run = await manual();
    const [add] = await addressChanges(run.id);
    await sync.apply(admin, run.id, { basisHash: run.basisHash, select: [add!.id] });
    expect(await marksOf(lisa)).toEqual(['SS12000']);

    // The school corrects Lisa's address, as the manual says.
    await owner.query(`UPDATE "Users" SET email = 'lisa.lund@ekskolan.example' WHERE id = $1`, [lisa]);
    run = await manual();
    expect(await addressChanges(run.id)).toEqual([
      expect.objectContaining({ op: 'END', selected: false, auto: false, applied: false, code: 'PROTECTION_ADDRESS_NO_LONGER_MATCHES' }),
    ]);
    await sync.apply(admin, run.id, { basisHash: run.basisHash });
    expect(await marksOf(lisa)).toEqual(['SS12000']);
    run = await night();
    expect(await addressChanges(run.id)).toEqual([expect.objectContaining({ op: 'END', applied: false })]);
    expect(await marksOf(lisa)).toEqual(['SS12000']);

    run = await manual();
    const [end] = await addressChanges(run.id);
    await sync.apply(admin, run.id, { basisHash: run.basisHash, select: [end!.id] });
    expect(await marksOf(lisa)).toEqual([]);
    run = await night();
    expect(await addressChanges(run.id)).toEqual([]);
    expect(await protectionChanges(run.id)).toEqual([]);
    expect(await marksOf(lisa)).toEqual([]);
    expect(await marksOf(handTyped)).toEqual(['SS12000']);
  });

  it('N2: names compare loosely, and a name that still differs holds the night with its proposal for the administrator', async () => {
    const student = async (email: string, first: string, last: string) =>
      (await one<{ id: string }>(
        `INSERT INTO "Users" ("schoolId", email, "firstName", "lastName", role, "authId", "isActive", "updatedAt")
         VALUES ($1, $2, $3, $4, 'STUDENT', gen_random_uuid(), true, now() - interval '1 day') RETURNING id`,
        [school, email, first, last],
      )).id;
    // Typed in by hand without accents; and with the call name the school uses.
    const jose = await student('jose.garcia@ekskolan.example', 'Jose', 'Garcia');
    const kalle = await student('karl.berg@ekskolan.example', 'Kalle', 'Berg');
    const p2 = s1Pupil(P2, 'Hand', 'Skriven', 'p2.hand@ekskolan.example', ORG, { securityMarking: 'Skyddad folkbokföring' });
    const p3 = s1Pupil(P3, 'Ny', 'Skyddad', 'p3.ny@ekskolan.example', ORG, { securityMarking: 'Sekretessmarkering' });
    const sara = s1Pupil(P4, 'Sara', 'Skydd', 'delad@ekskolan.example', ORG, { securityMarking: 'Sekretessmarkering' });
    const p5 = s1Pupil(P5, 'José', 'García', 'jose.garcia@ekskolan.example', ORG, { securityMarking: 'Skyddad folkbokföring' });
    const p6 = s1Pupil(P6, 'Karl', 'Berg', 'karl.berg@ekskolan.example', ORG, { securityMarking: 'Sekretessmarkering' });
    world('Ingen', [p2, p3, sara, p5, p6]);

    let run = await night();
    expect(await marksOf(jose)).toEqual(['SS12000']);
    expect(await marksOf(kalle)).toEqual([]);
    // The night made what it could and waits: the proposal is there in the morning.
    expect(run.status).toBe('DIFF_READY');
    expect(await reasonOf(run.id)).toBe('PROTECTION_REVIEW');
    const [add] = await addressChanges(run.id);
    expect(add).toMatchObject({ op: 'ADD', selected: false, applied: false, code: 'PROTECTION_ADDRESS_NAME_DIFFERS' });

    await sync.apply(admin, run.id, { basisHash: run.basisHash, select: [add!.id] });
    expect(await marksOf(kalle)).toEqual(['SS12000']);
    run = await night();
    expect(await addressChanges(run.id)).toEqual([]);
    expect(await reasonOf(run.id)).not.toBe('PROTECTION_REVIEW');
    expect(await marksOf(jose)).toEqual(['SS12000']);
    expect(await marksOf(kalle)).toEqual(['SS12000']);
  });

  it('F8: no finished run, log line or count names a protected person', async () => {
    const held = await one<{ n: number }>(
      `SELECT count(*)::int AS n FROM "Ss12000SyncChanges" c JOIN "Ss12000SyncRuns" r ON r.id = c."runId"
        WHERE c."schoolId" = $1 AND r.status NOT IN ('RUNNING', 'DIFF_READY')
          AND (c."before" IS NOT NULL OR c."after" IS NOT NULL OR c."protectedIdentity" OR (c.entity = 'PROTECTION' AND (c."externalId" IS NOT NULL OR c."localId" IS NOT NULL)))`,
      [school],
    );
    expect(held.n).toBe(0);
    expect(lines.filter((line) => /Pia|Skriven|Skyddad folk|p1\.ett|p2\.hand|p3\.ny|Sara|delad@|Jos[eé]|Garc[ií]a|Karl|Kalle|karl\.berg/.test(line))).toEqual([]);
    const runs = JSON.stringify(await all(`SELECT counts, errors FROM "Ss12000SyncRuns" WHERE "schoolId" = $1`, [school]));
    for (const id of [P1, P2, P3, P4, P5, P6]) expect(runs).not.toContain(id);
  });
});
