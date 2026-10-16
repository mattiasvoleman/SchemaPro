/**
 * The adapter probe's checks for SCB:s Pedagogisk personal (20261111090000),
 * through the real services on the API's role and real Postgres as CI runs
 * it. In a school of its own (slug <marker>-scb), swept whole before and
 * after:
 *
 *   scb1  the admin writes a post's anställningsform and karriärtjänst
 *         through TeacherEmploymentsService; a PUT that leaves the three out
 *         keeps them, and its answer, which hands them back unsent, is in the
 *         läslogg; one sent as null clears it; a share that takes the two
 *         above the post with the other one stored reaches the gateway as
 *         the table's named CHECK, answered 400 in Swedish;
 *   scb2  ScbFileService builds the year's file as the admin: the post's
 *         AnstForm and ForsteLarare, OmfLarare and the subject on the
 *         skolenhet's row, no header line, PersonNr empty, and what the row
 *         lacks listed;
 *   scb3  the download is in the läslogg: one EMPLOYMENT and one PEOPLE row
 *         naming the teachers in the file, the admin's own id left out, in
 *         the read's own transaction — less whoever the same admin read of
 *         that kind in the last quarter-hour (Anna's post, in scb1);
 *   scb4  Bo's sick leave, registered a week at a time over the mätdatum,
 *         is read under the admin's absence arm as one stretch, named
 *         (LONG_ABSENCE) and recorded as STAFF_ABSENCES; no record alone is
 *         30 days.
 *
 * Imported by prisma-adapter-probe.ts, which hands in its `check`.
 */
import { strict as assert } from 'node:assert';
import { randomUUID } from 'node:crypto';
import type { Client } from 'pg';
import { Role } from '../../src/auth/enums/role.enum';
import type { AuthenticatedUser } from '../../src/auth/interfaces/authenticated-user.interface';
import type { PrismaService } from '../../src/database/prisma.service';
import { ScbFileService } from '../../src/staffing/scb/scb-file.service';
import { TeacherEmploymentsService } from '../../src/staffing/teacher-employments.service';

type Check = (label: string, body: () => Promise<void>) => Promise<void>;

export function scbSlug(marker: string): string {
  return `${marker}-scb`;
}

export async function sweepScbSchool(owner: Client, marker: string): Promise<void> {
  await owner.query(`DELETE FROM "Schools" WHERE slug = $1`, [scbSlug(marker)]);
}

export async function scbFileChecks(owner: Client, api: PrismaService, marker: string, check: Check): Promise<void> {
  await sweepScbSchool(owner, marker);
  const one = async <T extends object>(sql: string, params: unknown[] = []): Promise<T> => (await owner.query<T>(sql, params)).rows[0]!;
  const s = (
    await one<{ id: string }>(
      `INSERT INTO "Schools" (name, slug, timezone, "updatedAt") VALUES ($1, $2, 'Europe/Stockholm', now()) RETURNING id`,
      [`${marker} scb`, scbSlug(marker)],
    )
  ).id;
  // A läsår of its own far ahead, so its mätdatum is a date no other probe owns.
  const year = await one<{ id: string }>(
    `INSERT INTO "AcademicYears" ("schoolId", name, "startDate", "endDate", "isActive", "updatedAt")
     VALUES ($1, '2096/97', DATE '2096-08-13', DATE '2097-06-10', true, now()) RETURNING id`,
    [s],
  );
  const person = async (role: string, first: string, last: string) => {
    const authId = randomUUID();
    const row = await one<{ id: string }>(
      `INSERT INTO "Users" ("schoolId", email, "firstName", "lastName", role, "authId", "isActive", "updatedAt")
       VALUES ($1, $2, $3, $4, $5, $6, true, now()) RETURNING id`,
      [s, `${marker}-scb-${first.toLowerCase()}@example.invalid`, first, last, role, authId],
    );
    return { id: row.id, authId };
  };
  const admin = await person('SCHOOL_ADMIN', 'Admin', 'Probe');
  const anna = await person('TEACHER', 'Anna', 'Öberg');
  const bo = await person('TEACHER', 'Bo', 'Alm');
  await owner.query(
    `INSERT INTO "SchoolUnits" ("schoolId", name, code, "schoolTypes", "gradeFrom", "gradeTo", "updatedAt")
     VALUES ($1, 'Probe F–9', '12345678', '{GR}', 0, 9, now())`,
    [s],
  );
  const group = async (name: string) =>
    one<{ id: string }>(
      `INSERT INTO "StudentGroups" ("schoolId", "academicYearId", name, "gradeLevel", "updatedAt") VALUES ($1, $2, $3, 7, now()) RETURNING id`,
      [s, year.id, name],
    );
  const a7 = await group('SCB7A');
  const b7 = await group('SCB7B');
  const subject = await one<{ id: string }>(
    `INSERT INTO "Subjects" ("schoolId", name, code, "nationalCode", "updatedAt") VALUES ($1, 'Matematik', 'MA', 'MA', now()) RETURNING id`,
    [s],
  );
  await owner.query(
    `INSERT INTO "TeachingRequirements" ("schoolId", "academicYearId", "subjectId", "studentGroupId", "teacherId", "lessonsPerWeek", "minutesPerLesson", "updatedAt")
     VALUES ($1, $2, $3, $4, $5, 4, 60, now()), ($1, $2, $3, $6, $7, 2, 60, now())`,
    [s, year.id, subject.id, a7.id, anna.id, b7.id, bo.id],
  );

  const asAdmin: AuthenticatedUser = { authId: admin.authId, role: Role.SCHOOL_ADMIN, userId: admin.id, schoolId: s, channel: 'WEB' };
  const posts = new TeacherEmploymentsService(api);
  const scb = new ScbFileService(api);

  try {
    await check('(scb1) a post states its anställningsform and karriärtjänst; a PUT without them keeps them', async () => {
      await posts.upsert(anna.id, year.id, { employmentPercent: 80, employmentForm: 'TILLSVIDARE', firstTeacherPercent: 10, lecturerPercent: 85 }, asAdmin);
      const kept = await posts.upsert(anna.id, year.id, { employmentPercent: 80 }, asAdmin);
      assert.deepEqual([kept.employmentForm, kept.firstTeacherPercent, kept.lecturerPercent], ['TILLSVIDARE', 10, 85]);
      const echo = await one<{ ids: string[] }>(
        `SELECT ARRAY(SELECT x::text FROM unnest("subjectIds") x) AS ids FROM "PersonalDataAccess"
          WHERE "schoolId" = $1 AND kind = 'EMPLOYMENT' ORDER BY "at" DESC, id DESC LIMIT 1`,
        [s],
      );
      assert.deepEqual(echo?.ids, [anna.id], 'the kept fields handed back unsent are not in the läslogg');
      // The first share alone, above the post beside the stored lektor share: the table's CHECK, in Swedish.
      await assert.rejects(
        () => posts.upsert(anna.id, year.id, { employmentPercent: 80, firstTeacherPercent: 20 }, asAdmin),
        (error: { getStatus?: () => number; message?: string }) => {
          assert.equal(error.getStatus?.(), 400, String(error));
          assert.match(String(error.message), /tillsammans vara högst hela tjänsten/);
          return true;
        },
      );
      const cleared = await posts.upsert(anna.id, year.id, { employmentPercent: 80, lecturerPercent: null }, asAdmin);
      assert.deepEqual([cleared.employmentForm, cleared.firstTeacherPercent, cleared.lecturerPercent], ['TILLSVIDARE', 10, null]);
      await posts.upsert(bo.id, year.id, { employmentPercent: 100 }, asAdmin);
    });

    await check('(scb2, scb3) the file is SCB\'s text from the posts, and its download is in the läslogg', async () => {
      const before = Number((await one<{ n: string }>(`SELECT count(*)::text AS n FROM "PersonalDataAccess" WHERE "schoolId" = $1`, [s])).n);
      const file = await scb.build(year.id, asAdmin);
      assert.equal(file.matdatum, '2096-10-15');
      assert.equal(file.filename, 'scb-pedagogisk-personal-2096-97.txt');
      const lines = file.text.split('\r\n');
      assert.equal(lines.pop(), '');
      assert.equal(lines.length, 2);
      const at = (row: string[], name: string) => row[file.columns.indexOf(name as (typeof file.columns)[number])];
      const [boRow, annaRow] = file.rows;
      assert.deepEqual(
        ['PersonNamn', 'SkolenhetsKod', 'PersonNr', 'Verksamhetstyp', 'AnstForm', 'OmfLarare', 'ForsteLarare', 'Lektor', 'Undervisning', 'OmfMatematik'].map(
          (name) => at(annaRow!, name),
        ),
        ['Anna Öberg', '12345678', '', '6', 'T', '80', '10', '', 'J', '100'],
      );
      assert.equal(at(boRow!, 'AnstForm'), '');
      assert.deepEqual(file.missing, [{ line: 1, name: 'Bo Alm', unit: 'Probe F–9', verksamhetstyp: '6', fields: ['ANSTFORM'] }]);

      const rows = (
        await owner.query<{ kind: string; channel: string; actorId: string; subjectIds: string[] }>(
          `SELECT kind::text AS kind, channel::text AS channel, "actorId",
                  ARRAY(SELECT x::text FROM unnest("subjectIds") x ORDER BY x) AS "subjectIds"
             FROM "PersonalDataAccess" WHERE "schoolId" = $1 ORDER BY "at", id OFFSET $2`,
          [s, before],
        )
      ).rows;
      const named = [anna.id, bo.id].sort();
      assert.deepEqual(
        rows.map((row) => [row.kind, row.channel, row.actorId, row.subjectIds]),
        [
          ['EMPLOYMENT', 'WEB', admin.id, [bo.id]],
          ['PEOPLE', 'WEB', admin.id, named],
        ],
      );
    });

    await check('(scb4) a sick leave registered week by week is one long absence, named and in the läslogg', async () => {
      // Monday 24 September – Friday 26 October 2096: five weeks over the
      // mätdatum, each its own record, Monday 00:00 to Saturday 00:00.
      const mondays = ['2096-09-24', '2096-10-01', '2096-10-08', '2096-10-15', '2096-10-22'];
      for (const monday of mondays) {
        await owner.query(
          `INSERT INTO "TeacherAbsences" ("schoolId", "userId", "startsAt", "endsAt")
           VALUES ($1, $2, ($3::date)::timestamp AT TIME ZONE 'Europe/Stockholm',
                   ($3::date + 5)::timestamp AT TIME ZONE 'Europe/Stockholm')`,
          [s, bo.id, monday],
        );
      }
      const file = await scb.build(year.id, asAdmin);
      assert.deepEqual(
        file.notices.filter((notice) => notice.code === 'LONG_ABSENCE'),
        [{ code: 'LONG_ABSENCE', params: { name: 'Bo Alm', from: '2096-09-24', to: '2096-10-26' } }],
      );
      const read = await one<{ ids: string[] }>(
        `SELECT ARRAY(SELECT x::text FROM unnest("subjectIds") x) AS ids FROM "PersonalDataAccess"
          WHERE "schoolId" = $1 AND kind = 'STAFF_ABSENCES' ORDER BY "at" DESC, id DESC LIMIT 1`,
        [s],
      );
      assert.deepEqual(read?.ids, [bo.id], 'the long absence the file names is not in the läslogg');
    });
  } finally {
    await sweepScbSchool(owner, marker);
  }
}
