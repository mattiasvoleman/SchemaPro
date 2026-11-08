/**
 * The adapter probe's checks for Checklistor (20270129090000–20270129091000), through the real
 * InstructionService, ConsentService and AckService on the API's role, against real Postgres as CI runs it.
 * The RLS sections 430-434 prove what the arms, the triggers and the functions do; this proves what the gateway and
 * the adapter make of them: the casts of the uuid arrays, the refusals read back by SQLSTATE and by name, the
 * Kvittens request a consent is asked through and the answer its last confirmation writes, and the races, with real
 * concurrent connections. In a school of its own (slug <marker>-checklistor), swept whole before and after:
 *
 *   ca  the templates: an administrator makes and retires them, a teacher and a läsare cannot, a moment is named once
 *   cb  the groups and the roster: a teacher's own, a mentor's to look at, an administrator's all; the roster is read
 *       and recorded in the läslogg, the lists of templates and groups name nobody and are not
 *   cc  ticking: a teacher ticks the pupils they teach and no others, a second tick of the day is counted and not
 *       written, a colleague can be named as the instructor and a guardian cannot, a retired template and a day to come
 *       are refused with their codes
 *   cd  voiding: the writer, nobody else's, a reason is needed, the tick stays and the card says who and why
 *   ce  the proof is the pupil's: a change of class and a pupil who has left keep it, and a pupil who has left cannot be ticked
 *   cf  a consent list: a mentor makes one for their class and not another's; paper answers; a withdrawal is the list's
 *       state at once; a teacher who only teaches the pupil reads and writes nothing of a consent
 *   cg  the guardians asked through Kvittens (the rule ALL): the answer is written when the last guardian has confirmed,
 *       a request that is no consent's writes nothing, a withdrawn consent can be asked for again
 *   ch  a pupil marked as having a protected identity is named on the screen, as the register names them, and is left out of
 *       the sheet for paper (and counted), which a teacher, who cannot read the marks, prints too
 *   ci  races: two guardians confirm at once (ten rounds, one answer each), a list closed under writers (no answer
 *       after the close), the same tick twice at once (one proof)
 *   cj  a withdrawal staff write while a request is open is not undone by the request's last confirmation (the
 *       pupil stays withdrawn and the guardian's confirmation is not lost); asking again grants it
 *
 * Imported by prisma-adapter-probe.ts, which hands in its `check`.
 */
import { strict as assert } from 'node:assert';
import { randomUUID } from 'node:crypto';
import { HttpException } from '@nestjs/common';
import { Client } from 'pg';
import { AckService } from '../../src/ack/ack.service';
import { Role } from '../../src/auth/enums/role.enum';
import type { AuthenticatedUser } from '../../src/auth/interfaces/authenticated-user.interface';
import { CONSENT_FOOTER } from '../../src/checklists/checklists';
import { ConsentService } from '../../src/checklists/consent.service';
import { InstructionService } from '../../src/checklists/instruction.service';
import type { PrismaService } from '../../src/database/prisma.service';
import type { OutboxEntry } from '../../src/notifications/notification-outbox';
import { NotificationsService } from '../../src/notifications/notifications.service';

type Check = (label: string, body: () => Promise<void>) => Promise<void>;

export function checklistorSlug(marker: string): string {
  return `${marker}-checklistor`;
}

export async function sweepChecklistorSchool(owner: Client, marker: string): Promise<void> {
  await owner.query(`DELETE FROM "Schools" WHERE slug = $1`, [checklistorSlug(marker)]);
}

/** A refusal the gateway answers: the HTTP status and the code. */
const refusedWith = (status: number, code: string) => (error: unknown) => {
  assert.ok(error instanceof HttpException, `not an HTTP refusal: ${String(error)}`);
  assert.equal(error.getStatus(), status, `status ${error.getStatus()} (${JSON.stringify(error.getResponse())})`);
  assert.equal((error.getResponse() as { code?: string }).code, code, JSON.stringify(error.getResponse()));
  return true;
};

export async function checklistorChecks(owner: Client, api: PrismaService, marker: string, check: Check): Promise<void> {
  await sweepChecklistorSchool(owner, marker);
  const one = async <T extends object>(sql: string, params: unknown[] = []): Promise<T> => (await owner.query<T>(sql, params)).rows[0]!;
  const count = async (sql: string, params: unknown[] = []): Promise<number> => Number((await one<{ n: string }>(sql, params)).n);
  const today = (await one<{ d: string }>(`SELECT ((now() AT TIME ZONE 'Europe/Stockholm')::date)::text AS d`)).d;
  const daysAgo = async (n: number) => (await one<{ d: string }>(`SELECT (($1::date) - $2::int)::text AS d`, [today, n])).d;
  // Days the checks use inside arrow functions, which cannot await.
  const inThreeDays = await daysAgo(-3);
  const dayMinus = { 2: await daysAgo(2), 3: await daysAgo(3), 4: await daysAgo(4), 9: await daysAgo(9), 30: await daysAgo(30) };

  const school = await one<{ id: string }>(
    `INSERT INTO "Schools" (name, slug, timezone, "updatedAt") VALUES ($1, $2, 'Europe/Stockholm', now()) RETURNING id`,
    [`${marker} checklistor`, checklistorSlug(marker)],
  );
  const s = school.id;
  const year = await one<{ id: string }>(
    `INSERT INTO "AcademicYears" ("schoolId", name, "startDate", "endDate", "isActive", "updatedAt")
     VALUES ($1, 'cl probe', $2::date - 200, $2::date + 200, true, now()) RETURNING id`,
    [s, today],
  );
  const group = async (name: string, kind = 'CLASS') =>
    (
      await one<{ id: string }>(
        `INSERT INTO "StudentGroups" ("schoolId", "academicYearId", name, kind, "gradeLevel", "updatedAt") VALUES ($1, $2, $3, $4::"StudentGroupKind", 7, now()) RETURNING id`,
        [s, year.id, name, kind],
      )
    ).id;
  const cl1 = await group('CLP1');
  const cl2 = await group('CLP2');
  const tg = await group('CLPSLJ', 'TEACHING_GROUP');
  const subject = await one<{ id: string }>(`INSERT INTO "Subjects" ("schoolId", name, code, "updatedAt") VALUES ($1, 'Slöjd', 'CLPS', now()) RETURNING id`, [s]);
  const person = async (role: string, label: string, extra: { adminProfile?: string; group?: string } = {}) => {
    const authId = randomUUID();
    const row = await one<{ id: string }>(
      `INSERT INTO "Users" ("schoolId", email, "firstName", "lastName", role, "adminProfile", "studentGroupId", "authId", "isActive", "updatedAt")
       VALUES ($1, $2, $3, 'Probe', $4::"UserRole", $5::"AdminProfile", $6, $7, true, now()) RETURNING id`,
      [s, `${marker}-cl-${label}@example.invalid`, label, role, extra.adminProfile ?? null, extra.group ?? null, authId],
    );
    return { id: row.id, authId };
  };
  const admin = await person('SCHOOL_ADMIN', 'admin', { adminProfile: 'FULL' });
  const lasare = await person('SCHOOL_ADMIN', 'lasare', { adminProfile: 'LASARE' });
  const t1 = await person('TEACHER', 't1');
  const t2 = await person('TEACHER', 't2');
  const t3 = await person('TEACHER', 't3');
  const p1 = await person('STUDENT', 'p1', { group: cl1 });
  const p2 = await person('STUDENT', 'p2', { group: cl1 });
  const p3 = await person('STUDENT', 'p3', { group: cl2 });
  const p4 = await person('STUDENT', 'p4', { group: cl1 });
  const g1 = await person('GUARDIAN', 'g1');
  const g2 = await person('GUARDIAN', 'g2');
  const g3 = await person('GUARDIAN', 'g3');
  for (const [g, p] of [[g1, p1], [g1, p2], [g2, p1], [g3, p3]] as const) {
    await owner.query(`INSERT INTO "GuardianStudents" ("schoolId", "guardianId", "studentId") VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`, [s, g.id, p.id]);
  }
  await owner.query(`INSERT INTO "StudentGroupMembers" ("schoolId", "studentGroupId", "studentId") VALUES ($1, $2, $3), ($1, $2, $4)`, [s, tg, p1.id, p3.id]);
  // t1 teaches the teaching group (p1, p3); t2 mentors CLP1 (p1, p2, p4) and teaches nobody; t3 has nothing to do with any of them.
  await owner.query(
    `INSERT INTO "MasterLessons" ("schoolId", "academicYearId", "subjectId", "studentGroupId", "teacherId", "dayOfWeek", "startTime", "endTime", "updatedAt")
     VALUES ($1, $2, $3, $4, $5, 1, '08:00', '09:00', now())`,
    [s, year.id, subject.id, tg, t1.id],
  );
  await owner.query(
    `INSERT INTO "TeacherDuties" ("schoolId", "userId", "academicYearId", kind, label, "minutesPerWeek", "studentGroupId", "updatedAt")
     VALUES ($1, $2, $3, 'MENTORSKAP', 'Mentor CLP1', 60, $4, now())`,
    [s, t2.id, year.id, cl1],
  );
  const as = (who: { id: string; authId: string }, role: Role, adminProfile?: 'FULL' | 'LASARE'): AuthenticatedUser => ({
    authId: who.authId, role, userId: who.id, schoolId: s, ...(adminProfile ? { adminProfile } : {}),
  });
  const asAdmin = as(admin, Role.SCHOOL_ADMIN, 'FULL');
  const asLasare = as(lasare, Role.SCHOOL_ADMIN, 'LASARE');
  const asT1 = as(t1, Role.TEACHER);
  const asT2 = as(t2, Role.TEACHER);
  const asT3 = as(t3, Role.TEACHER);
  const asG = (g: { id: string; authId: string }) => as(g, Role.GUARDIAN);

  const delivered: OutboxEntry[] = [];
  const delivery = { wants: () => true, emailConfigured: () => true, enqueue: (batch: OutboxEntry[]) => void delivered.push(...batch) };
  const notifications = new NotificationsService(api, delivery as never);
  const ack = new AckService(api, notifications);
  const instructions = new InstructionService(api);
  const consents = new ConsentService(api, ack);
  const names = (rows: Array<{ name: string }>) => rows.map((row) => row.name.split(' ')[0]).sort();

  let template = '';
  await check('ca: an administrator makes and retires templates; a teacher and a läsare cannot; a moment is named once in a subject', async () => {
    const made = await instructions.createTemplate({ title: 'Cirkelsågen', description: 'Skydd, nödstopp och arbetsställning.', subjectId: subject.id }, asAdmin);
    template = made.id;
    assert.deepEqual([made.subjectName, made.active, made.title], ['Slöjd', true, 'Cirkelsågen']);
    await assert.rejects(() => instructions.createTemplate({ title: '  cirkelsågen ', subjectId: subject.id }, asAdmin), refusedWith(409, 'CHECKLIST_TEMPLATE_EXISTS'));
    await assert.rejects(() => instructions.createTemplate({ title: 'Egen mall' }, asT1), 'a teacher made a template');
    await assert.rejects(() => instructions.createTemplate({ title: 'Läsarens' }, asLasare), 'a läsare made a template');
    await assert.rejects(() => instructions.createTemplate({ title: 'Utan ämne', subjectId: randomUUID() }, asAdmin), refusedWith(422, 'CHECKLIST_UNKNOWN_SUBJECT'));
    await assert.rejects(() => instructions.updateTemplate(randomUUID(), { title: 'Finns inte' }, asAdmin), (error: unknown) => (error as HttpException).getStatus() === 404);
    await instructions.updateTemplate(template, { active: false }, asAdmin);
    assert.deepEqual((await instructions.templates(asT1)).map((t) => t.title), [], 'a retired template is offered');
    assert.deepEqual((await instructions.templates(asT1, true)).map((t) => [t.title, t.active]), [['Cirkelsågen', false]]);
    const back = await instructions.updateTemplate(template, { active: true, description: null }, asAdmin);
    assert.equal(back.description, null);
    assert.equal((await instructions.templates(asT1)).length, 1);
    await assert.rejects(() => instructions.updateTemplate(template, { active: false }, asT1), 'a teacher retired a template');
  });

  await check('cb: a teacher’s groups are their lessons, a mentor’s class is for looking at, an administrator has them all; the roster is recorded in the läslogg', async () => {
    assert.deepEqual((await instructions.groups(asT1)).map((g) => [g.name, g.canTick, g.subjects]), [['CLPSLJ', true, ['Slöjd']]]);
    assert.deepEqual((await instructions.groups(asT2)).map((g) => [g.name, g.canTick]), [['CLP1', false]]);
    assert.deepEqual(await instructions.groups(asT3), []);
    assert.deepEqual((await instructions.groups(asAdmin)).map((g) => [g.name, g.canTick]), [['CLP1', true], ['CLP2', true], ['CLPSLJ', true]]);
    assert.deepEqual((await instructions.instructors(asT1)).map((i) => i.name.split(' ')[0]).sort(), ['admin', 'lasare', 't1', 't2', 't3']);

    const reads = () => count(`SELECT count(*) AS n FROM "PersonalDataAccess" WHERE "schoolId" = $1 AND kind = 'PEOPLE'`, [s]);
    const before = await reads();
    await instructions.templates(asT1);
    await instructions.groups(asT1);
    assert.equal(await reads(), before, 'the lists of templates and groups name nobody and were recorded');
    const roster = await instructions.roster(template, tg, asT1);
    assert.deepEqual(names(roster.rows), ['p1', 'p3']);
    assert.ok(roster.rows.every((row) => row.canTick && row.proofs.length === 0), 'a fresh roster has proofs or a pupil the teacher cannot tick');
    assert.deepEqual([roster.done, roster.pupils], [0, 2]);
    assert.ok((await reads()) > before, 'opening a roster was not recorded in the läslogg');
    // A mentor looks at their class and ticks nobody; a teacher with no pupils reads none.
    assert.deepEqual((await instructions.roster(template, cl1, asT2)).rows.map((row) => [row.name.split(' ')[0], row.canTick]), [['p1', false], ['p2', false], ['p4', false]]);
    assert.deepEqual((await instructions.roster(template, cl1, asT3)).rows, []);
    // The teacher reads only the pupils of a class that they teach: p1 of CLP1, and the class of p3.
    assert.deepEqual(names((await instructions.roster(template, cl1, asT1)).rows), ['p1']);
    await assert.rejects(() => instructions.roster(randomUUID(), tg, asT1), (error: unknown) => (error as HttpException).getStatus() === 404);
  });

  await check('cc: a teacher ticks the pupils they teach and no others; a second tick of the day is counted and not written', async () => {
    assert.deepEqual(await instructions.tick({ templateId: template, studentIds: [p1.id, p3.id], note: 'Genomgång' }, asT1), { written: 2, already: 0 });
    assert.deepEqual(await instructions.tick({ templateId: template, studentIds: [p1.id, p3.id] }, asT1), { written: 0, already: 2 });
    assert.equal(await count(`SELECT count(*) AS n FROM "InstructionProofs" WHERE "templateId" = $1`, [template]), 2);
    const row = await one<{ recordedById: string; instructorId: string; instructedOn: string }>(
      `SELECT "recordedById", "instructorId", "instructedOn"::text AS "instructedOn" FROM "InstructionProofs" WHERE "templateId" = $1 AND "studentId" = $2`, [template, p1.id]);
    assert.deepEqual([row.recordedById, row.instructorId, row.instructedOn], [t1.id, t1.id, today]);
    await assert.rejects(() => instructions.tick({ templateId: template, studentIds: [p2.id] }, asT1), refusedWith(403, 'CHECKLIST_NOT_YOUR_PUPIL'));
    await assert.rejects(() => instructions.tick({ templateId: template, studentIds: [p1.id, p2.id] }, asT2), refusedWith(403, 'CHECKLIST_NOT_YOUR_PUPIL'));
    await assert.rejects(() => instructions.tick({ templateId: template, studentIds: [p2.id] }, asLasare), 'a läsare ticked');
    await assert.rejects(() => instructions.tick({ templateId: template, studentIds: [p1.id], instructedOn: inThreeDays }, asT1), refusedWith(422, 'CHECKLIST_DATE_IN_THE_FUTURE'));
    await assert.rejects(() => instructions.tick({ templateId: template, studentIds: [p1.id], instructedOn: '2026-02-30' }, asT1), refusedWith(422, 'CHECKLIST_DATE_INVALID'));
    await assert.rejects(() => instructions.tick({ templateId: template, studentIds: [g1.id] }, asAdmin), refusedWith(422, 'CHECKLIST_UNKNOWN_PUPIL'));
    await assert.rejects(() => instructions.tick({ templateId: randomUUID(), studentIds: [p1.id] }, asT1), (error: unknown) => (error as HttpException).getStatus() === 404);
    // A colleague gave the instruction; a guardian cannot have.
    const day = dayMinus[2];
    await instructions.tick({ templateId: template, studentIds: [p1.id], instructedOn: day, instructorId: t3.id }, asT1);
    const roster = await instructions.roster(template, tg, asT1);
    const mine = roster.rows.find((r) => r.name.startsWith('p1'))!;
    assert.deepEqual(mine.proofs.map((proof) => [proof.instructedOn, proof.instructorName?.split(' ')[0], proof.recordedByName?.split(' ')[0]]), [[today, 't1', 't1'], [day, 't3', 't1']]);
    assert.deepEqual([roster.done, roster.pupils], [2, 2]);
    await assert.rejects(() => instructions.tick({ templateId: template, studentIds: [p1.id], instructedOn: dayMinus[3], instructorId: g1.id }, asT1), refusedWith(422, 'CHECKLIST_INSTRUCTOR_IS_NOT_STAFF'));
    // A retired template takes no more.
    await instructions.updateTemplate(template, { active: false }, asAdmin);
    await assert.rejects(() => instructions.tick({ templateId: template, studentIds: [p3.id], instructedOn: dayMinus[4] }, asT1), refusedWith(409, 'CHECKLIST_TEMPLATE_RETIRED'));
    await instructions.updateTemplate(template, { active: true }, asAdmin);
    // An administrator ticks any pupil.
    assert.deepEqual(await instructions.tick({ templateId: template, studentIds: [p2.id, p4.id] }, asAdmin), { written: 2, already: 0 });
  });

  await check('cd: the writer voids their tick with a reason; nobody else’s; the tick stays and the card says who and why', async () => {
    const proofId = (await one<{ id: string }>(`SELECT id FROM "InstructionProofs" WHERE "templateId" = $1 AND "studentId" = $2 AND "instructedOn" = $3::date`, [template, p3.id, today])).id;
    await assert.rejects(() => instructions.voidProof(proofId, { reason: 'Fel elev' }, asT3), refusedWith(404, 'CHECKLIST_NOT_FOUND'));
    await assert.rejects(() => instructions.voidProof(proofId, { reason: 'Fel elev' }, asLasare), refusedWith(403, 'CHECKLIST_NOT_STAFF'));
    await assert.rejects(() => instructions.voidProof(proofId, { reason: '  ' }, asT1), refusedWith(422, 'CHECKLIST_REASON_NEEDED'));
    const first = await instructions.voidProof(proofId, { reason: ' Fel elev ' }, asT1);
    const second = await instructions.voidProof(proofId, { reason: 'En annan' }, asAdmin);
    assert.equal(second.voidedAt, first.voidedAt, 'voiding twice answered another time');
    assert.deepEqual(names((await instructions.roster(template, tg, asT1)).rows.filter((row) => row.proofs.length > 0)), ['p1']);
    const card = await consents.student(p3.id, asAdmin);
    const voided = card.proofs.find((proof) => proof.id === proofId)!;
    assert.deepEqual([voided.voidReason, voided.voidedByName?.split(' ')[0], voided.templateTitle, voided.subjectName], ['Fel elev', 't1', 'Cirkelsågen', 'Slöjd']);
    assert.ok(voided.voidedAt, 'a voided tick says when');
    // The same pupil, template and day can be ticked again; the corrected tick is the valid one.
    assert.deepEqual(await instructions.tick({ templateId: template, studentIds: [p3.id] }, asT1), { written: 1, already: 0 });
  });

  await check('ce: the proof is the pupil’s: a change of class and a pupil who has left keep it, and a pupil who has left cannot be ticked', async () => {
    await owner.query(`UPDATE "Users" SET "studentGroupId" = $2 WHERE id = $1`, [p1.id, cl2]);
    const moved = await consents.student(p1.id, asAdmin);
    assert.equal(moved.student.className, 'CLP2');
    assert.ok(moved.proofs.filter((proof) => !proof.voidedAt).length >= 2, 'the proofs did not follow the pupil to the new class');
    assert.deepEqual(names((await instructions.roster(template, cl2, asAdmin)).rows.filter((row) => row.proofs.length > 0)), ['p1', 'p3']);
    assert.deepEqual(names((await instructions.roster(template, tg, asT1)).rows.filter((row) => row.proofs.length > 0)), ['p1', 'p3'], 'the teacher’s own group lost the pupil’s proof');
    await owner.query(`UPDATE "Users" SET "isActive" = false WHERE id = $1`, [p1.id]);
    assert.ok((await consents.student(p1.id, asAdmin)).proofs.length >= 2, 'a pupil who has left lost their proofs');
    await assert.rejects(() => instructions.tick({ templateId: template, studentIds: [p1.id], instructedOn: dayMinus[9] }, asAdmin), refusedWith(422, 'CHECKLIST_UNKNOWN_PUPIL'));
    await owner.query(`UPDATE "Users" SET "isActive" = true, "studentGroupId" = $2 WHERE id = $1`, [p1.id, cl1]);
  });

  let list = '';
  await check('cf: a mentor makes a list for their class and not another’s; paper answers; a withdrawal is the state at once', async () => {
    const made = await consents.createList({ classId: cl1, title: 'Fotografering', body: 'Jag samtycker till att mitt barn fotograferas i skolans verksamhet.' }, asT2);
    list = made.id;
    assert.deepEqual([made.className, made.counts.pupils, made.counts.missing, made.createdByName?.split(' ')[0]], ['CLP1', 3, 3, 't2']);
    await assert.rejects(() => consents.createList({ classId: cl2, title: 'Fotografering', body: 'Text' }, asT2), 'a mentor made a list for a class they do not mentor');
    await assert.rejects(() => consents.createList({ classId: cl1, title: 'Fotografering', body: 'Text' }, asAdmin), refusedWith(409, 'CONSENT_LIST_EXISTS'));
    await assert.rejects(() => consents.createList({ classId: tg, title: 'Gruppen', body: 'Text' }, asAdmin), refusedWith(422, 'CONSENT_NOT_A_CLASS'));
    await assert.rejects(() => consents.createList({ classId: cl1, title: 'Läsarens', body: 'Text' }, asLasare), 'a läsare made a list');

    assert.deepEqual(await consents.record(list, { studentIds: [p1.id], kind: 'GRANTED', givenBy: 'mamma Anna', note: 'Lapp i facket.', givenOn: dayMinus[2] }, asT2), { written: 1 });
    await assert.rejects(() => consents.record(list, { studentIds: [p1.id], kind: 'GRANTED' }, asT1), refusedWith(403, 'CHECKLIST_NOT_YOUR_PUPIL'));
    await assert.rejects(() => consents.record(list, { studentIds: [p3.id], kind: 'GRANTED' }, asT2), refusedWith(403, 'CHECKLIST_NOT_YOUR_PUPIL'));
    await assert.rejects(() => consents.record(list, { studentIds: [p1.id], kind: 'GRANTED', givenOn: inThreeDays }, asT2), refusedWith(422, 'CHECKLIST_DATE_IN_THE_FUTURE'));
    await assert.rejects(() => consents.record(list, { studentIds: [p1.id], kind: 'GRANTED' }, asLasare), 'a läsare wrote an answer');
    let detail = await consents.detail(list, asT2);
    const row = (name: string) => detail.rows.find((r) => r.name.startsWith(name))!;
    assert.deepEqual([row('p1').state, row('p1').entry?.source, row('p1').entry?.givenBy, row('p1').entry?.recordedByName?.split(' ')[0], row('p2').state], ['GRANTED', 'REGISTERED', 'mamma Anna', 't2', 'MISSING']);
    // A no, and a consent taken back, show at once; the history keeps both.
    await consents.record(list, { studentIds: [p2.id], kind: 'DECLINED' }, asT2);
    await consents.record(list, { studentIds: [p1.id], kind: 'WITHDRAWN', note: 'Mamma ringde.' }, asT2);
    detail = await consents.detail(list, asT2);
    assert.deepEqual([row('p1').state, row('p2').state, row('p4').state], ['WITHDRAWN', 'DECLINED', 'MISSING']);
    assert.deepEqual(row('p1').history.map((entry) => entry.kind), ['WITHDRAWN', 'GRANTED']);
    assert.deepEqual([detail.list.counts.granted, detail.list.counts.declined, detail.list.counts.withdrawn, detail.list.counts.missing], [0, 1, 1, 1]);
    assert.equal(detail.canClose, true);
    // t1 teaches p1 and not the others: reads p1's row, not p2's or p4's, and writes nothing.
    const asTeaching = await consents.detail(list, asT1);
    assert.deepEqual(names(asTeaching.rows), ['p1']);
    assert.equal(asTeaching.rows[0]!.canWrite, false);
    assert.equal(asTeaching.canClose, false);
    // t3 teaches nobody here: no list and no pupil.
    assert.deepEqual(await consents.lists(asT3), []);
    await assert.rejects(() => consents.detail(list, asT3), (error: unknown) => (error as HttpException).getStatus() === 404);
    await assert.rejects(() => consents.student(p1.id, asT3), (error: unknown) => (error as HttpException).getStatus() === 404);
    assert.equal((await consents.student(p1.id, asT2)).consents.find((c) => c.listId === list)?.state, 'WITHDRAWN');
  });

  let asked = '';
  await check('cg: the guardians asked through Kvittens (the rule ALL): the answer is written when the last has confirmed', async () => {
    const utflykt = (await consents.createList({ classId: cl1, title: 'Utflykter', body: 'Jag samtycker till utflykter inom kommunen.' }, asT2)).id;
    asked = utflykt;
    await assert.rejects(() => consents.ask(utflykt, {}, asT2), refusedWith(409, 'ACK_DISABLED'));
    assert.deepEqual(await consents.settings(asT2), { kvittens: false });
    await owner.query(`INSERT INTO "AckSettings" ("schoolId", enabled) VALUES ($1, true) ON CONFLICT ("schoolId") DO UPDATE SET enabled = true`, [s]);
    assert.deepEqual(await consents.settings(asT2), { kvittens: true });
    await assert.rejects(() => consents.ask(utflykt, { studentIds: [p3.id] }, asT2), refusedWith(403, 'CHECKLIST_NOT_YOUR_PUPIL'));

    // Left to itself the ask goes to every pupil with no answer: p1 (two guardians), p2 (one) and p4 (none).
    const result = await consents.ask(utflykt, {}, asT2);
    assert.deepEqual([result.pupils, result.guardians, result.withoutGuardian], [2, 2, [p4.id]]);
    const request = await one<{ rule: string; title: string; body: string; authorId: string }>(`SELECT rule::text, title, body, "authorId" FROM "AckRequests" WHERE id = $1`, [result.requestId]);
    assert.deepEqual([request.rule, request.title, request.authorId], ['ALL', 'Samtycke: Utflykter', t2.id]);
    assert.ok(request.body.startsWith('Jag samtycker till utflykter inom kommunen.') && request.body.endsWith(CONSENT_FOOTER), 'the request does not carry the text and the sentence that a confirmation is the consent');
    assert.equal(await count(`SELECT count(*) AS n FROM "ConsentAsks" WHERE "listId" = $1 AND "ackRequestId" = $2`, [utflykt, result.requestId]), 1);
    assert.equal((await ack.mine(asG(g1))).items.map((item) => item.title).includes('Samtycke: Utflykter'), true, 'the guardian is not shown the request in Meddelanden');
    let detail = await consents.detail(utflykt, asT2);
    const row = (name: string) => detail.rows.find((r) => r.name.startsWith(name))!;
    assert.deepEqual([row('p1').state, row('p1').ask?.guardiansWaiting, row('p2').state, row('p4').state], ['ASKED', 2, 'ASKED', 'MISSING']);

    // The guardian of p2 only confirms: p2 is met; p1 still waits for the other.
    await ack.confirm(result.requestId, asG(g1));
    detail = await consents.detail(utflykt, asT2);
    assert.deepEqual([row('p2').state, row('p2').entry?.source, row('p2').entry?.recordedByName, row('p1').state, row('p1').ask?.guardiansWaiting], ['GRANTED', 'KVITTENS', null, 'ASKED', 1]);
    await ack.confirm(result.requestId, asG(g1));
    assert.equal(await count(`SELECT count(*) AS n FROM "ConsentEntries" WHERE "listId" = $1`, [utflykt]), 1, 'a second tap wrote a second answer');
    await ack.confirm(result.requestId, asG(g2));
    detail = await consents.detail(utflykt, asT2);
    assert.deepEqual([row('p1').state, detail.list.counts.granted, detail.list.counts.asked], ['GRANTED', 2, 0]);

    // A request that is no consent's writes nothing when it is confirmed.
    const plain = await ack.create({ title: 'Utflykt på torsdag', body: 'Vi åker kl. 8.', rule: 'ALL', studentIds: [p3.id] }, asAdmin);
    await ack.confirm(plain.id, asG(g3));
    assert.equal(await count(`SELECT count(*) AS n FROM "ConsentEntries" WHERE "studentId" = $1`, [p3.id]), 0);

    // A consent taken back can be asked for again: the pupil is ASKED until the guardians confirm, and then GRANTED once more.
    await consents.record(utflykt, { studentIds: [p2.id], kind: 'WITHDRAWN' }, asT2);
    detail = await consents.detail(utflykt, asT2);
    assert.equal(row('p2').state, 'WITHDRAWN');
    const again = await consents.ask(utflykt, { studentIds: [p2.id] }, asT2);
    assert.deepEqual([again.pupils, again.guardians], [1, 1]);
    detail = await consents.detail(utflykt, asT2);
    assert.equal(row('p2').state, 'ASKED');
    await ack.confirm(again.requestId, asG(g1));
    detail = await consents.detail(utflykt, asT2);
    assert.equal(row('p2').state, 'GRANTED');
    assert.deepEqual((await consents.detail(utflykt, asT2)).rows.find((r) => r.name.startsWith('p2'))!.history.map((entry) => entry.kind), ['GRANTED', 'WITHDRAWN', 'GRANTED']);

    // Nobody to ask: the only pupil with no answer, p4, has no guardian (Kvittens says so); and a list whose every pupil has answered.
    await assert.rejects(() => consents.ask(utflykt, {}, asT2), refusedWith(422, 'ACK_NO_GUARDIANS'));
    const answered = (await consents.createList({ classId: cl2, title: 'Alla har svarat', body: 'Text' }, asAdmin)).id;
    await consents.record(answered, { studentIds: [p3.id], kind: 'GRANTED' }, asAdmin);
    await assert.rejects(() => consents.ask(answered, {}, asAdmin), refusedWith(422, 'CONSENT_NOBODY_TO_ASK'));
    // An ended list takes no more answers or asks.
    await assert.rejects(() => consents.close(utflykt, asT1), refusedWith(404, 'CHECKLIST_NOT_FOUND'));
    const closed = await consents.close(utflykt, asT2);
    assert.equal((await consents.close(utflykt, asAdmin)).closedAt, closed.closedAt);
    await assert.rejects(() => consents.record(utflykt, { studentIds: [p1.id], kind: 'GRANTED' }, asT2), refusedWith(409, 'CONSENT_LIST_CLOSED'));
    await assert.rejects(() => consents.ask(utflykt, { studentIds: [p1.id] }, asT2), refusedWith(409, 'CONSENT_LIST_CLOSED'));
    assert.deepEqual((await consents.lists(asT2)).map((l) => l.title), ['Fotografering']);
    assert.deepEqual((await consents.lists(asT2, { includeClosed: true })).map((l) => l.title).sort(), ['Fotografering', 'Utflykter']);
    // The name is free again for the class.
    await consents.createList({ classId: cl1, title: 'Utflykter', body: 'Ny termin.' }, asT2);
  });

  await check('ch: a pupil marked as having a protected identity is named on the screen, as the register names them, and left out of the sheet for paper, which a teacher can print', async () => {
    await owner.query(`INSERT INTO "PersonProtections" ("userId", "schoolId", source) VALUES ($1, $2, 'MANUAL') ON CONFLICT DO NOTHING`, [p4.id, s]);
    // The screen: named, nothing held out.
    const detail = await consents.detail(list, asT2);
    assert.ok(detail.rows.some((row) => row.studentId === p4.id && row.name.startsWith('p4')), 'the marked pupil is not on the screen');
    assert.equal(detail.heldOut, 0);
    assert.ok((await instructions.roster(template, cl1, asAdmin)).rows.some((row) => row.studentId === p4.id));
    // A teacher reads no mark, and prints all the same: the gateway leaves the marked pupil out of the sheet and counts them.
    assert.equal((await api.withRls(asT2, (tx) => tx.personProtection.count())), 0, 'a teacher reads the register of marks');
    for (const who of [asT2, asAdmin]) {
      const paper = await consents.detail(list, who, true);
      assert.ok(!paper.rows.some((row) => row.studentId === p4.id) && !JSON.stringify(paper).includes(p4.id), 'the sheet names or carries the marked pupil');
      assert.deepEqual([paper.heldOut, paper.rows.length, paper.list.counts.pupils], [1, detail.rows.length - 1, detail.rows.length - 1]);
      const roster = await instructions.roster(template, cl1, who, true);
      assert.ok(!JSON.stringify(roster).includes(p4.id));
      assert.deepEqual([roster.heldOut, roster.pupils], [1, 2]);
    }
    // A class with nobody marked is printed whole.
    assert.deepEqual((await instructions.roster(template, cl2, asAdmin, true)).heldOut, 0);
    await owner.query(`DELETE FROM "PersonProtections" WHERE "userId" = $1`, [p4.id]);
    assert.equal((await consents.detail(list, asT2, true)).heldOut, 0);
  });

  await check('ci: races: two guardians confirm at once (one answer each time), a list closed under writers, the same tick twice at once', async () => {
    // Two guardians of p1 confirm at the same moment: each sees the other’s confirmation as not yet made, and the
    // answer is still written once, by whichever is last (the confirmations of a consent’s request take a lock).
    for (let round = 0; round < 10; round++) {
      const title = `Lopp ${round}`;
      const lopp = (await consents.createList({ classId: cl1, title, body: 'Text' }, asAdmin)).id;
      // The request is written the owner's way (the sender's limit of ten an hour is for logged-in writers), as the service writes it.
      const request = {
        requestId: (await one<{ id: string }>(`INSERT INTO "AckRequests" ("schoolId", "authorId", title, body, rule) VALUES ($1, $2, $3, 'Text', 'ALL') RETURNING id`, [s, admin.id, `Samtycke: ${title}`])).id,
      };
      await owner.query(`INSERT INTO "AckReceipts" ("requestId", "schoolId", "studentId", "guardianId") VALUES ($1, $2, $3, $4), ($1, $2, $3, $5)`, [request.requestId, s, p1.id, g1.id, g2.id]);
      await owner.query(`INSERT INTO "ConsentAsks" ("ackRequestId", "schoolId", "listId") VALUES ($1, $2, $3)`, [request.requestId, s, lopp]);
      await Promise.all([ack.confirm(request.requestId, asG(g1)), ack.confirm(request.requestId, asG(g2))]);
      const written = await count(`SELECT count(*) AS n FROM "ConsentEntries" WHERE "listId" = $1 AND source = 'KVITTENS'`, [lopp]);
      assert.equal(written, 1, `round ${round}: two guardians confirmed at once and the answer was written ${written} times, not once`);
      await consents.close(lopp, asAdmin);
    }
    // A list closed under a writer, and a writer under a closing list: a connection of the API's role holds one side open, the other
    // is seen waiting on the list's row, and the side that comes second finds the first one's result.
    const held = async (who: { authId: string }): Promise<Client> => {
      const client = new Client({ connectionString: process.env['DATABASE_URL'] });
      await client.connect();
      await client.query('BEGIN');
      await client.query(`SELECT set_config('request.jwt.claims', $1, true), set_config('app.chosen_school_id', $2, true)`, [JSON.stringify({ sub: who.authId }), s]);
      return client;
    };
    const waitUntilBlocked = async (fragment: string): Promise<void> => {
      for (let attempt = 0; attempt < 200; attempt++) {
        if ((await owner.query(`SELECT 1 FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND query LIKE $1`, [`%${fragment}%`])).rowCount) return;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      assert.fail(`nothing waited on a lock in ${fragment}`);
    };
    // (1) An answer is being written when the close comes: the close waits for it, and the answer is not later than the close.
    const first = (await consents.createList({ classId: cl1, title: 'Stängs 1', body: 'Text' }, asAdmin)).id;
    const writer = await held(admin);
    await writer.query(`INSERT INTO "ConsentEntries" ("schoolId", "listId", "studentId", kind, "givenOn") VALUES ($1, $2, $3, 'GRANTED', $4::date)`, [s, first, p1.id, today]);
    const closing = consents.close(first, asAdmin);
    await waitUntilBlocked('checklist_close_list');
    await writer.query('COMMIT');
    await writer.end();
    const closedAt = new Date((await closing).closedAt);
    const entry = await one<{ at: Date }>(`SELECT "recordedAt" AS at FROM "ConsentEntries" WHERE "listId" = $1`, [first]);
    assert.ok(entry.at.getTime() <= closedAt.getTime(), 'an answer written under the close is later than it');
    // (2) The close is being made when an answer comes: the answer waits for it, and is refused when it is done.
    const second = (await consents.createList({ classId: cl1, title: 'Stängs 2', body: 'Text' }, asAdmin)).id;
    const closer = await held(admin);
    await closer.query(`SELECT app.checklist_close_list($1::uuid)`, [second]);
    const writing = consents.record(second, { studentIds: [p1.id], kind: 'GRANTED' }, asAdmin).then(() => 'written', (error: unknown) => error);
    // The adapter qualifies the table ("public"."ConsentEntries"), so the fragment is the table's name.
    await waitUntilBlocked('ConsentEntries');
    await closer.query('COMMIT');
    await closer.end();
    const outcome = await writing;
    assert.ok(refusedWith(409, 'CONSENT_LIST_CLOSED')(outcome), `the answer under the close was ${String(outcome)}`);
    assert.equal(await count(`SELECT count(*) AS n FROM "ConsentEntries" WHERE "listId" = $1`, [second]), 0, 'an answer was written to a list that had been closed');
    // The same tick twice at once is one proof.
    const day = dayMinus[30];
    const both = await Promise.all([
      instructions.tick({ templateId: template, studentIds: [p1.id], instructedOn: day }, asAdmin),
      instructions.tick({ templateId: template, studentIds: [p1.id], instructedOn: day }, asT1),
    ]);
    assert.equal(both.reduce((sum, r) => sum + r.written, 0), 1);
    assert.equal(await count(`SELECT count(*) AS n FROM "InstructionProofs" WHERE "templateId" = $1 AND "studentId" = $2 AND "instructedOn" = $3::date AND "voidedAt" IS NULL`, [template, p1.id, day]), 1);
  });

  await check('cj: a withdrawal written while a request is open is not undone by its last confirmation; asking again grants it (granskning #288)', async () => {
    const photo = (await consents.createList({ classId: cl1, title: 'Fotografering mellan', body: 'Jag samtycker.' }, asT2)).id;
    const first = await consents.ask(photo, { studentIds: [p1.id] }, asT2);
    assert.deepEqual([first.pupils, first.guardians], [1, 2]);
    // g1 says yes in the app, rings the school and takes the consent back (the mentor writes it down), and then g2 says yes to the request that is still open.
    await ack.confirm(first.requestId, asG(g1));
    await consents.record(photo, { studentIds: [p1.id], kind: 'WITHDRAWN', givenBy: 'Vårdnadshavare 1', note: 'Ringde.' }, asT2);
    await ack.confirm(first.requestId, asG(g2));
    const read = async () => (await consents.detail(photo, asT2)).rows.find((r) => r.name.startsWith('p1'))!;
    assert.equal((await read()).state, 'WITHDRAWN', 'the last confirmation of the older request undid the withdrawal');
    assert.equal(await count(`SELECT count(*) AS n FROM "ConsentEntries" WHERE "listId" = $1 AND source = 'KVITTENS'`, [photo]), 0, 'a Kvittens answer was written over the withdrawal');
    assert.equal(await count(`SELECT count(*) AS n FROM "AckReceipts" WHERE "requestId" = $1 AND "ackedAt" IS NOT NULL`, [first.requestId]), 2, "a guardian's confirmation was lost with the withdrawal");
    // The school asks again: a request made after the withdrawal, confirmed by both, grants it again, and the history keeps all.
    const again = await consents.ask(photo, { studentIds: [p1.id] }, asT2);
    assert.equal((await read()).state, 'ASKED');
    await ack.confirm(again.requestId, asG(g1));
    assert.equal((await read()).state, 'ASKED', 'one of two guardians was enough');
    await ack.confirm(again.requestId, asG(g2));
    const row = await read();
    assert.equal(row.state, 'GRANTED');
    assert.deepEqual(row.history.map((entry) => entry.kind), ['GRANTED', 'WITHDRAWN']);
  });

  await sweepChecklistorSchool(owner, marker);
  void asked;
}
