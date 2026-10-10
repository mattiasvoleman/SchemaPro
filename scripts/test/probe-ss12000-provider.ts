/**
 * The adapter probe's checks for the SS12000 v2.0 provider (20261014120000,
 * 20261014130000), against real Postgres as CI runs it and a local TLS mock
 * webhook receiver (never a real consumer): S1-shaped answers under the
 * service principal of a key's school and key, with no absence text and no
 * HR figure (sp-a); meta.modified moved by the statement triggers on an
 * emitted change and not by any other (sp-b); a deactivation buried and
 * served by /deletedEntities (sp-c); a subscription made with the key's
 * sealed signing secret, a committed change delivered once, signed, through
 * the xid watermark, and nothing for a revoked key (sp-d); another key's
 * subscription invisible (sp-e). In a school of its own (slug
 * <marker>-ss12000-provider), swept whole before and after.
 *
 * Imported by prisma-adapter-probe.ts, which hands in its `check`.
 */
import { strict as assert } from 'node:assert';
import { createServer, type Server } from 'node:https';
import type { AddressInfo } from 'node:net';
import { ConsoleLogger, Logger } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import type { Client } from 'pg';
import { Role } from '../../src/auth/enums/role.enum';
import type { AuthenticatedUser } from '../../src/auth/interfaces/authenticated-user.interface';
import type { PrismaService } from '../../src/database/prisma.service';
import { IntegrationKeysController } from '../../src/integration/integration.controller';
import type { ClientOptions } from '../../src/integration/ss12000-sync/client';
import { Ss12000Outbound, Ss12000Secrets } from '../../src/integration/ss12000-sync/ss12000-sync.providers';
import { verifySignature } from '../../src/integration/ss12000-v2/signing';
import type { Scope } from '../../src/integration/ss12000-v2/scopes';
import { Ss12000V2Service, type V2Caller } from '../../src/integration/ss12000-v2/ss12000-v2.service';
import { Ss12000SubscriptionsService } from '../../src/integration/ss12000-v2/subscriptions.service';
import { Ss12000WebhookDeliveryService } from '../../src/integration/ss12000-v2/webhook-delivery.service';
import { checkSchema } from '../../test/utils/s1-contract';
import { makeTestTls } from '../../test/utils/test-tls';

type Check = (label: string, body: () => Promise<void>) => Promise<void>;

const ABSENCE = 'probe: Karin är sjuk i influensa';
const V2_SCOPES: Scope[] = [
  'organisations.read', 'persons.read', 'responsibles.read', 'groups.read', 'duties.read', 'activities.read',
  'calendarEvents.read', 'rooms.read', 'syllabuses.read', 'subscriptions.write',
];

export function ss12000ProviderSlug(marker: string): string {
  return `${marker}-ss12000-provider`;
}

export async function sweepSs12000ProviderSchool(owner: Client, marker: string): Promise<void> {
  await owner.query(`DELETE FROM "Schools" WHERE slug = $1`, [ss12000ProviderSlug(marker)]);
}

class ProbeOutbound extends Ss12000Outbound {
  constructor(private readonly ca: string) {
    super();
  }
  override clientOptions(): ClientOptions {
    return { policy: { allowLoopback: true, ca: this.ca } };
  }
}

export async function ss12000ProviderChecks(owner: Client, api: PrismaService, marker: string, check: Check): Promise<void> {
  await sweepSs12000ProviderSchool(owner, marker);
  const one = async <T extends object>(sql: string, params: unknown[] = []): Promise<T> => (await owner.query<T>(sql, params)).rows[0]!;
  const day = (offset: number) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);

  const school = await one<{ id: string }>(
    `INSERT INTO "Schools" (name, slug, timezone, "updatedAt") VALUES ($1, $2, 'Europe/Stockholm', now()) RETURNING id`,
    [`${marker} ss12000 provider`, ss12000ProviderSlug(marker)],
  );
  const year = await one<{ id: string }>(
    `INSERT INTO "AcademicYears" ("schoolId", name, "startDate", "endDate", "isActive", "updatedAt")
     VALUES ($1, $2, $3::date, $4::date, true, now()) RETURNING id`,
    [school.id, `${marker} provider`, day(-60), day(240)],
  );
  const group = await one<{ id: string }>(
    `INSERT INTO "StudentGroups" ("schoolId", "academicYearId", name, kind, "gradeLevel", "updatedAt") VALUES ($1, $2, '7A', 'CLASS', 7, now()) RETURNING id`,
    [school.id, year.id],
  );
  const person = (role: string, email: string, first: string, last: string, groupId: string | null = null) =>
    one<{ id: string; authId: string }>(
      `INSERT INTO "Users" ("schoolId", email, "firstName", "lastName", role, "authId", "isActive", "studentGroupId", "updatedAt")
       VALUES ($1, $2, $3, $4, $5::"UserRole", gen_random_uuid(), true, $6, now()) RETURNING id, "authId"`,
      [school.id, email, first, last, role, groupId],
    );
  const adminRow = await person('SCHOOL_ADMIN', `${marker}-sp-admin@example.invalid`, 'Probe', 'Admin');
  const teacher = await person('TEACHER', `${marker}-sp-teacher@example.invalid`, 'Tove', 'Lärare');
  const pupil = await person('STUDENT', `${marker}-sp-pupil@example.invalid`, 'Palle', 'Girgensohn', group.id);
  const leaver = await person('STUDENT', `${marker}-sp-leaver@example.invalid`, 'Per', 'Slutar', group.id);
  const admin: AuthenticatedUser = { authId: adminRow.authId, userId: adminRow.id, schoolId: school.id, role: Role.SCHOOL_ADMIN };
  const room = await one<{ id: string }>(`INSERT INTO "Rooms" ("schoolId", name, capacity, "updatedAt") VALUES ($1, 'Sal 1', 30, now()) RETURNING id`, [school.id]);
  const subject = await one<{ id: string }>(`INSERT INTO "Subjects" ("schoolId", name, "updatedAt") VALUES ($1, 'Matematik', now()) RETURNING id`, [school.id]);
  const post = await one<{ id: string }>(
    `INSERT INTO "TeacherEmployments" ("schoolId", "userId", "academicYearId", "employmentPercent", "reductionPercent", note, "updatedAt")
     VALUES ($1, $2, $3, 80, 20, 'probe: nedsättning för facklig tid', now()) RETURNING id`,
    [school.id, teacher.id, year.id],
  );
  const master = await one<{ id: string }>(
    `INSERT INTO "MasterLessons" ("schoolId", "academicYearId", "subjectId", "studentGroupId", "teacherId", "roomId", "dayOfWeek", "startTime", "endTime", "updatedAt")
     VALUES ($1, $2, $3, $4, $5, $6, 1, '08:00', '09:00', now()) RETURNING id`,
    [school.id, year.id, subject.id, group.id, teacher.id, room.id],
  );
  const startsAt = new Date(`${day(3)}T07:00:00.000Z`);
  const lesson = await one<{ id: string }>(
    `INSERT INTO "CalendarLessons" ("schoolId", "masterLessonId", "subjectId", "studentGroupId", "roomId", date, "startsAt", "endsAt", status, note, "updatedAt")
     VALUES ($1, $2, $3, $4, $5, $6::date, $7, $8, 'CANCELLED', $9, now()) RETURNING id`,
    [school.id, master.id, subject.id, group.id, room.id, day(3), startsAt, new Date(startsAt.getTime() + 3_600_000), ABSENCE],
  );
  await owner.query(`INSERT INTO "CalendarLessonTeachers" ("schoolId", "calendarLessonId", "teacherId", role) VALUES ($1, $2, $3, 'LEAD')`, [school.id, lesson.id, teacher.id]);
  const key = await one<{ id: string }>(
    `INSERT INTO "IntegrationApiKeys" ("schoolId", name, "keyHash", scopes) VALUES ($1, 'probe v2', $2, $3::text[]) RETURNING id`,
    [school.id, `${marker}-sp-key`.padEnd(64, '0').slice(0, 64), V2_SCOPES],
  );
  const otherKey = await one<{ id: string }>(
    `INSERT INTO "IntegrationApiKeys" ("schoolId", name, "keyHash", scopes) VALUES ($1, 'probe v2 other', $2, '{rooms.read,subscriptions.write}') RETURNING id`,
    [school.id, `${marker}-sp-key2`.padEnd(64, '1').slice(0, 64)],
  );
  const caller: V2Caller = { schoolId: school.id, keyId: key.id, scopes: new Set(V2_SCOPES) };
  const other: V2Caller = { schoolId: school.id, keyId: otherKey.id, scopes: new Set(['rooms.read', 'subscriptions.write'] as Scope[]) };

  const tls = makeTestTls();
  const received: Array<{ headers: Record<string, string | string[] | undefined>; body: string }> = [];
  const receiver: Server = createServer({ key: tls.serverKey, cert: tls.serverCert }, (req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      received.push({ headers: req.headers, body: Buffer.concat(chunks).toString('utf8') });
      res.end('ok');
    });
  });
  await new Promise<void>((resolve) => receiver.listen(0, '127.0.0.1', resolve));
  const target = `https://127.0.0.1:${(receiver.address() as AddressInfo).port}/ss12000/notices`;

  const lines: string[] = [];
  Logger.overrideLogger({
    log: (m: unknown) => void lines.push(String(m)),
    warn: (m: unknown) => void lines.push(String(m)),
    error: (m: unknown) => void lines.push(String(m)),
    debug: (m: unknown) => void lines.push(String(m)),
    verbose: (m: unknown) => void lines.push(String(m)),
  });
  const config = { get: () => ({ secretsKey: Buffer.alloc(32, 6), background: false, allowInsecureLocal: true }) } as unknown as ConfigService;
  const secrets = new Ss12000Secrets(config);
  const outbound = new ProbeOutbound(tls.ca);
  const provider = new Ss12000V2Service(api);
  const subscriptions = new Ss12000SubscriptionsService(api, outbound);
  const delivery = new Ss12000WebhookDeliveryService(api, outbound, secrets);
  const keys = new IntegrationKeysController(api, secrets);
  const window = { 'startTime.onOrAfter': `${day(-1)}T00:00:00Z`, 'startTime.onOrBefore': `${day(30)}T00:00:00Z` };

  try {
    await check('(sp-a) v2.0 answers S1-shaped under the key\'s school and key, with no absence text and no HR figure', async () => {
      const cases: Array<[string, unknown]> = [
        ['Organisations', await provider.listOrganisations(caller, {})],
        ['PersonsExpanded', await provider.listPersons(caller, { expand: ['duties', 'groupMemberships'] })],
        ['GroupsExpanded', await provider.listGroups(caller, { expand: 'assignmentRoles' })],
        ['Duties', await provider.listDuties(caller, { expand: 'person' })],
        ['Activities', await provider.listActivities(caller, { expand: ['teachers', 'groups'] })],
        ['CalendarEvents', await provider.listCalendarEvents(caller, { ...window, expand: 'activity' })],
        ['Rooms', await provider.listRooms(caller, {})],
        ['DeletedEntities', await provider.deletedEntities(caller, {})],
      ];
      for (const [schema, body] of cases) assert.deepEqual(checkSchema(body, schema), [], `${schema} is not S1-shaped`);
      const text = JSON.stringify(cases);
      assert.ok(!text.includes(ABSENCE), 'a lesson note left through v2');
      assert.ok(!text.includes('nedsättning') && !text.includes('reductionPercent') && !text.includes('dutyPercent'), 'an HR figure left through v2');
      const events = cases[5]![1] as { data: Array<{ id: string; cancelled: boolean; activity: { id: string } }> };
      assert.deepEqual(events.data.map((event) => [event.id, event.cancelled, event.activity.id]), [[lesson.id, true, master.id]]);
      const duties = cases[3]![1] as { data: Array<{ id: string }> };
      assert.deepEqual(duties.data.map((duty) => duty.id), [post.id]);
    });

    await check('(sp-b) meta.modified moves with an emitted change, by the statement triggers, and not with any other', async () => {
      const groupMeta = async () => ((await provider.getGroup(caller, group.id, {}))['meta'] as { modified: string }).modified;
      const personMeta = async () => ((await provider.getPerson(caller, pupil.id, {}))['meta'] as { modified: string }).modified;
      const dutyMeta = async () => ((await provider.getDuty(caller, post.id, {}))['meta'] as { modified: string }).modified;
      const [g0, p0, d0] = [await groupMeta(), await personMeta(), await dutyMeta()];
      await new Promise((resolve) => setTimeout(resolve, 15));
      await owner.query(`UPDATE "Users" SET phone = '070-0000000', "invitedAt" = now() WHERE id = $1`, [pupil.id]);
      await owner.query(`UPDATE "TeacherEmployments" SET "reductionPercent" = 10, note = 'probe: ny nedsättning' WHERE id = $1`, [post.id]);
      assert.equal(await personMeta(), p0, 'a phone or an invitation moved a Person\'s meta.modified');
      assert.equal(await dutyMeta(), d0, 'a nedsättning moved a Duty\'s meta.modified');
      await owner.query(`UPDATE "StudentGroups" SET name = '7A Ek' WHERE id = $1`, [group.id]);
      const g1 = await groupMeta();
      assert.ok(g1 > g0, `a rename did not move the group (${g0} -> ${g1})`);
      // A class move: the pupil's enrolments and the class's memberships.
      await owner.query(`UPDATE "StudentGroups" SET "gradeLevel" = 8 WHERE id = $1`, [group.id]);
      const after = await provider.listGroups(caller, { 'meta.modified.after': g1 });
      assert.deepEqual(after.data.map((row) => row.id), [group.id]);
      assert.ok(String(after.data[0]!['displayName']) === '7A Ek');
    });

    await check('(sp-c) a deactivation is buried and served by /deletedEntities, and the person is gone from /persons', async () => {
      const before = new Date().toISOString();
      await new Promise((resolve) => setTimeout(resolve, 15));
      await owner.query(`UPDATE "Users" SET "isActive" = false WHERE id = $1`, [leaver.id]);
      const deleted = await provider.deletedEntities(caller, { after: before, entities: 'Person' });
      assert.deepEqual(deleted.data, { persons: [leaver.id] });
      const persons = await provider.listPersons(caller, {});
      assert.ok(!persons.data.some((row) => row.id === leaver.id), 'a deactivated person is still served');
    });

    await check('(sp-d) a subscription needs the sealed secret; a committed change is delivered once, signed; a revoked key gets nothing', async () => {
      await assert.rejects(
        subscriptions.create(caller, { name: 'probe', target, resourceTypes: [{ resource: 'Room' }] }),
        (error: { code?: string }) => error.code === 'WEBHOOK_SECRET_MISSING',
      );
      const made = await keys.webhookSecret(key.id, admin);
      assert.match(made.secret, /^whsec_/);
      const sealed = await one<{ ciphertext: Buffer }>(`SELECT ciphertext FROM "IntegrationKeyWebhookSecrets" WHERE "keyId" = $1`, [key.id]);
      assert.ok(!sealed.ciphertext.toString('utf8').includes(made.secret), 'the signing secret was stored in plaintext');
      const subscription = await subscriptions.create(caller, { name: 'probe', target, resourceTypes: [{ resource: 'Room' }, { resource: 'Person' }] });
      assert.equal(checkSchema(subscription, 'Subscription').length, 0);
      // Committed after the subscription: below the next horizon.
      await owner.query(`UPDATE "Rooms" SET name = 'Sal 1 (renoverad)' WHERE id = $1`, [room.id]);
      await delivery.tick();
      assert.equal(received.length, 1, `${received.length} notices for one change`);
      const notice = received[0]!;
      assert.deepEqual(JSON.parse(notice.body), { modifiedEntites: ['Room'], deletedEntities: false });
      assert.ok(verifySignature(String(notice.headers['x-schemapro-signature']), made.secret, Number(notice.headers['x-schemapro-timestamp']), notice.body));
      const settled = await one<{ outcome: string; httpStatus: number }>(
        `SELECT outcome, "httpStatus" FROM "Ss12000SubscriptionDeliveries" WHERE "subscriptionId" = $1`,
        [subscription.id],
      );
      assert.deepEqual(settled, { outcome: 'DELIVERED', httpStatus: 200 });
      await delivery.tick();
      assert.equal(received.length, 1, 'the watermark did not move: the same change was notified twice');
      await owner.query(`UPDATE "IntegrationApiKeys" SET "revokedAt" = now() WHERE id = $1`, [key.id]);
      await owner.query(`UPDATE "Rooms" SET capacity = 31 WHERE id = $1`, [room.id]);
      await delivery.tick();
      assert.equal(received.length, 1, 'a revoked key\'s subscription was notified');
      await owner.query(`UPDATE "IntegrationApiKeys" SET "revokedAt" = NULL WHERE id = $1`, [key.id]);
      assert.ok(!lines.join('\n').includes(made.secret), 'the signing secret reached a log line');
    });

    await check('(sp-e) a key sees its own subscriptions only', async () => {
      const mine = await subscriptions.list(caller, {});
      assert.equal(mine.data.length, 1);
      const theirs = await subscriptions.list(other, {});
      assert.equal(theirs.data.length, 0);
      await assert.rejects(subscriptions.get(other, mine.data[0]!.id), (error: { status?: number }) => error.status === 404);
      await subscriptions.end(caller, mine.data[0]!.id);
      const ended = await one<{ endedAt: Date | null }>(`SELECT "endedAt" FROM "Ss12000Subscriptions" WHERE id = $1`, [mine.data[0]!.id]);
      assert.ok(ended.endedAt instanceof Date, 'DELETE removed the row instead of ending it');
    });
  } finally {
    Logger.overrideLogger(new ConsoleLogger());
    await new Promise<void>((resolve) => receiver.close(() => resolve()));
    await sweepSs12000ProviderSchool(owner, marker);
  }
}
