/**
 * Administratör som lärare, gatewayens halva (PR 2 av 7), through the real adapter. PR 1 (the database) proved that
 * TE409 and TE410 arrive as themselves ((ar-i) and (ar-j) in probe-admin-areas.ts); this proves what the gateway makes
 * of them, and of the one race PR 1's review found that ends in a 40P01. Called last by prisma-adapter-probe.ts, in a
 * school of its own (`<marker>-teaches-gw`), created and removed as the owner.
 *
 *   (tg-a) the identity lookup JwtStrategy makes reads `teaches` through row security: true for a marked administrator,
 *          false for an unmarked one, absent from a teacher's principal, and the huvudman's reader is false;
 *   (tg-b) UsersService: the mark is set by rektor and answered as stored, logged fromTeaches false / toTeaches true; a
 *          person with no post is 409 TEACHES_NEEDS_A_POST with the person in flat params; a role change of a marked
 *          person answers the row as stored (teaches false) and logs fromTeaches true / toTeaches false; a teacher, a
 *          läsare and a pupil are refused with their own 400 codes; the lists carry the mark;
 *   (tg-c) a marked person's last post is 409 A_TEACHING_ADMINISTRATORS_LAST_POST_STAYS through TeacherEmploymentsService
 *          and AcademicYearsService (the asked-first count, then the database's net with the same code), and a post
 *          that is not the last goes;
 *   (tg-d) TE409 and TE410 through $executeRaw arrive as P2010 with the code under the cause, and teachesRefusal reads
 *          that shape as it reads the model call's P2039 (adapter-raw-refusals-are-p2010);
 *   (tg-e) the deadlock: a request that writes a post and then the person's Users row, against UsersService.update
 *          marking the same person, ends in 40P01 for ONE of them and a clean end for the other; the mark's side is
 *          answered 409 WRITE_CONFLICT ("försök igen"), through the real adapter and two real connections. Each side is
 *          SEEN to wait (pg_blocking_pids) before the holder goes on, so it is the lock order that is proven and not a
 *          lucky interleaving; the deadlock detector's one second is the cost of the check.
 *
 * The failure forms of the mapping that this cannot provoke (a COMMIT that fails) are pinned in
 * src/common/utils/prisma-errors.spec.ts with the shape (el-h) measured.
 */
import { strict as assert } from 'node:assert';
import { randomUUID } from 'node:crypto';
import type { ConfigService } from '@nestjs/config';
import { ConflictException } from '@nestjs/common';
import type { Client } from 'pg';
import { Role } from '../../src/auth/enums/role.enum';
import type { AuthenticatedUser } from '../../src/auth/interfaces/authenticated-user.interface';
import { JwtStrategy } from '../../src/auth/jwt.strategy';
import {
  A_TEACHING_ADMINISTRATORS_LAST_POST_STAYS,
  TEACHES_NEEDS_A_POST,
  WRITE_CONFLICT,
  isWriteConflict,
  teachesRefusal,
} from '../../src/common/utils/prisma-errors';
import type { PrismaService } from '../../src/database/prisma.service';
import { AcademicYearsService } from '../../src/resources/academic-years.service';
import { TeacherEmploymentsService } from '../../src/staffing/teacher-employments.service';
import type { SupabaseAdminService } from '../../src/users/supabase-admin.service';
import { UsersService } from '../../src/users/users.service';

type Check = (label: string, body: () => Promise<void>) => Promise<void>;

export function teachesGatewaySlug(marker: string): string {
  return `${marker}-teaches-gw`;
}

export async function sweepTeachesGatewaySchool(owner: Client, marker: string): Promise<void> {
  await owner.query(`DELETE FROM "Schools" WHERE slug = $1`, [teachesGatewaySlug(marker)]);
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

function summarise(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  return String(error);
}

/** The error a promise rejects with, or a failed assertion when it resolves. */
async function refusalOf(work: Promise<unknown>): Promise<unknown> {
  try {
    await work;
  } catch (error) {
    return error;
  }
  assert.fail('the write was not refused');
}

/** The problem body of a 4xx a service threw: its status and the `code` and `params` the filter would forward. */
function problemOf(error: unknown): { status?: number; code?: string; params?: Record<string, unknown> } {
  const status = (error as { status?: number } | null)?.status;
  const body = (error as { getResponse?: () => unknown } | null)?.getResponse?.();
  return { status, ...(typeof body === 'object' && body !== null ? (body as { code?: string; params?: Record<string, unknown> }) : {}) };
}

export async function teachesGatewayChecks(
  owner: Client,
  api: PrismaService,
  marker: string,
  check: Check,
  open: (url: string) => PrismaService,
  appUrl: string,
): Promise<void> {
  await sweepTeachesGatewaySchool(owner, marker);
  // The second pool, for the side that waits on a held transaction (tg-e).
  const second = open(appUrl);
  await second.onModuleInit();
  const one = async <T extends object>(sql: string, params: unknown[] = []): Promise<T> => (await owner.query<T>(sql, params)).rows[0]!;

  const school = await one<{ id: string }>(
    `INSERT INTO "Schools" (name, slug, "updatedAt") VALUES ($1, $2, now()) RETURNING id`,
    [`${marker} teaches gateway`, teachesGatewaySlug(marker)],
  );
  const s = school.id;
  const year = await one<{ id: string }>(
    `INSERT INTO "AcademicYears" ("schoolId", name, "startDate", "endDate", "isActive", "updatedAt")
     VALUES ($1, 'Probe 2095/96', '2095-08-15', '2096-06-15', true, now()) RETURNING id`,
    [s],
  );
  const year2 = await one<{ id: string }>(
    `INSERT INTO "AcademicYears" ("schoolId", name, "startDate", "endDate", "isActive", "updatedAt")
     VALUES ($1, 'Probe 2096/97', '2096-08-15', '2097-06-15', false, now()) RETURNING id`,
    [s],
  );
  const person = async (label: string, role: string, adminProfile: string | null = null) => {
    const authId = randomUUID();
    const row = await one<{ id: string }>(
      `INSERT INTO "Users" ("schoolId", email, "firstName", "lastName", role, "adminProfile", "hrRead", "authId", "updatedAt")
       VALUES ($1, $2, $3, 'Probe', $4, $5, false, $6, now()) RETURNING id`,
      [s, `${marker}-teaches-gw-${label}@example.invalid`, label, role, adminProfile, authId],
    );
    const principal: AuthenticatedUser = {
      authId,
      role: role as Role,
      userId: row.id,
      schoolId: s,
      ...(adminProfile ? { adminProfile: adminProfile as never, hrRead: false } : {}),
    };
    return { id: row.id, authId, principal };
  };
  const post = (userId: string, academicYearId: string, percent = 50) =>
    owner.query(
      `INSERT INTO "TeacherEmployments" ("schoolId", "userId", "academicYearId", "employmentPercent", "updatedAt") VALUES ($1, $2, $3, $4, now())`,
      [s, userId, academicYearId, percent],
    );
  const standing = async (userId: string) =>
    one<{ teaches: boolean; posts: number }>(
      `SELECT u."teaches", (SELECT count(*)::int FROM "TeacherEmployments" e WHERE e."userId" = u.id) AS posts FROM "Users" u WHERE u.id = $1`,
      [userId],
    );

  const rektor = await person('rektor', 'SCHOOL_ADMIN', 'REKTOR');
  const planner = await person('planner', 'SCHOOL_ADMIN', 'SCHEMALAGGARE');
  const teacher = await person('teacher', 'TEACHER');
  const pupil = await person('pupil', 'STUDENT');
  const reader = await person('reader', 'SCHOOL_ADMIN', 'LASARE');
  const users = new UsersService(api, { isConfigured: false } as unknown as SupabaseAdminService);
  const posts = new TeacherEmploymentsService(api);
  const years = new AcademicYearsService(api);

  try {
    await check('(tg-a) the identity lookup reads teaches through row security: true for a marked administrator, false for an unmarked one, none on a teacher (Administratör som lärare)', async () => {
      const marked = await person('marked-a', 'SCHOOL_ADMIN', 'SCHEMALAGGARE');
      await post(marked.id, year.id);
      await owner.query(`UPDATE "Users" SET teaches = true WHERE id = $1`, [marked.id]);
      // The strategy itself, built as the spec builds it, against the real adapter: the select it makes is the one under test.
      const config = { getOrThrow: () => ({ secret: 'a-probe-secret-that-is-long-enough-0000', issuer: 'https://probe.invalid', jwksUri: 'https://probe.invalid/jwks', audience: undefined }) } as unknown as ConfigService;
      const strategy = new JwtStrategy(config, api);
      const principalOf = async (authId: string) => strategy.validate({ headers: { 'x-school-id': s } }, { sub: authId } as never);
      const asMarked = await principalOf(marked.authId);
      assert.deepEqual([asMarked.role, asMarked.adminProfile, asMarked.teaches], ['SCHOOL_ADMIN', 'SCHEMALAGGARE', true]);
      assert.equal((await principalOf(planner.authId)).teaches, false);
      assert.equal((await principalOf(reader.authId)).teaches, false);
      assert.equal('teaches' in (await principalOf(teacher.authId)), false);
      // An inactive person is refused before the mark is read: the principal never carries teaches: true past isActive.
      await owner.query(`UPDATE "Users" SET "isActive" = false WHERE id = $1`, [marked.id]);
      const refused = await refusalOf(principalOf(marked.authId));
      assert.equal((refused as { status?: number }).status, 401, summarise(refused));
      await owner.query(`UPDATE "Users" SET "isActive" = true, teaches = false WHERE id = $1`, [marked.id]);
      await owner.query(`DELETE FROM "TeacherEmployments" WHERE "userId" = $1`, [marked.id]);
    });

    await check('(tg-b) UsersService marks, answers the row as stored, and says so with its own codes (Administratör som lärare)', async () => {
      const target = await person('target', 'SCHOOL_ADMIN', 'SCHEMALAGGARE');
      // No post: the trigger's TE409 reaches the client as a 409 of its own, the person in flat params.
      const noPost = problemOf(await refusalOf(users.update(target.id, { teaches: true }, rektor.principal)));
      assert.deepEqual([noPost.status, noPost.code, noPost.params], [409, TEACHES_NEEDS_A_POST, { userId: target.id }]);
      assert.equal((await standing(target.id)).teaches, false);
      // A planner does not decide: 403 before the database is asked.
      assert.equal(problemOf(await refusalOf(users.update(target.id, { teaches: true }, planner.principal))).code, 'DECISION_NOT_YOURS');
      await post(target.id, year.id);
      const marked = await users.update(target.id, { teaches: true }, rektor.principal);
      assert.equal(marked.teaches, true);
      assert.deepEqual(await standing(target.id), { teaches: true, posts: 1 });
      const history = await users.roleChanges(target.id, rektor.principal);
      assert.deepEqual([history[0]?.fromTeaches, history[0]?.toTeaches], [false, true]);
      // The lists carry it: the register (usePeople), the administrators, the counts.
      assert.equal((await users.list(rektor.principal)).find((person_) => person_.id === target.id)?.teaches, true);
      assert.equal((await users.administrators(rektor.principal)).find((admin) => admin.id === target.id)?.teaches, true);
      const counts = await users.counts(rektor.principal);
      assert.equal(counts.teachingAdministrators, 1);
      assert.equal(counts.byRole.SCHOOL_ADMIN >= 4, true);
      // A value the person has already is no change: no decision asked of a planner who edits their phone number.
      const same = await users.update(target.id, { teaches: true, phone: '070-0' }, rektor.principal);
      assert.equal(same.teaches, true);
      // A role change the mark cannot follow clears it in the database, and the answer is the row as stored: teaches false,
      // the log's row fromTeaches true / toTeaches false (the post stays: it was a teaching administrator's, now a teacher's).
      const demoted = await users.update(target.id, { role: 'TEACHER' }, rektor.principal);
      assert.deepEqual([demoted.role, demoted.teaches], ['TEACHER', false]);
      const after = await users.roleChanges(target.id, rektor.principal);
      assert.deepEqual([after[0]?.fromTeaches, after[0]?.toTeaches], [true, false]);
      // Refused before the database: a teacher, a läsare, a pupil.
      const refusals = [
        [teacher.id, 'A_TEACHER_TEACHES_ALREADY'],
        [reader.id, 'A_READER_DOES_NOT_TEACH'],
        [pupil.id, 'TEACHES_NEEDS_AN_ADMINISTRATOR'],
      ] as const;
      for (const [id, code] of refusals) {
        const refused = problemOf(await refusalOf(users.update(id, { teaches: true }, rektor.principal)));
        assert.deepEqual([refused.status, refused.code], [400, code]);
      }
      // `teaches: false` on a person who does not teach is no change, and no refusal.
      assert.equal((await users.update(teacher.id, { teaches: false }, rektor.principal)).teaches, false);
    });

    await check('(tg-c) a marked person’s last post stays: 409 from the post’s removal and from the läsår’s, with the code and flat params; a post that is not the last goes (Administratör som lärare)', async () => {
      const keeper = await person('keeper', 'SCHOOL_ADMIN', 'FULL');
      await post(keeper.id, year.id);
      await post(keeper.id, year2.id);
      await users.update(keeper.id, { teaches: true }, rektor.principal);
      // Two posts: the first goes, and the läsår of the second is then the one that cannot.
      await posts.remove(keeper.id, year.id, rektor.principal);
      assert.equal((await standing(keeper.id)).posts, 1);
      const last = problemOf(await refusalOf(posts.remove(keeper.id, year2.id, rektor.principal)));
      assert.deepEqual([last.status, last.code, last.params], [409, A_TEACHING_ADMINISTRATORS_LAST_POST_STAYS, { userId: keeper.id, academicYearId: year2.id }]);
      assert.equal((await standing(keeper.id)).posts, 1);
      // The läsår holding the only post is asked first, with a count and the ids and no name.
      const yearRefusal = problemOf(await refusalOf(years.remove(year2.id, rektor.principal)));
      assert.deepEqual([yearRefusal.status, yearRefusal.code], [409, A_TEACHING_ADMINISTRATORS_LAST_POST_STAYS]);
      assert.deepEqual(yearRefusal.params, { administrators: 1, userIds: keeper.id });
      assert.equal((await owner.query(`SELECT 1 FROM "AcademicYears" WHERE id = $1`, [year2.id])).rowCount, 1);
      // The mark off, and the same removals go through.
      await users.update(keeper.id, { teaches: false }, rektor.principal);
      await posts.remove(keeper.id, year2.id, rektor.principal);
      assert.deepEqual(await standing(keeper.id), { teaches: false, posts: 0 });
    });

    await check('(tg-d) TE409 and TE410 through $executeRaw arrive as P2010 with the code under the cause, and teachesRefusal reads that shape and the model call’s alike', async () => {
      const raw = await person('raw', 'SCHOOL_ADMIN', 'FULL');
      const markRaw = (service: PrismaService) =>
        service.withRls(rektor.principal, (tx) => tx.$executeRaw`UPDATE "Users" SET "teaches" = true WHERE "id" = ${raw.id}::uuid`);
      const noPostRaw = await refusalOf(markRaw(api));
      assert.equal((noPostRaw as { code?: string }).code, 'P2010', `not the raw shape: ${summarise(noPostRaw)}`);
      assert.deepEqual(teachesRefusal(noPostRaw), { code: TEACHES_NEEDS_A_POST, userId: raw.id, academicYearId: null });
      const noPostModel = await refusalOf(api.withRls(rektor.principal, (tx) => tx.user.update({ where: { id: raw.id }, data: { teaches: true } })));
      assert.equal((noPostModel as { code?: string }).code, 'P2039');
      assert.deepEqual(teachesRefusal(noPostModel), { code: TEACHES_NEEDS_A_POST, userId: raw.id, academicYearId: null });
      await post(raw.id, year.id);
      await markRaw(api);
      const lastRaw = await refusalOf(
        api.withRls(rektor.principal, (tx) => tx.$executeRaw`DELETE FROM "TeacherEmployments" WHERE "userId" = ${raw.id}::uuid`),
      );
      assert.equal((lastRaw as { code?: string }).code, 'P2010');
      assert.deepEqual(teachesRefusal(lastRaw), { code: A_TEACHING_ADMINISTRATORS_LAST_POST_STAYS, userId: raw.id, academicYearId: year.id });
      assert.deepEqual(await standing(raw.id), { teaches: true, posts: 1 });
      await owner.query(`UPDATE "Users" SET teaches = false WHERE id = $1`, [raw.id]);
    });

    await check('(tg-e) a post written and then the person’s row, against a mark of the same person: one side is a 40P01, the mark’s is 409 WRITE_CONFLICT, and neither ends in a mark without a post (Administratör som lärare)', async () => {
      const victim = await person('deadlock', 'SCHOOL_ADMIN', 'FULL');
      await post(victim.id, year.id);
      const touched = deferred<number>();
      const release = deferred<void>();
      // The holder: a request that writes the post first and the person's row after, as a save of both does. It parks between.
      const holder = api.withRls(rektor.principal, async (tx) => {
        await tx.teacherEmployment.update({
          where: { schoolId_userId_academicYearId: { schoolId: s, userId: victim.id, academicYearId: year.id } },
          data: { employmentPercent: 60 },
        });
        const [{ pid }] = await tx.$queryRaw<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`;
        touched.resolve(pid);
        await release.promise;
        await tx.user.update({ where: { id: victim.id }, data: { phone: '070-9' } });
      });
      const holderSettled = holder.then(() => null, (error: unknown) => error);
      const pid = await Promise.race([touched.promise, holderSettled.then((error) => { throw error ?? new Error('the holder ended before it parked'); })]);
      // The mark, on the other connection, through the service: its first statement locks the person's row, then the trigger
      // asks for the post's row FOR SHARE, which the holder has. It must be seen waiting.
      let early = false;
      const markSettled = (async () => {
        const secondUsers = new UsersService(second, { isConfigured: false } as unknown as SupabaseAdminService);
        try {
          await secondUsers.update(victim.id, { teaches: true }, rektor.principal);
          early = true;
          return null;
        } catch (error) {
          early = true;
          return error;
        }
      })();
      for (let tries = 0; ; tries++) {
        const { rows } = await owner.query<{ n: number }>('SELECT count(*)::int AS n FROM pg_stat_activity WHERE $1::int = ANY(pg_blocking_pids(pid))', [pid]);
        if (rows[0]!.n > 0) break;
        if (early || tries > 3000) {
          release.resolve();
          await holderSettled;
          const error = await markSettled;
          assert.fail(`the mark did not wait for the post: ${early ? 'it was answered at once' : 'it never waited'} (${error === null ? 'and it went through' : summarise(error)})`);
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      // The holder goes on to the person's row, which the mark holds: a circle, and Postgres ends one side after its second.
      release.resolve();
      const [holderOutcome, markOutcome] = await Promise.all([holderSettled, markSettled]);
      // The holder's error is the adapter's own (isWriteConflict reads it); the mark's has been through UsersService (the 409).
      const endedByDeadlock = (outcome: unknown) => outcome !== null && (isWriteConflict(outcome) || problemOf(outcome).code === WRITE_CONFLICT);
      const deadlocks = [holderOutcome, markOutcome].filter(endedByDeadlock);
      assert.equal(deadlocks.length, 1, `not exactly one side was ended by the deadlock: holder ${summarise(holderOutcome)}, mark ${summarise(markOutcome)}`);
      // The mark's side, whoever the detector chose: if it was the one ended, it is the 409 "try again" (not a 500), and then
      // the person is not marked; if it was the holder, the mark went through with the post it saw.
      if (markOutcome !== null) {
        assert.ok(markOutcome instanceof ConflictException, `the mark's refusal is not a 409: ${summarise(markOutcome)}`);
        assert.equal(problemOf(markOutcome).code, WRITE_CONFLICT);
        assert.equal(holderOutcome, null, `the holder should have gone through: ${summarise(holderOutcome)}`);
        assert.equal((await standing(victim.id)).teaches, false);
      } else {
        assert.equal((await standing(victim.id)).teaches, true);
      }
      assert.equal((await standing(victim.id)).posts, 1, 'a mark was left with no post');
    });
  } finally {
    await sweepTeachesGatewaySchool(owner, marker);
  }
}
