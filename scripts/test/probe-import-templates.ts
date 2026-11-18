/**
 * The adapter probe's checks for Kolumnmappning (20270223090000), through the real services on the API's role
 * and real Postgres as CI runs it. In two schools of their own (slugs <marker>-kolumnmallar and
 * <marker>-kolumnmallar-b), swept whole before and after:
 *
 *   km1  the full administrator makes, lists, renames, re-posts and removes a template through
 *        ImportTemplatesService; the posts come back as they went in, a null field still null, and two hundred
 *        posts of a few kilobytes make the round trip;
 *   km2  a name written twice meets the unique key through @prisma/adapter-pg as P2002 and is answered as
 *        409 TEMPLATE_NAME_TAKEN, whether the service's own count saw it or a second writer made it;
 *   km3  Planering writes and every other profile only reads: the schemaläggare writes, the läsare and the
 *        expedition read the template and are refused with 403 AREA_NOT_YOURS by the database's arms; a teacher
 *        and a pupil are refused as well and read nothing;
 *   km4  the other school reads none of this school's templates, cannot change or remove one by its id (404), and
 *        makes its own under the same name; a template goes with its school;
 *   km5  the requirements import names a teacher by signature as a schemaläggare without HR-läs: the year's
 *        signature, in any case, finds the teacher; a signature of another school's, of a deactivated teacher
 *        and of nobody is that row's error, and a row naming a teacher both ways is refused.
 *
 * Imported by prisma-adapter-probe.ts, which hands in its `check`. A third school of the same slug family (-c) is made
 * and removed inside km4, to see a template go with its school.
 */
import { strict as assert } from 'node:assert';
import { randomUUID } from 'node:crypto';
import type { Client } from 'pg';
import { Role } from '../../src/auth/enums/role.enum';
import type { AuthenticatedUser } from '../../src/auth/interfaces/authenticated-user.interface';
import type { PrismaService } from '../../src/database/prisma.service';
import { ImportService } from '../../src/import/import.service';
import { ImportTemplatesService, TEMPLATE_NAME_TAKEN } from '../../src/import-templates/import-templates.service';
import type { UsersService } from '../../src/users/users.service';

type Check = (label: string, body: () => Promise<void>) => Promise<void>;

export function importTemplatesSlug(marker: string): string {
  return `${marker}-kolumnmallar`;
}

export async function sweepImportTemplatesSchools(owner: Client, marker: string): Promise<void> {
  const slug = importTemplatesSlug(marker);
  await owner.query(`DELETE FROM "Schools" WHERE slug IN ($1, $2, $3)`, [slug, `${slug}-b`, `${slug}-c`]);
}

const rejectsWith = async (body: () => Promise<unknown>, status: number, code?: string) => {
  await assert.rejects(body, (error: { getStatus?: () => number; getResponse?: () => unknown }) => {
    assert.equal(error.getStatus?.(), status, `status ${String(error.getStatus?.())}: ${JSON.stringify(error.getResponse?.() ?? error)}`);
    if (code !== undefined) assert.equal((error.getResponse?.() as { code?: string } | undefined)?.code, code);
    return true;
  });
};

const post = (key: string, field: string | null, label = key) => ({ key, label, field });

export async function importTemplatesChecks(owner: Client, api: PrismaService, marker: string, check: Check): Promise<void> {
  await sweepImportTemplatesSchools(owner, marker);
  const one = async <T extends object>(sql: string, params: unknown[] = []): Promise<T> => (await owner.query<T>(sql, params)).rows[0]!;
  const today = (await one<{ d: string }>(`SELECT ((now() AT TIME ZONE 'Europe/Stockholm')::date)::text AS d`)).d;
  const school = async (slug: string, name: string) =>
    (await one<{ id: string }>(`INSERT INTO "Schools" (name, slug, timezone, "updatedAt") VALUES ($1, $2, 'Europe/Stockholm', now()) RETURNING id`, [name, slug])).id;
  const a = await school(importTemplatesSlug(marker), `${marker} kolumnmallar`);
  const b = await school(`${importTemplatesSlug(marker)}-b`, `${marker} kolumnmallar b`);
  const yearOf = async (schoolId: string) =>
    (
      await one<{ id: string }>(
        `INSERT INTO "AcademicYears" ("schoolId", name, "startDate", "endDate", "isActive", "gradeNumbering", "updatedAt")
         VALUES ($1, 'probe kolumnmallar', '${today}'::date - 30, '${today}'::date + 300, true, 'NIOARIG', now()) RETURNING id`,
        [schoolId],
      )
    ).id;
  const yearA = await yearOf(a);
  const yearB = await yearOf(b);
  const person = async (schoolId: string, role: string, label: string, profile: string | null = null, active = true) => {
    const authId = randomUUID();
    const row = await one<{ id: string }>(
      `INSERT INTO "Users" ("schoolId", email, "firstName", "lastName", role, "adminProfile", "authId", "isActive", "updatedAt")
       VALUES ($1, $2, $3, 'Probe', $4::"UserRole", $5::"AdminProfile", $6, $7, now()) RETURNING id`,
      [schoolId, `${marker}-kolumnmallar-${label}@example.invalid`, label, role, profile, authId, active],
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
  const teacher = await person(a, 'TEACHER', 'karin');
  const pupil = await person(a, 'STUDENT', 'elev');
  const fullB = await person(b, 'SCHOOL_ADMIN', 'full-b', 'FULL');
  const asFull = user(a, full, Role.SCHOOL_ADMIN, 'FULL');
  const asPlanner = user(a, planner, Role.SCHOOL_ADMIN, 'SCHEMALAGGARE');
  const asReader = user(a, reader, Role.SCHOOL_ADMIN, 'LASARE');
  const asClerk = user(a, clerk, Role.SCHOOL_ADMIN, 'EXPEDITION');
  const asTeacher = user(a, teacher, Role.TEACHER);
  const asPupil = user(a, pupil, Role.STUDENT);
  const asFullB = user(b, fullB, Role.SCHOOL_ADMIN, 'FULL');
  const templates = new ImportTemplatesService(api);

  try {
    let id = '';
    await check('(km1) the full administrator makes, lists, renames, re-posts and removes a template', async () => {
      const made = await templates.create(
        { kind: 'requirements', name: '  Höstens tjänstefördelning ', headerRow: 3, placements: [post('grupp', 'groupName', 'Grupp'), post('anteckning', null, 'Anteckning'), post('ped', 'teacherSignature', 'Ped')] },
        asFull,
      );
      id = made.id;
      assert.equal(made.name, 'Höstens tjänstefördelning');
      assert.equal(made.headerRow, 3);
      assert.deepEqual(made.placements, [post('grupp', 'groupName', 'Grupp'), post('anteckning', null, 'Anteckning'), post('ped', 'teacherSignature', 'Ped')]);
      assert.match(made.createdAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
      assert.deepEqual((await templates.list({}, asFull)).map((t) => t.id), [id]);
      assert.deepEqual((await templates.list({ kind: 'rooms' }, asFull)).map((t) => t.id), []);
      const renamed = await templates.update(id, { name: 'Hösten', headerRow: null, placements: [post('namn', 'groupName', 'Namn')] }, asFull);
      assert.equal(renamed.name, 'Hösten');
      assert.equal(renamed.headerRow, null);
      assert.deepEqual(renamed.placements, [post('namn', 'groupName', 'Namn')]);
      assert.ok(renamed.updatedAt >= made.updatedAt);
      // Two hundred posts of a few hundred bytes each make the round trip (the column is capped at 40 000 bytes).
      const many = Array.from({ length: 200 }, (_, i) => post(`k${i}`, i === 0 ? 'groupName' : null, `Kolumn ${i} åäö ${'x'.repeat(100)}`));
      const wide = await templates.create({ kind: 'classes', name: 'Bred', placements: many.map((p) => ({ ...p, field: p.key === 'k0' ? 'name' : null })) }, asFull);
      assert.equal(wide.placements.length, 200);
      assert.equal(wide.placements[199]!.label, many[199]!.label);
      await templates.remove(wide.id, asFull);
      await rejectsWith(() => templates.remove(wide.id, asFull), 404);
    });

    await check('(km2) a name twice meets the unique key and is answered as 409 TEMPLATE_NAME_TAKEN', async () => {
      // The service's own check is a count, so the key is what a second writer meets: two writes at once.
      const results = await Promise.allSettled([
        templates.create({ kind: 'rooms', name: 'Samma', placements: [] }, asFull),
        templates.create({ kind: 'rooms', name: 'Samma', placements: [] }, asPlanner),
      ]);
      const failed = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
      assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1, JSON.stringify(results.map((r) => r.status)));
      assert.equal(failed.length, 1);
      const refusal = failed[0]!.reason as { getStatus?: () => number; getResponse?: () => { code?: string } };
      assert.equal(refusal.getStatus?.(), 409);
      assert.equal(refusal.getResponse?.().code, TEMPLATE_NAME_TAKEN);
      await rejectsWith(() => templates.create({ kind: 'rooms', name: 'Samma', placements: [] }, asFull), 409, TEMPLATE_NAME_TAKEN);
      // The same name in another kind is another template, and a rename into a taken name is the same refusal.
      const other = await templates.create({ kind: 'subjects', name: 'Samma', placements: [] }, asFull);
      assert.notEqual(other.id, '');
      const third = await templates.create({ kind: 'subjects', name: 'Tredje', placements: [] }, asFull);
      await rejectsWith(() => templates.update(third.id, { name: 'Samma' }, asFull), 409, TEMPLATE_NAME_TAKEN);
    });

    await check('(km3) Planering writes and the other profiles only read; a teacher and a pupil meet nothing', async () => {
      const made = await templates.create({ kind: 'students', name: 'Elevlistan', placements: [post('fornamn', 'firstName')] }, asPlanner);
      assert.equal(made.name, 'Elevlistan');
      for (const [label, who] of [['läsare', asReader], ['expedition', asClerk]] as const) {
        const seen = (await templates.list({ kind: 'students' }, who)).map((t) => t.id);
        assert.deepEqual(seen, [made.id], `the ${label} reads the template`);
        await rejectsWith(() => templates.create({ kind: 'students', name: `Av ${label}`, placements: [] }, who), 403, 'AREA_NOT_YOURS');
        await rejectsWith(() => templates.update(made.id, { name: `Ändrad av ${label}` }, who), 403, 'AREA_NOT_YOURS');
        // A delete's arm has only its USING, so the refused one finds no row: the same 404 as a row that is not there.
        await rejectsWith(() => templates.remove(made.id, who), 404);
      }
      for (const [label, who] of [['lärare', asTeacher], ['elev', asPupil]] as const) {
        assert.deepEqual(await templates.list({}, who), [], `the ${label} reads none`);
        await rejectsWith(() => templates.create({ kind: 'students', name: `Av ${label}`, placements: [] }, who), 403, 'AREA_NOT_YOURS');
        await rejectsWith(() => templates.update(made.id, { name: 'Ändrad' }, who), 404);
        await rejectsWith(() => templates.remove(made.id, who), 404);
      }
      assert.equal((await templates.list({ kind: 'students' }, asFull))[0]!.name, 'Elevlistan');
    });

    await check('(km4) the other school reads, changes and removes none of it and makes its own; a template goes with its school', async () => {
      const mine = (await templates.list({}, asFull)).map((t) => t.id);
      assert.ok(mine.length >= 3, `this school has ${mine.length} templates`);
      assert.deepEqual(await templates.list({}, asFullB), []);
      for (const templateId of mine) {
        await rejectsWith(() => templates.update(templateId, { name: 'Stulen' }, asFullB), 404);
        await rejectsWith(() => templates.remove(templateId, asFullB), 404);
      }
      const theirs = await templates.create({ kind: 'requirements', name: 'Hösten', placements: [post('grupp', 'groupName')] }, asFullB);
      assert.deepEqual((await templates.list({}, asFullB)).map((t) => t.id), [theirs.id]);
      assert.equal((await templates.list({}, asFull)).length, mine.length);
      const count = async (schoolId: string) => Number((await one<{ n: string }>(`SELECT count(*) AS n FROM "ImportMappingTemplates" WHERE "schoolId" = $1`, [schoolId])).n);
      assert.equal(await count(b), 1);
      // A template goes with its school (the key cascades): a third school, made and removed here.
      const c = await school(`${importTemplatesSlug(marker)}-c`, `${marker} kolumnmallar c`);
      await owner.query(`INSERT INTO "ImportMappingTemplates" ("schoolId", kind, name, placements, "updatedAt") VALUES ($1, 'rooms', 'Följer skolan', '[]', now())`, [c]);
      assert.equal(await count(c), 1);
      await owner.query(`DELETE FROM "Schools" WHERE id = $1`, [c]);
      assert.equal(await count(c), 0, 'the templates of a school that goes stay behind');
    });

    await check('(km5) the requirements import names a teacher by signature, as a schemaläggare without HR-läs', async () => {
      const group = await one<{ id: string }>(
        `INSERT INTO "StudentGroups" ("schoolId", "academicYearId", name, "gradeLevel", "updatedAt") VALUES ($1, $2, 'KM7A', 7, now()) RETURNING id`,
        [a, yearA],
      );
      const subject = await one<{ id: string }>(`INSERT INTO "Subjects" ("schoolId", name, code, "updatedAt") VALUES ($1, 'Matematik km', 'KMMA', now()) RETURNING id`, [a]);
      const gone = await person(a, 'TEACHER', 'slutad', null, false);
      const other = await person(a, 'TEACHER', 'annan');
      const outsider = await person(b, 'TEACHER', 'utomstaende');
      const employ = (schoolId: string, year: string, who: { id: string }, signature: string) =>
        owner.query(
          `INSERT INTO "TeacherEmployments" ("schoolId", "userId", "academicYearId", "employmentPercent", signature, "updatedAt") VALUES ($1, $2, $3, 100, $4, now())`,
          [schoolId, who.id, year, signature],
        );
      await employ(a, yearA, teacher, 'KA');
      await employ(a, yearA, gone, 'OFF');
      await employ(a, yearA, other, 'ÅSÖ');
      // The other school has a teacher who signs ZZ; the school of the file has nobody who does.
      await employ(b, yearB, outsider, 'ZZ');

      const imports = new ImportService(api, {} as UsersService);
      const columns = ['teacherEmail', 'teacherSignature', 'coTeacherEmail', 'coTeacherSignature'] as const;
      const row = (extra: Record<string, unknown>) => ({
        groupName: 'KM7A',
        subject: 'KMMA',
        lessonsPerWeek: 2,
        minutesPerLesson: 60,
        recurrence: 'ALL_WEEKS' as const,
        ...extra,
      });
      const report = await imports.importRequirements({ academicYearId: yearA, columns: [...columns], rows: [row({ teacherSignature: ' ka ', coTeacherSignature: 'åsö' })] }, asPlanner);
      assert.deepEqual(report.errors, []);
      assert.equal(report.created, 1);
      const stored = await one<{ teacherId: string; coTeacherId: string }>(
        `SELECT "teacherId", "coTeacherId" FROM "TeachingRequirements" WHERE "schoolId" = $1 AND "studentGroupId" = $2 AND "subjectId" = $3`,
        [a, group.id, subject.id],
      );
      assert.equal(stored.teacherId, teacher.id);
      assert.equal(stored.coTeacherId, other.id);

      // The same row again, naming nobody who exists: each is that row's error, and the stored teachers stay.
      for (const [signature, why] of [['ZZ', 'another school'], ['OFF', 'a deactivated teacher'], ['NOBODY', 'nobody']] as const) {
        const refused = await imports.importRequirements({ academicYearId: yearA, columns: [...columns], rows: [row({ teacherSignature: signature.slice(0, 8) })] }, asPlanner);
        assert.equal(refused.created + (refused.updated ?? 0), 0, `${why} was imported`);
        assert.equal(refused.errors.length, 1, `${why}: ${JSON.stringify(refused.errors)}`);
        assert.match(refused.errors[0]!.message, /Ingen aktiv lärare med signaturen/, why);
      }
      const both = await imports.importRequirements(
        { academicYearId: yearA, columns: [...columns], rows: [row({ teacherEmail: `${marker}-kolumnmallar-karin@example.invalid`, teacherSignature: 'KA' })] },
        asPlanner,
      );
      assert.match(both.errors[0]!.message, /både med e-postadress och med signatur/);
      const kept = await one<{ teacherId: string }>(`SELECT "teacherId" FROM "TeachingRequirements" WHERE "schoolId" = $1 AND "studentGroupId" = $2`, [a, group.id]);
      assert.equal(kept.teacherId, teacher.id);
      // An empty cell in a signature column the file has is "no teacher": the stored one is taken off.
      const emptied = await imports.importRequirements({ academicYearId: yearA, columns: ['teacherSignature'], rows: [row({ teacherSignature: null })] }, asPlanner);
      assert.deepEqual(emptied.errors, []);
      assert.equal(emptied.updated, 1);
      const none = await one<{ teacherId: string | null; coTeacherId: string | null }>(
        `SELECT "teacherId", "coTeacherId" FROM "TeachingRequirements" WHERE "schoolId" = $1 AND "studentGroupId" = $2`,
        [a, group.id],
      );
      assert.equal(none.teacherId, null);
      assert.equal(none.coTeacherId, other.id, 'the file had no co-teacher column, so the co-teacher stays');
    });
  } finally {
    await sweepImportTemplatesSchools(owner, marker);
  }
}
