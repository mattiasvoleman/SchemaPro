/**
 * Huvudman (20261212090000–090200) through the real adapter
 * (prisma-adapter-probe.ts calls this). The RLS suite proves the resolver,
 * the arms and the functions in psql (sections 260–268), and the e2e suite
 * mocks PrismaService; what neither shows is the gateway's half against the
 * database: the lookups JwtStrategy and the realtime gateway make, the
 * principal they build, the read log a reader's recordRead writes, the key's
 * transactions and what @prisma/adapter-pg hands back for an HM refusal.
 *
 *   (hm-a) the reader's lookup, under the claims and the choice, finds the
 *          reader at a school the huvudman owns and nobody elsewhere; a
 *          member is a member, an administrator is none;
 *   (hm-b) withRls as the reader: the database answers for the school named,
 *          as the läsare, with no user id; a recordRead writes the school's
 *          log with the member and no Users row;
 *   (hm-c) the switcher's list: the reader's three schools with the
 *          huvudman and the member's name;
 *   (hm-d) the key: resolveHuvudmanKey finds the live key, its huvudman and
 *          its three schools, and no revoked key; a school opened for it is
 *          that school's principal (the same rows as the school's own), a
 *          school the huvudman does not own is HM403, read by huvudmanRefusal
 *          through the adapter as a 403;
 *   (hm-e) the provider through Ss12000HuvudmanReads: /persons walks the
 *          huvudman's schools, a page from one school, and each read is
 *          written in that school's log as the huvudman's key;
 *   (hm-f) HuvudmanService as the kommunadministratör: the huvudman's view,
 *          and a question to a school it owns refused as the 409 it is;
 *   (hm-g) HuvudmanService's writes through the generated client, which
 *          names every column it fills: a member invited (no Supabase here,
 *          so no login), the same address again a 409, a planner's invite a
 *          403; a key made and revoked; the kommunadministratör making
 *          themself inactive while another is active, and refused when none
 *          would be left. The owner deletes what it made, and makes K
 *          active again.
 *   (hm-h) the rektor's assessments of a teacher (20270306090000) as a
 *          reader without HR-läs gets them: the database hands the reader and
 *          a planner every row of the school (the administrators' arm), so
 *          the gateway (hr-visibility) is the only thing that keeps the
 *          level, the day, the note and who decided from them, in the list
 *          and in the load report alike; a planner reads their own row
 *          whole, an administrator with HR-läs every one whole. The owner
 *          makes a nine-year läsår of its own for it and removes it.
 *
 * On the RLS fixtures (run-rls-tests.sh first): huvudmannen H owns the seeded
 * school, rls-roller-school and rls-huvudman-c. What it writes is rolled back,
 * is the read log's own rows, which it leaves (append-only), or is (hm-g)'s,
 * which the owner deletes.
 */
import { strict as assert } from 'node:assert';
import { ConflictException, ForbiddenException } from '@nestjs/common';
import type { Client } from 'pg';
import { Role } from '../../src/auth/enums/role.enum';
import { huvudmanReaderOf, isHuvudmanMember } from '../../src/auth/huvudman-reader';
import type { AuthenticatedUser } from '../../src/auth/interfaces/authenticated-user.interface';
import type { PrismaService } from '../../src/database/prisma.service';
import { recordRead } from '../../src/access-log/access-log';
import { huvudmanRefusal } from '../../src/huvudman/huvudman-errors';
import { HuvudmanService } from '../../src/huvudman/huvudman.service';
import { ScopeAssessmentsService, type ScopeAssessmentResponse } from '../../src/staffing/scope-assessments.service';
import { StaffingLoadService } from '../../src/staffing/staffing-load.service';
import { resolveHuvudmanKey } from '../../src/integration/integration-key';
import { Ss12000HuvudmanReads } from '../../src/integration/ss12000-v2/huvudman-reads';
import { Ss12000V2Service } from '../../src/integration/ss12000-v2/ss12000-v2.service';
import type { SupabaseAdminService } from '../../src/users/supabase-admin.service';
import { MySchoolsService } from '../../src/users/my-schools.service';

type Check = (label: string, body: () => Promise<void>) => Promise<void>;

const P = 'fe000000-0000-4000-8000-000000000260';
const K = 'fe000000-0000-4000-8000-000000000261';
const LIVE_KEY = `sh_${'a'.repeat(48)}`;
const REVOKED_KEY = `sh_${'b'.repeat(48)}`;

export async function huvudmanChecks(owner: Client, api: PrismaService, check: Check): Promise<void> {
  const ids = (
    await owner.query<{ slug: string; id: string }>(
      `SELECT s.slug, s.id FROM "Schools" s WHERE s.slug IN ('rls-roller-school', 'rls-huvudman-c', 'rls-fixture-school')
       UNION ALL SELECT 'a', hs."schoolId" FROM "HuvudmanSchools" hs JOIN "Huvudmen" h ON h.id = hs."huvudmanId"
        WHERE h."organisationNumber" = '2121000001'
          AND hs."schoolId" NOT IN (SELECT id FROM "Schools" WHERE slug IN ('rls-roller-school', 'rls-huvudman-c'))`,
    )
  ).rows;
  const of = (slug: string) => ids.find((row) => row.slug === slug)?.id;
  const roller = of('rls-roller-school');
  const c = of('rls-huvudman-c');
  const b = of('rls-fixture-school');
  const a = of('a');
  assert.ok(roller && c && b && a, 'the RLS fixtures have no huvudman (run run-rls-tests.sh first)');
  const member = (
    await owner.query<{ id: string; huvudmanId: string }>(`SELECT id, "huvudmanId" FROM "HuvudmanMembers" WHERE "authId" = $1`, [P])
  ).rows[0]!;
  const reader = (school: string): AuthenticatedUser => ({
    authId: P,
    role: Role.SCHOOL_ADMIN,
    schoolId: school,
    adminProfile: 'LASARE',
    hrRead: false,
    huvudman: { id: member.huvudmanId, name: 'RLS Kommun', memberId: member.id, role: 'PLANERARE', firstName: 'Huvudman', lastName: 'Planerare' },
  });

  await check('(hm-a) the reader\'s lookup finds the reader at a school the huvudman owns, and nobody elsewhere', async () => {
    const found = await huvudmanReaderOf(api, P, { school: roller! });
    assert.deepEqual(found, {
      id: member.huvudmanId,
      name: 'RLS Kommun',
      memberId: member.id,
      role: 'PLANERARE',
      firstName: 'Huvudman',
      lastName: 'Planerare',
      schoolId: roller,
    });
    assert.equal(await huvudmanReaderOf(api, P, { school: b! }), null);
    assert.equal(await huvudmanReaderOf(api, P, {}), null);
    assert.equal(await huvudmanReaderOf(api, P, { school: c!, closedSchools: { [c!]: 'sso_required' } }), null);
    // JwtStrategy's own lookup finds no Users row for the reader.
    const own = await api.withVerifiedSubject(P, (db) => db.user.findFirst({ where: { authId: P }, select: { id: true } }), { school: roller! });
    assert.equal(own, null);
    assert.equal(await isHuvudmanMember(api, P), true);
    assert.equal(await isHuvudmanMember(api, '00000000-0000-4000-8000-000000000105'), false);
  });

  await check('(hm-b) withRls as the reader answers for the school as its läsare, and a recordRead names the member', async () => {
    const pupil = (
      await owner.query<{ id: string }>(
        `SELECT id FROM "Users" WHERE "schoolId" = $1 AND role = 'STUDENT' AND "isActive" ORDER BY "authId" LIMIT 1`,
        [roller],
      )
    ).rows[0]!.id;
    const before = new Date();
    const seen = await api.withRls(reader(roller!), async (tx) => {
      const [row] = await tx.$queryRaw<
        { school: string | null; role: string | null; userId: string | null; mayRead: boolean; mayWrite: boolean; decides: boolean }[]
      >`SELECT app.current_school_id()::text AS school, app.current_user_role()::text AS role, app.current_user_id()::text AS "userId",
               app.current_user_may('PERSONAL', false) AS "mayRead", app.current_user_may('PERSONAL', true) AS "mayWrite",
               app.current_user_decides() AS decides`;
      const visible = await tx.user.count({ where: { id: pupil } });
      await recordRead(tx, 'PEOPLE', [pupil], 'WEB');
      return { ...row!, visible };
    });
    assert.deepEqual(seen, { school: roller, role: 'SCHOOL_ADMIN', userId: null, mayRead: true, mayWrite: false, decides: false, visible: 1 });
    const logged = (
      await owner.query<{ actor: string | null; role: string | null; member: string | null; channel: string }>(
        `SELECT "actorId"::text AS actor, "actorRole"::text AS role, "huvudmanMemberId"::text AS member, channel::text AS channel
           FROM "PersonalDataAccess" WHERE "schoolId" = $1 AND $2::uuid = ANY ("subjectIds") AND at >= $3 AND "huvudmanMemberId" IS NOT NULL`,
        [roller, pupil, before],
      )
    ).rows;
    assert.deepEqual(logged, [{ actor: null, role: 'SCHOOL_ADMIN', member: member.id, channel: 'WEB' }]);
  });

  await check('(hm-c) the switcher lists the reader\'s three schools with the huvudman and the member\'s name', async () => {
    const schools = await new MySchoolsService(api).list({ authId: P, role: Role.HUVUDMAN });
    assert.deepEqual(
      schools.map((school) => school.schoolId).sort(),
      [a!, roller!, c!].sort(),
    );
    assert.ok(schools.every((school) => school.role === 'SCHOOL_ADMIN' && school.adminProfile === 'LASARE' && !school.current));
    assert.ok(
      schools.every(
        (school) => school.huvudman?.name === 'RLS Kommun' && school.huvudman.memberId === member.id && school.huvudman.firstName === 'Huvudman',
      ),
    );
  });

  await check('(hm-d) the key resolves to its huvudman and schools, opens only its own, and HM403 reads as a 403', async () => {
    const live = await resolveHuvudmanKey(api, LIVE_KEY, { touch: false });
    assert.ok(live, 'the live key did not resolve');
    assert.deepEqual(live.schools, [a!, roller!, c!].sort());
    assert.deepEqual([live.huvudman.name, live.huvudman.organisationNumber, live.huvudman.municipalityCode], ['RLS Kommun', '2121000001', '0884']);
    assert.deepEqual(live.scopes, ['organisations.read', 'persons.read', 'groups.read']);
    assert.equal(await resolveHuvudmanKey(api, REVOKED_KEY, { touch: false }), null);

    const own = await api.withServicePrincipal(roller!, (tx) => tx.user.count());
    const opened = await api.withHuvudmanKeyPrincipal(live.id, roller!, (tx) => tx.user.count());
    assert.ok(own > 0);
    assert.equal(opened, own);
    let refused: unknown = null;
    try {
      await api.withHuvudmanKeyPrincipal(live.id, b!, (tx) => tx.user.count());
    } catch (error) {
      refused = error;
    }
    const mapped = huvudmanRefusal(refused);
    assert.ok(mapped instanceof ForbiddenException, `HM403 read as ${String(mapped)} from ${String(refused)}`);
  });

  await check('(hm-e) /persons walks the huvudman\'s schools a page from one school each, written in each school\'s log as the key', async () => {
    const live = (await resolveHuvudmanKey(api, LIVE_KEY, { touch: false }))!;
    const reads = new Ss12000HuvudmanReads(new Ss12000V2Service(api));
    const caller = { keyId: live.id, scopes: new Set(live.scopes), huvudman: live.huvudman, schools: live.schools };
    const before = new Date();
    const fromSchool = new Map<string, string>();
    for (const school of live.schools) {
      for (const row of (await owner.query<{ id: string; emitted: string }>(
        `SELECT id::text, coalesce("ss12000Id", id)::text AS emitted FROM "Users" WHERE "schoolId" = $1`, [school])).rows) {
        fromSchool.set(row.emitted.toLowerCase(), school);
      }
    }
    let token: string | null = null;
    const schoolsSeen: string[] = [];
    let pages = 0;
    do {
      const page: { data: Array<{ id: string }>; pageToken: string | null } = await reads.list(
        'listPersons',
        caller,
        token ? { pageToken: token, limit: '50' } : { limit: '50' },
      );
      const schools = new Set(page.data.map((person) => fromSchool.get(person.id.toLowerCase())));
      assert.ok(schools.size <= 1, `a page held persons of ${schools.size} schools`);
      for (const school of schools) if (school && !schoolsSeen.includes(school)) schoolsSeen.push(school);
      token = page.pageToken;
      pages += 1;
      assert.ok(pages < 200, 'the walk did not end');
    } while (token);
    assert.deepEqual(schoolsSeen, live.schools.filter((school) => [...fromSchool.values()].includes(school)));
    const logged = (
      await owner.query<{ school: string }>(
        `SELECT DISTINCT "schoolId"::text AS school FROM "PersonalDataAccess"
          WHERE "huvudmanApiKeyId" = $1 AND at >= $2 AND channel = 'INTEGRATION' AND "apiKeyId" IS NULL`,
        [live.id, before],
      )
    ).rows.map((row) => row.school);
    assert.deepEqual(logged.sort(), schoolsSeen.slice().sort());
  });

  await check('(hm-f) HuvudmanService as the kommunadministratör: the view, and a question to an owned school as a 409', async () => {
    const supabase = { isConfigured: false } as unknown as SupabaseAdminService;
    const service = new HuvudmanService(api, supabase);
    const k: AuthenticatedUser = { authId: K, role: Role.HUVUDMAN };
    const [mine] = await service.mine(k);
    assert.equal(mine?.role, 'KOMMUNADMINISTRATOR');
    const view = await service.view(k, mine!.id);
    assert.deepEqual(
      view.schools.map((school) => `${school.state}:${school.id === a ? 'A' : school.slug}`).sort(),
      ['OWNED:A', 'OWNED:rls-huvudman-c', 'OWNED:rls-roller-school', 'REQUESTED:rls-fixture-school', 'REQUESTED:rls-huvudman-d'],
    );
    assert.equal(view.keys?.length, 2);
    assert.ok(view.members.some((one) => one.role === 'KOMMUNADMINISTRATOR' && one.invited));
    await assert.rejects(service.requestSchool(k, mine!.id, 'rls-roller-school'), (error) => error instanceof ConflictException);
    // A planner sees no keys.
    const planner = await service.view({ authId: P, role: Role.HUVUDMAN }, mine!.id);
    assert.equal(planner.keys, null);
  });

  await check('(hm-g) HuvudmanService writes through the generated client: invite, key, and a kommunadministratör who leaves', async () => {
    const supabase = { isConfigured: false } as unknown as SupabaseAdminService;
    const service = new HuvudmanService(api, supabase);
    const k: AuthenticatedUser = { authId: K, role: Role.HUVUDMAN };
    const planner: AuthenticatedUser = { authId: P, role: Role.HUVUDMAN };
    const h = member.huvudmanId;
    const email = 'hm-g-probe@example.invalid';
    let invited: string | null = null;
    let keyId: string | null = null;
    try {
      const made = await service.invite(k, h, { email: ` ${email.toUpperCase()} `, firstName: 'Probe', lastName: 'Admin', role: 'KOMMUNADMINISTRATOR' });
      invited = made.id;
      assert.equal(made.emailSent, false);
      const row = (await owner.query<{ email: string; authId: string | null; createdAt: Date }>(
        `SELECT email, "authId", "createdAt" FROM "HuvudmanMembers" WHERE id = $1`, [made.id])).rows[0];
      assert.equal(row?.email, email);
      assert.equal(row?.authId, null);
      assert.ok(row?.createdAt instanceof Date, 'the database stamped createdAt');
      await assert.rejects(service.invite(k, h, { email, firstName: 'Probe', lastName: 'Again', role: 'PLANERARE' }), (error) => error instanceof ConflictException);
      await assert.rejects(service.invite(planner, h, { email: 'hm-g-other@example.invalid', firstName: 'P', lastName: 'P', role: 'PLANERARE' }),
        (error) => error instanceof ForbiddenException);

      const key = await service.createKey(k, h, { name: 'Probe nyckel', scopes: ['persons.read', 'attendances.read'] });
      keyId = key.id;
      assert.match(key.key, /^sh_[0-9a-f]{48}$/);
      assert.deepEqual(key.scopes, ['persons.read'], 'only the huvudman\'s read scopes are kept');
      await assert.rejects(service.createKey(planner, h, { name: 'Planerarens', scopes: ['persons.read'] }), (error) => error instanceof ForbiddenException);
      await service.revokeKey(k, h, key.id);
      assert.ok((await owner.query(`SELECT 1 FROM "HuvudmanApiKeys" WHERE id = $1 AND "revokedAt" IS NOT NULL`, [key.id])).rowCount === 1);

      // K leaves while the invited kommunadministratör is active, then the
      // invited one cannot be made inactive by anybody left: K is inactive.
      const kId = (await owner.query<{ id: string }>(`SELECT id FROM "HuvudmanMembers" WHERE "authId" = $1`, [K])).rows[0]!.id;
      await service.updateMember(k, h, kId, { isActive: false });
      assert.ok((await owner.query(`SELECT 1 FROM "HuvudmanMembers" WHERE id = $1 AND NOT "isActive"`, [kId])).rowCount === 1);
      await owner.query(`UPDATE "HuvudmanMembers" SET "isActive" = true WHERE id = $1`, [kId]);
      // With K the only active one again (the invited one made a planner),
      // K may not leave.
      await service.updateMember(k, h, invited, { role: 'PLANERARE' });
      await assert.rejects(service.updateMember(k, h, kId, { isActive: false }), (error) => error instanceof ConflictException);
      await assert.rejects(service.updateMember(k, h, kId, { role: 'PLANERARE' }), (error) => error instanceof ConflictException);
    } finally {
      await owner.query(`UPDATE "HuvudmanMembers" SET "isActive" = true, role = 'KOMMUNADMINISTRATOR' WHERE "authId" = $1`, [K]);
      if (keyId) await owner.query(`DELETE FROM "HuvudmanApiKeys" WHERE id = $1`, [keyId]);
      if (invited) await owner.query(`DELETE FROM "HuvudmanMembers" WHERE id = $1`, [invited]);
    }
  });

  await check('(hm-h) the rektor\'s assessments are the gateway\'s to hide: the reader and a planner without HR-läs read them masked, the database alone would not', async () => {
    const personOf = async (authId: string) => (await owner.query<{ id: string }>(`SELECT id FROM "Users" WHERE "authId" = $1`, [authId])).rows[0]!.id;
    const teacher = await personOf('00000000-0000-4000-8000-000000000111');
    const plannerId = await personOf('00000000-0000-4000-8000-000000000107'); // SCHEMALAGGARE, no HR-läs
    const withHrId = await personOf('00000000-0000-4000-8000-000000000109'); // SCHEMALAGGARE with HR-läs
    const asPlanner: AuthenticatedUser = {
      authId: '00000000-0000-4000-8000-000000000107', userId: plannerId, schoolId: roller, role: Role.SCHOOL_ADMIN, adminProfile: 'SCHEMALAGGARE', hrRead: false,
    };
    const asHr: AuthenticatedUser = {
      authId: '00000000-0000-4000-8000-000000000109', userId: withHrId, schoolId: roller, role: Role.SCHOOL_ADMIN, adminProfile: 'SCHEMALAGGARE', hrRead: true,
    };
    // A nine-year läsår the ordinance reaches, so the load report judges (a year of the huvudman fixtures begins in 2030, which is ten-year).
    const year = (
      await owner.query<{ id: string }>(
        `INSERT INTO "AcademicYears" ("schoolId", name, "startDate", "endDate", "isActive", "gradeNumbering", "updatedAt")
         VALUES ($1, 'probe hm-h bedömning', '2099-08-17', '2100-06-12', false, 'NIOARIG', now()) RETURNING id`,
        [roller],
      )
    ).rows[0]!.id;
    try {
      await owner.query(
        `INSERT INTO "TeacherEmployments" ("schoolId", "userId", "academicYearId", "employmentPercent", "reductionPercent", signature, "updatedAt")
         VALUES ($1, $2, $3, 100, 0, 'HMH', now())`,
        [roller, teacher, year],
      );
      // The teacher's row carries a level, an exception with its day and a note; the planner's own row a level and a note.
      await owner.query(
        `INSERT INTO "AssignmentScopeAssessments" ("schoolId", "userId", "academicYearId", "teachingLevelHours", "exceptionKind", "ownInitiativeOn", note, "updatedAt")
         VALUES ($1, $2, $3, 560, 'OWN_INITIATIVE', '2099-05-02', 'hm-h teacher note', now()),
                ($1, $4, $3, 540, NULL, NULL, 'hm-h planner note', now())`,
        [roller, teacher, year, plannerId],
      );
      const assessments = new ScopeAssessmentsService(api);
      const byUser = (rows: ScopeAssessmentResponse[]) => new Map(rows.map((row) => [row.userId, row]));
      const masked = (row: ScopeAssessmentResponse | undefined) =>
        row && [row.hrHidden, row.teachingLevelHours, row.ownInitiativeOn, row.note, row.decidedById, row.decidedAt];

      // The database alone: the huvudman's reader (no Users row) and the planner read both rows, as the administrators' arm says.
      for (const who of [reader(roller!), asPlanner]) {
        const raw = await api.withRls(who, (tx) =>
          tx.assignmentScopeAssessment.findMany({ where: { academicYearId: year }, select: { userId: true, teachingLevelHours: true, note: true }, orderBy: { userId: 'asc' } }),
        );
        assert.deepEqual(
          raw.map((row) => [row.userId, row.teachingLevelHours, row.note]).sort(),
          [[teacher, 560, 'hm-h teacher note'], [plannerId, 540, 'hm-h planner note']].sort(),
          'the database hands every row of the school to the reader and to a planner',
        );
      }

      // The list: the reader has no row of their own to match, so both are masked; the exception kind is what is left.
      const readerList = byUser(await assessments.list(year, reader(roller!)));
      assert.deepEqual(masked(readerList.get(teacher)), [true, null, null, null, null, null]);
      assert.deepEqual(masked(readerList.get(plannerId)), [true, null, null, null, null, null]);
      assert.equal(readerList.get(teacher)?.exceptionKind, 'OWN_INITIATIVE');
      // A planner without HR-läs: the teacher's row masked, their own whole.
      const plannerList = byUser(await assessments.list(year, asPlanner));
      assert.deepEqual(masked(plannerList.get(teacher)), [true, null, null, null, null, null]);
      assert.deepEqual([plannerList.get(plannerId)?.hrHidden, plannerList.get(plannerId)?.teachingLevelHours, plannerList.get(plannerId)?.note], [false, 540, 'hm-h planner note']);
      // An administrator with HR-läs reads every row whole.
      const hrList = byUser(await assessments.list(year, asHr));
      assert.deepEqual(
        [hrList.get(teacher)?.hrHidden, hrList.get(teacher)?.teachingLevelHours, hrList.get(teacher)?.ownInitiativeOn, hrList.get(teacher)?.note],
        [false, 560, '2099-05-02', 'hm-h teacher note'],
      );

      // The load report carries the assessment on the teacher's row and hides it the same way.
      const assessmentOf = async (who: AuthenticatedUser) =>
        (await new StaffingLoadService(api).load(year, 'planned', who)).scope?.teachers.find((row) => row.userId === teacher)?.assessment;
      const toReader = await assessmentOf(reader(roller!));
      assert.deepEqual(
        toReader && [toReader.levelHours, toReader.exceptionKind, toReader.ownInitiativeOn, toReader.note, toReader.decidedAt],
        [null, 'OWN_INITIATIVE', null, null, null],
        'the reader\'s report holds the exception kind and nothing about the person',
      );
      const toPlanner = await assessmentOf(asPlanner);
      assert.deepEqual(toPlanner && [toPlanner.levelHours, toPlanner.note], [null, null]);
      const toHr = await assessmentOf(asHr);
      assert.deepEqual(toHr && [toHr.levelHours, toHr.ownInitiativeOn, toHr.note], [560, '2099-05-02', 'hm-h teacher note']);
    } finally {
      await owner.query(`DELETE FROM "AssignmentScopeAssessments" WHERE "academicYearId" = $1`, [year]);
      await owner.query(`DELETE FROM "TeacherEmployments" WHERE "academicYearId" = $1`, [year]);
      await owner.query(`DELETE FROM "AcademicYears" WHERE id = $1`, [year]);
    }
  });
}
