/**
 * Analys och planering's measurement: a school of 81 classes, 2 025 pupils and
 * 120 teachers, through the real services on the API's role and real Postgres
 * (the requirement: under two seconds a view).
 *
 *   PROBE_OWNER_URL=postgresql://postgres:…@127.0.0.1:<port>/schemapro \
 *   DATABASE_URL=postgresql://app_authenticated:…@127.0.0.1:<port>/schemapro \
 *   npx ts-node --transpile-only scripts/bench/analysis.ts [rounds]
 *
 * The school is planted by the owner in a few statements (generate_series, not a
 * service per row): nine årskurser of nine classes of 25, a mathematics group of
 * 12 pupils per class pair, twelve subjects, a timplanspost per class and
 * subject taught by a teacher in turn, behörigheter for nine in ten, the
 * grundschema (a master lesson per lesson of a post), and four weeks of held
 * lessons with a vikarie on every twentieth. Three skoldelar, rates for all three
 * categories. Every round is the cold read of a fresh transaction, as a request is.
 *
 * Prints the lowest, the median and the 95th percentile of the rounds, the CPU
 * time of the process per round (the host's load inflates wall-clock time and
 * CPU time alike, so the pure arithmetic is also timed alone, below), and the
 * size of each answer.
 *
 * Not a CI check: wall-clock numbers on a shared host measure the host.
 */
import { randomUUID } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { Client } from 'pg';
import { Role } from '../../src/auth/enums/role.enum';
import type { AuthenticatedUser } from '../../src/auth/interfaces/authenticated-user.interface';
import { CoverReportsService } from '../../src/cover/cover-reports.service';
import { PrismaService } from '../../src/database/prisma.service';
import { AnalysisService } from '../../src/analysis/analysis.service';
import { StaffingLoadService } from '../../src/staffing/staffing-load.service';

const CLASS_COUNT = 81;
const PUPILS_PER_CLASS = 25;
const TEACHERS = 120;
const SUBJECTS = 12;
const SLUG = 'bench-analys';

const quantile = (values: number[], q: number) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]!;
};

async function main() {
  const rounds = Number(process.argv[2] ?? 7);
  const owner = new Client({ connectionString: process.env['PROBE_OWNER_URL'] });
  await owner.connect();
  const api = new PrismaService();
  await api.onModuleInit();
  const one = async <T extends object>(sql: string, params: unknown[] = []): Promise<T> => (await owner.query<T>(sql, params)).rows[0]!;
  await owner.query(`DELETE FROM "Schools" WHERE slug = $1`, [SLUG]);
  try {
    const s = (await one<{ id: string }>(`INSERT INTO "Schools" (name, slug, timezone, "updatedAt") VALUES ('Bench', $1, 'Europe/Stockholm', now()) RETURNING id`, [SLUG])).id;
    const year = (
      await one<{ id: string }>(
        `INSERT INTO "AcademicYears" ("schoolId", name, "startDate", "endDate", "isActive", "gradeNumbering", "updatedAt")
         VALUES ($1, 'bench', (date_trunc('week', current_date) - interval '35 days')::date, current_date + 250, true, 'NIOARIG', now()) RETURNING id`,
        [s],
      )
    ).id;
    await owner.query(`INSERT INTO "StaffingPolicies" ("schoolId", "fullTimeTeachingMinutesPerWeek", "updatedAt") VALUES ($1, 1080, now())`, [s]);
    await owner.query(`INSERT INTO "Subjects" ("schoolId", name, code, "updatedAt") SELECT $1, 'Ämne ' || i, 'BS' || lpad(i::text, 2, '0'), now() FROM generate_series(1, $2) i`, [s, SUBJECTS]);
    await owner.query(
      `INSERT INTO "StudentGroups" ("schoolId", "academicYearId", name, kind, "gradeLevel", "updatedAt")
       SELECT $1, $2, 'K' || lpad(i::text, 2, '0'), 'CLASS', 1 + ((i - 1) % 9), now() FROM generate_series(1, $3) i`,
      [s, year, CLASS_COUNT],
    );
    await owner.query(
      `INSERT INTO "Users" ("schoolId", email, "firstName", "lastName", role, "authId", "isActive", "updatedAt")
       SELECT $1, 'bench-t' || i || '@example.invalid', 'Lärare', 'Nr ' || lpad(i::text, 3, '0'), 'TEACHER', gen_random_uuid(), true, now() FROM generate_series(1, $2) i`,
      [s, TEACHERS],
    );
    await owner.query(
      `INSERT INTO "Users" ("schoolId", email, "firstName", "lastName", role, "authId", "isActive", "studentGroupId", "updatedAt")
       SELECT $1, 'bench-p' || g.n || '-' || p || '@example.invalid', 'Elev', g.name || '-' || p, 'STUDENT', gen_random_uuid(), true, g.id, now()
         FROM (SELECT id, name, row_number() OVER (ORDER BY name) AS n FROM "StudentGroups" WHERE "schoolId" = $1) g, generate_series(1, $2) p`,
      [s, PUPILS_PER_CLASS],
    );
    await owner.query(
      `INSERT INTO "TeacherEmployments" ("schoolId", "userId", "academicYearId", "employmentPercent", signature, "updatedAt")
       SELECT $1, id, $2, 50 + (abs(hashtext(id::text)) % 6) * 10, 'T' || lpad((row_number() OVER (ORDER BY email))::text, 3, '0'), now() FROM "Users" WHERE "schoolId" = $1 AND role = 'TEACHER'`,
      [s, year],
    );
    await owner.query(
      `INSERT INTO "TeacherSubjectQualifications" ("schoolId", "userId", "subjectId", "minGradeLevel", "maxGradeLevel", kind, "updatedAt")
       SELECT $1, u.id, sub.id, 1, 9, 'LEGITIMATION', now()
         FROM "Users" u JOIN "Subjects" sub ON sub."schoolId" = $1
        WHERE u."schoolId" = $1 AND u.role = 'TEACHER' AND (abs(hashtext(u.id::text || sub.id::text)) % 10) <> 0`,
      [s],
    );
    // A timplanspost per class and subject: the teacher in turn, 2 lessons of 55 minutes.
    await owner.query(
      `WITH classes AS (SELECT id, row_number() OVER (ORDER BY name) AS c FROM "StudentGroups" WHERE "schoolId" = $1),
            subjects AS (SELECT id, row_number() OVER (ORDER BY name) AS n FROM "Subjects" WHERE "schoolId" = $1),
            teachers AS (SELECT id, row_number() OVER (ORDER BY email) AS t FROM "Users" WHERE "schoolId" = $1 AND role = 'TEACHER')
       INSERT INTO "TeachingRequirements" ("schoolId", "academicYearId", "subjectId", "studentGroupId", "teacherId", "lessonsPerWeek", "minutesPerLesson", "updatedAt")
       SELECT $1, $2, subjects.id, classes.id, teachers.id, 2, 55, now()
         FROM classes JOIN subjects ON true JOIN teachers ON teachers.t = ((classes.c * 7 + subjects.n * 11) % $3) + 1`,
      [s, year, TEACHERS],
    );
    // Parts of the school and the school's rates.
    await owner.query(`INSERT INTO "SchoolParts" ("schoolId", name, account, "gradeFrom", "gradeTo") VALUES ($1, 'Lågstadiet', '4010', 0, 3), ($1, 'Mellanstadiet', '4020', 4, 6), ($1, 'Högstadiet', '4030', 7, 9)`, [s]);
    await owner.query(`INSERT INTO "StaffCostRates" ("schoolId", category, "hourlyCost") VALUES ($1, 'TEACHER', 420), ($1, 'UNQUALIFIED_TEACHER', 330), ($1, 'SUBSTITUTE', 310)`, [s]);
    // The grundschema: a master lesson per lesson of a post, a teacher once per day and slot.
    await owner.query(
      `WITH posts AS (SELECT r.id, r."subjectId", r."studentGroupId", r."teacherId", row_number() OVER (ORDER BY r."studentGroupId", r."subjectId") AS n FROM "TeachingRequirements" r WHERE r."schoolId" = $1),
            two AS (SELECT p.*, l FROM posts p, generate_series(0, 1) l)
       INSERT INTO "MasterLessons" ("schoolId", "academicYearId", "subjectId", "studentGroupId", "teacherId", "dayOfWeek", "startTime", "endTime", "updatedAt")
       SELECT $1, $2, "subjectId", "studentGroupId", "teacherId", 1 + ((n + l * 2) % 5),
              time '08:00' + ((n / 5 + l * 3) % 7) * interval '65 minutes', time '08:00' + ((n / 5 + l * 3) % 7) * interval '65 minutes' + interval '55 minutes', now()
         FROM two`,
      [s, year],
    ).catch((error) => console.log('master lessons not planted:', String(error.message).slice(0, 120)));
    // Four weeks of held lessons, all but the last day: one lesson per class and slot, with the post's teacher, a vikarie on every twentieth.
    await owner.query(
      `WITH cls AS (SELECT id, row_number() OVER (ORDER BY name) AS c FROM "StudentGroups" WHERE "schoolId" = $1),
            sub AS (SELECT id, row_number() OVER (ORDER BY name) AS n FROM "Subjects" WHERE "schoolId" = $1),
            days AS (SELECT (date_trunc('week', current_date) - interval '28 days')::date + d AS day FROM generate_series(0, 24) d WHERE extract(isodow FROM (date_trunc('week', current_date) - interval '28 days')::date + d) < 6),
            slots AS (SELECT t FROM generate_series(1, 6) t)
       INSERT INTO "CalendarLessons" ("schoolId", "subjectId", "studentGroupId", date, "startsAt", "endsAt", status, "updatedAt")
       SELECT $1, sub.id, cls.id, days.day, (days.day + time '08:00' + (slots.t - 1) * interval '65 minutes') AT TIME ZONE 'Europe/Stockholm',
              (days.day + time '08:00' + (slots.t - 1) * interval '65 minutes' + interval '55 minutes') AT TIME ZONE 'Europe/Stockholm', 'COMPLETED', now()
         FROM cls JOIN slots ON true JOIN days ON true JOIN sub ON sub.n = ((cls.c + slots.t) % $2) + 1`,
      [s, SUBJECTS],
    );
    await owner.query(
      `INSERT INTO "CalendarLessonTeachers" ("schoolId", "calendarLessonId", "teacherId", role)
       SELECT $1, cl.id, r."teacherId", CASE WHEN (abs(hashtext(cl.id::text)) % 20) = 0 THEN 'SUBSTITUTE'::"LessonTeacherRole" ELSE 'LEAD'::"LessonTeacherRole" END
         FROM "CalendarLessons" cl JOIN "TeachingRequirements" r ON r."studentGroupId" = cl."studentGroupId" AND r."subjectId" = cl."subjectId" WHERE cl."schoolId" = $1`,
      [s],
    ).catch((error) => console.log('held lessons not planted with teachers:', String(error.message).slice(0, 160)));

    const counts = await one<{ pupils: string; reqs: string; masters: string; held: string }>(
      `SELECT (SELECT count(*) FROM "Users" WHERE "schoolId" = $1 AND role = 'STUDENT') AS pupils,
              (SELECT count(*) FROM "TeachingRequirements" WHERE "schoolId" = $1) AS reqs,
              (SELECT count(*) FROM "MasterLessons" WHERE "schoolId" = $1) AS masters,
              (SELECT count(*) FROM "CalendarLessons" WHERE "schoolId" = $1) AS held`,
      [s],
    );
    console.log(`school: ${CLASS_COUNT} classes, ${counts.pupils} pupils, ${TEACHERS} teachers, ${counts.reqs} timplansposter, ${counts.masters} master lessons, ${counts.held} held lessons`);

    const adminAuth = randomUUID();
    const admin = (
      await one<{ id: string }>(
        `INSERT INTO "Users" ("schoolId", email, "firstName", "lastName", role, "adminProfile", "authId", "isActive", "updatedAt") VALUES ($1, 'bench-admin@example.invalid', 'Admin', 'Bench', 'SCHOOL_ADMIN', 'FULL', $2, true, now()) RETURNING id`,
        [s, adminAuth],
      )
    ).id;
    const user: AuthenticatedUser = { authId: adminAuth, role: Role.SCHOOL_ADMIN, userId: admin, schoolId: s, channel: 'WEB', adminProfile: 'FULL' as never, hrRead: false };
    const staffing = new StaffingLoadService(api);
    const analysis = new AnalysisService(api, staffing, new CoverReportsService(api, { now: () => new Date() } as never));
    const dates = await one<{ from: string; to: string }>(`SELECT (date_trunc('week', current_date) - interval '28 days')::date::text AS "from", (date_trunc('week', current_date) - interval '1 day')::date::text AS "to"`);
    const measure = async (label: string, work: () => Promise<unknown>) => {
      await work();
      const times: number[] = [];
      const cpu: number[] = [];
      let last: unknown;
      for (let i = 0; i < rounds; i += 1) {
        const usage = process.cpuUsage();
        const started = performance.now();
        last = await work();
        times.push(performance.now() - started);
        const spent = process.cpuUsage(usage);
        cpu.push((spent.user + spent.system) / 1000);
      }
      const json = JSON.stringify(last);
      console.log(
        `${label.padEnd(30)} min ${quantile(times, 0).toFixed(0).padStart(5)} ms   median ${quantile(times, 0.5).toFixed(0).padStart(5)} ms   p95 ${quantile(times, 0.95).toFixed(0).padStart(5)} ms   cpu median ${quantile(cpu, 0.5).toFixed(0).padStart(5)} ms   ${(json.length / 1024).toFixed(0).padStart(5)} kB raw  ${(gzipSync(json).length / 1024).toFixed(0).padStart(4)} kB gzip`,
      );
    };
    await measure('key figures', () => analysis.keyFigures(year, user));
    await measure('cost basis', () => analysis.costBasis({ academicYearId: year }, user));
    await measure('payroll basis (4 weeks)', () => analysis.payrollBasis({ academicYearId: year, ...dates }, user));
    await measure('payroll file, CSV', () => analysis.payrollFile({ academicYearId: year, ...dates, format: 'CSV' }, user));
    await measure('payroll file, Excel', () => analysis.payrollFile({ academicYearId: year, ...dates, format: 'XLSX' }, user));
    // The reference: the load report alone, the part every view reads first.
    await measure('reference: load report', () => staffing.load(year, 'planned', user, { record: false, travel: false }));
  } finally {
    await owner.query(`DELETE FROM "Schools" WHERE slug = $1`, [SLUG]);
    await api.$disconnect();
    await owner.end();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
