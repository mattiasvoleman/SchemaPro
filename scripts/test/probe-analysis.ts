/**
 * Analys och planering (K1, 20270130090000) against a real database, as the API role under RLS,
 * through the real AnalysisService, StaffingLoadService and CoverReportsService.
 *
 *   DATABASE_URL='postgresql://app_authenticated:app_authenticated_local@localhost:5432/schemapro?schema=public&connection_limit=2' \
 *   PROBE_OWNER_URL='postgresql://postgres:postgres_local@localhost:5432/schemapro' \
 *   npx ts-node --transpile-only scripts/test/probe-analysis.ts
 *
 * The jest specs hold the arithmetic with the database faked and the RLS sections 435-439 the
 * arms; this is what the löneunderlag makes of a person who has LEFT, through statement E, the
 * vikarie export and the stored uppdrag, on rows a school really has. In a school of its own
 * (<tag>-analys), removed whole before and after.
 *
 * A teacher, Anna, teaches 7A mathematics five lessons a week (08:00-09:00), has a stored
 * uppdrag of 60 minutes a week (ämnesansvar) and a rastvaktspass of 20 minutes each weekday. The
 * period is 2026-10-12 to 2026-10-23, ten school days. She is deactivated on 2026-10-15 at 12:00
 * (the school's time): the stamp is set by the owner with the dating trigger off for the one
 * statement, because the trigger stamps now(), and the lessons are in October.
 *
 *   (la)  active, the whole period: 600 minutes of teaching, 120 + 200 of uppdrag: the
 *         numbers the rows say, and no notice about anyone who left;
 *   (lb)  deactivated: the period she left in. Teaching is the four lessons over by the stamp
 *         (12-15 October, 240 minutes), not the ten the lessons still carrying her would give;
 *         the stored uppdrag stop the day before, with the rastvakt (3 days: 36 + 60), and the
 *         answer says so (ANALYSIS_LEFT_IN_PERIOD);
 *   (lc)  a lesson later the same day is not hers (14:00 on the 15th), one that was over is;
 *   (ld)  a period wholly after: nobody called Anna in the answer, no line, no tjänstgrad, and the
 *         notice; the file (CSV) has no row for her either;
 *   (le)  a period that ends before the stamp's day is what it always was;
 *   (lf)  a vikarie who left: the cover over by the stamp stands, the cover after it does not;
 *   (lg)  made active again: the trigger clears the stamp and she is booked as if she had never
 *         left, the gap included (the earlier leave is not kept);
 *   (lh)  Bo marked as having a protected identity (PersonProtections, by hand): the mark's
 *         trigger gives him a code (PayrollPseudonyms, 20270206091000). The answer says his
 *         signature, the mark and the code and no name; both files have his row by signature (BO)
 *         and every figure, name and e-mail empty, and SKYDDAD-<his number> in the last column,
 *         Löne-id; nothing of his name or address anywhere; Anna is named as before, with the
 *         Löne-id written on her post (20270206090000); protectedInFile is 1. Then his post gets a
 *         Löne-id and the code gives way to it. The mark is removed after, and the code with it.
 *   (li)  the mark and the code, from two connections at once (20270206091000): the register's
 *         mark set while an administrator's is removed, in both orders. The second waits for the
 *         first (the trigger locks the person's Users row), and the person ends marked WITH a
 *         code. Without the lock the insert keeps the code it finds, the delete cannot see the
 *         insert's mark and removes the code, and the person is marked with none, for good.
 *   (lj)  the versions' guard (20270206091000): outside gallring no version changes; in gallring
 *         a version's payroll number may be set to null, and nothing else of it may change.
 */
import { strict as assert } from 'node:assert';
import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { AnalysisService } from '../../src/analysis/analysis.service';
import type { PayrollBasisResponse } from '../../src/analysis/analysis.types';
import { Role } from '../../src/auth/enums/role.enum';
import type { AuthenticatedUser } from '../../src/auth/interfaces/authenticated-user.interface';
import { CoverReportsService } from '../../src/cover/cover-reports.service';
import { PrismaService } from '../../src/database/prisma.service';
import { readXlsx } from '../../src/schedule-exchange/xlsx';
import { StaffingLoadService } from '../../src/staffing/staffing-load.service';

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Set ${name}.`);
  return value;
}

let failures = 0;
async function check(label: string, body: () => Promise<void>): Promise<void> {
  try {
    await body();
    console.log(`ok   ${label}`);
  } catch (error) {
    failures += 1;
    console.error(`FAIL ${label}\n     ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
  }
}

const TZ = 'Europe/Stockholm';
const NOW = new Date('2026-11-08T10:00:00Z');
const DAYS = ['2026-10-12', '2026-10-13', '2026-10-14', '2026-10-15', '2026-10-16', '2026-10-19', '2026-10-20', '2026-10-21', '2026-10-22', '2026-10-23'];

async function main(): Promise<void> {
  const owner = new Client({ connectionString: requiredEnv('PROBE_OWNER_URL') });
  await owner.connect();
  const previous = process.env['DATABASE_URL'];
  const api = new PrismaService();
  process.env['DATABASE_URL'] = previous;
  const slug = `${randomUUID().slice(0, 8)}-analys`;

  const sweep = async () => {
    await owner.query(`DELETE FROM "Schools" WHERE slug LIKE '%-analys'`);
  };
  await sweep();
  try {
    await checks(owner, api, slug);
  } finally {
    await sweep().catch((error) => console.error('cleanup:', error));
    await owner.query(`ALTER TABLE "Users" ENABLE TRIGGER "Users_deactivation_is_dated_on_update"`).catch(() => undefined);
    await api.$disconnect();
    await owner.end();
  }
  if (failures > 0) {
    console.error(`\n${failures} check(s) failed.`);
    process.exit(1);
  }
  console.log('\nanalysis probe passed.');
}

async function checks(owner: Client, api: PrismaService, slug: string): Promise<void> {
  const one = async <T extends object>(sql: string, params: unknown[] = []): Promise<T> => (await owner.query(sql, params)).rows[0] as T;

  const s = (await one<{ id: string }>(`INSERT INTO "Schools" (name, slug, timezone, "updatedAt") VALUES ('Analys', $1, $2, now()) RETURNING id`, [slug, TZ])).id;
  const year = (
    await one<{ id: string }>(
      `INSERT INTO "AcademicYears" ("schoolId", name, "startDate", "endDate", "isActive", "gradeNumbering", "updatedAt")
       VALUES ($1, 'analys', '2026-08-17', '2027-06-11', true, 'NIOARIG', now()) RETURNING id`,
      [s],
    )
  ).id;
  await owner.query(`INSERT INTO "StaffingPolicies" ("schoolId", "fullTimeTeachingMinutesPerWeek", "updatedAt") VALUES ($1, 1080, now())`, [s]);
  const mat = (await one<{ id: string }>(`INSERT INTO "Subjects" ("schoolId", name, code, "updatedAt") VALUES ($1, 'Matematik', 'MA', now()) RETURNING id`, [s])).id;
  const c7 = (await one<{ id: string }>(`INSERT INTO "StudentGroups" ("schoolId", "academicYearId", name, kind, "gradeLevel", "updatedAt") VALUES ($1, $2, '7A', 'CLASS', 7, now()) RETURNING id`, [s, year])).id;
  const user = async (first: string, role: string, extra: { profile?: string } = {}) =>
    await one<{ id: string; authId: string }>(
      `INSERT INTO "Users" ("schoolId", email, "firstName", "lastName", role, "authId", "isActive", "adminProfile", "updatedAt")
       VALUES ($1, $2, $3, 'Analys', $4, $5, true, $6, now()) RETURNING id, "authId"`,
      [s, `${first.toLowerCase()}-${randomUUID().slice(0, 6)}@example.invalid`, first, role, randomUUID(), extra.profile ?? null],
    );
  const anna = await user('Anna', 'TEACHER');
  const bo = await user('Bo', 'TEACHER');
  const dan = await user('Dan', 'TEACHER');
  const admin = await user('Admin', 'SCHOOL_ADMIN', { profile: 'FULL' });
  for (const [teacher, signature] of [[anna, 'AN'], [bo, 'BO']] as const) {
    await owner.query(
      `INSERT INTO "TeacherEmployments" ("schoolId", "userId", "academicYearId", "employmentPercent", signature, "updatedAt") VALUES ($1, $2, $3, 100, $4, now())`,
      [s, teacher.id, year, signature],
    );
  }
  await owner.query(
    `INSERT INTO "TeachingRequirements" ("schoolId","academicYearId","subjectId","studentGroupId","teacherId","lessonsPerWeek","minutesPerLesson","updatedAt") VALUES ($1,$2,$3,$4,$5,5,60,now())`,
    [s, year, mat, c7, anna.id],
  );

  /** A lesson held in the school's time with `lead` (and `substitute`). */
  const lesson = async (day: string, from: string, to: string, lead: string, substitute: string | null = null): Promise<string> => {
    const id = (
      await one<{ id: string }>(
        `INSERT INTO "CalendarLessons" ("schoolId","subjectId","studentGroupId",date,"startsAt","endsAt",status,"updatedAt")
         VALUES ($1,$2,$3,$4::date,($4::date + $5::time) AT TIME ZONE $7,($4::date + $6::time) AT TIME ZONE $7,'COMPLETED',now()) RETURNING id`,
        [s, mat, c7, day, from, to, TZ],
      )
    ).id;
    await owner.query(`INSERT INTO "CalendarLessonTeachers" ("schoolId","calendarLessonId","teacherId",role) VALUES ($1,$2,$3,'LEAD')`, [s, id, lead]);
    if (substitute) await owner.query(`INSERT INTO "CalendarLessonTeachers" ("schoolId","calendarLessonId","teacherId",role) VALUES ($1,$2,$3,'SUBSTITUTE')`, [s, id, substitute]);
    return id;
  };
  for (const day of DAYS) await lesson(day, '08:00', '09:00', anna.id);
  // Her uppdrag: a stored one (ämnesansvar, 60 min a week, no end) and a rastvaktspass each weekday (20 min).
  await owner.query(
    `INSERT INTO "TeacherDuties" ("schoolId","userId","academicYearId",kind,label,"minutesPerWeek","countsAsTeaching","updatedAt") VALUES ($1,$2,$3,'AMNESANSVAR','Ämnesansvar',60,false,now())`,
    [s, anna.id, year],
  );
  const area = (await one<{ id: string }>(`INSERT INTO "SupervisionAreas" ("schoolId", name) VALUES ($1,'Gården') RETURNING id`, [s])).id;
  for (let d = 1; d <= 5; d += 1) {
    await owner.query(
      `INSERT INTO "SupervisionShifts" ("schoolId","academicYearId","areaId","userId","dayOfWeek","startTime","endTime") VALUES ($1,$2,$3,$4,$5,'09:00','09:20')`,
      [s, year, area, anna.id, d],
    );
  }
  await owner.query(`INSERT INTO "SchoolParts" ("schoolId", name, account, "gradeFrom", "gradeTo") VALUES ($1,'Högstadiet','4030',7,9)`, [s]);
  await owner.query(`INSERT INTO "StaffCostRates" ("schoolId", category, "hourlyCost") VALUES ($1,'TEACHER',400)`, [s]);

  const asAdmin: AuthenticatedUser = {
    authId: admin.authId,
    role: Role.SCHOOL_ADMIN,
    userId: admin.id,
    schoolId: s,
    channel: 'WEB',
    adminProfile: 'FULL' as never,
    hrRead: false,
  };
  const analysis = new AnalysisService(api, new StaffingLoadService(api), new CoverReportsService(api, { now: () => NOW } as never));
  analysis.now = () => NOW;

  const payroll = (from: string, to: string): Promise<PayrollBasisResponse> => analysis.payrollBasis({ academicYearId: year, from, to }, asAdmin);
  const totalsOf = (answer: PayrollBasisResponse, userId: string) => answer.people.find((person) => person.userId === userId);
  const codes = (answer: PayrollBasisResponse) => answer.notices.map((notice) => notice.code);
  const leave = async (userId: string, stamp: string) => {
    // The trigger stamps now(); the lessons are in October, so the stamp is set with the trigger off for this statement.
    await owner.query(`ALTER TABLE "Users" DISABLE TRIGGER "Users_deactivation_is_dated_on_update"`);
    try {
      await owner.query(`UPDATE "Users" SET "isActive" = false, "deactivatedAt" = ($2::timestamp AT TIME ZONE $3) WHERE id = $1`, [userId, stamp, TZ]);
    } finally {
      await owner.query(`ALTER TABLE "Users" ENABLE TRIGGER "Users_deactivation_is_dated_on_update"`);
    }
  };

  await check('(la) active: the rows say 600 minutes of teaching and 120 + 200 of uppdrag, and nobody has left', async () => {
    const answer = await payroll('2026-10-12', '2026-10-23');
    const anna_ = totalsOf(answer, anna.id)!;
    assert.deepEqual([anna_.teachingMinutes, anna_.dutyMinutes], [600, 320]);
    assert.ok(!codes(answer).includes('ANALYSIS_LEFT_IN_PERIOD'));
  });

  await leave(anna.id, '2026-10-15 12:00');
  assert.equal((await one<{ day: string }>(`SELECT to_char(("deactivatedAt" AT TIME ZONE $2)::date, 'YYYY-MM-DD') AS day FROM "Users" WHERE id = $1`, [anna.id, TZ])).day, '2026-10-15');

  await check('(lb) she left on the 15th at 12:00: the four lessons over by then, the uppdrag to the 14th, and the answer says so', async () => {
    const answer = await payroll('2026-10-12', '2026-10-23');
    const anna_ = totalsOf(answer, anna.id)!;
    // Teaching: 12, 13, 14 and 15 October at 08:00-09:00. Uppdrag: the ämnesansvar's 12 minutes a day on the 12th to the 14th, and the rastvakt's three passes.
    assert.deepEqual([anna_.teachingMinutes, anna_.dutyMinutes], [240, 36 + 60]);
    assert.deepEqual(answer.lines.filter((line) => line.userId === anna.id).map((line) => [line.teachingMinutes, line.dutyMinutes]), [[240, 96]]);
    const notice = answer.notices.find((n) => n.code === 'ANALYSIS_LEFT_IN_PERIOD');
    assert.deepEqual(notice?.params, { people: 1 });
  });

  await check('(lc) a lesson later the same day is not hers, one that was over is', async () => {
    await lesson('2026-10-15', '14:00', '15:00', anna.id);
    await lesson('2026-10-15', '10:00', '11:00', anna.id);
    const answer = await payroll('2026-10-12', '2026-10-23');
    // 08:00 and 10:00 on the 15th were over at 12:00, 14:00 was not: five lessons.
    assert.equal(totalsOf(answer, anna.id)!.teachingMinutes, 300);
  });

  await check('(ld) a period wholly after she left: she is not in the answer, and the answer says someone left', async () => {
    const answer = await payroll('2026-10-19', '2026-10-23');
    assert.equal(totalsOf(answer, anna.id), undefined, 'a person who left before the period is booked in it');
    assert.equal(answer.lines.filter((line) => line.userId === anna.id).length, 0);
    assert.deepEqual(answer.notices.find((n) => n.code === 'ANALYSIS_LEFT_IN_PERIOD')?.params, { people: 1 });
    const file = await analysis.payrollFile({ academicYearId: year, from: '2026-10-19', to: '2026-10-23', format: 'CSV' }, asAdmin);
    assert.ok(!Buffer.from(file.contentBase64, 'base64').toString('latin1').includes('Anna'), 'the file names her');
  });

  await check('(le) a period that ends before the day she left is what it always was', async () => {
    const answer = await payroll('2026-10-12', '2026-10-14');
    const anna_ = totalsOf(answer, anna.id)!;
    assert.deepEqual([anna_.teachingMinutes, anna_.dutyMinutes], [180, 96]);
    assert.ok(!codes(answer).includes('ANALYSIS_LEFT_IN_PERIOD'));
  });

  await check('(lf) a vikarie who left: the cover over by then stands, the cover after it does not', async () => {
    await lesson('2026-10-14', '10:00', '11:00', bo.id, dan.id);
    await lesson('2026-10-19', '10:00', '11:00', bo.id, dan.id);
    const before = await payroll('2026-10-12', '2026-10-23');
    assert.equal(totalsOf(before, dan.id)?.substituteMinutes, 120, 'both covers while he is active');
    await leave(dan.id, '2026-10-16 12:00');
    const after = await payroll('2026-10-12', '2026-10-23');
    assert.equal(totalsOf(after, dan.id)?.substituteMinutes, 60);
    assert.deepEqual(after.notices.find((n) => n.code === 'ANALYSIS_LEFT_IN_PERIOD')?.params, { people: 2 });
  });

  await check('(lg) made active again she is booked as if she had never left, the gap included', async () => {
    await owner.query(`UPDATE "Users" SET "isActive" = true WHERE id = $1`, [anna.id]);
    assert.equal((await one<{ gone: boolean }>(`SELECT "deactivatedAt" IS NOT NULL AS gone FROM "Users" WHERE id = $1`, [anna.id])).gone, false);
    const answer = await payroll('2026-10-12', '2026-10-23');
    const anna_ = totalsOf(answer, anna.id)!;
    // Ten mornings and the two lessons on the 15th: 720; ämnesansvar 120 and rastvakt 200.
    assert.deepEqual([anna_.teachingMinutes, anna_.dutyMinutes], [720, 320]);
    assert.deepEqual(answer.notices.find((n) => n.code === 'ANALYSIS_LEFT_IN_PERIOD')?.params, { people: 1 }, 'only Dan has left');
  });

  await check('(lh) a marked teacher is in the answer and both files by signature and code, with no name and no e-mail', async () => {
    await lesson('2026-10-20', '10:00', '11:00', bo.id);
    await owner.query(`UPDATE "TeacherEmployments" SET "payrollNumber" = '4711' WHERE "userId" = $1`, [anna.id]);
    await owner.query(`INSERT INTO "PersonProtections" ("userId", "schoolId", source) VALUES ($1, $2, 'MANUAL')`, [bo.id, s]);
    try {
      const email = (await one<{ email: string }>(`SELECT email FROM "Users" WHERE id = $1`, [bo.id])).email;
      const number = (await one<{ number: number }>(`SELECT number FROM "PayrollPseudonyms" WHERE "userId" = $1`, [bo.id])).number;
      const code = `SKYDDAD-${number}`;
      const answer = await payroll('2026-10-12', '2026-10-23');
      const bo_ = totalsOf(answer, bo.id)!;
      assert.deepEqual([bo_.signature, bo_.protectedIdentity, bo_.payrollNumber, bo_.pseudonym], ['BO', true, null, code]);
      assert.deepEqual([totalsOf(answer, anna.id)!.protectedIdentity, totalsOf(answer, anna.id)!.payrollNumber], [false, '4711']);
      assert.deepEqual([answer.protectedInAnswer, answer.protectedWithoutPayrollNumber], [1, 1]);
      assert.ok(!JSON.stringify(answer).includes(email), 'the answer names him');

      const request = { academicYearId: year, from: '2026-10-12', to: '2026-10-23' };
      const csv = await analysis.payrollFile({ ...request, format: 'CSV' }, asAdmin);
      const lines = new TextDecoder('windows-1252').decode(Buffer.from(csv.contentBase64, 'base64')).split('\r\n').filter(Boolean);
      assert.equal(lines[0]!.split(';').slice(0, 4).join(';') + ';' + lines[0]!.split(';').at(-1), 'Signatur;Efternamn;Förnamn;E-post;Löne-id');
      const row = lines.find((line) => line.startsWith('BO;'));
      assert.ok(row, 'his row is not in the CSV');
      assert.equal(row!.split(';').slice(0, 5).join(';'), 'BO;;;;Personal');
      assert.equal(row!.split(';')[8], String(bo_.teachingMinutes));
      assert.equal(row!.split(';').at(-1), code);
      assert.ok(!lines.join('\n').includes(email) && !lines.some((line) => line.split(';')[2] === 'Bo'), 'the CSV names him');
      const annaRow = lines.find((line) => line.startsWith('AN;Analys;Anna;anna-'));
      assert.ok(annaRow, 'Anna is not named as before');
      assert.equal(annaRow!.split(';').at(-1), '4711');
      assert.deepEqual([csv.protectedInFile, csv.protectedWithoutPayrollNumber], [1, 1]);

      const xlsx = await analysis.payrollFile({ ...request, format: 'XLSX' }, asAdmin);
      const sheet = readXlsx(Buffer.from(xlsx.contentBase64, 'base64')).rows;
      const boCells = sheet.find((cells) => cells[0] === 'BO')!;
      assert.deepEqual([...boCells.slice(0, 5), boCells.at(-1)], ['BO', '', '', '', 'Personal', code]);
      assert.ok(!JSON.stringify(sheet).includes(email) && !sheet.some((cells) => cells[2] === 'Bo'), 'the workbook names him');
      assert.deepEqual(sheet.find((cells) => cells[0] === 'AN')!.slice(1, 3), ['Analys', 'Anna']);
      assert.equal(xlsx.protectedInFile, 1);

      // A Löne-id on his post: the file books him on it, and the code is not written.
      await owner.query(`UPDATE "TeacherEmployments" SET "payrollNumber" = '8800' WHERE "userId" = $1`, [bo.id]);
      const later = await analysis.payrollFile({ ...request, format: 'CSV' }, asAdmin);
      const laterRow = new TextDecoder('windows-1252').decode(Buffer.from(later.contentBase64, 'base64')).split('\r\n').find((line) => line.startsWith('BO;'));
      assert.equal(laterRow!.split(';').at(-1), '8800');
      assert.deepEqual([later.protectedInFile, later.protectedWithoutPayrollNumber], [1, 0]);
    } finally {
      await owner.query(`DELETE FROM "PersonProtections" WHERE "userId" = $1`, [bo.id]);
      await owner.query(`UPDATE "TeacherEmployments" SET "payrollNumber" = NULL WHERE "userId" IN ($1, $2)`, [anna.id, bo.id]);
    }
    const left = await one<{ n: number }>(`SELECT count(*)::int AS n FROM "PayrollPseudonyms" WHERE "userId" = $1`, [bo.id]);
    assert.equal(left.n, 0, 'the code outlived the mark');
  });

  await check('(li) the register\'s mark and an administrator\'s removal at once, in either order, leave the person marked with a code', async () => {
    const rana = await user('Rana', 'TEACHER');
    const second = new Client({ connectionString: requiredEnv('PROBE_OWNER_URL') });
    await second.connect();
    const state = async () =>
      one<{ marks: string | null; code: number | null }>(
        `SELECT (SELECT string_agg(source::text, ',' ORDER BY source::text) FROM "PersonProtections" WHERE "userId" = $1) AS marks,
                (SELECT number FROM "PayrollPseudonyms" WHERE "userId" = $1) AS code`,
        [rana.id],
      );
    const mark = (client: Client, source: string) =>
      client.query(`INSERT INTO "PersonProtections" ("userId", "schoolId", source) VALUES ($1, $2, $3)`, [rana.id, s, source]);
    const unmark = (client: Client, source: string) => client.query(`DELETE FROM "PersonProtections" WHERE "userId" = $1 AND source = $2`, [rana.id, source]);
    /** Starts `later` while `first` holds its transaction open, and says whether `later` finished before `first` committed. */
    const race = async (first: () => Promise<unknown>, later: () => Promise<unknown>, a: Client, b: Client) => {
      await a.query('BEGIN');
      await first();
      await b.query('BEGIN');
      let done = false;
      const pending = later().then(() => (done = true));
      await new Promise((resolve) => setTimeout(resolve, 600));
      const finishedEarly = done;
      await a.query('COMMIT');
      await pending;
      await b.query('COMMIT');
      return finishedEarly;
    };
    try {
      await mark(owner, 'MANUAL');
      const before = (await state()).code;
      assert.ok(before, 'the mark gave no code');
      // The register's mark first (held open), the administrator's removal second.
      const early1 = await race(() => mark(owner, 'SS12000'), () => unmark(second, 'MANUAL'), owner, second);
      const after1 = await state();
      assert.deepEqual([after1.marks, after1.code], ['SS12000', before], 'insert, then delete: the person is marked with no code, or another');
      assert.equal(early1, false, 'the removal did not wait for the mark');

      // The removal first (held open), the register's mark second: the code goes and a new one comes.
      await mark(owner, 'MANUAL');
      const early2 = await race(() => unmark(owner, 'SS12000'), () => mark(second, 'SS12000'), owner, second);
      const after2 = await state();
      assert.equal(after2.marks, 'MANUAL,SS12000');
      assert.equal(after2.code, before, 'delete of one source, then insert: the code moved');
      assert.equal(early2, false, 'the mark did not wait for the removal');

      await unmark(owner, 'SS12000');
      const early3 = await race(() => unmark(owner, 'MANUAL'), () => mark(second, 'SS12000'), owner, second);
      const after3 = await state();
      assert.equal(after3.marks, 'SS12000');
      assert.ok(after3.code !== null && after3.code > before!, 'delete of the last mark, then a new one: no new code');
      assert.equal(early3, false, 'the new mark did not wait for the removal of the last');
    } finally {
      await second.query('ROLLBACK').catch(() => undefined);
      await owner.query('ROLLBACK').catch(() => undefined);
      await second.end();
      await owner.query(`DELETE FROM "PersonProtections" WHERE "userId" = $1`, [rana.id]);
    }
  });

  await check('(lj) outside gallring no version changes; in gallring a version loses its payroll number and nothing else', async () => {
    await owner.query(`UPDATE "TeacherEmployments" SET "payrollNumber" = '4711' WHERE "userId" = $1`, [anna.id]);
    const version = (
      await one<{ id: string }>(
        `SELECT id FROM "TeacherEmploymentLogs" WHERE "userId" = $1 AND entity = 'EMPLOYMENT' AND "after" ->> 'payrollNumber' = '4711' ORDER BY version DESC LIMIT 1`,
        [anna.id],
      )
    ).id;
    const refused = async (sql: string, gallring: boolean): Promise<string | null> => {
      await owner.query('BEGIN');
      try {
        if (gallring) await owner.query(`SELECT set_config('app.gallring', $1, true)`, [s]);
        await owner.query(sql, [version]);
        return null;
      } catch (error) {
        return (error as { code?: string }).code ?? 'error';
      } finally {
        await owner.query('ROLLBACK');
      }
    };
    const clear = `UPDATE "TeacherEmploymentLogs" SET "after" = jsonb_set("after", '{payrollNumber}', 'null'::jsonb) WHERE id = $1`;
    try {
      assert.equal(await refused(clear, false), 'TL403', 'a version changed outside gallring');
      assert.equal(await refused(clear, true), null, 'gallring may not clear the number');
      assert.equal(await refused(`UPDATE "TeacherEmploymentLogs" SET "after" = jsonb_set("after", '{signature}', '"XX"'::jsonb) WHERE id = $1`, true), 'TL403', 'gallring changed the signature of a version');
      assert.equal(await refused(`UPDATE "TeacherEmploymentLogs" SET "after" = jsonb_set("after", '{payrollNumber}', '"9999"'::jsonb) WHERE id = $1`, true), 'TL403', 'gallring wrote another number');
      assert.equal(await refused(`UPDATE "TeacherEmploymentLogs" SET "version" = "version" + 1000, "after" = jsonb_set("after", '{payrollNumber}', 'null'::jsonb) WHERE id = $1`, true), 'TL403', 'gallring changed a column beside the number');
    } finally {
      await owner.query(`UPDATE "TeacherEmployments" SET "payrollNumber" = NULL WHERE "userId" = $1`, [anna.id]);
    }
  });
}

void main().catch((error) => {
  console.error(error);
  process.exit(1);
});
