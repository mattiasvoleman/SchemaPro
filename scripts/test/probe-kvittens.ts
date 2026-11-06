/**
 * The adapter probe's checks for Kvittens (20270117090000–20270117091000), through the
 * real AckService on the API's role, against real Postgres as CI runs it. The RLS sections
 * 370-374 prove what the arms and the functions do; this proves what the gateway and the
 * adapter make of them: the casts of the uuid arrays, the refusals read back by SQLSTATE
 * (P2010), the notices a request writes, and above all the races, with two connections
 * and the second seen waiting on a lock before the first commits. In a school of its own
 * (slug <marker>-kvittens), swept whole before and after:
 *
 *   ka  the switch: off, so a teacher is told 409; on, with three days
 *   kb  an administrator asks about two pupils (one has two guardians, the other one, and
 *       a third has none): the counts, a notice per guardian, and the reminder time
 *   kc  the guardians: each reads their own, one tap confirms both children at one time, a
 *       second tap answers the same time, and nobody reads the other guardian's tap
 *   kd  a teacher asks only about her mentees, and reads only her pupils in a request
 *   ke  custody that ends: the guardian can no longer confirm or read, what they confirmed
 *       before stays, and the other guardian alone meets a request that asked both
 *   kf  a pupil marked as having a protected identity: the guardian is asked and confirms
 *       like any other, and the staff's overview names the pupil, as the register does
 *   kg  races: two guardians confirm at once (twenty rounds, both recorded, the pupil met),
 *       one guardian taps twice at once, a link removed under a confirmation (and a
 *       confirmation under a link being removed), the reminder pass and a confirmation
 *   kh  the reminder, through the real pass: only the guardian who has not confirmed, once,
 *       and nothing of the child, the title or the text in the e-mail
 *   ki  a request about two hundred pupils with two guardians each, in one transaction
 *
 * Imported by prisma-adapter-probe.ts, which hands in its `check`.
 */
import { strict as assert } from 'node:assert';
import { randomUUID } from 'node:crypto';
import { ConflictException, ForbiddenException } from '@nestjs/common';
import { Client } from 'pg';
import { AckService } from '../../src/ack/ack.service';
import { Role } from '../../src/auth/enums/role.enum';
import type { AuthenticatedUser } from '../../src/auth/interfaces/authenticated-user.interface';
import type { PrismaService } from '../../src/database/prisma.service';
import type { OutboxEntry } from '../../src/notifications/notification-outbox';
import { NotificationsService } from '../../src/notifications/notifications.service';

type Check = (label: string, body: () => Promise<void>) => Promise<void>;

export function kvittensSlug(marker: string): string {
  return `${marker}-kvittens`;
}

export async function sweepKvittensSchool(owner: Client, marker: string): Promise<void> {
  await owner.query(`DELETE FROM "Schools" WHERE slug = $1`, [kvittensSlug(marker)]);
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export async function kvittensChecks(owner: Client, api: PrismaService, marker: string, check: Check): Promise<void> {
  await sweepKvittensSchool(owner, marker);
  const one = async <T extends object>(sql: string, params: unknown[] = []): Promise<T> => (await owner.query<T>(sql, params)).rows[0]!;
  const count = async (sql: string, params: unknown[] = []): Promise<number> => Number((await one<{ n: string }>(sql, params)).n);
  const today = (await one<{ d: string }>(`SELECT ((now() AT TIME ZONE 'Europe/Stockholm')::date)::text AS d`)).d;

  const school = await one<{ id: string }>(
    `INSERT INTO "Schools" (name, slug, timezone, "updatedAt") VALUES ($1, $2, 'Europe/Stockholm', now()) RETURNING id`,
    [`${marker} kvittens`, kvittensSlug(marker)],
  );
  const s = school.id;
  const year = await one<{ id: string }>(
    `INSERT INTO "AcademicYears" ("schoolId", name, "startDate", "endDate", "isActive", "updatedAt")
     VALUES ($1, 'kv probe', '${today}'::date - 200, '${today}'::date + 200, true, now()) RETURNING id`,
    [s],
  );
  const klass = async (name: string) =>
    (await one<{ id: string }>(`INSERT INTO "StudentGroups" ("schoolId", "academicYearId", name, "gradeLevel", "updatedAt") VALUES ($1, $2, $3, 7, now()) RETURNING id`, [s, year.id, name])).id;
  const k1 = await klass('KV1');
  const k2 = await klass('KV2');
  const person = async (role: string, label: string, extra: { adminProfile?: string; group?: string } = {}) => {
    const authId = randomUUID();
    const row = await one<{ id: string }>(
      `INSERT INTO "Users" ("schoolId", email, "firstName", "lastName", role, "adminProfile", "studentGroupId", "authId", "isActive", "updatedAt")
       VALUES ($1, $2, $3, 'Probe', $4::"UserRole", $5::"AdminProfile", $6, $7, true, now()) RETURNING id`,
      [s, `${marker}-kv-${label}@example.invalid`, label, role, extra.adminProfile ?? null, extra.group ?? null, authId],
    );
    return { id: row.id, authId };
  };
  const admin = await person('SCHOOL_ADMIN', 'admin', { adminProfile: 'FULL' });
  const lasare = await person('SCHOOL_ADMIN', 'lasare', { adminProfile: 'LASARE' });
  const mentor1 = await person('TEACHER', 'mentor1');
  const mentor2 = await person('TEACHER', 'mentor2');
  const loner = await person('TEACHER', 'loner');
  const p1 = await person('STUDENT', 'p1', { group: k1 });
  const p2 = await person('STUDENT', 'p2', { group: k1 });
  const p3 = await person('STUDENT', 'p3', { group: k2 });
  const p4 = await person('STUDENT', 'p4', { group: k1 });
  const p5 = await person('STUDENT', 'p5', { group: k2 });
  const g1 = await person('GUARDIAN', 'g1');
  const g2 = await person('GUARDIAN', 'g2');
  const g3 = await person('GUARDIAN', 'g3');
  const g4 = await person('GUARDIAN', 'g4');
  const link = (g: { id: string }, p: { id: string }) =>
    owner.query(`INSERT INTO "GuardianStudents" ("schoolId", "guardianId", "studentId") VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`, [s, g.id, p.id]);
  for (const [g, p] of [[g1, p1], [g1, p2], [g2, p1], [g3, p3], [g4, p4]] as const) await link(g, p);
  for (const [teacher, group, label] of [[mentor1, k1, 'Mentor KV1'], [mentor2, k2, 'Mentor KV2']] as const) {
    await owner.query(
      `INSERT INTO "TeacherDuties" ("schoolId", "userId", "academicYearId", kind, label, "minutesPerWeek", "studentGroupId", "updatedAt")
       VALUES ($1, $2, $3, 'MENTORSKAP', $4, 60, $5, now())`,
      [s, teacher.id, year.id, label, group],
    );
  }
  const as = (who: { id: string; authId: string }, role: Role, adminProfile?: 'FULL' | 'LASARE'): AuthenticatedUser => ({
    authId: who.authId, role, userId: who.id, schoolId: s, ...(adminProfile ? { adminProfile } : {}),
  });
  const asAdmin = as(admin, Role.SCHOOL_ADMIN, 'FULL');
  const asLasare = as(lasare, Role.SCHOOL_ADMIN, 'LASARE');
  const asMentor1 = as(mentor1, Role.TEACHER);
  const asMentor2 = as(mentor2, Role.TEACHER);
  const asLoner = as(loner, Role.TEACHER);
  const asG = (g: { id: string; authId: string }) => as(g, Role.GUARDIAN);

  // The delivery is the gateway's own; here it only records what was handed to it.
  const delivered: OutboxEntry[] = [];
  const delivery = { wants: () => true, emailConfigured: () => true, enqueue: (batch: OutboxEntry[]) => void delivered.push(...batch) };
  const notifications = new NotificationsService(api, delivery as never);
  const service = new AckService(api, notifications);

  const statusOf = async (id: string) => {
    const detail = await service.detail(id, asAdmin);
    return Object.fromEntries(detail.pupils.map((p) => [p.name.split(' ')[0], { met: p.met, guardians: p.guardians.map((g) => `${g.name.split(' ')[0]}:${g.state}`) }]));
  };
  /** A connection of the API's role, a transaction open as a guardian: for a confirmation held in flight. */
  const asGuardianConnection = async (g: { authId: string }): Promise<Client> => {
    const client = new Client({ connectionString: process.env['DATABASE_URL'] });
    await client.connect();
    await client.query('BEGIN');
    await client.query(`SELECT set_config('request.jwt.claims', $1, true), set_config('app.chosen_school_id', $2, true)`, [JSON.stringify({ sub: g.authId }), s]);
    return client;
  };
  const waitUntilBlocked = async (sqlFragment: string): Promise<void> => {
    for (let attempt = 0; attempt < 100; attempt++) {
      const rows = await owner.query(`SELECT 1 FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND query LIKE $1`, [`%${sqlFragment}%`]);
      if (rows.rowCount) return;
      await sleep(50);
    }
    assert.fail(`nothing waited on a lock in ${sqlFragment}`);
  };

  await check('ka: kvittens is off until an administrator turns it on, and the reminder time is the school’s', async () => {
    assert.deepEqual(await service.settings(asAdmin), { enabled: false, remindAfterDays: 2 });
    await assert.rejects(() => service.create({ title: 'T', body: 'B', rule: 'ANY', studentIds: [p1.id] }, asMentor1), (error: unknown) => {
      assert.ok(error instanceof ConflictException);
      assert.equal((error.getResponse() as { code: string }).code, 'ACK_DISABLED');
      return true;
    });
    await assert.rejects(() => service.updateSettings({ enabled: true }, asLasare), 'a läsare turned kvittens on');
    assert.deepEqual(await service.updateSettings({ enabled: true, remindAfterDays: 3 }, asAdmin), { enabled: true, remindAfterDays: 3 });
    assert.deepEqual(await service.settings(asMentor1), { enabled: true, remindAfterDays: 3 }, 'a teacher is not told what the school chose');
  });

  let main = '';
  await check('kb: an administrator asks about three pupils: two have guardians, one has none', async () => {
    const created = await service.create({ title: 'Utflykt', body: 'Vi åker kl. 8.', rule: 'ALL', studentIds: [p1.id, p2.id, p5.id] }, asAdmin);
    main = created.id;
    assert.equal(created.pupils, 2);
    assert.equal(created.guardians, 2, 'a guardian with two children in the request is one guardian');
    assert.deepEqual(created.withoutGuardian, [p5.id]);
    assert.equal(await count(`SELECT count(*) AS n FROM "AckReceipts" WHERE "requestId" = $1`, [main]), 3);
    const notices = await owner.query<{ userId: string; meta: { title: string; requestId: string } }>(
      `SELECT "userId", meta FROM "Notifications" WHERE type = 'ACK_REQUESTED' AND meta ->> 'requestId' = $1 ORDER BY "userId"`, [main]);
    assert.deepEqual(notices.rows.map((r) => r.userId).sort(), [g1.id, g2.id].sort());
    assert.equal(notices.rows[0]!.meta.title, 'Utflykt');
    const row = await one<{ authorName: string; days: string }>(
      `SELECT "authorName", round(extract(epoch FROM "remindAt" - "createdAt") / 86400)::text AS days FROM "AckRequests" WHERE id = $1`, [main]);
    assert.equal(row.authorName, 'admin Probe');
    assert.equal(row.days, '3', 'the reminder is due after the days the school chose');
    const list = await service.list(asAdmin);
    assert.deepEqual(list.map((r) => [r.pupils, r.met, r.waiting]), [[2, 0, 3]]);
    await assert.rejects(() => service.list(asLasare).then(() => service.create({ title: 'T', body: 'B', rule: 'ANY', studentIds: [p1.id] }, asLasare)), 'a läsare wrote a request');
  });

  await check('kc: each guardian reads their own; one tap confirms both children at one time; nobody reads the other guardian’s tap', async () => {
    const mineG1 = await service.mine(asG(g1));
    assert.equal(mineG1.length, 1);
    assert.deepEqual(mineG1[0]!.children.map((c) => c.name.split(' ')[0]).sort(), ['p1', 'p2']);
    assert.equal(mineG1[0]!.authorName, 'admin Probe');
    assert.deepEqual((await service.mine(asG(g2)))[0]!.children.map((c) => c.name.split(' ')[0]), ['p1']);
    assert.deepEqual(await service.mine(asG(g3)), [], 'a guardian who was not asked reads nothing');
    const first = await service.confirm(main, asG(g1));
    const second = await service.confirm(main, asG(g1));
    assert.equal(second.ackedAt, first.ackedAt, 'a second tap changed the time');
    assert.equal(await count(`SELECT count(DISTINCT "ackedAt") AS n FROM "AckReceipts" WHERE "requestId" = $1 AND "ackedAt" IS NOT NULL`, [main]), 1);
    const g2sees = await service.mine(asG(g2));
    assert.equal(g2sees[0]!.ackedAt, null);
    assert.ok(!JSON.stringify(g2sees).includes(g1.id) && !JSON.stringify(g2sees).includes(first.ackedAt), 'a guardian reads the other guardian’s confirmation');
    const state = await statusOf(main);
    assert.deepEqual(state['p2'], { met: true, guardians: ['g1:CONFIRMED'] });
    assert.deepEqual(state['p1']!.met, false);
    assert.deepEqual(state['p1']!.guardians.sort(), ['g1:CONFIRMED', 'g2:WAITING']);
    const row = (await service.list(asAdmin)).find((r) => r.id === main)!;
    assert.deepEqual([row.pupils, row.met, row.waiting], [2, 1, 1], 'the list does not count who has confirmed');
    // The staff's reading is recorded as people and as guardians.
    assert.ok((await count(`SELECT count(*) AS n FROM "PersonalDataAccess" WHERE "actorId" = $1 AND kind IN ('PEOPLE', 'GUARDIANS')`, [admin.id])) >= 2);
    await assert.rejects(() => service.confirm(main, asLoner), (error: unknown) => error instanceof ForbiddenException);
  });
  await check('kd: a teacher asks only about her mentees and reads only her pupils', async () => {
    const own = await service.create({ title: 'Mentor 1', body: 'B', rule: 'ANY', studentIds: [p1.id] }, asMentor1);
    assert.equal(own.guardians, 2);
    await assert.rejects(() => service.create({ title: 'T', body: 'B', rule: 'ANY', studentIds: [p3.id] }, asMentor1), (error: unknown) => {
      assert.ok(error instanceof ForbiddenException);
      assert.equal((error.getResponse() as { code: string }).code, 'ACK_NOT_YOUR_PUPIL');
      return true;
    });
    await assert.rejects(() => service.create({ title: 'T', body: 'B', rule: 'ANY', studentIds: [p1.id] }, asLoner), 'a teacher who mentors nobody asked');
    assert.deepEqual((await service.pupils(asMentor1)).map((p) => p.name.split(' ')[0]), ['p1', 'p2', 'p4']);
    assert.deepEqual(await service.pupils(asLoner), []);
    assert.equal((await service.pupils(asAdmin)).length, 5);
    // The mentor reads the administrator's request, for her pupils; the other class's mentor and the loner do not.
    assert.deepEqual((await service.detail(main, asMentor1)).pupils.map((p) => p.name.split(' ')[0]), ['p1', 'p2']);
    await assert.rejects(() => service.detail(main, asMentor2), (error: unknown) => (error as { status?: number }).status === 404);
    await assert.rejects(() => service.detail(main, asLoner), (error: unknown) => (error as { status?: number }).status === 404);
    assert.deepEqual((await service.list(asMentor2)).length, 0);
    assert.equal((await service.list(asMentor1)).length, 2);
  });

  await check('ke: custody that ends: no confirming, no reading; what was confirmed stays; the other guardian alone meets it', async () => {
    const both = await service.create({ title: 'Båda', body: 'B', rule: 'ALL', studentIds: [p1.id] }, asAdmin);
    await service.confirm(both.id, asG(g2));
    await service.confirm(main, asG(g2));
    await owner.query(`DELETE FROM "GuardianStudents" WHERE "guardianId" = $1 AND "studentId" = $2`, [g2.id, p1.id]);
    await assert.rejects(() => service.confirm(both.id, asG(g2)), (error: unknown) => {
      assert.ok(error instanceof ConflictException);
      assert.equal((error.getResponse() as { code: string }).code, 'ACK_CUSTODY_ENDED');
      return true;
    });
    assert.deepEqual(await service.mine(asG(g2)), [], 'a guardian whose custody has ended still reads a request about the child');
    // What g2 confirmed before the custody ended stands, in the staff's overview.
    const state = await statusOf(main);
    assert.ok(state['p1']!.guardians.includes('g2:CONFIRMED'), 'a confirmation made while the custody stood was lost');
    // ALL: g2 confirmed and left, g1 alone is left to ask, and the pupil is met when g1 has.
    assert.equal((await statusOf(both.id))['p1']!.met, false, 'ALL: g1 had not confirmed, and the pupil was met');
    await service.confirm(both.id, asG(g1));
    assert.equal((await statusOf(both.id))['p1']!.met, true, 'ALL: g1 confirmed, g2 had before leaving, and the pupil is not met');
    await service.confirm(main, asG(g1));
    await link(g2, p1);
  });

  await check('kf: a pupil marked as having a protected identity: the guardian confirms like any other, and the staff see the pupil', async () => {
    await owner.query(`INSERT INTO "PersonProtections" ("userId", "schoolId", source) VALUES ($1, $2, 'MANUAL')`, [p4.id, s]);
    const created = await service.create({ title: 'Skyddad', body: 'B', rule: 'ANY', studentIds: [p4.id, p3.id] }, asAdmin);
    assert.equal(created.guardians, 2);
    assert.equal((await service.mine(asG(g4))).length, 1);
    await service.confirm(created.id, asG(g4));
    const state = await statusOf(created.id);
    assert.deepEqual(state['p4'], { met: true, guardians: ['g4:CONFIRMED'] });
    assert.deepEqual(state['p3']!.met, false);
    assert.deepEqual((await service.detail(created.id, asMentor1)).pupils.map((p) => p.name.split(' ')[0]), ['p4'], 'the mentor of the marked pupil reads the pupil, and not the other class’s');
    await owner.query(`DELETE FROM "PersonProtections" WHERE "userId" = $1`, [p4.id]);
  });

  await check('kg: races', async () => {
    // Two guardians confirm at once, twenty times: both are recorded and the pupil is met.
    for (let round = 0; round < 20; round++) {
      const r = await service.create({ title: `Samtidigt ${round}`, body: 'B', rule: 'ALL', studentIds: [p1.id] }, asAdmin);
      await Promise.all([service.confirm(r.id, asG(g1)), service.confirm(r.id, asG(g2))]);
      assert.equal(await count(`SELECT count(*) AS n FROM "AckReceipts" WHERE "requestId" = $1 AND "ackedAt" IS NOT NULL`, [r.id]), 2, `round ${round}: a confirmation was lost`);
      assert.equal((await statusOf(r.id))['p1']!.met, true, `round ${round}: both confirmed and the pupil is not met`);
    }
    // One guardian taps twice at once: one time.
    const dbl = await service.create({ title: 'Dubbeltryck', body: 'B', rule: 'ANY', studentIds: [p1.id, p2.id] }, asAdmin);
    const taps = await Promise.all([service.confirm(dbl.id, asG(g1)), service.confirm(dbl.id, asG(g1)), service.confirm(dbl.id, asG(g1))]);
    assert.equal(new Set(taps.map((t) => t.ackedAt)).size, 1, 'a double tap gave two times');
    assert.equal(await count(`SELECT count(DISTINCT "ackedAt") AS n FROM "AckReceipts" WHERE "requestId" = $1 AND "ackedAt" IS NOT NULL`, [dbl.id]), 1);

    // A link removed under a confirmation: the confirmation waits for the removal and then refuses.
    const gone = await service.create({ title: 'Länk bort', body: 'B', rule: 'ANY', studentIds: [p2.id] }, asAdmin);
    const remover = new Client({ connectionString: process.env['PROBE_OWNER_URL'] });
    await remover.connect();
    try {
      await remover.query('BEGIN');
      await remover.query(`DELETE FROM "GuardianStudents" WHERE "guardianId" = $1 AND "studentId" = $2`, [g1.id, p2.id]);
      const confirming = service.confirm(gone.id, asG(g1)).then(() => 'confirmed', (error: unknown) => (error as { response?: { code?: string } }).response?.code ?? 'failed');
      await waitUntilBlocked('ack_confirm');
      await remover.query('COMMIT');
      assert.equal(await confirming, 'ACK_CUSTODY_ENDED', 'a confirmation went through under a link that was being removed');
      assert.equal(await count(`SELECT count(*) AS n FROM "AckReceipts" WHERE "requestId" = $1 AND "ackedAt" IS NOT NULL`, [gone.id]), 0);
    } finally {
      await remover.query('ROLLBACK').catch(() => undefined);
      await remover.end();
    }
    await link(g1, p2);

    // And the other way: a confirmation in flight holds the link, so the removal waits for it and the tap stands.
    const held = await service.create({ title: 'Håll', body: 'B', rule: 'ANY', studentIds: [p2.id] }, asAdmin);
    const tapping = await asGuardianConnection(g1);
    const deleting = new Client({ connectionString: process.env['PROBE_OWNER_URL'] });
    await deleting.connect();
    try {
      await tapping.query(`SELECT app.ack_confirm($1::uuid)`, [held.id]);
      const removal = deleting.query(`DELETE FROM "GuardianStudents" WHERE "guardianId" = $1 AND "studentId" = $2`, [g1.id, p2.id]);
      await waitUntilBlocked('DELETE FROM "GuardianStudents"');
      assert.equal(await count(`SELECT count(*) AS n FROM "GuardianStudents" WHERE "guardianId" = $1 AND "studentId" = $2`, [g1.id, p2.id]), 1, 'the link went under a confirmation');
      await tapping.query('COMMIT');
      await removal;
      assert.equal(await count(`SELECT count(*) AS n FROM "AckReceipts" WHERE "requestId" = $1 AND "ackedAt" IS NOT NULL`, [held.id]), 1, 'the tap made before the link went was lost');
    } finally {
      await tapping.query('ROLLBACK').catch(() => undefined);
      await tapping.end();
      await deleting.end();
    }
    await link(g1, p2);

    // The reminder pass and a confirmation: the pass leaves a request that is being confirmed, and a request being passed holds the confirmation.
    const due = await service.create({ title: 'Påminnelse och tryck', body: 'B', rule: 'ALL', studentIds: [p2.id] }, asAdmin);
    await owner.query(`UPDATE "AckRequests" SET "remindAt" = now() - interval '1 minute' WHERE id = $1`, [due.id]);
    await owner.query(`UPDATE "AckRequests" SET "remindAt" = now() + interval '1 day' WHERE "schoolId" = $1 AND id <> $2 AND "reminderSentAt" IS NULL`, [s, due.id]);
    const inFlight = await asGuardianConnection(g1);
    try {
      await inFlight.query(`SELECT app.ack_confirm($1::uuid)`, [due.id]);
      assert.deepEqual(await service.remind(), { reminded: 0 }, 'the pass asked a guardian who was confirming');
      assert.equal(await count(`SELECT count(*) AS n FROM "AckRequests" WHERE id = $1 AND "reminderSentAt" IS NOT NULL`, [due.id]), 0, 'the pass closed a request it had skipped');
      await inFlight.query('COMMIT');
    } finally {
      await inFlight.query('ROLLBACK').catch(() => undefined);
      await inFlight.end();
    }
    assert.deepEqual(await service.remind(), { reminded: 0 }, 'a guardian who had confirmed was reminded');
    assert.equal(await count(`SELECT count(*) AS n FROM "AckRequests" WHERE id = $1 AND "reminderSentAt" IS NOT NULL`, [due.id]), 1);
    const holder = new Client({ connectionString: process.env['PROBE_OWNER_URL'] });
    await holder.connect();
    try {
      const again = await service.create({ title: 'Pass håller', body: 'B', rule: 'ANY', studentIds: [p2.id] }, asAdmin);
      await holder.query('BEGIN');
      await holder.query(`SELECT 1 FROM "AckRequests" WHERE id = $1 FOR UPDATE`, [again.id]);
      const tap = service.confirm(again.id, asG(g1));
      await waitUntilBlocked('ack_confirm');
      await holder.query('COMMIT');
      await tap;
      assert.equal(await count(`SELECT count(*) AS n FROM "AckReceipts" WHERE "requestId" = $1 AND "ackedAt" IS NOT NULL`, [again.id]), 1);
    } finally {
      await holder.query('ROLLBACK').catch(() => undefined);
      await holder.end();
    }
  });

  await check('kh: the reminder: the guardian who has not confirmed, once, with nothing of the child in the e-mail', async () => {
    await owner.query(`UPDATE "AckRequests" SET "remindAt" = now() + interval '1 day' WHERE "schoolId" = $1 AND "reminderSentAt" IS NULL`, [s]);
    const r = await service.create({ title: 'Hemligt namn på utflykt', body: 'Elev Ett ska stanna hemma.', rule: 'ALL', studentIds: [p1.id] }, asAdmin);
    await service.confirm(r.id, asG(g1));
    await owner.query(`UPDATE "AckRequests" SET "remindAt" = now() - interval '1 hour' WHERE id = $1`, [r.id]);
    delivered.length = 0;
    assert.deepEqual(await service.remind(), { reminded: 1 });
    assert.equal(delivered.length, 1);
    const entry = delivered[0]!;
    assert.equal(entry.type, 'ACK_REMINDER');
    assert.deepEqual(entry.recipients.map((x) => x.userId), [g2.id], 'the guardian who had confirmed was reminded, or the one who had not was not');
    assert.deepEqual(entry.meta, {});
    const email = entry.email!;
    assert.ok(!email.body.includes('Hemligt') && !email.body.includes('Elev Ett') && !email.subject.includes('Hemligt'), 'the e-mail names the title or the child');
    assert.equal(email.recipients.length, 1);
    const row = await one<{ meta: { title: string } }>(`SELECT meta FROM "Notifications" WHERE type = 'ACK_REMINDER' AND "userId" = $1 AND meta ->> 'requestId' = $2`, [g2.id, r.id]);
    assert.equal(row.meta.title, 'Hemligt namn på utflykt', 'the inbox, behind the login, has the title');
    delivered.length = 0;
    assert.deepEqual(await service.remind(), { reminded: 0 }, 'the reminder went twice');
    assert.equal(delivered.length, 0);
    const detail = await service.detail(r.id, asAdmin);
    assert.equal(detail.reminderSentAt !== null, true);
    assert.ok(detail.pupils[0]!.guardians.find((g) => g.name.startsWith('g2'))!.remindedAt, 'staff are not told when the reminder went');
  });

  await check('ki: a request about two hundred pupils with two guardians each is one transaction that fits the gateway’s time', async () => {
    // KVITTENS_BIG=2000 measures the largest request the gateway takes (a whole school); CI uses two hundred.
    const big = Number(process.env['KVITTENS_BIG'] ?? 200);
    const many = await one<{ id: string }>(`INSERT INTO "StudentGroups" ("schoolId", "academicYearId", name, "gradeLevel", "updatedAt") VALUES ($1, $2, 'KV3', 7, now()) RETURNING id`, [s, year.id]);
    await owner.query(
      `INSERT INTO "Users" ("schoolId", email, "firstName", "lastName", role, "studentGroupId", "authId", "isActive", "updatedAt")
       SELECT $1, $2 || '-kv-big-p' || i || '@example.invalid', 'big', 'p' || i, 'STUDENT', $3, gen_random_uuid(), true, now() FROM generate_series(1, $4::int) i`,
      [s, marker, many.id, big]);
    await owner.query(
      `INSERT INTO "Users" ("schoolId", email, "firstName", "lastName", role, "authId", "isActive", "updatedAt")
       SELECT $1, $2 || '-kv-big-g' || i || '-' || j || '@example.invalid', 'big', 'g' || i || j, 'GUARDIAN', gen_random_uuid(), true, now() FROM generate_series(1, $3::int) i, generate_series(1, 2) j`,
      [s, marker, big]);
    await owner.query(
      `INSERT INTO "GuardianStudents" ("schoolId", "guardianId", "studentId")
       SELECT $1, g.id, p.id FROM "Users" p JOIN "Users" g ON g.email = $2 || '-kv-big-g' || substr(p."lastName", 2) || '-1@example.invalid' OR g.email = $2 || '-kv-big-g' || substr(p."lastName", 2) || '-2@example.invalid'
        WHERE p."schoolId" = $1 AND p.email LIKE $2 || '-kv-big-p%'`,
      [s, marker]);
    const ids = (await owner.query<{ id: string }>(`SELECT id FROM "Users" WHERE "schoolId" = $1 AND email LIKE $2 || '-kv-big-p%'`, [s, marker])).rows.map((r) => r.id);
    assert.equal(ids.length, big);
    const started = Date.now();
    const created = await service.create({ title: 'Hela årskursen', body: 'B', rule: 'ANY', studentIds: ids }, asAdmin);
    const elapsed = Date.now() - started;
    assert.equal(created.pupils, big);
    assert.equal(created.guardians, 2 * big);
    console.log(`    ki: ${big} pupils, ${2 * big} guardians, ${2 * big} receipts and ${2 * big} notices in ${elapsed} ms`);
    assert.ok(elapsed < 8000 * (big / 200), `the request took ${elapsed} ms against the gateway’s ten seconds`);
  });

  await sweepKvittensSchool(owner, marker);
}
