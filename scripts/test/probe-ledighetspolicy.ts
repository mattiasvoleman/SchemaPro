/**
 * The adapter probe's checks for Ledighetspolicy (20270205090000-20270205091000), through the real
 * LeaveService on the API's role, against real Postgres as CI runs it. The RLS sections 445-449 prove
 * what the triggers, the functions and the arms do; this proves what the gateway and the adapter make of
 * them: the refusals read back by SQLSTATE through a model query (create, updateMany) and through a raw
 * one (P2010), the notices the database writes and the delivery is handed, what a guardian, an
 * administrator and a mentor each read of the same request, and the races between an answer and a
 * decision. In a school of its own (slug <marker>-ledighetspolicy), swept whole before and after:
 *
 *   ma  the policy: all off for a school that chose nothing; a läsare cannot record it, an administrator who
 *       decides can; everybody reads the same
 *   mb  the minimum: seven days, refused by the gateway with its code and by the trigger with LV413 when the
 *       gateway is bypassed, the line on the seventh day, flagged instead when the school chose to; the
 *       administrator is let through and the request flagged
 *   mc  the contact: required and incomplete are 400s with their codes, the contact is read by the family, the
 *       administrator and the deciding mentor, by no other teacher, and is in no notice, mail or push
 *   md  the consent: the other guardian is asked (a notice with an address, nothing of the child's dates in the
 *       mail), the administrator sees the count and cannot decide (409), the mentor neither reads nor hears of
 *       it until the last yes, which tells the mentor in its own transaction; the mentor decides and the
 *       absence is written
 *   me  a no: the request ends, whoever applied is told without a name, the mentor never hears of it, nobody
 *       decides it, and an answer cannot be taken back
 *   mf  custody that ends: the guardian who waited can no longer answer (409), the request is clear without a
 *       yes and the administrator decides it; the pass tells the mentor of it, once
 *   mg  the pass: one reminder, to the guardian who can still answer, two days after the request, with an
 *       address and with no name, date or reason in the mail
 *   mh  races: the same guardian answers yes and yes, and yes and no, at once; an answer and a decision at
 *       once, forty rounds: a request is never decided without its consent, and nothing deadlocks
 *   mi  a pupil with a protected identity: the guardian is asked like any other; the staff's overview names
 *       nobody who answered
 *
 * Imported by prisma-adapter-probe.ts, which hands in its `check`.
 */
import { strict as assert } from 'node:assert';
import { randomUUID } from 'node:crypto';
import { BadRequestException, ConflictException, ForbiddenException } from '@nestjs/common';
import { Client } from 'pg';
import { Role } from '../../src/auth/enums/role.enum';
import type { AuthenticatedUser } from '../../src/auth/interfaces/authenticated-user.interface';
import type { PrismaService } from '../../src/database/prisma.service';
import { leaveSqlStateOf, tooLateDaysOf } from '../../src/family/leave-errors';
import { LeaveService } from '../../src/family/leave.service';
import type { OutboxEntry } from '../../src/notifications/notification-outbox';
import { NotificationsService } from '../../src/notifications/notifications.service';

type Check = (label: string, body: () => Promise<void>) => Promise<void>;

export function ledighetspolicySlug(marker: string): string {
  return `${marker}-ledighetspolicy`;
}

export async function sweepLedighetspolicySchool(owner: Client, marker: string): Promise<void> {
  await owner.query(`DELETE FROM "Schools" WHERE slug = $1`, [ledighetspolicySlug(marker)]);
}

const DAY_MS = 86_400_000;
const addDays = (date: string, days: number) => new Date(Date.parse(`${date}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);
const codeOf = (error: unknown): string | undefined => (error as { getResponse?: () => { code?: string } }).getResponse?.()?.code;

export async function ledighetspolicyChecks(owner: Client, api: PrismaService, marker: string, check: Check): Promise<void> {
  await sweepLedighetspolicySchool(owner, marker);
  const one = async <T extends object>(sql: string, params: unknown[] = []): Promise<T> => (await owner.query<T>(sql, params)).rows[0]!;
  const count = async (sql: string, params: unknown[] = []): Promise<number> => Number((await one<{ n: string }>(sql, params)).n);
  const today = (await one<{ d: string }>(`SELECT ((now() AT TIME ZONE 'Europe/Stockholm')::date)::text AS d`)).d;

  const school = await one<{ id: string }>(
    `INSERT INTO "Schools" (name, slug, timezone, "updatedAt") VALUES ($1, $2, 'Europe/Stockholm', now()) RETURNING id`,
    [`${marker} ledighetspolicy`, ledighetspolicySlug(marker)],
  );
  const s = school.id;
  const year = await one<{ id: string }>(
    `INSERT INTO "AcademicYears" ("schoolId", name, "startDate", "endDate", "isActive", "updatedAt")
     VALUES ($1, 'lp probe', '${today}'::date - 200, '${today}'::date + 200, true, now()) RETURNING id`,
    [s],
  );
  const klass = async (name: string) =>
    (await one<{ id: string }>(`INSERT INTO "StudentGroups" ("schoolId", "academicYearId", name, "gradeLevel", "updatedAt") VALUES ($1, $2, $3, 7, now()) RETURNING id`, [s, year.id, name])).id;
  const k1 = await klass('LP1');
  const k2 = await klass('LP2');
  const person = async (role: string, label: string, extra: { adminProfile?: string; group?: string } = {}) => {
    const authId = randomUUID();
    const row = await one<{ id: string }>(
      `INSERT INTO "Users" ("schoolId", email, "firstName", "lastName", role, "adminProfile", "studentGroupId", "authId", "isActive", "updatedAt")
       VALUES ($1, $2, $3, 'Probe', $4::"UserRole", $5::"AdminProfile", $6, $7, true, now()) RETURNING id`,
      [s, `${marker}-lp-${label}@example.invalid`, label, role, extra.adminProfile ?? null, extra.group ?? null, authId],
    );
    return { id: row.id, authId, email: `${marker}-lp-${label}@example.invalid` };
  };
  const admin = await person('SCHOOL_ADMIN', 'admin', { adminProfile: 'FULL' });
  const lasare = await person('SCHOOL_ADMIN', 'lasare', { adminProfile: 'LASARE' });
  const mentor1 = await person('TEACHER', 'mentor1');
  const mentor2 = await person('TEACHER', 'mentor2');
  const p1 = await person('STUDENT', 'p1', { group: k1 });
  const p2 = await person('STUDENT', 'p2', { group: k1 });
  const p3 = await person('STUDENT', 'p3', { group: k1 });
  const g1 = await person('GUARDIAN', 'g1');
  const g2 = await person('GUARDIAN', 'g2');
  const g3 = await person('GUARDIAN', 'g3');
  const link = (g: { id: string }, p: { id: string }) =>
    owner.query(`INSERT INTO "GuardianStudents" ("schoolId", "guardianId", "studentId") VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`, [s, g.id, p.id]);
  for (const [g, p] of [[g1, p1], [g2, p1], [g1, p2], [g3, p3]] as const) await link(g, p);
  for (const [teacher, group, label] of [[mentor1, k1, 'Mentor LP1'], [mentor2, k2, 'Mentor LP2']] as const) {
    await owner.query(
      `INSERT INTO "TeacherDuties" ("schoolId", "userId", "academicYearId", kind, label, "minutesPerWeek", "studentGroupId", "updatedAt")
       VALUES ($1, $2, $3, 'MENTORSKAP', $4, 60, $5, now())`,
      [s, teacher.id, year.id, label, group],
    );
  }
  // Rektor delegates five days to the mentors: the leave of P1 is mentor1's to decide.
  await owner.query(`INSERT INTO "LeaveDelegationDecisions" ("schoolId", "mentorMaxSchoolDays") VALUES ($1, 5)`, [s]);
  const as = (who: { id: string; authId: string }, role: Role, adminProfile?: 'FULL' | 'LASARE'): AuthenticatedUser => ({
    authId: who.authId, role, userId: who.id, schoolId: s, ...(adminProfile ? { adminProfile } : {}),
  });
  const asAdmin = as(admin, Role.SCHOOL_ADMIN, 'FULL');
  const asLasare = as(lasare, Role.SCHOOL_ADMIN, 'LASARE');
  const asMentor1 = as(mentor1, Role.TEACHER);
  const asMentor2 = as(mentor2, Role.TEACHER);
  const asG = (g: { id: string; authId: string }) => as(g, Role.GUARDIAN);
  const asPupil = as(p1, Role.STUDENT);

  // The delivery is the gateway's own; here it records what was handed to it.
  const delivered: OutboxEntry[] = [];
  const delivery = {
    wants: () => true,
    emailConfigured: () => true,
    enqueue: (batch: OutboxEntry[], settled?: (delivered: boolean) => void) => {
      delivered.push(...batch);
      settled?.(true);
    },
  };
  const notifications = new NotificationsService(api, delivery as never);
  const service = new LeaveService(api, notifications);
  /** What the delivery was handed since `from`. The outbox is flushed after the commit, a tick after the call returned: wait for it. */
  const settle = () => new Promise((resolve) => setTimeout(resolve, 30));
  const lastDelivered = async (from: number) => {
    await settle();
    return delivered.slice(from);
  };
  const policy = (extra: Partial<{ requireAllGuardians: boolean; minDaysAhead: number | null; shortNotice: 'REFUSE' | 'FLAG'; contact: 'OFF' | 'OPTIONAL' | 'REQUIRED' }> = {}) =>
    service.setPolicy({ requireAllGuardians: false, minDaysAhead: null, shortNotice: 'REFUSE', contact: 'OFF', ...extra }, asAdmin);
  /** The pupil's next free week of working days, from `ahead` days on (a Monday), so a request is two skoldagar wherever it falls. */
  const monday = (ahead: number): string => {
    let day = addDays(today, ahead);
    while (new Date(`${day}T00:00:00Z`).getUTCDay() !== 1) day = addDays(day, 1);
    return day;
  };
  let week = 40;
  const nextMonday = (): string => {
    const day = monday(week);
    week += 7;
    return day;
  };
  const file = (who: AuthenticatedUser, pupil: { id: string }, from = nextMonday(), extra: Record<string, string> = {}) =>
    service.createLeaveRequest({ studentId: pupil.id, startDate: from, endDate: addDays(from, 1), reason: 'Familjeresa', ...extra } as never, who);
  const view = async (who: AuthenticatedUser, id: string) => (await service.listLeaveRequests({}, who)).find((r) => r.id === id);
  const reset = async () => {
    await owner.query(`DELETE FROM "LeaveRequests" WHERE "schoolId" = $1`, [s]);
    await owner.query(`DELETE FROM "Notifications" WHERE "schoolId" = $1`, [s]);
    await owner.query(`DELETE FROM "LeavePolicies" WHERE "schoolId" = $1`, [s]);
    await owner.query(`DELETE FROM "AbsenceReports" WHERE "schoolId" = $1`, [s]);
    await link(g2, p1);
    delivered.length = 0;
    week = 40;
  };

  await check('ma: a school that chose nothing has all three off; a läsare cannot record the policy, rektor can, and everybody reads it', async () => {
    const off = { requireAllGuardians: false, minDaysAhead: null, shortNotice: 'REFUSE', contact: 'OFF' };
    for (const who of [asAdmin, asLasare, asMentor1, asG(g1), asPupil]) assert.deepEqual(await service.getPolicy(who), off);
    await assert.rejects(() => service.setPolicy({ requireAllGuardians: true, minDaysAhead: null, shortNotice: 'REFUSE', contact: 'OFF' }, asLasare), 'a läsare recorded the policy');
    assert.deepEqual(await service.getPolicy(asG(g1)), off, 'a refused write changed the policy');
    const on = { requireAllGuardians: true, minDaysAhead: 7, shortNotice: 'FLAG', contact: 'OPTIONAL' };
    assert.deepEqual(await service.setPolicy(on as never, asAdmin), on);
    for (const who of [asLasare, asMentor1, asG(g2), asPupil, asAdmin]) assert.deepEqual(await service.getPolicy(who), on);
    // The row is one per school: a second record replaces it.
    assert.equal(await count(`SELECT count(*) AS n FROM "LeavePolicies" WHERE "schoolId" = $1`, [s]), 1);
    await assert.rejects(() => service.setPolicy({ requireAllGuardians: true, minDaysAhead: 0, shortNotice: 'REFUSE', contact: 'OFF' }, asAdmin), 'a minimum of no days');
    await reset();
  });

  await check('mb: the minimum is refused by the gateway with its code, by the trigger when the gateway is bypassed, and flagged when the school chose to', async () => {
    await policy({ minDaysAhead: 7 });
    const early = await file(asG(g1), p2, addDays(today, 7));
    assert.equal(early.shortNotice, false, 'seven days ahead is on the line, not late');
    await assert.rejects(() => file(asG(g1), p2, addDays(today, 6)), (error: unknown) => {
      assert.ok(error instanceof BadRequestException);
      assert.deepEqual([codeOf(error), (error.getResponse() as { params: unknown }).params], ['LEAVE_REQUEST_TOO_LATE', { days: 7 }]);
      return true;
    });
    // The trigger holds the line when the gateway's own question is not asked: a model create reads the refusal back by its SQLSTATE.
    const before = await count(`SELECT count(*) AS n FROM "LeaveRequests" WHERE "schoolId" = $1`, [s]);
    await assert.rejects(
      () => api.withRls(asG(g1), (tx) => tx.leaveRequest.create({ data: { schoolId: s, studentId: p2.id, requestedById: g1.id, startDate: new Date(`${addDays(today, 2)}T00:00:00Z`), endDate: new Date(`${addDays(today, 2)}T00:00:00Z`), reason: 'förbi' } })),
      (error: unknown) => {
        assert.equal(leaveSqlStateOf(error), 'LV413', `the model create's refusal read back as ${leaveSqlStateOf(error)}`);
        assert.equal(tooLateDaysOf(error), 7, 'the trigger names the minimum');
        return true;
      },
    );
    assert.equal(await count(`SELECT count(*) AS n FROM "LeaveRequests" WHERE "schoolId" = $1`, [s]), before, 'a refused request was written');
    // The pupil is held to it too; rektor is let through and the request is flagged.
    await assert.rejects(() => file(asPupil, p1, addDays(today, 1)), (error: unknown) => codeOf(error) === 'LEAVE_REQUEST_TOO_LATE');
    const late = await file(asAdmin, p2, addDays(today, 1));
    assert.equal(late.shortNotice, true);
    assert.equal((await view(asAdmin, late.id))!.shortNotice, true);
    // FLAG: the same request is let in from a guardian and flagged, and the timely one is not.
    await policy({ minDaysAhead: 7, shortNotice: 'FLAG' });
    const flagged = await file(asG(g1), p2, addDays(today, 2));
    assert.equal(flagged.shortNotice, true);
    assert.equal((await view(asG(g1), flagged.id))!.shortNotice, true);
    assert.equal((await file(asG(g1), p2, addDays(today, 9))).shortNotice, false);
    await reset();
  });

  await check('mc: the contact is required or incomplete with codes, read by the family, rektor and the deciding mentor, and by no other teacher, and in no notice', async () => {
    await policy({ contact: 'REQUIRED' });
    const contact = { contactName: 'Farmor Gun', contactPhone: '070-123 45 67', contactRelation: 'Farmor' };
    await assert.rejects(() => file(asG(g1), p1), (error: unknown) => codeOf(error) === 'LEAVE_CONTACT_REQUIRED');
    await assert.rejects(() => file(asG(g1), p1, nextMonday(), { contactName: 'Farmor Gun' }), (error: unknown) => codeOf(error) === 'LEAVE_CONTACT_INCOMPLETE');
    await assert.rejects(() => file(asG(g1), p1, nextMonday(), { contactName: '  ', contactPhone: ' ', contactRelation: '' }), (error: unknown) => codeOf(error) === 'LEAVE_CONTACT_REQUIRED');
    const from = delivered.length;
    const made = await file(asG(g1), p1, nextMonday(), contact);
    const expected = { name: 'Farmor Gun', phone: '070-123 45 67', relation: 'Farmor' };
    for (const who of [asG(g1), asG(g2), asAdmin, asMentor1]) assert.deepEqual((await view(who, made.id))?.contact, expected, 'a reader of the request did not read its contact');
    assert.equal(await view(asMentor2, made.id), undefined, 'a teacher who mentors another class reads the request');
    // The mentor was told of the request (it is theirs to decide) and the notice carries no contact, no reason.
    const text = JSON.stringify(await lastDelivered(from));
    assert.ok(delivered.length > from, 'nobody was told of the request');
    for (const secret of ['Farmor', '070-123', 'Familjeresa']) assert.ok(!text.includes(secret), `${secret} is in a notice, a mail or a push`);
    // Optional: none is none; off: a contact given is dropped.
    await policy({ contact: 'OPTIONAL' });
    assert.equal((await view(asG(g1), (await file(asG(g1), p1)).id))?.contact, null);
    await policy({ contact: 'OFF' });
    assert.equal((await view(asG(g1), (await file(asG(g1), p1, nextMonday(), contact)).id))?.contact, null, 'a contact the school did not ask for was kept');
    await reset();
  });

  await check('md: the other guardian is asked, rektor sees the count and cannot decide, the mentor hears of it with the last yes and decides, and the absence is written', async () => {
    await policy({ requireAllGuardians: true });
    const from = delivered.length;
    const made = await file(asG(g1), p1);
    assert.equal(made.consentRequired, true);
    // The notice to the guardian who is asked: an address, and in the mail neither the child, the dates, nor the reason.
    const asked = (await lastDelivered(from)).filter((entry) => entry.type === 'LEAVE_CONSENT_REQUESTED');
    assert.equal(asked.length, 1);
    assert.deepEqual(asked[0]!.recipients.map((r) => r.userId), [g2.id]);
    assert.deepEqual(asked[0]!.email!.recipients, [{ userId: g2.id, email: g2.email }]);
    assert.ok(!/Familjeresa|Probe/.test(JSON.stringify([asked[0]!.email, asked[0]!.meta])), 'the mail says too much');
    // The mentor was told of nothing yet.
    assert.equal((await lastDelivered(from)).filter((entry) => entry.type === 'LEAVE_REQUESTED').length, 0, 'the mentor was told of a request that waits');
    assert.equal(await view(asMentor1, made.id), undefined, 'the mentor reads a request that waits');
    // The views.
    const forG1 = (await view(asG(g1), made.id))!;
    assert.deepEqual(forG1.consent, { required: true, state: 'WAITING', mine: 'NOT_ASKED', asked: null, given: null, waiting: null });
    const forG2 = (await view(asG(g2), made.id))!;
    assert.deepEqual(forG2.consent, { required: true, state: 'WAITING', mine: 'WAITING', asked: null, given: null, waiting: null });
    assert.deepEqual((await view(asAdmin, made.id))!.consent, { required: true, state: 'WAITING', mine: 'NOT_ASKED', asked: 1, given: 0, waiting: 1 });
    // Rektor cannot decide it: 409 with the code; and the guardian who applied cannot answer for the other.
    await assert.rejects(() => service.decideLeaveRequest(made.id, { status: 'APPROVED' } as never, asAdmin), (error: unknown) => {
      assert.ok(error instanceof ConflictException);
      return codeOf(error) === 'LEAVE_AWAITING_CONSENT';
    });
    await assert.rejects(() => service.answerConsent(made.id, { consent: true }, asG(g1)), (error: unknown) => codeOf(error) === 'LEAVE_CONSENT_NOT_FOUND');
    for (const who of [asMentor1, asAdmin, asPupil]) {
      await assert.rejects(() => service.answerConsent(made.id, { consent: true }, who), (error: unknown) => error instanceof ForbiddenException, 'a role other than a guardian answered');
    }
    // The last yes: the answer, and the mentor told in its own transaction, with an address.
    await settle();
    const mark = delivered.length;
    assert.deepEqual(await service.answerConsent(made.id, { consent: true }, asG(g2)), { id: made.id, answer: 'GIVEN', state: 'GIVEN' });
    const told = (await lastDelivered(mark)).filter((entry) => entry.type === 'LEAVE_REQUESTED');
    assert.equal(told.length, 1);
    assert.deepEqual(told[0]!.recipients.map((r) => r.userId), [mentor1.id]);
    assert.deepEqual(told[0]!.email!.recipients, [{ userId: mentor1.id, email: mentor1.email }]);
    assert.ok(!/Familjeresa/.test(JSON.stringify(told)), 'the reason is in the mentor\'s notice');
    // A second yes changes nothing and tells nobody.
    await settle();
    const again = delivered.length;
    assert.deepEqual(await service.answerConsent(made.id, { consent: true }, asG(g2)), { id: made.id, answer: 'GIVEN', state: 'GIVEN' });
    await settle();
    assert.equal(delivered.length, again);
    // The mentor reads it, with the consent as given, and decides; the absence of its skoldagar is written.
    assert.deepEqual((await view(asMentor1, made.id))!.consent, { required: true, state: 'GIVEN', mine: 'NOT_ASKED', asked: 1, given: 1, waiting: 0 });
    const decided = await service.decideLeaveRequest(made.id, { status: 'APPROVED' } as never, asMentor1);
    assert.deepEqual([decided.status, decided.decidedAs, decided.absenceDays], ['APPROVED', 'MENTOR', 2]);
    assert.equal(await count(`SELECT count(*) AS n FROM "AbsenceReports" WHERE "studentId" = $1 AND "grantedLeave"`, [p1.id]), 2);
    assert.equal((await view(asG(g1), made.id))!.status, 'APPROVED');
    await reset();
  });

  await check('me: a no ends the request and tells whoever applied without a name; nobody decides it, the mentor never hears of it, an answer is final', async () => {
    await policy({ requireAllGuardians: true });
    const from = delivered.length;
    const made = await file(asG(g1), p1);
    await settle();
    const mark = delivered.length;
    assert.deepEqual(await service.answerConsent(made.id, { consent: false }, asG(g2)), { id: made.id, answer: 'REFUSED', state: 'REFUSED' });
    const refused = await lastDelivered(mark);
    assert.deepEqual(refused.map((entry) => entry.type), ['LEAVE_CONSENT_REFUSED']);
    assert.deepEqual(refused[0]!.recipients.map((r) => r.userId), [g1.id]);
    assert.deepEqual(refused[0]!.email!.recipients, [{ userId: g1.id, email: g1.email }]);
    assert.ok(!JSON.stringify(refused).includes(g2.id) && !/g2|Probe/.test(JSON.stringify(refused[0]!.email)), 'the mail says who refused');
    assert.equal((await lastDelivered(from)).filter((entry) => entry.type === 'LEAVE_REQUESTED').length, 0, 'the mentor heard of a request that ended');
    const forG1 = (await view(asG(g1), made.id))!;
    assert.deepEqual([forG1.status, forG1.consent.state, forG1.decidedById, forG1.decidedAs], ['GUARDIAN_DECLINED', 'REFUSED', null, null]);
    assert.equal(await view(asMentor1, made.id), undefined);
    await assert.rejects(() => service.decideLeaveRequest(made.id, { status: 'APPROVED' } as never, asAdmin), (error: unknown) => codeOf(error) === 'LEAVE_REQUEST_DECIDED');
    // The model route to the same stop is closed by the trigger: reading the SQLSTATE through an updateMany.
    await assert.rejects(
      () => api.withRls(asAdmin, (tx) => tx.leaveRequest.updateMany({ where: { id: made.id }, data: { status: 'APPROVED' } })),
      (error: unknown) => leaveSqlStateOf(error) === 'LV409',
    );
    // Final: the same answer again is no news; the other answer is a 409.
    await settle();
    const again = delivered.length;
    assert.deepEqual(await service.answerConsent(made.id, { consent: false }, asG(g2)), { id: made.id, answer: 'REFUSED', state: 'REFUSED' });
    await settle();
    assert.equal(delivered.length, again);
    await assert.rejects(() => service.answerConsent(made.id, { consent: true }, asG(g2)), (error: unknown) => codeOf(error) === 'LEAVE_CONSENT_ANSWERED');
    // A list of the family says it, and the administrator's counts it.
    const forAdmin = (await view(asAdmin, made.id))!;
    assert.deepEqual([forAdmin.status, forAdmin.consent.state, forAdmin.decides], ['GUARDIAN_DECLINED', 'REFUSED', null]);
    // The model route to an approval that races the consent is read back as LV412 too.
    const waiting = await file(asG(g1), p1);
    await assert.rejects(
      () => api.withRls(asAdmin, (tx) => tx.leaveRequest.updateMany({ where: { id: waiting.id }, data: { status: 'APPROVED' } })),
      (error: unknown) => leaveSqlStateOf(error) === 'LV412',
    );
    await reset();
  });

  await check('mf: a custody that ends clears the request without a yes; the guardian who waited can no longer answer; the pass tells the mentor once', async () => {
    await policy({ requireAllGuardians: true });
    const made = await file(asG(g1), p1);
    const other = await file(asG(g1), p1);
    assert.equal((await view(asAdmin, made.id))!.consent.state, 'WAITING');
    await owner.query(`DELETE FROM "GuardianStudents" WHERE "guardianId" = $1 AND "studentId" = $2`, [g2.id, p1.id]);
    assert.deepEqual((await view(asAdmin, made.id))!.consent, { required: true, state: 'GIVEN', mine: 'NOT_ASKED', asked: 1, given: 0, waiting: 0 });
    await assert.rejects(() => service.answerConsent(made.id, { consent: true }, asG(g2)), (error: unknown) => codeOf(error) === 'LEAVE_CONSENT_CUSTODY_ENDED');
    // The mentor reads it now, and has not been told: the pass tells them, once, for both requests.
    assert.ok(await view(asMentor1, made.id), 'the mentor does not read a request a custody that ended cleared');
    await settle();
    const mark = delivered.length;
    assert.deepEqual(await service.consentPass(), { notices: 2, reminded: 0 });
    const told = (await lastDelivered(mark)).filter((entry) => entry.type === 'LEAVE_REQUESTED');
    assert.equal(told.length, 2, 'the pass told the mentor of one request');
    for (const entry of told) assert.deepEqual(entry.recipients.map((r) => r.userId), [mentor1.id]);
    assert.deepEqual(await service.consentPass(), { notices: 0, reminded: 0 });
    // Rektor decides the other at once.
    assert.equal((await service.decideLeaveRequest(other.id, { status: 'REJECTED' } as never, asAdmin)).status, 'REJECTED');
    await reset();
  });

  await check('mg: the pass reminds once, the guardian who can still answer, two days after the request, with an address and nothing else in the mail', async () => {
    await policy({ requireAllGuardians: true });
    const aged = async (days: number, from: string) => {
      const row = await one<{ id: string }>(
        `INSERT INTO "LeaveRequests" ("schoolId", "studentId", "requestedById", "startDate", "endDate", reason, "consentRequired", "createdAt")
         VALUES ($1, $2, $3, $4::date, $4::date, 'Hemlig anledning', true, now() - make_interval(days => $5)) RETURNING id`,
        [s, p1.id, g1.id, from, days],
      );
      return row.id;
    };
    const due = await aged(3, addDays(today, 20));
    const fresh = await aged(1, addDays(today, 21));
    const over = await aged(3, addDays(today, -5));
    await settle();
    const mark = delivered.length;
    assert.deepEqual(await service.consentPass(), { notices: 1, reminded: 1 });
    const sent = await lastDelivered(mark);
    assert.equal(sent.length, 1);
    assert.equal(sent[0]!.type, 'LEAVE_CONSENT_REMINDER');
    assert.deepEqual(sent[0]!.recipients.map((r) => r.userId), [g2.id]);
    assert.deepEqual(sent[0]!.email!.recipients, [{ userId: g2.id, email: g2.email }]);
    assert.ok(!/Hemlig|Probe|20\d\d/.test(JSON.stringify([sent[0]!.email, sent[0]!.meta])), 'the reminder says too much');
    assert.deepEqual(await service.consentPass(), { notices: 0, reminded: 0 }, 'the second pass reminded again');
    assert.equal(await count(`SELECT count(*) AS n FROM "LeaveConsents" WHERE "remindedAt" IS NOT NULL AND "leaveRequestId" = ANY ($1::uuid[])`, [[due]]), 1);
    assert.equal(await count(`SELECT count(*) AS n FROM "LeaveConsents" WHERE "remindedAt" IS NOT NULL AND "leaveRequestId" = ANY ($1::uuid[])`, [[fresh, over]]), 0);
    await reset();
  });

  await check('mh: the same guardian answering twice at once, an answer and a decision at once: never a decision without the consent, and no deadlock', async () => {
    await policy({ requireAllGuardians: true });
    // yes and yes: both are the same answer, one write.
    const same = await file(asG(g1), p1);
    const results = await Promise.allSettled([service.answerConsent(same.id, { consent: true }, asG(g2)), service.answerConsent(same.id, { consent: true }, asG(g2))]);
    assert.deepEqual(results.map((r) => r.status), ['fulfilled', 'fulfilled'], JSON.stringify(results));
    // yes and no: exactly one wins, the other is a 409 with the code.
    const opposed = await file(asG(g1), p1);
    const pair = await Promise.allSettled([service.answerConsent(opposed.id, { consent: true }, asG(g2)), service.answerConsent(opposed.id, { consent: false }, asG(g2))]);
    assert.equal(pair.filter((r) => r.status === 'fulfilled').length, 1, JSON.stringify(pair));
    const lost = pair.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    assert.equal(codeOf(lost.reason), 'LEAVE_CONSENT_ANSWERED');
    // An answer and a decision at once, forty times.
    for (let round = 0; round < 40; round++) {
      const racing = await file(asG(g1), p1);
      const [answer, decision] = await Promise.allSettled([
        service.answerConsent(racing.id, { consent: round % 2 === 0 }, asG(g2)),
        service.decideLeaveRequest(racing.id, { status: 'APPROVED' } as never, asAdmin),
      ]);
      assert.equal(answer.status, 'fulfilled', `round ${round}: the answer failed: ${JSON.stringify(answer)}`);
      const row = await one<{ status: string; consented: boolean | null }>(
        `SELECT r.status::text AS status, c.consented FROM "LeaveRequests" r JOIN "LeaveConsents" c ON c."leaveRequestId" = r.id WHERE r.id = $1`, [racing.id]);
      if (round % 2 === 0) {
        // A yes: the decision either lost the race (409 awaiting, still pending) or came after it (rejected with the consent given).
        if (decision.status === 'rejected') {
          assert.equal(codeOf(decision.reason), 'LEAVE_AWAITING_CONSENT', `round ${round}: ${String(decision.reason)}`);
          assert.equal(row.status, 'PENDING');
        } else {
          assert.equal(row.status, 'APPROVED');
          assert.equal(row.consented, true, `round ${round}: approved without the consent`);
        }
      } else {
        // A no: the request ended, and a decision that came after it found it ended (or lost before the no).
        assert.equal(row.status === 'GUARDIAN_DECLINED' || (decision.status === 'rejected' && codeOf(decision.reason) === 'LEAVE_AWAITING_CONSENT'), true, `round ${round}: ${row.status} ${JSON.stringify(decision)}`);
        assert.notEqual(row.status, 'APPROVED', `round ${round}: a request the guardian refused was approved`);
      }
    }
    await reset();
  });

  await check('mj: rektor can reject a request that waits for a guardian who never answers; it ends the wait and the late answer is a 409', async () => {
    await policy({ requireAllGuardians: true });
    const made = await file(asG(g1), p1);
    // Approving is held back; rejecting is not (the review of #292, MEDEL-1), and the policy switched off does not undo the stamp.
    await assert.rejects(() => service.decideLeaveRequest(made.id, { status: 'APPROVED' } as never, asAdmin), (error: unknown) => codeOf(error) === 'LEAVE_AWAITING_CONSENT');
    await policy({ requireAllGuardians: false });
    await assert.rejects(() => service.decideLeaveRequest(made.id, { status: 'APPROVED' } as never, asAdmin), (error: unknown) => codeOf(error) === 'LEAVE_AWAITING_CONSENT');
    const mark = delivered.length;
    const decided = await service.decideLeaveRequest(made.id, { status: 'REJECTED', note: 'Vi nådde inte alla vårdnadshavare' } as never, asAdmin);
    assert.deepEqual([decided.status, decided.decidedAs, decided.absenceDays], ['REJECTED', 'ADMIN', 0]);
    // The one who applied is told it was rejected, as for any rejection; no absence is written.
    assert.deepEqual((await lastDelivered(mark)).map((entry) => entry.type), ['LEAVE_DECIDED']);
    assert.equal(await count(`SELECT count(*) AS n FROM "AbsenceReports" WHERE "studentId" = $1 AND "grantedLeave"`, [p1.id]), 0);
    // The guardian who was asked finds it ended, and the request for it is no longer unread work.
    await assert.rejects(() => service.answerConsent(made.id, { consent: true }, asG(g2)), (error: unknown) => codeOf(error) === 'LEAVE_CONSENT_REQUEST_ENDED');
    assert.equal(await count(`SELECT count(*) AS n FROM "Notifications" WHERE "userId" = $1 AND type = 'LEAVE_CONSENT_REQUESTED' AND "readAt" IS NULL AND meta ->> 'leaveRequestId' = $2`, [g2.id, made.id]), 0);
    // The pass reminds nobody about it, however old.
    await owner.query(`UPDATE "LeaveConsents" SET "remindedAt" = NULL WHERE "leaveRequestId" = $1`, [made.id]);
    assert.deepEqual(await service.consentPass(), { notices: 0, reminded: 0 });
    // The mentor never read it.
    assert.equal(await view(asMentor1, made.id), undefined);
    await reset();
  });

  await check('mi: the guardian of a pupil with a protected identity is asked like any other, and the staff\'s overview names nobody who answered', async () => {
    await policy({ requireAllGuardians: true });
    await owner.query(`INSERT INTO "PersonProtections" ("userId", "schoolId", source) VALUES ($1, $2, 'MANUAL') ON CONFLICT DO NOTHING`, [p3.id, s]);
    await settle();
    const mark = delivered.length;
    const made = await file(asAdmin, p3);
    const asked = (await lastDelivered(mark)).filter((entry) => entry.type === 'LEAVE_CONSENT_REQUESTED');
    assert.deepEqual(asked.map((entry) => entry.recipients.map((r) => r.userId)), [[g3.id]]);
    const overview = (await view(asAdmin, made.id))!;
    assert.deepEqual(overview.consent, { required: true, state: 'WAITING', mine: 'NOT_ASKED', asked: 1, given: 0, waiting: 1 });
    assert.ok(!JSON.stringify(overview.consent).includes(g3.id), 'the overview names the guardian');
    assert.equal(await service.answerConsent(made.id, { consent: true }, asG(g3)).then((r) => r.state), 'GIVEN');
    await owner.query(`DELETE FROM "PersonProtections" WHERE "userId" = $1`, [p3.id]);
    await reset();
  });

  await sweepLedighetspolicySchool(owner, marker);
}
