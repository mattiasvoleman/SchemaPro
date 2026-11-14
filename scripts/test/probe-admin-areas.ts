/**
 * Roller i skolan through the real adapter (prisma-adapter-probe.ts calls
 * this last). The RLS suite proves the arms in psql and the e2e suite mocks
 * PrismaService; what neither shows is what @prisma/adapter-pg hands the
 * gateway when the database refuses an administrator's write, and so whether
 * src/common/utils/prisma-errors.ts areaRefusal reads it. Measured here:
 *
 *   (ar-a) an area-checked insert refused by row security (42501, WITH CHECK);
 *   (ar-b) an area-checked update refused by WITH CHECK under a USING that
 *          admits every administrator;
 *   (ar-c) the decision trigger's AR403;
 *   (ar-d) a planner's row lock on a teacher's Users row and post (the
 *          locks other areas' work takes), which must find the rows;
 *   (ar-e) UsersService: the expedition refused an administrator's row before
 *          the database is asked, rektor's profile change written and logged;
 *   (ar-f) TeacherEmploymentsService: the percentages left out for a planner
 *          without HR-läs, kept for one with it;
 *   (ar-i) Users.teaches (20270212090000): the mark is a decision (AR403, read as
 *          DECISION_NOT_YOURS), needs a post (TE409), and keeps the last post
 *          (TE410), each with the code in driverAdapterError.cause.originalCode
 *          where the gateway's mapping will read it, and the log row carries it;
 *   (ar-j) the same three guards against each other with TWO connections, the only
 *          place the two FOR SHARE locks that make them safe are proven (the RLS
 *          suite runs in one): a mark set while the last post is deleted, the last
 *          post deleted while a mark is set, and two last posts deleted together.
 *          Each ends in a state that holds, never a mark with no post, and each
 *          side is seen to WAIT on the other (pg_blocking_pids), so a lock taken
 *          out is a failure and not a lucky ordering.
 *
 * Its school is its own (`<marker>-roller`), created and removed as the owner.
 */
import { strict as assert } from 'node:assert';
import { randomUUID } from 'node:crypto';
import type { Client } from 'pg';
import { AdminProfile, type PrismaClient } from '@prisma/client';
import { Role } from '../../src/auth/enums/role.enum';
import type { AuthenticatedUser } from '../../src/auth/interfaces/authenticated-user.interface';
import { areaRefusal } from '../../src/common/utils/prisma-errors';
import type { PrismaService } from '../../src/database/prisma.service';
import { CoverSettingsService } from '../../src/cover/cover-settings.service';
import { TeacherEmploymentsService } from '../../src/staffing/teacher-employments.service';
import type { SupabaseAdminService } from '../../src/users/supabase-admin.service';
import { UsersService } from '../../src/users/users.service';

type Check = (label: string, body: () => Promise<void>) => Promise<void>;

export function rollerSlug(marker: string): string {
  return `${marker}-roller`;
}

export async function sweepRollerSchool(owner: Client, marker: string): Promise<void> {
  await owner.query(`DELETE FROM "Schools" WHERE slug = $1`, [rollerSlug(marker)]);
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

/** The SQLSTATE a refused write carries through the adapter: the cause's originalCode, or the P2039 text. */
function sqlstateOf(error: unknown): string | null {
  const meta = (error as { meta?: { driverAdapterError?: { cause?: { originalCode?: unknown } } } } | null)?.meta;
  const original = meta?.driverAdapterError?.cause?.originalCode;
  if (typeof original === 'string') return original;
  const m = /Code: `([A-Z0-9]{5})`/.exec(String((error as { message?: unknown } | null)?.message ?? ''));
  return m ? m[1]! : null;
}

export async function adminAreaChecks(
  owner: Client,
  api: PrismaService,
  marker: string,
  check: Check,
  open: (url: string) => PrismaService,
  appUrl: string,
): Promise<void> {
  await sweepRollerSchool(owner, marker);
  // A second pool for the side that waits on a held transaction (ar-j).
  const second = open(appUrl);
  await second.onModuleInit();
  const one = async <T extends object>(sql: string, params: unknown[] = []): Promise<T> =>
    (await owner.query<T>(sql, params)).rows[0]!;

  const school = await one<{ id: string }>(
    `INSERT INTO "Schools" (name, slug, "updatedAt") VALUES ($1, $2, now()) RETURNING id`,
    [`${marker} roller`, rollerSlug(marker)],
  );
  const s = school.id;
  const year = await one<{ id: string }>(
    `INSERT INTO "AcademicYears" ("schoolId", name, "startDate", "endDate", "isActive", "updatedAt")
     VALUES ($1, 'Probe 2097/98', '2097-08-15', '2098-06-15', true, now()) RETURNING id`,
    [s],
  );
  const person = async (label: string, role: string, adminProfile: AdminProfile | null = null, hrRead = false) => {
    const authId = randomUUID();
    const row = await one<{ id: string }>(
      `INSERT INTO "Users" ("schoolId", email, "firstName", "lastName", role, "adminProfile", "hrRead", "authId", "updatedAt")
       VALUES ($1, $2, $3, 'Probe', $4, $5, $6, $7, now()) RETURNING id`,
      [s, `${marker}-roller-${label}@example.invalid`, label, role, adminProfile, hrRead, authId],
    );
    const principal: AuthenticatedUser = {
      authId,
      role: role as Role,
      userId: row.id,
      schoolId: s,
      ...(adminProfile ? { adminProfile, hrRead } : {}),
    };
    return { id: row.id, principal };
  };
  const full = await person('full', 'SCHOOL_ADMIN', 'FULL');
  const rektor = await person('rektor', 'SCHOOL_ADMIN', 'REKTOR');
  const planner = await person('planner', 'SCHOOL_ADMIN', 'SCHEMALAGGARE');
  const plannerHr = await person('plannerhr', 'SCHOOL_ADMIN', 'SCHEMALAGGARE', true);
  const expedition = await person('expedition', 'SCHOOL_ADMIN', 'EXPEDITION');
  const reader = await person('reader', 'SCHOOL_ADMIN', 'LASARE');
  const readerHr = await person('readerhr', 'SCHOOL_ADMIN', 'LASARE', true);
  const teacher = await person('teacher', 'TEACHER');
  await owner.query(
    `INSERT INTO "TeacherEmployments" ("schoolId", "userId", "academicYearId", "employmentPercent", "reductionPercent", signature, note, "updatedAt")
     VALUES ($1, $2, $3, 80, 20, 'PRB', 'skäl', now())`,
    [s, teacher.id, year.id],
  );
  const room = await one<{ id: string }>(
    `INSERT INTO "Rooms" ("schoolId", name, "updatedAt") VALUES ($1, 'Probe sal', now()) RETURNING id`,
    [s],
  );

  try {
    await check('(ar-a) an insert outside the profile is refused by row security, and read as AREA_NOT_YOURS', async () => {
      const error = await refusalOf(
        api.withRls(expedition.principal, (tx) => tx.room.create({ data: { schoolId: s, name: 'Expeditionens sal' } })),
      );
      assert.equal(areaRefusal(error)?.code, 'AREA_NOT_YOURS', `not read as an area refusal: ${String(error)}`);
      const made = await api.withRls(planner.principal, (tx) => tx.room.create({ data: { schoolId: s, name: 'Planerarens sal' } }));
      assert.ok(made.id);
    });

    await check('(ar-b) an update the update arm admits and its WITH CHECK refuses is an error, never zero rows', async () => {
      const error = await refusalOf(
        api.withRls(expedition.principal, (tx) => tx.room.update({ where: { id: room.id }, data: { name: 'Omdöpt' } })),
      );
      assert.equal(areaRefusal(error)?.code, 'AREA_NOT_YOURS', `not read as an area refusal: ${String(error)}`);
      assert.equal((await one<{ name: string }>(`SELECT name FROM "Rooms" WHERE id = $1`, [room.id])).name, 'Probe sal');
    });

    await check("(ar-c) the decision trigger's AR403 reaches the gateway, and reads as DECISION_NOT_YOURS", async () => {
      const error = await refusalOf(
        api.withRls(expedition.principal, (tx) => tx.user.update({ where: { id: planner.id }, data: { firstName: 'Bytt' } })),
      );
      const refusal = areaRefusal(error);
      assert.equal(refusal?.code, 'DECISION_NOT_YOURS', `not read as a decision refusal: ${String(error)}`);
      assert.match(refusal!.message, /rektor/);
    });

    await check("(ar-d) a planner's row locks find the teacher and the post", async () => {
      const [users, posts] = await api.withRls(planner.principal, async (tx) => [
        await tx.$queryRaw<{ id: string }[]>`SELECT id FROM "Users" WHERE id = ${teacher.id}::uuid FOR NO KEY UPDATE`,
        await tx.$queryRaw<{ id: string }[]>`SELECT id FROM "TeacherEmployments" WHERE "userId" = ${teacher.id}::uuid FOR NO KEY UPDATE`,
      ]);
      assert.equal(users.length, 1);
      assert.equal(posts.length, 1);
    });

    await check("(ar-e) UsersService refuses the expedition an administrator, and writes and logs rektor's change", async () => {
      const users = new UsersService(api, { isConfigured: false } as unknown as SupabaseAdminService);
      const refused = await refusalOf(users.update(planner.id, { firstName: 'Bytt' }, expedition.principal));
      assert.equal((refused as { status?: number }).status, 403);
      await users.update(planner.id, { adminProfile: 'EXPEDITION', hrRead: true }, rektor.principal);
      const row = await one<{ adminProfile: string; hrRead: boolean }>(
        `SELECT "adminProfile", "hrRead" FROM "Users" WHERE id = $1`,
        [planner.id],
      );
      assert.deepEqual(row, { adminProfile: 'EXPEDITION', hrRead: true });
      const history = await users.roleChanges(planner.id, expedition.principal);
      assert.equal(history[0]?.toProfile, 'EXPEDITION');
      assert.equal(history[0]?.actorName, 'rektor Probe');
      await users.update(planner.id, { adminProfile: 'SCHEMALAGGARE', hrRead: false }, rektor.principal);
    });

    await check('(ar-f) the posts come back without tjänst % to a planner without HR-läs, and whole with it', async () => {
      const posts = new TeacherEmploymentsService(api);
      const [hidden] = await posts.list(year.id, planner.principal);
      assert.deepEqual(
        [hidden?.employmentPercent, hidden?.reductionPercent, hidden?.note, hidden?.signature],
        [null, null, null, 'PRB'],
      );
      const [shown] = await posts.list(year.id, plannerHr.principal);
      assert.deepEqual([shown?.employmentPercent, shown?.reductionPercent, shown?.note], [80, 20, 'skäl']);
      const [full_] = await posts.list(year.id, full.principal);
      assert.equal(full_?.employmentPercent, 80);
    });

    await check('(ar-g) a läsare reads the room and the posts, and a write of it is refused by row security as AREA_NOT_YOURS (Läsbehörighet)', async () => {
      const rooms = await api.withRls(reader.principal, (tx) => tx.room.findMany({ where: { id: room.id }, select: { id: true } }));
      assert.equal(rooms.length, 1);
      for (const write of [
        (tx: Parameters<Parameters<typeof api.withRls>[1]>[0]) => tx.room.create({ data: { schoolId: s, name: 'Läsarens sal' } }),
        (tx: Parameters<Parameters<typeof api.withRls>[1]>[0]) => tx.room.update({ where: { id: room.id }, data: { name: 'Läst om' } }),
      ]) {
        const error = await refusalOf(api.withRls(reader.principal, write));
        assert.equal(areaRefusal(error)?.code, 'AREA_NOT_YOURS', `not read as an area refusal: ${String(error)}`);
      }
      const error = await refusalOf(
        api.withRls(reader.principal, (tx) => tx.user.update({ where: { id: planner.id }, data: { hrRead: true } })),
      );
      assert.equal(areaRefusal(error)?.code, 'DECISION_NOT_YOURS', `not read as a decision refusal: ${String(error)}`);
      // HR-läs is its own grant: tjänst % without it is hidden, with it shown.
      const posts = new TeacherEmploymentsService(api);
      const [hidden] = await posts.list(year.id, reader.principal);
      assert.deepEqual([hidden?.employmentPercent, hidden?.signature], [null, 'PRB']);
      const [shown] = await posts.list(year.id, readerHr.principal);
      assert.equal(shown?.employmentPercent, 80);
    });

    await check('(ar-h) a läsare lists the absence reasons without seeding them; a planner who writes drift seeds the five built-ins (Läsbehörighet)', async () => {
      const cover = new CoverSettingsService(api);
      // Before anybody has seeded: an empty list, not the refused upsert.
      assert.deepEqual(await cover.reasons(reader.principal), []);
      const seeded = await cover.reasons(planner.principal);
      assert.equal(seeded.filter((reason) => reason.builtin !== null).length, 5);
      assert.deepEqual(
        (await cover.reasons(reader.principal)).map((reason) => reason.id),
        seeded.map((reason) => reason.id),
      );
    });

    await check('(ar-i) the mark is rektor\'s decision, needs a post and keeps the last one, and says so with its own codes (Administratör som undervisar)', async () => {
      // A planner and an expedition are refused the mark as they are refused a profile: AR403, read as a decision.
      for (const who of [planner, expedition, reader]) {
        const error = await refusalOf(
          api.withRls(who.principal, (tx) => tx.user.update({ where: { id: full.id }, data: { teaches: true } })),
        );
        assert.equal(sqlstateOf(error), 'AR403', `not AR403: ${String(error)}`);
        assert.equal(areaRefusal(error)?.code, 'DECISION_NOT_YOURS', `not read as a decision refusal: ${String(error)}`);
      }
      // Rektor, who decides, is refused for lack of a post: TE409, which no gateway mapping reads yet and which must arrive as itself.
      const noPost = await refusalOf(api.withRls(rektor.principal, (tx) => tx.user.update({ where: { id: full.id }, data: { teaches: true } })));
      assert.equal(sqlstateOf(noPost), 'TE409', `not TE409: ${String(noPost)}`);
      assert.equal(areaRefusal(noPost), null);
      await owner.query(
        `INSERT INTO "TeacherEmployments" ("schoolId", "userId", "academicYearId", "employmentPercent", "updatedAt") VALUES ($1, $2, $3, 40, now())`,
        [s, full.id, year.id],
      );
      const marked = await api.withRls(rektor.principal, (tx) =>
        tx.user.update({ where: { id: full.id }, data: { teaches: true }, select: { teaches: true } }),
      );
      assert.equal(marked.teaches, true);
      assert.equal((await api.withRls(full.principal, (tx) => tx.user.findUnique({ where: { id: full.id }, select: { teaches: true } })))?.teaches, true);
      const logged = await one<{ fromTeaches: boolean | null; toTeaches: boolean; actor: string }>(
        `SELECT "fromTeaches", "toTeaches", "actorId"::text AS actor FROM "UserRoleChanges" WHERE "userId" = $1 ORDER BY "createdAt" DESC, id LIMIT 1`,
        [full.id],
      );
      assert.deepEqual(logged, { fromTeaches: false, toTeaches: true, actor: rektor.id });
      const log = await api.withRls(rektor.principal, (tx) =>
        tx.userRoleChange.findMany({ where: { userId: full.id }, orderBy: { createdAt: 'desc' }, take: 1, select: { fromTeaches: true, toTeaches: true } }),
      );
      assert.deepEqual(log, [{ fromTeaches: false, toTeaches: true }]);
      // The last post stays, through the model API's delete (what TeacherEmploymentsService.remove calls).
      const kept = await refusalOf(
        api.withRls(rektor.principal, (tx) =>
          tx.teacherEmployment.delete({ where: { schoolId_userId_academicYearId: { schoolId: s, userId: full.id, academicYearId: year.id } } }),
        ),
      );
      assert.equal(sqlstateOf(kept), 'TE410', `not TE410: ${String(kept)}`);
      // The mark off, and the post goes.
      await api.withRls(rektor.principal, (tx) => tx.user.update({ where: { id: full.id }, data: { teaches: false } }));
      await api.withRls(rektor.principal, (tx) =>
        tx.teacherEmployment.delete({ where: { schoolId_userId_academicYearId: { schoolId: s, userId: full.id, academicYearId: year.id } } }),
      );
      // A mark written to a teacher is zeroed, not refused: the write the gateway before this release may still make.
      const zeroed = await api.withRls(rektor.principal, (tx) =>
        tx.user.update({ where: { id: teacher.id }, data: { teaches: true }, select: { teaches: true } }),
      );
      assert.equal(zeroed.teaches, false);
    });

    await check('(ar-j) a mark set while the last post goes, the last post going while a mark is set, and two last posts going together: each waits for the other and none ends with a mark and no post (Administratör som undervisar)', async () => {
      const year2 = await one<{ id: string }>(
        `INSERT INTO "AcademicYears" ("schoolId", name, "startDate", "endDate", "isActive", "updatedAt")
         VALUES ($1, 'Probe 2098/99', '2098-08-15', '2099-06-15', false, now()) RETURNING id`,
        [s],
      );
      const post = (userId: string, academicYearId: string) =>
        owner.query(
          `INSERT INTO "TeacherEmployments" ("schoolId", "userId", "academicYearId", "employmentPercent", "updatedAt") VALUES ($1, $2, $3, 50, now())`,
          [s, userId, academicYearId],
        );
      const standing = async (userId: string) =>
        one<{ teaches: boolean; posts: number }>(
          `SELECT u."teaches", (SELECT count(*)::int FROM "TeacherEmployments" e WHERE e."userId" = u.id) AS posts FROM "Users" u WHERE u.id = $1`,
          [userId],
        );
      const mark = (service: PrismaService, userId: string) =>
        service.withRls(rektor.principal, (tx) => tx.user.update({ where: { id: userId }, data: { teaches: true }, select: { id: true } }));
      const remove = (service: PrismaService, userId: string, academicYearId: string) =>
        service.withRls(rektor.principal, (tx) =>
          tx.teacherEmployment.delete({ where: { schoolId_userId_academicYearId: { schoolId: s, userId, academicYearId } } }),
        );

      /**
       * `held` runs on one connection and parks before it commits; `rival` runs on the other and must be seen waiting on it
       * (a lock the database reports, not a clock) before the holder is released. A rival that settles before it has waited
       * is a lock that is not there: it fails here, and says so, instead of ending in a state that happened to hold.
       */
      const meet = async (label: string, held: (tx: PrismaClient) => Promise<unknown>, rival: () => Promise<unknown>) => {
        const touched = deferred<number>();
        const release = deferred<void>();
        const holder = api.withRls(rektor.principal, async (tx) => {
          await held(tx);
          const [{ pid }] = await tx.$queryRaw<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`;
          touched.resolve(pid);
          await release.promise;
        });
        const holderSettled = holder.then(() => null, (error: unknown) => error);
        const pid = await Promise.race([
          touched.promise,
          holderSettled.then((error) => {
            throw error ?? new Error(`${label}: the holder committed before it parked`);
          }),
        ]);
        let early = false;
        const rivalSettled = rival().then(
          () => {
            early = true;
            return null;
          },
          (error: unknown) => {
            early = true;
            return error;
          },
        );
        for (let tries = 0; ; tries++) {
          const { rows } = await owner.query<{ n: number }>(
            'SELECT count(*)::int AS n FROM pg_stat_activity WHERE $1::int = ANY(pg_blocking_pids(pid))',
            [pid],
          );
          if (rows[0]!.n > 0) break;
          if (early || tries > 500) {
            release.resolve();
            await holderSettled;
            const error = await rivalSettled;
            assert.fail(`${label}: the second connection did not wait for the first (${early ? 'it was answered at once' : 'it never waited'}: ${error === null ? 'and it went through' : String(error)})`);
          }
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        release.resolve();
        return Promise.all([holderSettled, rivalSettled]);
      };

      // 1. The mark is set and held; the last post is deleted on the other connection: it waits for the mark, and is then refused.
      const first = await person('race1', 'SCHOOL_ADMIN', 'FULL');
      await post(first.id, year.id);
      const [markHeld, deleteRefused] = await meet('mark, then the last post', (tx) =>
        tx.user.update({ where: { id: first.id }, data: { teaches: true }, select: { id: true } }), () => remove(second, first.id, year.id));
      assert.equal(markHeld, null, `the mark failed: ${summarise(markHeld)}`);
      assert.equal(sqlstateOf(deleteRefused), 'TE410', `the last post was not refused: ${summarise(deleteRefused)}`);
      assert.deepEqual(await standing(first.id), { teaches: true, posts: 1 });

      // 2. The last post is deleted and held (the person is not marked yet); the mark on the other connection waits for it, and is then refused.
      const secondPerson = await person('race2', 'SCHOOL_ADMIN', 'FULL');
      await post(secondPerson.id, year.id);
      const [deleteHeld, markRefused] = await meet('the last post, then the mark', (tx) =>
        tx.teacherEmployment.delete({ where: { schoolId_userId_academicYearId: { schoolId: s, userId: secondPerson.id, academicYearId: year.id } } }),
      () => mark(second, secondPerson.id));
      assert.equal(deleteHeld, null, `the delete failed: ${summarise(deleteHeld)}`);
      assert.equal(sqlstateOf(markRefused), 'TE409', `the mark was not refused: ${summarise(markRefused)}`);
      assert.deepEqual(await standing(secondPerson.id), { teaches: false, posts: 0 });

      // 3. A marked person with two posts: one is deleted and held, the other deleted on the other connection waits for it and is
      // then refused, for the first has gone. One post is left.
      const third = await person('race3', 'SCHOOL_ADMIN', 'FULL');
      await post(third.id, year.id);
      await post(third.id, year2.id);
      await api.withRls(rektor.principal, (tx) => tx.user.update({ where: { id: third.id }, data: { teaches: true } }));
      const [firstGone, secondRefused] = await meet('two last posts', (tx) =>
        tx.teacherEmployment.delete({ where: { schoolId_userId_academicYearId: { schoolId: s, userId: third.id, academicYearId: year.id } } }),
      () => remove(second, third.id, year2.id));
      assert.equal(firstGone, null, `the first delete failed: ${summarise(firstGone)}`);
      assert.equal(sqlstateOf(secondRefused), 'TE410', `the second delete was not refused: ${summarise(secondRefused)}`);
      assert.deepEqual(await standing(third.id), { teaches: true, posts: 1 });
    });
  } finally {
    await sweepRollerSchool(owner, marker);
  }
}
