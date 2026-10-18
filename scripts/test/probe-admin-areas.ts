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
 *          without HR-läs, kept for one with it.
 *
 * Its school is its own (`<marker>-roller`), created and removed as the owner.
 */
import { strict as assert } from 'node:assert';
import { randomUUID } from 'node:crypto';
import type { Client } from 'pg';
import { AdminProfile } from '@prisma/client';
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

/** The error a promise rejects with, or a failed assertion when it resolves. */
async function refusalOf(work: Promise<unknown>): Promise<unknown> {
  try {
    await work;
  } catch (error) {
    return error;
  }
  assert.fail('the write was not refused');
}

export async function adminAreaChecks(owner: Client, api: PrismaService, marker: string, check: Check): Promise<void> {
  await sweepRollerSchool(owner, marker);
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
  } finally {
    await sweepRollerSchool(owner, marker);
  }
}
