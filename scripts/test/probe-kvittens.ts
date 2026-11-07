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
 *       confirmation under a link being removed), the reminder pass and a confirmation,
 *       the reminder pass and a stop
 *   kh  the reminder, through the real pass: every guardian who has not confirmed, once,
 *       also when the other guardian has (so that no reminder tells), and nothing of the
 *       child, the title or the text in the e-mail
 *   ki  a request about two hundred pupils with two guardians each, in one transaction
 *   kj  ten requests about the whole school fall due at once: the pass takes them one at a
 *       time, each in a transaction of its own, so all ten are done; a request that fails
 *       is rolled back alone and the others are done; a pass out of time leaves the rest
 *   kk  stopping a reminder: the author, an administrator, nobody else; and a school that
 *       turns kvittens off stops the reminders that fall due while it is off
 *   kl  the limits: a person's eleventh request in an hour, and a school's receipts in a
 *       day, are 429s with their own codes through the adapter, and write nothing
 *   km  the lists are paged, and a read builds the policies' ids once per statement and
 *       calls no function per row of the school's requests
 *
 * Imported by prisma-adapter-probe.ts, which hands in its `check`.
 */
import { strict as assert } from 'node:assert';
import { randomUUID } from 'node:crypto';
import { ConflictException, ForbiddenException, HttpException, NotFoundException } from '@nestjs/common';
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
  // Who the owner's seeded requests are written by. The limit counts a person's requests in the last hour whoever wrote them,
  // so a probe that seeds dozens "by the administrator" would use up the administrator's ten.
  const seeder = await person('TEACHER', 'seeder');
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

  // The delivery is the gateway's own; here it records what was handed to it, and tells the listener how the batch went:
  // 'taken' at once, 'refused' at once, or 'held' (the batch sits in the queue until the check lets it go, or for good: a
  // process that stopped with it in its memory).
  const delivered: OutboxEntry[] = [];
  let channel: 'taken' | 'refused' | 'held' = 'taken';
  const held: Array<(delivered: boolean) => void> = [];
  const delivery = {
    wants: () => true,
    emailConfigured: () => true,
    enqueue: (batch: OutboxEntry[], settled?: (delivered: boolean) => void) => {
      delivered.push(...batch);
      if (!settled) return;
      if (channel === 'held') held.push(settled);
      else settled(channel === 'taken');
    },
  };
  const notifications = new NotificationsService(api, delivery as never);
  const service = new AckService(api, notifications);

  /**
   * A request written the owner's way: the people's limits (ten an hour, 20 000 receipts a day) are for logged-in
   * writers, and the races below need dozens of requests.
   */
  const seed = async (title: string, rule: 'ANY' | 'ALL', studentIds: string[], by: { id: string } = seeder): Promise<string> => {
    const row = await one<{ id: string }>(`INSERT INTO "AckRequests" ("schoolId", "authorId", title, body, rule) VALUES ($1, $2, $3, 'B', $4::"AckRule") RETURNING id`, [s, by.id, title, rule]);
    await owner.query(
      `INSERT INTO "AckReceipts" ("requestId", "schoolId", "studentId", "guardianId")
       SELECT $1, $2, gs."studentId", gs."guardianId" FROM "GuardianStudents" gs WHERE gs."schoolId" = $2 AND gs."studentId" = ANY ($3::uuid[])`,
      [row.id, s, studentIds]);
    return row.id;
  };
  /** The delivery's word that a reminder's mail was taken is recorded after the pass has returned: wait for it. */
  const untilMirrored = async (id: string): Promise<void> => {
    for (let attempt = 0; attempt < 100; attempt++) {
      if ((await one<{ m: Date | null }>(`SELECT "reminderMirroredAt" AS m FROM "AckRequests" WHERE id = $1`, [id])).m) return;
      await sleep(50);
    }
    assert.fail(`the delivery's word on ${id} was not recorded`);
  };
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
    const list = (await service.list(asAdmin)).items;
    assert.deepEqual(list.map((r) => [r.pupils, r.met, r.waiting]), [[2, 0, 3]]);
    assert.equal(list[0]!.reminder, 'SCHEDULED');
    await assert.rejects(() => service.list(asLasare).then(() => service.create({ title: 'T', body: 'B', rule: 'ANY', studentIds: [p1.id] }, asLasare)), 'a läsare wrote a request');
  });

  await check('kc: each guardian reads their own; one tap confirms both children at one time; nobody reads the other guardian’s tap', async () => {
    const mineG1 = (await service.mine(asG(g1))).items;
    assert.equal(mineG1.length, 1);
    assert.deepEqual(mineG1[0]!.children.map((c) => c.name.split(' ')[0]).sort(), ['p1', 'p2']);
    assert.equal(mineG1[0]!.authorName, 'admin Probe');
    assert.deepEqual((await service.mine(asG(g2))).items[0]!.children.map((c) => c.name.split(' ')[0]), ['p1']);
    assert.deepEqual((await service.mine(asG(g3))).items, [], 'a guardian who was not asked reads nothing');
    const first = await service.confirm(main, asG(g1));
    const second = await service.confirm(main, asG(g1));
    assert.equal(second.ackedAt, first.ackedAt, 'a second tap changed the time');
    assert.equal(await count(`SELECT count(DISTINCT "ackedAt") AS n FROM "AckReceipts" WHERE "requestId" = $1 AND "ackedAt" IS NOT NULL`, [main]), 1);
    const g2sees = (await service.mine(asG(g2))).items;
    assert.equal(g2sees[0]!.ackedAt, null);
    assert.ok(!JSON.stringify(g2sees).includes(g1.id) && !JSON.stringify(g2sees).includes(first.ackedAt), 'a guardian reads the other guardian’s confirmation');
    const state = await statusOf(main);
    assert.deepEqual(state['p2'], { met: true, guardians: ['g1:CONFIRMED'] });
    assert.deepEqual(state['p1']!.met, false);
    assert.deepEqual(state['p1']!.guardians.sort(), ['g1:CONFIRMED', 'g2:WAITING']);
    const row = (await service.list(asAdmin)).items.find((r) => r.id === main)!;
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
    assert.deepEqual((await service.list(asMentor2)).items.length, 0);
    assert.equal((await service.list(asMentor1)).items.length, 2);
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
    assert.deepEqual((await service.mine(asG(g2))).items, [], 'a guardian whose custody has ended still reads a request about the child');
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
    assert.equal((await service.mine(asG(g4))).items.length, 1);
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
      const r = { id: await seed(`Samtidigt ${round}`, 'ALL', [p1.id]) };
      await Promise.all([service.confirm(r.id, asG(g1)), service.confirm(r.id, asG(g2))]);
      assert.equal(await count(`SELECT count(*) AS n FROM "AckReceipts" WHERE "requestId" = $1 AND "ackedAt" IS NOT NULL`, [r.id]), 2, `round ${round}: a confirmation was lost`);
      assert.equal((await statusOf(r.id))['p1']!.met, true, `round ${round}: both confirmed and the pupil is not met`);
    }
    // One guardian taps twice at once: one time.
    const dbl = { id: await seed('Dubbeltryck', 'ANY', [p1.id, p2.id]) };
    const taps = await Promise.all([service.confirm(dbl.id, asG(g1)), service.confirm(dbl.id, asG(g1)), service.confirm(dbl.id, asG(g1))]);
    assert.equal(new Set(taps.map((t) => t.ackedAt)).size, 1, 'a double tap gave two times');
    assert.equal(await count(`SELECT count(DISTINCT "ackedAt") AS n FROM "AckReceipts" WHERE "requestId" = $1 AND "ackedAt" IS NOT NULL`, [dbl.id]), 1);

    // A link removed under a confirmation: the confirmation waits for the removal and then refuses.
    const gone = { id: await seed('Länk bort', 'ANY', [p2.id]) };
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
    const held = { id: await seed('Håll', 'ANY', [p2.id]) };
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
    const due = { id: await seed('Påminnelse och tryck', 'ALL', [p2.id]) };
    await owner.query(`UPDATE "AckRequests" SET "remindAt" = now() - interval '1 minute' WHERE id = $1`, [due.id]);
    await owner.query(`UPDATE "AckRequests" SET "remindAt" = now() + interval '1 day' WHERE "schoolId" = $1 AND id <> $2 AND "reminderOutcome" IS NULL`, [s, due.id]);
    const inFlight = await asGuardianConnection(g1);
    try {
      await inFlight.query(`SELECT app.ack_confirm($1::uuid)`, [due.id]);
      const skipped = await service.remind();
      assert.equal(skipped.reminded, 0, 'the pass asked a guardian who was confirming');
      assert.equal(skipped.failed, 0, 'the pass waited for the confirmation, or failed on it');
      assert.equal(await count(`SELECT count(*) AS n FROM "AckRequests" WHERE id = $1 AND "reminderOutcome" IS NOT NULL`, [due.id]), 0, 'the pass closed a request it had skipped');
      await inFlight.query('COMMIT');
    } finally {
      await inFlight.query('ROLLBACK').catch(() => undefined);
      await inFlight.end();
    }
    assert.equal((await service.remind()).reminded, 0, 'a guardian who had confirmed was reminded');
    assert.equal(await count(`SELECT count(*) AS n FROM "AckRequests" WHERE id = $1 AND "reminderOutcome" = 'NOT_NEEDED'`, [due.id]), 1, 'nobody was left to remind, and the request does not say so');

    // The pass and a stop: the pass in flight holds the request, the stop waits for it and answers what the pass made of it
    // (SENT: a reminder that has gone cannot be called back); a stop made first stands, and the pass finds the request stopped.
    const racing = { id: await seed('Pass och stopp', 'ANY', [p3.id], mentor2) };
    await owner.query(`UPDATE "AckRequests" SET "remindAt" = now() - interval '1 minute' WHERE id = $1`, [racing.id]);
    const passing = new Client({ connectionString: process.env['PROBE_OWNER_URL'] });
    await passing.connect();
    try {
      await passing.query('BEGIN');
      await passing.query(`SELECT * FROM app.ack_remind_request($1::uuid)`, [racing.id]);
      const stopping = service.stopReminder(racing.id, asMentor2);
      await waitUntilBlocked('ack_stop_reminder');
      await passing.query('COMMIT');
      assert.deepEqual(await stopping, { reminder: 'SENT' }, 'a stop made after the reminder went called it back, or said it had stopped it');
    } finally {
      await passing.query('ROLLBACK').catch(() => undefined);
      await passing.end();
    }
    const first = { id: await seed('Stopp före pass', 'ANY', [p3.id], mentor2) };
    await owner.query(`UPDATE "AckRequests" SET "remindAt" = now() - interval '1 minute' WHERE id = $1`, [first.id]);
    assert.deepEqual(await service.stopReminder(first.id, asMentor2), { reminder: 'STOPPED' });
    const afterStop = await service.remind();
    assert.equal(afterStop.reminded, 0, 'the pass reminded a request that had been stopped');
    assert.equal(await count(`SELECT count(*) AS n FROM "AckRequests" WHERE id = $1 AND "reminderOutcome" = 'STOPPED'`, [first.id]), 1, 'the pass changed a stop');
    const holder = new Client({ connectionString: process.env['PROBE_OWNER_URL'] });
    await holder.connect();
    try {
      const again = { id: await seed('Pass håller', 'ANY', [p2.id]) };
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

  await check('kh: the reminder: every guardian who has not confirmed, once, with nothing of the child in the e-mail', async () => {
    await owner.query(`UPDATE "AckRequests" SET "remindAt" = now() + interval '1 day' WHERE "schoolId" = $1 AND "reminderOutcome" IS NULL`, [s]);
    const r = await service.create({ title: 'Hemligt namn på utflykt', body: 'Elev Ett ska stanna hemma.', rule: 'ALL', studentIds: [p1.id] }, asAdmin);
    await service.confirm(r.id, asG(g1));
    await owner.query(`UPDATE "AckRequests" SET "remindAt" = now() - interval '1 hour' WHERE id = $1`, [r.id]);
    delivered.length = 0;
    const pass = await service.remind();
    assert.deepEqual([pass.reminded, pass.requests, pass.failed, pass.left], [1, 1, 0, 0]);
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
    assert.equal((await service.remind()).reminded, 0, 'the reminder went twice');
    assert.equal(delivered.length, 0);
    await untilMirrored(r.id);
    const detail = await service.detail(r.id, asAdmin);
    assert.equal(detail.reminder, 'SENT');
    assert.equal(detail.reminderSentAt !== null, true);
    assert.equal(detail.reminderMirroredAt !== null, true);
    assert.equal(detail.mayStopReminder, false, 'a reminder that has gone can be stopped');
    assert.ok(detail.pupils[0]!.guardians.find((g) => g.name.startsWith('g2'))!.remindedAt, 'staff are not told when the reminder went');

    // ANY: g1 has confirmed and the pupil is met, and g2 is reminded all the same. A missing reminder would tell g2 that
    // the other guardian has answered, which a guardian whose other parent is hidden from them must never learn.
    const any = { id: await seed('Räcker en', 'ANY', [p1.id]) };
    await service.confirm(any.id, asG(g1));
    await owner.query(`UPDATE "AckRequests" SET "remindAt" = now() - interval '1 hour' WHERE id = $1`, [any.id]);
    delivered.length = 0;
    assert.equal((await service.remind()).reminded, 1, 'the guardian who had not confirmed was not reminded because the other had');
    assert.deepEqual(delivered[0]!.recipients.map((x) => x.userId), [g2.id]);
    await untilMirrored(any.id);
    assert.equal((await service.list(asAdmin)).items.find((x) => x.id === any.id)!.reminder, 'SENT');
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

  await check('kj: ten requests about the whole school fall due at once: one at a time, each in its own transaction, none holds up the others', async () => {
    const pupils = (await owner.query<{ id: string }>(`SELECT id FROM "Users" WHERE "schoolId" = $1 AND email LIKE $2 || '-kv-big-p%'`, [s, marker])).rows.map((r) => r.id);
    assert.ok(pupils.length >= 100, 'ki did not make the pupils of a school');
    await owner.query(`UPDATE "AckRequests" SET "remindAt" = now() + interval '1 day' WHERE "schoolId" = $1 AND "reminderOutcome" IS NULL`, [s]);
    const ids: string[] = [];
    for (let i = 1; i <= 10; i++) ids.push(await seed(`Hel skola ${i}`, 'ANY', pupils, loner));
    await owner.query(`UPDATE "AckRequests" SET "remindAt" = now() - interval '1 hour' WHERE id = ANY ($1::uuid[])`, [ids]);
    delivered.length = 0;
    const started = Date.now();
    const pass = await service.remind();
    const elapsed = Date.now() - started;
    console.log(`    kj: ${ids.length} requests of ${2 * pupils.length} guardians each reminded in ${elapsed} ms (${pass.reminded} notices)`);
    assert.deepEqual([pass.requests, pass.failed, pass.left], [10, 0, 0]);
    assert.equal(pass.reminded, 10 * 2 * pupils.length);
    assert.equal(await count(`SELECT count(*) AS n FROM "AckRequests" WHERE id = ANY ($1::uuid[]) AND "reminderOutcome" = 'SENT' AND "reminderSentAt" IS NOT NULL`, [ids]), 10);
    assert.equal(delivered.length, 10, 'the delivery got one entry per request, after each commit');

    // A request that fails is rolled back alone: the ones before and after it are done, and it is done by the pass after.
    const [before, failing, after] = [await seed('Före', 'ANY', [p3.id], mentor2), await seed('Felande', 'ANY', [p3.id], mentor2), await seed('Efter', 'ANY', [p3.id], mentor2)];
    for (const [hours, id] of [[3, before], [2, failing], [1, after]] as const) await owner.query(`UPDATE "AckRequests" SET "remindAt" = now() - make_interval(hours => $2) WHERE id = $1`, [id, hours]);
    await owner.query(`CREATE FUNCTION public.kv_probe_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'probe: forced failure' USING ERRCODE = 'XX001'; END $$`);
    await owner.query(`CREATE TRIGGER kv_probe_fail BEFORE INSERT ON "Notifications" FOR EACH ROW WHEN (NEW.type = 'ACK_REMINDER' AND NEW.meta ->> 'title' = 'Felande') EXECUTE FUNCTION public.kv_probe_fail()`);
    try {
      const broken = await service.remind();
      assert.deepEqual([broken.requests, broken.failed, broken.left, broken.reminded], [2, 1, 0, 2], 'the request that failed stopped the ones after it, or went unreported');
      assert.equal(await count(`SELECT count(*) AS n FROM "AckRequests" WHERE id = ANY ($1::uuid[]) AND "reminderOutcome" = 'SENT'`, [[before, after]]), 2);
      assert.equal(await count(`SELECT count(*) AS n FROM "AckRequests" WHERE id = $1 AND "reminderOutcome" IS NULL AND "reminderSentAt" IS NULL`, [failing]), 1, 'a request that failed was marked');
      assert.equal(await count(`SELECT count(*) AS n FROM "AckReceipts" WHERE "requestId" = $1 AND "remindedAt" IS NOT NULL`, [failing]), 0, 'a request that failed left a receipt reminded: its guardian is never reminded');
    } finally {
      await owner.query(`DROP TRIGGER IF EXISTS kv_probe_fail ON "Notifications"`);
      await owner.query(`DROP FUNCTION IF EXISTS public.kv_probe_fail()`);
    }
    delivered.length = 0;
    const retried = await service.remind();
    assert.deepEqual([retried.requests, retried.failed, retried.reminded], [1, 0, 1], 'the request that failed was not done by the next pass');
    assert.equal(delivered.length, 1);

    // A pass out of time leaves what it has not reached, counted, for the next.
    const late = await seed('Sen', 'ANY', [p3.id], mentor2);
    await owner.query(`UPDATE "AckRequests" SET "remindAt" = now() - interval '1 minute' WHERE id = $1`, [late]);
    const none = await service.remind(0);
    assert.deepEqual([none.requests, none.reminded, none.left], [0, 0, 1]);
    assert.equal(await count(`SELECT count(*) AS n FROM "AckRequests" WHERE id = $1 AND "reminderOutcome" IS NULL`, [late]), 1);
    assert.equal((await service.remind()).reminded, 1);
  });

  await check('kk: stopping a reminder: the author, an administrator, nobody else; and kvittens turned off stops the reminders that fall due', async () => {
    const r = await service.create({ title: 'Fel text', body: 'B', rule: 'ANY', studentIds: [p1.id] }, asMentor1);
    const detailOf = (who: AuthenticatedUser) => service.detail(r.id, who);
    assert.deepEqual([(await detailOf(asMentor1)).reminder, (await detailOf(asMentor1)).mayStopReminder], ['SCHEDULED', true]);
    assert.equal((await detailOf(asAdmin)).mayStopReminder, true);
    assert.equal((await detailOf(asLasare)).mayStopReminder, false, 'a läsare is told she may stop a reminder');
    const refused = (who: AuthenticatedUser, type: new (...args: never[]) => object) => assert.rejects(() => service.stopReminder(r.id, who), (error: unknown) => error instanceof type);
    await refused(asMentor2, NotFoundException);
    await refused(asLoner, NotFoundException);
    await refused(asLasare, ForbiddenException);
    await refused(asG(g1), ForbiddenException);
    assert.deepEqual(await service.stopReminder(r.id, asMentor1), { reminder: 'STOPPED' });
    assert.deepEqual(await service.stopReminder(r.id, asMentor1), { reminder: 'STOPPED' }, 'stopping twice');
    assert.deepEqual([(await detailOf(asAdmin)).reminder, (await detailOf(asAdmin)).mayStopReminder], ['STOPPED', false]);
    assert.equal((await service.list(asAdmin)).items.find((x) => x.id === r.id)!.reminder, 'STOPPED');
    await owner.query(`UPDATE "AckRequests" SET "remindAt" = now() - interval '1 hour' WHERE id = $1`, [r.id]);
    delivered.length = 0;
    assert.equal((await service.remind()).reminded, 0, 'a stopped reminder went');
    assert.equal(delivered.length, 0);

    // Turned off, the reminder that falls due is not sent, now or when it is turned on again; it says so.
    const off = await service.create({ title: 'Avstängd', body: 'B', rule: 'ANY', studentIds: [p1.id] }, asAdmin);
    await owner.query(`UPDATE "AckRequests" SET "remindAt" = now() - interval '1 hour' WHERE id = $1`, [off.id]);
    await service.updateSettings({ enabled: false }, asAdmin);
    try {
      assert.equal((await service.remind()).reminded, 0, 'a reminder went in a school that has turned kvittens off');
      assert.equal((await service.detail(off.id, asAdmin)).reminder, 'OFF');
    } finally {
      await service.updateSettings({ enabled: true }, asAdmin);
    }
    assert.equal((await service.remind()).reminded, 0, 'turned on again, the reminder that fell due while it was off was sent');
  });

  await check('kl: the limits are 429s with their own codes through the adapter, and write nothing', async () => {
    const sender = await person('SCHOOL_ADMIN', 'sender', { adminProfile: 'FULL' });
    const asSender = as(sender, Role.SCHOOL_ADMIN, 'FULL');
    // The checks above wrote nine requests as the administrator, so the colleague (a person of their own) writes the rest.
    const colleague = await person('SCHOOL_ADMIN', 'colleague', { adminProfile: 'FULL' });
    const asColleague = as(colleague, Role.SCHOOL_ADMIN, 'FULL');
    const body = { body: 'B', rule: 'ANY' as const, studentIds: [p3.id] };
    for (let i = 1; i <= 10; i++) await service.create({ ...body, title: `Gräns ${i}` }, asSender);
    const refusedWith = async (run: () => Promise<unknown>, code: string) =>
      assert.rejects(run, (error: unknown) => {
        assert.ok(error instanceof HttpException, `not a 429: ${String(error)}`);
        assert.equal(error.getStatus(), 429);
        assert.equal((error.getResponse() as { code: string }).code, code);
        return true;
      });
    const notices = () => count(`SELECT count(*) AS n FROM "Notifications" WHERE "schoolId" = $1 AND type = 'ACK_REQUESTED'`, [s]);
    const noticesBefore = await notices();
    await refusedWith(() => service.create({ ...body, title: 'Gräns 11' }, asSender), 'ACK_TOO_MANY_REQUESTS');
    assert.equal(await count(`SELECT count(*) AS n FROM "AckRequests" WHERE title = 'Gräns 11'`), 0);
    assert.equal(await notices(), noticesBefore, 'the refused request wrote notices');
    // The limit is the sender's: a colleague writes on.
    await service.create({ ...body, title: 'Kollegan' }, asColleague);

    // The school's day: what the school asked before is moved out of the day, the owner brings the last 24 hours to 19 999 receipts,
    // and a request that would make 20 001 is refused whole.
    await owner.query(`UPDATE "AckReceipts" SET "createdAt" = now() - interval '30 hours' WHERE "schoolId" = $1`, [s]);
    let wanted = 19999;
    while (wanted > 0) {
      const bulk = await seed('Dygnets underlag', 'ANY', [], loner);
      const written = await owner.query(
        `INSERT INTO "AckReceipts" ("requestId", "schoolId", "studentId", "guardianId")
         SELECT $1, $2, p.id, g.id
           FROM (SELECT id FROM "Users" WHERE "schoolId" = $2 AND role = 'STUDENT') p CROSS JOIN (SELECT id FROM "Users" WHERE "schoolId" = $2 AND role = 'GUARDIAN') g LIMIT $3`,
        [bulk, s, wanted]);
      wanted -= written.rowCount ?? 0;
    }
    const requestsBefore = await count(`SELECT count(*) AS n FROM "AckRequests" WHERE "schoolId" = $1`, [s]);
    const noticesNow = await notices();
    await refusedWith(() => service.create({ title: 'Över dygnet', body: 'B', rule: 'ANY', studentIds: [p1.id] }, asColleague), 'ACK_TOO_MANY_RECIPIENTS');
    assert.equal(await count(`SELECT count(*) AS n FROM "AckRequests" WHERE "schoolId" = $1`, [s]), requestsBefore, 'the refused request was written');
    assert.equal(await notices(), noticesNow);
    await service.create({ title: 'Dygnets sista', body: 'B', rule: 'ANY', studentIds: [p3.id] }, asColleague);
    await refusedWith(() => service.create({ title: 'Dygnets en för mycket', body: 'B', rule: 'ANY', studentIds: [p3.id] }, asColleague), 'ACK_TOO_MANY_RECIPIENTS');
    // The day moves on.
    await owner.query(`UPDATE "AckReceipts" SET "createdAt" = now() - interval '25 hours' WHERE "schoolId" = $1`, [s]);
    await service.create({ title: 'Nästa dygn', body: 'B', rule: 'ANY', studentIds: [p1.id] }, asColleague);
  });

  await check('km: the lists are paged, and a read builds the policies’ ids once and calls no function per row of the school’s requests', async () => {
    // Paging: every request once, newest first, the last page says so.
    const page = async <T extends { id: string }>(read: (query: { after?: string; limit: number }) => Promise<{ items: T[]; next: string | null }>, limit: number): Promise<string[]> => {
      const seen: string[] = [];
      for (let after: string | undefined, rounds = 0; rounds < 100; rounds++) {
        const got = await read({ limit, ...(after ? { after } : {}) });
        assert.ok(got.items.length <= limit);
        seen.push(...got.items.map((item) => item.id));
        if (got.next === null) return seen;
        assert.equal(got.next, got.items[got.items.length - 1]!.id);
        after = got.next;
      }
      return assert.fail('a list that never ends');
    };
    for (let i = 0; i < 7; i++) {
      const id = await seed(`Sida ${i}`, 'ANY', [p3.id], mentor2);
      await owner.query(`UPDATE "AckRequests" SET "createdAt" = now() - make_interval(hours => $2) WHERE id = $1`, [id, 100 + i]);
    }
    const mineAll = (await owner.query<{ id: string }>(`SELECT DISTINCT "requestId" AS id FROM "AckReceipts" WHERE "guardianId" = $1`, [g3.id])).rows.map((r) => r.id);
    const mine = await page((query) => service.mine(asG(g3), query), 3);
    assert.equal(new Set(mine).size, mine.length, 'a request on two pages');
    assert.deepEqual([...mine].sort(), [...mineAll].sort(), 'the pages are not the guardian’s requests');
    assert.deepEqual(mine, (await service.mine(asG(g3), { limit: 100 })).items.map((x) => x.id), 'the order depends on the size of the page');
    const everything = (await owner.query<{ id: string }>(`SELECT id FROM "AckRequests" WHERE "schoolId" = $1`, [s])).rows.map((r) => r.id);
    const listed = await page((query) => service.list(asAdmin, query), 7);
    assert.equal(new Set(listed).size, listed.length);
    assert.deepEqual([...listed].sort(), [...everything].sort());
    assert.equal((await service.mine(asG(g3), { limit: 1 })).next, mine[0]);
    const nothing = await service.mine(asG(g3), { after: randomUUID(), limit: 5 });
    assert.deepEqual([nothing.items, nothing.next], [[], null], 'a cursor that is no request of theirs gave something');

    // The cost: the school gets many requests the guardian is not asked about, and the guardian's read calls the policies' ids once
    // and no function per row of the school (the plan still filters the school's requests by the array, linearly, but a row
    // costs a fraction of a microsecond and not a function call). Counted in the database's own function statistics, in a
    // transaction of its own.
    const others = Number(process.env['KVITTENS_REQUESTS'] ?? 300);
    await owner.query(
      `INSERT INTO "AckRequests" ("schoolId", "authorId", title, body) SELECT $1, $2, 'Andras ' || i, 'B' FROM generate_series(1, $3::int) i`,
      [s, loner.id, others]);
    await owner.query(
      `INSERT INTO "AckReceipts" ("requestId", "schoolId", "studentId", "guardianId")
       SELECT q.id, $1, $2, $3 FROM "AckRequests" q WHERE q."schoolId" = $1 AND q.title LIKE 'Andras %'`,
      [s, p4.id, g4.id]);
    const readCalls = async (who: { authId: string }): Promise<Record<string, number>> => {
      const client = new Client({ connectionString: process.env['PROBE_OWNER_URL'] });
      await client.connect();
      try {
        await client.query('BEGIN');
        await client.query(`SET LOCAL track_functions = 'all'`);
        await client.query(`SET LOCAL ROLE app_authenticated`);
        await client.query(`SELECT set_config('request.jwt.claims', $1, true), set_config('app.chosen_school_id', $2, true)`, [JSON.stringify({ sub: who.authId }), s]);
        await client.query(`SELECT count(*) FROM "AckRequests"`);
        await client.query(`SELECT count(*) FROM "AckReceipts"`);
        await client.query('RESET ROLE');
        const rows = await client.query<{ funcname: string; calls: string }>(`SELECT funcname, calls FROM pg_stat_xact_user_functions WHERE schemaname = 'app' AND funcname LIKE 'ack\\_%'`);
        return Object.fromEntries(rows.rows.map((r) => [r.funcname, Number(r.calls)]));
      } finally {
        await client.query('ROLLBACK').catch(() => undefined);
        await client.end();
      }
    };
    const guardianCalls = await readCalls(g3);
    assert.equal(guardianCalls['ack_my_request_ids'], 1, `the guardian's ids were built ${guardianCalls['ack_my_request_ids']} times`);
    assert.ok(Object.values(guardianCalls).reduce((sum, n) => sum + n, 0) <= 4, `a guardian's read called ${JSON.stringify(guardianCalls)} in a school of ${others}+ requests`);
    const teacherCalls = await readCalls(mentor2);
    assert.equal(teacherCalls['ack_mentee_request_ids'], 1, `the teacher's ids were built ${teacherCalls['ack_mentee_request_ids']} times`);
    assert.equal(teacherCalls['ack_authored_request_ids'], 1);
    assert.ok(Object.values(teacherCalls).reduce((sum, n) => sum + n, 0) <= 8, `a teacher's read called ${JSON.stringify(teacherCalls)}`);
    const t0 = Date.now();
    const got = await service.mine(asG(g3));
    console.log(`    km: a guardian with ${mineAll.length} of ${others + everything.length} requests reads the page in ${Date.now() - t0} ms (${JSON.stringify(guardianCalls)})`);
    assert.ok(got.items.length > 0);
  });

  await check('kn: a reminder is WRITTEN until the delivery says its mail was taken, and SENT after; a refusal or a lost batch leaves it WRITTEN, and nothing sends it again', async () => {
    await service.updateSettings({ enabled: true }, asAdmin);
    const due = async (title: string): Promise<string> => {
      const id = await seed(title, 'ANY', [p3.id], mentor2);
      await owner.query(`UPDATE "AckRequests" SET "remindAt" = now() - interval '1 hour' WHERE id = $1`, [id]);
      return id;
    };
    const stateOf = async (id: string) => (await service.list(asAdmin, { limit: 100 })).items.find((x) => x.id === id)?.reminder;
    const row = (id: string) => one<{ o: string; m: Date | null; t: Date | null }>(`SELECT "reminderOutcome" AS o, "reminderMirroredAt" AS m, "reminderSentAt" AS t FROM "AckRequests" WHERE id = $1`, [id]);

    // Held: the notices are written and the database says SENT, but the mail has not gone, and the page says so.
    channel = 'held';
    held.length = 0;
    const slow = await due('Brevet är på väg');
    await service.remind();
    const waiting = await row(slow);
    assert.equal(waiting.o, 'SENT');
    assert.ok(waiting.t, 'the notices were written');
    assert.equal(waiting.m, null, 'the mail was recorded as taken before the delivery said so');
    assert.equal(await stateOf(slow), 'WRITTEN');
    assert.ok(held.length >= 1);
    // The delivery says it went: SENT, once, and the time is recorded after the notices.
    for (const settled of held.splice(0)) settled(true);
    await untilMirrored(slow);
    assert.equal(await stateOf(slow), 'SENT');
    const done = await row(slow);
    assert.ok(done.m! >= done.t!, 'the mail went before the notices were written');

    // Refused: a channel that did not take the batch leaves the request WRITTEN, and nothing records otherwise.
    channel = 'refused';
    const refused = await due('Brevet togs inte emot');
    await service.remind();
    await sleep(300);
    assert.equal((await row(refused)).m, null);
    assert.equal(await stateOf(refused), 'WRITTEN');

    // Lost: the batch was in the queue of a process that stopped; its word never comes.
    channel = 'held';
    held.length = 0;
    const lost = await due('Processen stoppades');
    await service.remind();
    await sleep(300);
    assert.equal(await stateOf(lost), 'WRITTEN');
    held.length = 0;

    // Neither is sent again: the pass does not take a request that is SENT, WRITTEN or not.
    channel = 'taken';
    delivered.length = 0;
    assert.equal((await service.remind()).reminded, 0);
    assert.equal(delivered.length, 0);
    // A logged-in administrator cannot record the delivery's word either: the function answers nothing to a login that is a person.
    await api.withRls(asAdmin, (tx) => tx.$executeRaw`SELECT app.ack_reminder_mirrored(${refused}::uuid)`);
    assert.equal((await row(refused)).m, null, 'a logged-in administrator recorded the delivery’s word');
  });

  await check('ko: a sender’s share of the day is a 429 of its own through the adapter, and the usage page reads the numbers', async () => {
    await service.updateSettings({ enabled: true }, asAdmin);
    const share = 2000;
    const before = (await service.usage(asMentor1)).mine;
    assert.equal(before.limit, share, 'a teacher’s share is 2 000');
    // The owner (no login: not counted against) brings her to three short of her share, five hours ago, so the hour's limit is not in play.
    const bulk = await one<{ id: string }>(
      `INSERT INTO "AckRequests" ("schoolId", "authorId", title, body, "createdAt") VALUES ($1, $2, 'Andelens underlag', 'B', now() - interval '5 hours') RETURNING id`,
      [s, mentor1.id]);
    await owner.query(
      `INSERT INTO "AckReceipts" ("requestId", "schoolId", "studentId", "guardianId")
       SELECT $1, $2, p.id, g.id FROM (SELECT id FROM "Users" WHERE "schoolId" = $2 AND role = 'STUDENT') p CROSS JOIN (SELECT id FROM "Users" WHERE "schoolId" = $2 AND role = 'GUARDIAN') g LIMIT $3`,
      [bulk.id, s, share - 3 - before.used]);
    assert.equal((await service.usage(asMentor1)).mine.used, share - 3);

    // P1 and P2 have three guardians between them (G1 and G2 for P1, G1 for P2): the 2 000th receipt is allowed, the next is not.
    const body = { body: 'B', rule: 'ANY' as const, studentIds: [p1.id, p2.id] };
    await service.create({ ...body, title: 'Den 2 000:e' }, asMentor1);
    const requests = await count(`SELECT count(*) AS n FROM "AckRequests" WHERE "schoolId" = $1`, [s]);
    const notices = () => count(`SELECT count(*) AS n FROM "Notifications" WHERE "schoolId" = $1 AND type = 'ACK_REQUESTED'`, [s]);
    const noticesBefore = await notices();
    await assert.rejects(() => service.create({ ...body, title: 'Över andelen' }, asMentor1), (error: unknown) => {
      assert.ok(error instanceof HttpException, `not a 429: ${String(error)}`);
      assert.equal(error.getStatus(), 429);
      assert.equal((error.getResponse() as { code: string }).code, 'ACK_SENDER_DAY_LIMIT');
      return true;
    });
    assert.equal(await count(`SELECT count(*) AS n FROM "AckRequests" WHERE "schoolId" = $1`, [s]), requests, 'the refused request was written');
    assert.equal(await notices(), noticesBefore, 'the refused request wrote notices');
    // The share is hers: the other mentor and an administrator write on, and the school has room (its own limit is 20 000).
    await service.create({ title: 'Kollegan', body: 'B', rule: 'ANY', studentIds: [p3.id] }, asMentor2);

    // What the page reads: an administrator the school, their share and the senders; the teacher only her own.
    const mine = await service.usage(asMentor1);
    assert.deepEqual([mine.school, mine.mine, mine.senders], [null, { used: share, limit: share }, null]);
    const admins = await service.usage(asAdmin);
    assert.equal(admins.school!.limit, 20000);
    assert.ok(admins.school!.used >= share, 'the school’s day is less than one teacher’s');
    assert.equal(admins.mine.limit, 8000);
    assert.deepEqual(admins.senders!.find((x) => x.name.startsWith('mentor1')), { name: 'mentor1 Probe', used: share, limit: share });
    assert.ok(admins.senders!.length <= 5);
    assert.deepEqual((await service.usage(asLasare)).mine.limit, 8000, 'an administrator who only reads Drift reads the usage');
    await assert.rejects(() => service.usage(asG(g1)), ForbiddenException);
  });

  await sweepKvittensSchool(owner, marker);
}
