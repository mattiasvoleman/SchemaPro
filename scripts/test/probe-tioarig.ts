/**
 * The adapter probe's checks for the tioårig grundskola (SFS 2025:729,
 * 20261121091000), through the real services on the API's role and real
 * Postgres as CI runs it: a school rolled over into HT 2028 reads its classes
 * one up, and every school-wide span it stated in the nioårig numbering still
 * binds the same children. In a school of its own (slug <marker>-tioarig),
 * swept whole before and after:
 *
 *   ti1  the rollover from 2027/28 into 2028/29 asks a school that shows no
 *        form, renumbers when told, writes a tioårig läsår and moves each
 *        class two årskurser: 8A → 10A, 5A → 7A;
 *   ti2  under qualificationMode REFUSE, a teacher behörig in matematik 7–9
 *        is assigned 10A's matematik, and one behörig 1–6 is refused it; 7A
 *        the other way round — the behörigheter stated nioårig, the classes
 *        read so (TeachingRequirementsService, enforceRequirementWrite);
 *   ti3  the solver's payload for the new läsår, on its projected rosters:
 *        10A and its timplanspost are sent as the 9 a "7–9" frame binds, 7A
 *        as the 6 the F–6 frame does, and the frames, raster and lunch
 *        sittings each bind exactly those classes;
 *   ti4  activated, the SS12000 v2 provider puts 10A in the 7–9 skolenhet and
 *        7A in the F–6 one, which övergångsbestämmelse 5 reads as 1–7.
 *
 * Imported by prisma-adapter-probe.ts, which hands in its `check`.
 */
import { strict as assert } from 'node:assert';
import { randomUUID } from 'node:crypto';
import { ConflictException } from '@nestjs/common';
import type { Client } from 'pg';
import { Role } from '../../src/auth/enums/role.enum';
import type { AuthenticatedUser } from '../../src/auth/interfaces/authenticated-user.interface';
import type { PrismaService } from '../../src/database/prisma.service';
import type { Scope } from '../../src/integration/ss12000-v2/scopes';
import { Ss12000V2Service, type V2Caller } from '../../src/integration/ss12000-v2/ss12000-v2.service';
import { OptimizationProxyService } from '../../src/optimization/optimization-proxy.service';
import { TeachingRequirementsService } from '../../src/resources/teaching-requirements.service';
import { rostersOfYear } from '../../src/year-rollover/projected-rosters';
import { YearRolloverService } from '../../src/year-rollover/year-rollover.service';

type Check = (label: string, body: () => Promise<void>) => Promise<void>;

export function tioarigSlug(marker: string): string {
  return `${marker}-tioarig`;
}

export async function sweepTioarigSchool(owner: Client, marker: string): Promise<void> {
  await owner.query(`DELETE FROM "Schools" WHERE slug = $1`, [tioarigSlug(marker)]);
}

/** A span of the payload, school-wide or a class's. */
type Span = { minGradeLevel: number | null; maxGradeLevel: number | null };

/** Whether a school-wide span reaches a class's, as the engine reads it (_grade_span_overlaps). */
const binds = (wide: Span, group: Span): boolean =>
  group.minGradeLevel !== null &&
  group.maxGradeLevel !== null &&
  group.minGradeLevel <= (wide.maxGradeLevel as number) &&
  group.maxGradeLevel >= (wide.minGradeLevel as number);

export async function tioarigChecks(owner: Client, api: PrismaService, marker: string, check: Check): Promise<void> {
  await sweepTioarigSchool(owner, marker);
  const one = async <T extends object>(sql: string, params: unknown[] = []): Promise<T> => (await owner.query<T>(sql, params)).rows[0]!;
  const s = (
    await one<{ id: string }>(
      `INSERT INTO "Schools" (name, slug, timezone, "updatedAt") VALUES ($1, $2, 'Europe/Stockholm', now()) RETURNING id`,
      [`${marker} tioårig`, tioarigSlug(marker)],
    )
  ).id;
  // 2027/28, the last nioårig läsår: the trigger fills NIOARIG before HT 2028.
  const source = await one<{ id: string; gradeNumbering: string }>(
    `INSERT INTO "AcademicYears" ("schoolId", name, "startDate", "endDate", "isActive", "updatedAt")
     VALUES ($1, 'Ti 2027/28', DATE '2027-08-16', DATE '2028-06-11', true, now()) RETURNING id, "gradeNumbering"::text`,
    [s],
  );
  const klass = async (name: string, grade: number) =>
    (
      await one<{ id: string }>(
        `INSERT INTO "StudentGroups" ("schoolId", "academicYearId", name, "gradeLevel", "updatedAt") VALUES ($1, $2, $3, $4, now()) RETURNING id`,
        [s, source.id, name, grade],
      )
    ).id;
  const c8 = await klass('Ti 8A', 8);
  const c5 = await klass('Ti 5A', 5);
  const person = async (role: string, label: string, groupId: string | null = null) => {
    const authId = randomUUID();
    const row = await one<{ id: string }>(
      `INSERT INTO "Users" ("schoolId", email, "firstName", "lastName", role, "authId", "isActive", "studentGroupId", "updatedAt")
       VALUES ($1, $2, $3, 'Probe', $4::"UserRole", $5, true, $6, now()) RETURNING id`,
      [s, `${marker}-tioarig-${label}@example.invalid`, label, role, authId, groupId],
    );
    return { id: row.id, authId };
  };
  const admin = await person('SCHOOL_ADMIN', 'admin');
  const hogstadiet = await person('TEACHER', 'hogstadiet');
  const lagstadiet = await person('TEACHER', 'lagstadiet');
  await person('STUDENT', 'elev8', c8);
  await person('STUDENT', 'elev5', c5);
  const asAdmin: AuthenticatedUser = { authId: admin.authId, role: Role.SCHOOL_ADMIN, userId: admin.id, schoolId: s, channel: 'WEB', adminProfile: 'FULL' };

  const ma = (await one<{ id: string }>(`INSERT INTO "Subjects" ("schoolId", name, code, "updatedAt") VALUES ($1, 'Matematik', 'MA', now()) RETURNING id`, [s])).id;
  for (const groupId of [c8, c5]) {
    await owner.query(
      `INSERT INTO "TeachingRequirements" ("schoolId", "academicYearId", "subjectId", "studentGroupId", "lessonsPerWeek", "minutesPerLesson", "updatedAt")
       VALUES ($1, $2, $3, $4, 3, 60, now())`,
      [s, source.id, ma, groupId],
    );
  }
  // Behörigheter, stated nioårig as a school writes them: one 7–9, one 1–6.
  for (const [teacher, from, to] of [
    [hogstadiet.id, 7, 9],
    [lagstadiet.id, 1, 6],
  ] as const) {
    await owner.query(
      `INSERT INTO "TeacherSubjectQualifications" ("schoolId", "userId", "subjectId", "minGradeLevel", "maxGradeLevel", kind, "updatedAt")
       VALUES ($1, $2, $3, $4, $5, 'BEHORIG', now())`,
      [s, teacher, ma, from, to],
    );
  }
  await owner.query(
    `INSERT INTO "StaffingPolicies" ("schoolId", "qualificationMode", "overAllocationMode", "updatedAt") VALUES ($1, 'REFUSE', 'OFF', now())`,
    [s],
  );
  // The school-wide spans, nioårig for good: högstadiet 7–9, F–6 below it,
  // each at its own time so a binding says which.
  for (const [from, to, start, end] of [
    [7, 9, '08:00', '16:00'],
    [0, 6, '08:30', '14:00'],
  ] as const) {
    await owner.query(
      `INSERT INTO "FrameTimes" ("schoolId", "minGradeLevel", "maxGradeLevel", "startTime", "endTime", "updatedAt") VALUES ($1, $2, $3, $4::time, $5::time, now())`,
      [s, from, to, start, end],
    );
  }
  for (const [name, from, to, start, end] of [
    ['Högstadiets rast', 7, 9, '09:40', '10:00'],
    ['Lågstadiets rast', 0, 6, '10:00', '10:20'],
  ] as const) {
    await owner.query(
      `INSERT INTO "Rasts" ("schoolId", name, "minGradeLevel", "maxGradeLevel", "startTime", "endTime", "updatedAt") VALUES ($1, $2, $3, $4, $5::time, $6::time, now())`,
      [s, name, from, to, start, end],
    );
  }
  for (const [from, to, start, end] of [
    [7, 9, '11:45', '12:15'],
    [0, 6, '11:00', '11:30'],
  ] as const) {
    await owner.query(
      `INSERT INTO "LunchServings" ("schoolId", "minGradeLevel", "maxGradeLevel", "startTime", "endTime", "updatedAt") VALUES ($1, $2, $3, $4::time, $5::time, now())`,
      [s, from, to, start, end],
    );
  }
  const unitF6 = (
    await one<{ id: string }>(
      `INSERT INTO "SchoolUnits" ("schoolId", name, code, "schoolTypes", "gradeFrom", "gradeTo", "updatedAt") VALUES ($1, 'Ti F–6', '41414141', '{GR,FKLASS}', 0, 6, now()) RETURNING id`,
      [s],
    )
  ).id;
  const unit79 = (
    await one<{ id: string }>(
      `INSERT INTO "SchoolUnits" ("schoolId", name, code, "schoolTypes", "gradeFrom", "gradeTo", "updatedAt") VALUES ($1, 'Ti 7–9', '42424242', '{GR}', 7, 9, now()) RETURNING id`,
      [s],
    )
  ).id;

  const rollover = new YearRolloverService(api);
  const requirements = new TeachingRequirementsService(api);
  try {
    let target = '';
    const targetGroup = async (name: string) =>
      (await one<{ id: string }>(`SELECT id FROM "StudentGroups" WHERE "academicYearId" = $1 AND name = $2`, [target, name])).id;
    const requirementOf = async (groupId: string) =>
      (await one<{ id: string }>(`SELECT id FROM "TeachingRequirements" WHERE "studentGroupId" = $1`, [groupId])).id;

    await check('(ti1) the rollover into HT 2028 writes a tioårig läsår and moves each class two årskurser', async () => {
      assert.equal(source.gradeNumbering, 'NIOARIG');
      // Åk 9 leaves the nioårig school; there is none here, so 8A stays.
      const options = { name: 'Ti 2028/29', startDate: '2028-08-14', endDate: '2029-06-08', breaks: [], renumber2028: true, graduatingGradeLevel: 9 };
      // A school its plans and year show no form for is asked (SFS 2025:729
      // covers the four forms); told, the preview renumbers and says it.
      const { renumber2028: _told, ...unasked } = options;
      const asked = await rollover.previewRollover(source.id, unasked, asAdmin);
      assert.deepEqual(
        asked.problems.filter((problem) => problem.code.startsWith('ROLLOVER_2028')).map((problem) => [problem.code, problem.blocking]),
        [['ROLLOVER_2028_SCHOOL_FORM_UNKNOWN', true]],
      );
      const preview = await rollover.previewRollover(source.id, options, asAdmin);
      assert.equal(preview.blocking, false, JSON.stringify(preview.problems));
      assert.deepEqual(
        preview.problems.filter((problem) => problem.code.startsWith('ROLLOVER_2028')),
        [{ code: 'ROLLOVER_2028_RENUMBERING', blocking: false, params: { startYear: 2028, source: 'SFS 2025:729, övergångsbestämmelse 4' } }],
      );
      assert.deepEqual(preview.reform2028, { renumbers: true, numbering: 'TIOARIG' });
      const result = await rollover.executeRollover(
        source.id,
        { ...options, planHash: preview.planHash },
        asAdmin,
      );
      target = result.academicYear.id;
      const year = await one<{ numbering: string; active: boolean }>(
        `SELECT "gradeNumbering"::text AS numbering, "isActive" AS active FROM "AcademicYears" WHERE id = $1`,
        [target],
      );
      assert.deepEqual(year, { numbering: 'TIOARIG', active: false });
      const groups = (
        await owner.query<{ name: string; grade: number; predecessor: string }>(
          `SELECT name, "gradeLevel" AS grade, "predecessorId" AS predecessor FROM "StudentGroups" WHERE "academicYearId" = $1 ORDER BY name`,
          [target],
        )
      ).rows;
      assert.deepEqual(groups, [
        { name: 'Ti 10A', grade: 10, predecessor: c8 },
        { name: 'Ti 7A', grade: 7, predecessor: c5 },
      ]);
    });

    await check('(ti2) under REFUSE a 7–9 behörighet takes 10A and not 7A, a 1–6 one 7A and not 10A', async () => {
      const [r10, r7] = [await requirementOf(await targetGroup('Ti 10A')), await requirementOf(await targetGroup('Ti 7A'))];
      const refused = (error: unknown) => {
        assert.ok(error instanceof ConflictException, String(error));
        assert.equal((error.getResponse() as { code?: string }).code, 'STAFF_TEACHER_NOT_QUALIFIED');
        return true;
      };
      await assert.rejects(requirements.update(r10, { teacherId: lagstadiet.id }, asAdmin), refused);
      await assert.rejects(requirements.update(r7, { teacherId: hogstadiet.id }, asAdmin), refused);
      const tenth = await requirements.update(r10, { teacherId: hogstadiet.id }, asAdmin);
      const seventh = await requirements.update(r7, { teacherId: lagstadiet.id }, asAdmin);
      assert.deepEqual([tenth.teacherId, seventh.teacherId], [hogstadiet.id, lagstadiet.id]);
      assert.deepEqual([tenth.warnings, seventh.warnings], [[], []]);
    });

    await check('(ti3) the solver payload sends 10A as 9 and 7A as 6, and the frames, raster and sittings bind them so', async () => {
      const proxy = new OptimizationProxyService(
        api,
        { post: () => { throw new Error('the engine was called'); } } as never,
        { getOrThrow: () => ({ baseUrl: 'http://engine.invalid', apiKey: 'k'.repeat(32), timeoutMs: 1 }) } as never,
      );
      const [g10, g7] = [await targetGroup('Ti 10A'), await targetGroup('Ti 7A')];
      const payload = await api.withRls(asAdmin, async (tx) => {
        const basis = await rostersOfYear(tx, asAdmin, target);
        assert.equal(basis.kind, 'PROJECTED');
        return (
          proxy as unknown as {
            fetchAndAnonymize: (...args: unknown[]) => Promise<{
              groups: (Span & { id: string })[];
              requirements: (Span & { studentGroupId: string; teacherId: string | null })[];
              frameTimes: (Span & { startTime: string })[];
              rasts: (Span & { startTime: string })[];
              lunchServings: (Span & { startTime: string })[];
              groupAnonMap: Map<string, string>;
              gradeNumbering: string;
            }>;
          }
        ).fetchAndAnonymize(tx, target, s, basis);
      });
      assert.equal(payload.gradeNumbering, 'TIOARIG');
      const anon10 = payload.groupAnonMap.get(g10)!;
      const anon7 = payload.groupAnonMap.get(g7)!;
      const spans = (rows: Span[]) => rows.map((row) => [row.minGradeLevel, row.maxGradeLevel]);
      // The class and its timplanspost, in the numbering the school's spans are in.
      assert.deepEqual(spans(payload.groups.filter((group) => group.id === anon10)), [[9, 9]]);
      assert.deepEqual(spans(payload.groups.filter((group) => group.id === anon7)), [[6, 6]]);
      assert.deepEqual(spans(payload.requirements.filter((row) => row.studentGroupId === anon10)), [[9, 9]]);
      assert.deepEqual(spans(payload.requirements.filter((row) => row.studentGroupId === anon7)), [[6, 6]]);
      // The school-wide spans as stated, and which class each reaches.
      const group10 = payload.groups.find((group) => group.id === anon10)!;
      const group7 = payload.groups.find((group) => group.id === anon7)!;
      const reach = (rows: (Span & { startTime: string })[]) =>
        rows
          .map((row) => [row.startTime.slice(0, 5), row.minGradeLevel, row.maxGradeLevel, binds(row, group10) ? '10A' : '', binds(row, group7) ? '7A' : ''])
          .sort();
      assert.deepEqual(reach(payload.frameTimes), [
        ['08:00', 7, 9, '10A', ''],
        ['08:30', 0, 6, '', '7A'],
      ]);
      assert.deepEqual(reach(payload.rasts), [
        ['09:40', 7, 9, '10A', ''],
        ['10:00', 0, 6, '', '7A'],
      ]);
      assert.deepEqual(reach(payload.lunchServings), [
        ['11:00', 0, 6, '', '7A'],
        ['11:45', 7, 9, '10A', ''],
      ]);
    });

    await check('(ti4) activated, the SS12000 v2 provider puts 10A in the 7–9 skolenhet and 7A in F–6', async () => {
      const today = { today: '2028-06-12' };
      const activation = await rollover.previewActivation(target, asAdmin, today);
      const done = await rollover.executeActivation(target, { planHash: activation.planHash }, asAdmin, today);
      assert.equal(done.moved, 2);
      const key = await one<{ id: string }>(
        `INSERT INTO "IntegrationApiKeys" ("schoolId", name, "keyHash", scopes) VALUES ($1, 'probe tioårig', $2, $3::text[]) RETURNING id`,
        [s, `${randomUUID().replace(/-/g, '')}${randomUUID().replace(/-/g, '')}`, '{organisations.read,groups.read}'],
      );
      const caller: V2Caller = { schoolId: s, keyId: key.id, scopes: new Set(['organisations.read', 'groups.read'] as Scope[]) };
      const v2 = new Ss12000V2Service(api);
      assert.deepEqual((await v2.getGroup(caller, await targetGroup('Ti 10A'), {}))['organisation'], { id: unit79 });
      assert.deepEqual((await v2.getGroup(caller, await targetGroup('Ti 7A'), {}))['organisation'], { id: unitF6 });
    });
  } finally {
    await sweepTioarigSchool(owner, marker);
  }
}
