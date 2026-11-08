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
 *         left, the gap included (the earlier leave is not kept).
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
}

void main().catch((error) => {
  console.error(error);
  process.exit(1);
});
