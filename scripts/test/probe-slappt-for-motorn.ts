/**
 * The adapter probe's checks for Släppt för motorn (20270226090000) and the second confirmation of Föreslå bemanning, through the
 * real services on the API's role and real Postgres as CI runs it. In three schools of their own (slugs <marker>-slappt,
 * <marker>-slappt-b and -c), swept whole before and after:
 *
 *   sm1  the full administrator releases a post, releases it again, takes it back, through EngineReleaseService: the first person
 *        and time are kept, each change is one ScheduleChangeLogs row with the ids, and two releases of the same post at once
 *        leave one row (the year's lock queues them; ON CONFLICT DO NOTHING is the second line);
 *   sm2  a teacher reads no release although there is one, the läsare reads it and writes none, the expedition writes none: the
 *        database's arms, which the guard's @Area asks before them;
 *   sm3  another school's administrator meets a 404 for this school's year, a 400 ENGINE_RELEASE_POST_NOT_IN_YEAR for this school's
 *        post named in its own year, and the release stays what it was;
 *   sm4  the proposal through the real reads: a staffed post is fixed whatever "bara obemannade" says until it is released, a
 *        release changes the basis, a release does not override "bara obemannade", and the count says how many are released;
 *   sm5  the apply: a change that gives a teacher a subject or a årskurs they do not teach is refused 409
 *        STAFF_NEW_TEACHING_UNCONFIRMED with flat params until it is confirmed for that very teacher, a change of a staffed post
 *        that is not released is refused STAFF_ROW_NOT_RELEASED, a release set after the proposal makes it stale, and an
 *        undo puts the lead back with no confirmation;
 *   sm6  a person removed leaves the release they made, signed by nobody; a post removed takes its release; a school removed takes
 *        the releases it had;
 *   sm7  a teacher chosen by hand takes the release back, in the same transaction and with a log row: a PATCH of the post through
 *        TeachingRequirementsService and a file through the requirements import, each on the real adapter. A save that sends the lead
 *        the post already has, and a file that names it, leave the release; the apply of a proposal still keeps it.
 *
 * Imported by prisma-adapter-probe.ts, which hands in its `check`.
 */
import { strict as assert } from 'node:assert';
import { randomUUID } from 'node:crypto';
import type { Client } from 'pg';
import { Role } from '../../src/auth/enums/role.enum';
import type { AuthenticatedUser } from '../../src/auth/interfaces/authenticated-user.interface';
import type { PrismaService } from '../../src/database/prisma.service';
import type { StaffRequest, StaffResponse } from '../../src/optimization/interfaces/staffing.interface';
import type { OptimizationProxyService } from '../../src/optimization/optimization-proxy.service';
import {
  STAFF_NEW_TEACHING_UNCONFIRMED,
  STAFF_PROPOSAL_STALE,
  STAFF_ROW_NOT_RELEASED,
  StaffingProposalService,
} from '../../src/optimization/staffing-proposal.service';
import { ImportService } from '../../src/import/import.service';
import { TeachingRequirementsService } from '../../src/resources/teaching-requirements.service';
import { ENGINE_RELEASE_POST_NOT_IN_YEAR, EngineReleaseService } from '../../src/staffing/engine-release.service';
import type { UsersService } from '../../src/users/users.service';

type Check = (label: string, body: () => Promise<void>) => Promise<void>;

export function slapptSlug(marker: string): string {
  return `${marker}-slappt`;
}

export async function sweepSlapptSchools(owner: Client, marker: string): Promise<void> {
  const slug = slapptSlug(marker);
  await owner.query(`DELETE FROM "Schools" WHERE slug IN ($1, $2, $3)`, [slug, `${slug}-b`, `${slug}-c`]);
}

const rejectsWith = async (body: () => Promise<unknown>, status: number, code?: string): Promise<{ params?: Record<string, unknown> }> => {
  let response: { code?: string; params?: Record<string, unknown> } = {};
  await assert.rejects(body, (error: { getStatus?: () => number; getResponse?: () => unknown }) => {
    assert.equal(error.getStatus?.(), status, `status ${String(error.getStatus?.())}: ${JSON.stringify(error.getResponse?.() ?? error)}`);
    response = (error.getResponse?.() ?? {}) as typeof response;
    if (code !== undefined) assert.equal(response.code, code, JSON.stringify(response));
    return true;
  });
  return response;
};

const ZERO_TERMS = {
  unstaffedRows: 0,
  unstaffedMinutes: 0,
  deviationTenths: 0,
  underBandTenths: 0,
  newClassTeachers: 0,
  continuityChanges: 0,
  currentChanges: 0,
  unqualifiedAssignments: 0,
};

/** A stand-in engine that keeps the rules (a kept row keeps its lead, an open row goes to the first teacher with a target). The model is the engine's own tests'. */
const stubEngine = (): OptimizationProxyService =>
  ({
    callAiEngine: async (_path: string, payload: StaffRequest): Promise<StaffResponse> => {
      const assignments: StaffResponse['assignments'] = [];
      const unstaffed: StaffResponse['unstaffed'] = [];
      for (const row of payload.requirements) {
        if (row.fixed) continue;
        if (row.currentTeacherId) {
          assignments.push({ requirementId: row.id, teacherId: row.currentTeacherId });
          continue;
        }
        const pick = payload.teachers.find((teacher) => (teacher.targetTenths ?? 0) > 0 && teacher.id !== row.coTeacherId);
        if (pick) assignments.push({ requirementId: row.id, teacherId: pick.id });
        else unstaffed.push({ requirementId: row.id, reason: 'NO_CAPACITY_LEFT' });
      }
      return { requestId: payload.requestId, status: 'OPTIMAL', unstaffedProven: true, assignments, unstaffed, conflicts: [], terms: { before: ZERO_TERMS, after: ZERO_TERMS } };
    },
  }) as unknown as OptimizationProxyService;

export async function slapptChecks(owner: Client, api: PrismaService, marker: string, check: Check): Promise<void> {
  await sweepSlapptSchools(owner, marker);
  const one = async <T extends object>(sql: string, params: unknown[] = []): Promise<T> => (await owner.query<T>(sql, params)).rows[0]!;
  const many = async <T extends object>(sql: string, params: unknown[] = []): Promise<T[]> => (await owner.query<T>(sql, params)).rows;
  const today = (await one<{ d: string }>(`SELECT ((now() AT TIME ZONE 'Europe/Stockholm')::date)::text AS d`)).d;
  const school = async (slug: string, name: string) =>
    (await one<{ id: string }>(`INSERT INTO "Schools" (name, slug, timezone, "updatedAt") VALUES ($1, $2, 'Europe/Stockholm', now()) RETURNING id`, [name, slug])).id;
  const a = await school(slapptSlug(marker), `${marker} slappt`);
  const b = await school(`${slapptSlug(marker)}-b`, `${marker} slappt b`);
  const yearOf = async (schoolId: string) =>
    (
      await one<{ id: string }>(
        `INSERT INTO "AcademicYears" ("schoolId", name, "startDate", "endDate", "isActive", "gradeNumbering", "updatedAt")
         VALUES ($1, 'probe slappt', '${today}'::date - 30, '${today}'::date + 300, true, 'NIOARIG', now()) RETURNING id`,
        [schoolId],
      )
    ).id;
  const yearA = await yearOf(a);
  const yearB = await yearOf(b);
  await owner.query(`INSERT INTO "StaffingPolicies" ("schoolId", "fullTimeTeachingMinutesPerWeek", "updatedAt") VALUES ($1, 600, now())`, [a]);
  const group = async (schoolId: string, yearId: string, name: string, grade: number) =>
    (
      await one<{ id: string }>(
        `INSERT INTO "StudentGroups" ("schoolId", "academicYearId", name, kind, "gradeLevel", "updatedAt") VALUES ($1, $2, $3, 'CLASS', $4, now()) RETURNING id`,
        [schoolId, yearId, name, grade],
      )
    ).id;
  const g7 = await group(a, yearA, '7A', 7);
  const g8 = await group(a, yearA, '8A', 8);
  const gB = await group(b, yearB, '7B', 7);
  const subject = async (schoolId: string, name: string, code: string) =>
    (await one<{ id: string }>(`INSERT INTO "Subjects" ("schoolId", name, code, "updatedAt") VALUES ($1, $2, $3, now()) RETURNING id`, [schoolId, name, code])).id;
  const ma = await subject(a, 'Matematik', 'MA');
  const sv = await subject(a, 'Svenska', 'SV');
  const maB = await subject(b, 'Matematik', 'MA');
  const person = async (schoolId: string, role: string, label: string, profile: string | null = null) => {
    const authId = randomUUID();
    const row = await one<{ id: string }>(
      `INSERT INTO "Users" ("schoolId", email, "firstName", "lastName", role, "adminProfile", "authId", "isActive", "updatedAt")
       VALUES ($1, $2, $3, 'Probe', $4::"UserRole", $5::"AdminProfile", $6, true, now()) RETURNING id`,
      [schoolId, `${marker}-slappt-${label}@example.invalid`, label, role, profile, authId],
    );
    return { id: row.id, authId };
  };
  const user = (schoolId: string, who: { id: string; authId: string }, role: Role, adminProfile?: AuthenticatedUser['adminProfile']): AuthenticatedUser => ({
    authId: who.authId,
    userId: who.id,
    schoolId,
    role,
    channel: 'WEB',
    ...(adminProfile ? { adminProfile } : {}),
  });
  const full = await person(a, 'SCHOOL_ADMIN', 'full', 'FULL');
  const planner = await person(a, 'SCHOOL_ADMIN', 'planerare', 'SCHEMALAGGARE');
  const reader = await person(a, 'SCHOOL_ADMIN', 'lasare', 'LASARE');
  const clerk = await person(a, 'SCHOOL_ADMIN', 'expedition', 'EXPEDITION');
  const releaser = await person(a, 'SCHOOL_ADMIN', 'avgangen', 'FULL');
  const t1 = await person(a, 'TEACHER', 'karin');
  const t2 = await person(a, 'TEACHER', 'lars');
  const t3 = await person(a, 'TEACHER', 'maria');
  const fullB = await person(b, 'SCHOOL_ADMIN', 'full-b', 'FULL');
  for (const t of [t1, t2, t3]) {
    await owner.query(
      `INSERT INTO "TeacherEmployments" ("schoolId", "userId", "academicYearId", "employmentPercent", "updatedAt") VALUES ($1, $2, $3, 100, now())`,
      [a, t.id, yearA],
    );
  }
  const requirement = async (schoolId: string, yearId: string, subjectId: string, groupId: string, teacherId: string | null) =>
    (
      await one<{ id: string }>(
        `INSERT INTO "TeachingRequirements" ("schoolId", "academicYearId", "subjectId", "studentGroupId", "teacherId", "lessonsPerWeek", "minutesPerLesson", "updatedAt")
         VALUES ($1, $2, $3, $4, $5, 2, 60, now()) RETURNING id`,
        [schoolId, yearId, subjectId, groupId, teacherId],
      )
    ).id;
  const p1 = await requirement(a, yearA, ma, g7, t1.id); // Karin leads Matematik 7A: staffed, chosen by the school
  const p2 = await requirement(a, yearA, ma, g8, null); // Matematik 8A: nobody
  const p3 = await requirement(a, yearA, sv, g7, t2.id); // Lars leads Svenska 7A
  const pB = await requirement(b, yearB, maB, gB, null);
  const asFull = user(a, full, Role.SCHOOL_ADMIN, 'FULL');
  const asPlanner = user(a, planner, Role.SCHOOL_ADMIN, 'SCHEMALAGGARE');
  const asReader = user(a, reader, Role.SCHOOL_ADMIN, 'LASARE');
  const asClerk = user(a, clerk, Role.SCHOOL_ADMIN, 'EXPEDITION');
  const asReleaser = user(a, releaser, Role.SCHOOL_ADMIN, 'FULL');
  const asTeacher = user(a, t1, Role.TEACHER);
  const asFullB = user(b, fullB, Role.SCHOOL_ADMIN, 'FULL');
  const releases = new EngineReleaseService(api);
  const staffing = new StaffingProposalService(api, stubEngine());
  const releasedIds = async (schoolId = a) =>
    (await many<{ requirementId: string }>(`SELECT "requirementId" FROM "TeachingRequirementReleases" WHERE "schoolId" = $1 ORDER BY "requirementId"`, [schoolId])).map((r) => r.requirementId).sort();
  const logRows = async () =>
    Number((await one<{ n: string }>(`SELECT count(*)::text AS n FROM "ScheduleChangeLogs" WHERE "schoolId" = $1 AND after ->> 'kind' = 'ENGINE_RELEASE'`, [a])).n);
  const leadOf = async (id: string) => (await one<{ t: string | null }>(`SELECT "teacherId"::text AS t FROM "TeachingRequirements" WHERE id = $1`, [id])).t;

  try {
    await check('(sm1) the full administrator releases, releases again and takes back; the first person and time are kept', async () => {
      assert.deepEqual(await releases.set({ academicYearId: yearA, requirementIds: [p1], released: true }, asFull), { changed: 1, unchanged: 0 });
      const first = await one<{ by: string; at: string }>(`SELECT "releasedById"::text AS by, "releasedAt"::text AS at FROM "TeachingRequirementReleases" WHERE "requirementId" = $1`, [p1]);
      assert.equal(first.by, full.id);
      // The second administrator's release of the same post writes nothing and keeps the first.
      assert.deepEqual(await releases.set({ academicYearId: yearA, requirementIds: [p1], released: true }, asPlanner), { changed: 0, unchanged: 1 });
      const again = await one<{ by: string; at: string }>(`SELECT "releasedById"::text AS by, "releasedAt"::text AS at FROM "TeachingRequirementReleases" WHERE "requirementId" = $1`, [p1]);
      assert.deepEqual(again, first);
      const listed = await releases.list(yearA, asFull);
      assert.equal(listed.releases.length, 1);
      assert.equal(listed.releases[0]!.requirementId, p1);
      assert.equal(listed.releases[0]!.releasedById, full.id);
      assert.match(listed.releases[0]!.releasedAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
      assert.equal(await logRows(), 1);
      assert.deepEqual(await releases.set({ academicYearId: yearA, requirementIds: [p1, p2], released: false }, asFull), { changed: 1, unchanged: 1 });
      assert.deepEqual(await releasedIds(), []);
      assert.equal(await logRows(), 2);
      // Two releases of one post at once: one row, whichever writes it.
      const both = await Promise.all([
        releases.set({ academicYearId: yearA, requirementIds: [p3], released: true }, asFull),
        releases.set({ academicYearId: yearA, requirementIds: [p3], released: true }, asPlanner),
      ]);
      assert.equal(both.reduce((sum, r) => sum + r.changed, 0), 1, JSON.stringify(both));
      assert.deepEqual(await releasedIds(), [p3]);
      await releases.set({ academicYearId: yearA, requirementIds: [p3], released: false }, asFull);
      assert.deepEqual(await releasedIds(), []);
    });

    await check('(sm1b) a post named in upper case is the post: released once, logged once, and taken back (review of #363)', async () => {
      const upper = p2.toUpperCase();
      assert.notEqual(upper, p2, 'the post id has no letter to spell in upper case');
      assert.deepEqual(await releases.set({ academicYearId: yearA, requirementIds: [upper], released: true }, asFull), { changed: 1, unchanged: 0 });
      assert.deepEqual(await releases.set({ academicYearId: yearA, requirementIds: [upper], released: true }, asFull), { changed: 0, unchanged: 1 });
      assert.deepEqual(await releasedIds(), [p2]);
      assert.deepEqual(await releases.set({ academicYearId: yearA, requirementIds: [upper], released: false }, asFull), { changed: 1, unchanged: 0 });
      assert.deepEqual(await releasedIds(), []);
    });

    await check('(sm2) a teacher reads no release, the läsare reads and writes none, the expedition writes none', async () => {
      await releases.set({ academicYearId: yearA, requirementIds: [p1], released: true }, asFull);
      assert.deepEqual((await releases.list(yearA, asTeacher)).releases, [], 'a teacher read a release');
      assert.deepEqual((await releases.list(yearA, asReader)).releases.map((r) => r.requirementId), [p1]);
      for (const who of [asReader, asClerk]) {
        await assert.rejects(() => releases.set({ academicYearId: yearA, requirementIds: [p2], released: true }, who), /./, `${who.adminProfile} released a post`);
        await assert.rejects(() => releases.set({ academicYearId: yearA, requirementIds: [p1], released: false }, who), /./, `${who.adminProfile} took a release back`);
      }
      await assert.rejects(() => releases.set({ academicYearId: yearA, requirementIds: [p2], released: true }, asTeacher));
      assert.deepEqual(await releasedIds(), [p1], 'a refused write changed something');
      await releases.set({ academicYearId: yearA, requirementIds: [p1], released: false }, asFull);
    });

    await check('(sm3) another school meets a 404 for this school’s year, a 400 for this school’s post, and changes nothing', async () => {
      await releases.set({ academicYearId: yearA, requirementIds: [p1], released: true }, asFull);
      await rejectsWith(() => releases.list(yearA, asFullB), 404);
      await rejectsWith(() => releases.set({ academicYearId: yearA, requirementIds: [p1], released: false }, asFullB), 404);
      const refused = await rejectsWith(
        () => releases.set({ academicYearId: yearB, requirementIds: [p1], released: true }, asFullB),
        400,
        ENGINE_RELEASE_POST_NOT_IN_YEAR,
      );
      assert.deepEqual(refused.params, { count: 1 });
      // Its own post, in its own school: released, and not visible to the other school.
      assert.deepEqual(await releases.set({ academicYearId: yearB, requirementIds: [pB], released: true }, asFullB), { changed: 1, unchanged: 0 });
      assert.deepEqual(await releasedIds(a), [p1]);
      assert.deepEqual(await releasedIds(b), [pB]);
      assert.deepEqual((await releases.list(yearB, asFullB)).releases.map((r) => r.requirementId), [pB]);
      await releases.set({ academicYearId: yearA, requirementIds: [p1], released: false }, asFull);
      await releases.set({ academicYearId: yearB, requirementIds: [pB], released: false }, asFullB);
    });

    await check('(sm4) a staffed post is fixed until it is released, a release changes the basis, and does not override "bara obemannade"', async () => {
      const ask = (onlyUnstaffed: boolean) => staffing.propose({ academicYearId: yearA, onlyUnstaffed, respectQualifications: false }, asFull);
      const none = await ask(false);
      assert.deepEqual(
        { free: none.counts.freeRequirements, open: none.counts.openRequirements, kept: none.counts.keptRequirements, fixed: none.counts.fixedRequirements, released: none.counts.releasedRequirements },
        { free: 1, open: 1, kept: 0, fixed: 2, released: 0 },
        'Karin’s and Lars’s posts must be fixed whatever "bara obemannade" says',
      );
      await releases.set({ academicYearId: yearA, requirementIds: [p1], released: true }, asFull);
      const released = await ask(false);
      assert.deepEqual(
        { free: released.counts.freeRequirements, open: released.counts.openRequirements, kept: released.counts.keptRequirements, fixed: released.counts.fixedRequirements, released: released.counts.releasedRequirements },
        { free: 2, open: 1, kept: 1, fixed: 1, released: 1 },
      );
      assert.notEqual(released.basisSha256, none.basisSha256, 'a release must change the basis');
      const narrow = await ask(true);
      assert.deepEqual(
        { free: narrow.counts.freeRequirements, kept: narrow.counts.keptRequirements, released: narrow.counts.releasedRequirements },
        { free: 1, kept: 0, released: 1 },
      );
      await releases.set({ academicYearId: yearA, requirementIds: [p1], released: false }, asFull);
      assert.equal((await ask(false)).basisSha256, none.basisSha256, 'taking the release back must restore the basis');
    });

    await check('(sm5) the second confirmation, the release rule at the apply, a stale basis and the undo', async () => {
      const proposal = await staffing.propose({ academicYearId: yearA, onlyUnstaffed: true, respectQualifications: false }, asFull);
      // Maria teaches nothing today: Matematik 8A is a new subject and a new year to her.
      const change = { requirementId: p2, fromTeacherId: null, toTeacherId: t3.id };
      const body = { academicYearId: yearA, basisSha256: proposal.basisSha256, changes: [change] };
      const unconfirmed = await rejectsWith(() => staffing.apply(body, asFull), 409, STAFF_NEW_TEACHING_UNCONFIRMED);
      assert.deepEqual(unconfirmed.params, { count: 1, requirementId: p2, userId: t3.id, newSubject: 1, newYears: '8' });
      assert.equal(await leadOf(p2), null, 'an unconfirmed apply wrote');
      // Confirmed for another teacher: not confirmed for her.
      await rejectsWith(() => staffing.apply({ ...body, confirmedNewTeaching: [{ requirementId: p2, toTeacherId: t2.id }] }, asFull), 409, STAFF_NEW_TEACHING_UNCONFIRMED);
      const applied = await staffing.apply({ ...body, confirmedNewTeaching: [{ requirementId: p2, toTeacherId: t3.id }] }, asFull);
      assert.equal(applied.updated, 1);
      assert.equal(await leadOf(p2), t3.id);
      // The undo puts the lead back and asks for no confirmation.
      await staffing.apply(
        { academicYearId: yearA, basisSha256: applied.basisSha256, undo: true, changes: [{ requirementId: p2, fromTeacherId: t3.id, toTeacherId: null }] },
        asFull,
      );
      assert.equal(await leadOf(p2), null);
      // A staffed post the school has not released is moved by nobody, whatever the proposal read.
      const staffed = await staffing.propose({ academicYearId: yearA, onlyUnstaffed: true, respectQualifications: false }, asFull);
      const moved = { academicYearId: yearA, basisSha256: staffed.basisSha256, confirmedNewTeaching: [{ requirementId: p1, toTeacherId: t3.id }], changes: [{ requirementId: p1, fromTeacherId: t1.id, toTeacherId: t3.id }] };
      const notReleased = await rejectsWith(() => staffing.apply(moved, asFull), 409, STAFF_ROW_NOT_RELEASED);
      assert.deepEqual(notReleased.params, { requirementId: p1 });
      assert.equal(await leadOf(p1), t1.id);
      // Released: the same change is let through, once the proposal has read the release; a proposal older than the release is stale.
      await releases.set({ academicYearId: yearA, requirementIds: [p1], released: true }, asFull);
      await rejectsWith(() => staffing.apply(moved, asFull), 409, STAFF_PROPOSAL_STALE);
      const fresh = await staffing.propose({ academicYearId: yearA, onlyUnstaffed: false, respectQualifications: false }, asFull);
      const released = await staffing.apply({ ...moved, basisSha256: fresh.basisSha256 }, asFull);
      assert.equal(released.updated, 1);
      assert.equal(await leadOf(p1), t3.id);
      // The release is still the school's: applying a proposal does not take it back.
      assert.deepEqual(await releasedIds(), [p1]);
      await owner.query(`UPDATE "TeachingRequirements" SET "teacherId" = $1 WHERE id = $2`, [t1.id, p1]);
      await releases.set({ academicYearId: yearA, requirementIds: [p1], released: false }, asFull);
    });

    await check('(sm6) a person removed leaves the release unsigned, a post removed takes its release, a school removed takes its releases', async () => {
      await releases.set({ academicYearId: yearA, requirementIds: [p1, p3], released: true }, asReleaser);
      assert.deepEqual(
        (await many<{ by: string }>(`SELECT "releasedById"::text AS by FROM "TeachingRequirementReleases" WHERE "schoolId" = $1 ORDER BY "requirementId"`, [a])).map((r) => r.by),
        [releaser.id, releaser.id],
      );
      // The administrator's own DELETE of a Users row, as the owner makes it here (users.service.ts remove() writes the same one).
      await owner.query(`DELETE FROM "Users" WHERE id = $1`, [releaser.id]);
      const unsigned = await releases.list(yearA, asFull);
      assert.deepEqual(unsigned.releases.map((r) => [r.requirementId, r.releasedById]).sort(), [[p1, null], [p3, null]].sort());
      assert.deepEqual(await releasedIds(), [p1, p3].sort(), 'the person removed took the release with them');
      // A post removed takes its release, and only its own.
      await owner.query(`DELETE FROM "TeachingRequirements" WHERE id = $1`, [p3]);
      assert.deepEqual(await releasedIds(), [p1]);
      // A school removed takes its releases (a third school, so that the others are not touched).
      const c = await school(`${slapptSlug(marker)}-c`, `${marker} slappt c`);
      const yearC = await yearOf(c);
      const gC = await group(c, yearC, '7C', 7);
      const maC = await subject(c, 'Matematik', 'MA');
      const pC = await requirement(c, yearC, maC, gC, null);
      const adminC = await person(c, 'SCHOOL_ADMIN', 'full-c', 'FULL');
      await releases.set({ academicYearId: yearC, requirementIds: [pC], released: true }, user(c, adminC, Role.SCHOOL_ADMIN, 'FULL'));
      assert.deepEqual(await releasedIds(c), [pC]);
      await owner.query(`DELETE FROM "Schools" WHERE id = $1`, [c]);
      assert.deepEqual(await releasedIds(c), []);
      assert.deepEqual(await releasedIds(a), [p1]);
    });

    await check('(sm7) a teacher chosen by hand, in the post’s PATCH or by file, takes the release back with a log row', async () => {
      const posts = new TeachingRequirementsService(api);
      const imports = new ImportService(api, {} as UsersService);
      const take = async () =>
        Number((await one<{ n: string }>(`SELECT count(*)::text AS n FROM "ScheduleChangeLogs" WHERE "schoolId" = $1 AND after ->> 'because' = 'TEACHER_CHANGED_BY_HAND'`, [a])).n);
      await owner.query(`UPDATE "TeachingRequirements" SET "teacherId" = $1 WHERE id = $2`, [t1.id, p1]);
      await releases.set({ academicYearId: yearA, requirementIds: [p1], released: false }, asFull);
      await releases.set({ academicYearId: yearA, requirementIds: [p1], released: true }, asFull);
      assert.deepEqual(await releasedIds(), [p1]);
      const before = await take();

      // A save that sends the lead the post already has leaves the release: the school has chosen nothing new.
      await posts.update(p1, { teacherId: t1.id, lessonsPerWeek: 3 }, asFull);
      assert.deepEqual(await releasedIds(), [p1], 'a save that left the lead took the release back');
      assert.equal(await take(), before);

      // Another teacher chosen in the post's PATCH: the release goes with the change, and the log says why.
      await posts.update(p1, { teacherId: t3.id }, asFull);
      assert.equal(await leadOf(p1), t3.id);
      assert.deepEqual(await releasedIds(), [], 'the release outlived a teacher chosen by hand');
      assert.equal(await take(), before + 1);
      const logged = await one<{ ids: string; released: string; actor: string }>(
        `SELECT after -> 'requirementIds' ->> 0 AS ids, after ->> 'released' AS released, "actorId"::text AS actor FROM "ScheduleChangeLogs"
          WHERE "schoolId" = $1 AND after ->> 'because' = 'TEACHER_CHANGED_BY_HAND' ORDER BY "createdAt" DESC LIMIT 1`,
        [a],
      );
      assert.deepEqual(logged, { ids: p1, released: 'false', actor: full.id });
      // A post nobody released: the same PATCH writes nothing about releases.
      await posts.update(p1, { teacherId: t1.id }, asFull);
      assert.equal(await take(), before + 1, 'a post nobody released was logged');

      // A file: the same post, released again, given another teacher by e-mail; and a file that names the lead it has.
      await releases.set({ academicYearId: yearA, requirementIds: [p1], released: true }, asFull);
      const columns = ['teacherEmail'] as const;
      const file = (teacherEmail: string) => ({ groupName: '7A', subject: 'MA', lessonsPerWeek: 2, minutesPerLesson: 60, recurrence: 'ALL_WEEKS' as const, teacherEmail });
      const same = await imports.importRequirements({ academicYearId: yearA, columns: [...columns], rows: [file(`${marker}-slappt-karin@example.invalid`)] }, asFull);
      assert.deepEqual(same.errors, []);
      assert.deepEqual(await releasedIds(), [p1], 'a file naming the lead the post has took the release back');
      const moved = await imports.importRequirements({ academicYearId: yearA, columns: [...columns], rows: [file(`${marker}-slappt-lars@example.invalid`)] }, asFull);
      assert.deepEqual(moved.errors, []);
      assert.equal(moved.updated, 1);
      assert.equal(await leadOf(p1), t2.id);
      assert.deepEqual(await releasedIds(), [], 'the release outlived a teacher chosen by file');
      assert.equal(await take(), before + 2);

      // The proposal that follows treats the post as the school's choice, and the apply of a proposal still keeps a release.
      const after = await staffing.propose({ academicYearId: yearA, onlyUnstaffed: false, respectQualifications: false }, asFull);
      assert.equal(after.counts.releasedRequirements, 0);
      assert.equal(after.counts.keptRequirements, 0);
      await owner.query(`UPDATE "TeachingRequirements" SET "teacherId" = $1 WHERE id = $2`, [t1.id, p1]);
    });
  } finally {
    await sweepSlapptSchools(owner, marker);
  }
}
