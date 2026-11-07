/**
 * Skolans dag's measurement: a school of 60 classes, 120 teachers and 80 rooms
 * for one week, through the real service on the API's role and real Postgres
 * (the requirement: a week in under a second in the API).
 *
 *   PROBE_OWNER_URL=postgresql://postgres:…@127.0.0.1:<port>/schemapro \
 *   DATABASE_URL=postgresql://app_authenticated:…@127.0.0.1:<port>/schemapro \
 *   npx ts-node --transpile-only scripts/bench/school-day.ts [rounds]
 *
 * The school is planted by the owner in a few statements (generate_series, not
 * a service per row), measured, and swept whole. Six lessons a day for every
 * class, one teacher on each and a second on every fourth, a room each with no
 * two lessons in one room at one time, a few hundred bookings, absences,
 * closures, an uppdrag-less pool and a lov in the week. Every round reads the
 * week as an administrator (everything: grids, absence, closures), as a
 * teacher with ALL (the marked staff masked) and the search for free teachers
 * and rooms; a round is the cold read of a fresh transaction, as a request is.
 * It prints the lowest, the median and the 95th percentile of the rounds, the
 * statements a read sends, and the answer's size raw and gzipped.
 *
 * Not a CI check: wall-clock numbers on a shared host measure the host.
 */
import { randomUUID } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { Client } from 'pg';
import { Role } from '../../src/auth/enums/role.enum';
import type { AuthenticatedUser } from '../../src/auth/interfaces/authenticated-user.interface';
import { PrismaService } from '../../src/database/prisma.service';
import { SchoolDayService } from '../../src/school-day/school-day.service';

const CLASSES = 60;
const TEACHERS = 120;
const ROOMS = 80;
const SLOTS = 6;
const SLUG = 'bench-skolans-dag';

const quantile = (values: number[], q: number) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]!;
};

async function main() {
  const rounds = Number(process.argv[2] ?? 15);
  const owner = new Client({ connectionString: process.env['PROBE_OWNER_URL'] });
  await owner.connect();
  const api = new PrismaService();
  await api.onModuleInit();
  const one = async <T extends object>(sql: string, params: unknown[] = []): Promise<T> => (await owner.query<T>(sql, params)).rows[0]!;
  await owner.query(`DELETE FROM "Schools" WHERE slug = $1`, [SLUG]);
  try {
    const s = (await one<{ id: string }>(`INSERT INTO "Schools" (name, slug, timezone, "updatedAt") VALUES ('Bench', $1, 'Europe/Stockholm', now()) RETURNING id`, [SLUG])).id;
    const monday = (await one<{ d: string }>(`SELECT (date_trunc('week', current_date) + interval '7 days')::date::text AS d`)).d;
    const year = (
      await one<{ id: string }>(
        `INSERT INTO "AcademicYears" ("schoolId", name, "startDate", "endDate", "isActive", "gradeNumbering", "updatedAt") VALUES ($1, 'bench', current_date - 30, current_date + 300, true, 'NIOARIG', now()) RETURNING id`,
        [s],
      )
    ).id;
    const subject = (await one<{ id: string }>(`INSERT INTO "Subjects" ("schoolId", name, code, "updatedAt") VALUES ($1, 'Matematik', 'BSMA', now()) RETURNING id`, [s])).id;
    await owner.query(
      `INSERT INTO "StudentGroups" ("schoolId", "academicYearId", name, kind, "gradeLevel", "updatedAt")
       SELECT $1, $2, 'K' || lpad(i::text, 2, '0'), 'CLASS', 1 + (i % 9), now() FROM generate_series(1, $3) i`,
      [s, year, CLASSES],
    );
    await owner.query(`INSERT INTO "Rooms" ("schoolId", name, "updatedAt") SELECT $1, 'Sal ' || lpad(i::text, 2, '0'), now() FROM generate_series(1, $2) i`, [s, ROOMS]);
    await owner.query(
      `INSERT INTO "Users" ("schoolId", email, "firstName", "lastName", role, "authId", "isActive", "updatedAt")
       SELECT $1, 'bench-t' || i || '@example.invalid', 'Lärare', 'Nr ' || lpad(i::text, 3, '0'), 'TEACHER', gen_random_uuid(), true, now() FROM generate_series(1, $2) i`,
      [s, TEACHERS],
    );
    await owner.query(`INSERT INTO "TeacherEmployments" ("schoolId", "userId", "academicYearId", "employmentPercent", "updatedAt") SELECT $1, id, $2, 100, now() FROM "Users" WHERE "schoolId" = $1 AND role = 'TEACHER'`, [s, year]);
    const adminAuth = randomUUID();
    const admin = (
      await one<{ id: string }>(
        `INSERT INTO "Users" ("schoolId", email, "firstName", "lastName", role, "adminProfile", "authId", "isActive", "updatedAt") VALUES ($1, 'bench-admin@example.invalid', 'Admin', 'Bench', 'SCHOOL_ADMIN', 'FULL', $2, true, now()) RETURNING id`,
        [s, adminAuth],
      )
    ).id;
    const teacherAuth = (await one<{ id: string; authId: string }>(`SELECT id, "authId" FROM "Users" WHERE "schoolId" = $1 AND role = 'TEACHER' ORDER BY email LIMIT 1`, [s]));
    await owner.query(`INSERT INTO "SchoolDaySettings" ("schoolId", "teacherView") VALUES ($1, 'ALL')`, [s]);

    // Lessons: class c, day d (0..4), slot t (1..6). One room each, distinct within a slot; one teacher each, distinct within a slot.
    await owner.query(
      `WITH classes AS (SELECT id, row_number() OVER (ORDER BY name) AS c FROM "StudentGroups" WHERE "schoolId" = $1),
            rooms AS (SELECT id, row_number() OVER (ORDER BY name) AS r FROM "Rooms" WHERE "schoolId" = $1),
            teachers AS (SELECT id, row_number() OVER (ORDER BY email) AS t FROM "Users" WHERE "schoolId" = $1 AND role = 'TEACHER'),
            slots AS (SELECT d, t, ($2::date + d) AS day, ($2::date + d + time '08:00' + (t - 1) * interval '65 minutes') AS starts FROM generate_series(0, 4) d, generate_series(1, $3) t)
       INSERT INTO "CalendarLessons" ("schoolId", "subjectId", "studentGroupId", "roomId", date, "startsAt", "endsAt", status, "updatedAt")
       SELECT $1, $4, classes.id, rooms.id, slots.day, slots.starts AT TIME ZONE 'Europe/Stockholm', (slots.starts + interval '45 minutes') AT TIME ZONE 'Europe/Stockholm', 'SCHEDULED', now()
         FROM classes JOIN slots ON true JOIN rooms ON rooms.r = ((classes.c + slots.d + slots.t) % $5) + 1`,
      [s, monday, SLOTS, subject, ROOMS],
    );
    await owner.query(
      `WITH numbered AS (SELECT cl.id, cl."studentGroupId", cl.date, cl."startsAt", row_number() OVER (PARTITION BY cl."startsAt" ORDER BY cl."studentGroupId") AS rn FROM "CalendarLessons" cl WHERE cl."schoolId" = $1),
            teachers AS (SELECT id, row_number() OVER (ORDER BY email) AS t FROM "Users" WHERE "schoolId" = $1 AND role = 'TEACHER')
       INSERT INTO "CalendarLessonTeachers" ("schoolId", "calendarLessonId", "teacherId", role)
       SELECT $1, numbered.id, teachers.id, 'LEAD' FROM numbered JOIN teachers ON teachers.t = ((numbered.rn - 1) % $2) + 1`,
      [s, TEACHERS],
    );
    // A second teacher on every fourth lesson, one a different from the lead.
    await owner.query(
      `INSERT INTO "CalendarLessonTeachers" ("schoolId", "calendarLessonId", "teacherId", role)
       SELECT $1, x.id, x.t2, 'ASSISTANT' FROM (
         SELECT cl.id, (SELECT u.id FROM "Users" u WHERE u."schoolId" = $1 AND u.role = 'TEACHER' AND u.id <> clt."teacherId" ORDER BY md5(u.id::text || cl.id::text) LIMIT 1) AS t2
           FROM "CalendarLessons" cl JOIN "CalendarLessonTeachers" clt ON clt."calendarLessonId" = cl.id
          WHERE cl."schoolId" = $1 AND (abs(hashtext(cl.id::text)) % 4) = 0) x`,
      [s],
    );
    // Bookings in the free slots after the day, absences, closures and a lov on Friday for the lower årskurser.
    await owner.query(
      `INSERT INTO "RoomBookings" ("schoolId", "roomId", "bookedById", title, "startsAt", "endsAt", status, "updatedAt")
       SELECT $1, r.id, $2, 'Möte', ($3::date + (i % 5) + time '15:00') AT TIME ZONE 'Europe/Stockholm', ($3::date + (i % 5) + time '16:00') AT TIME ZONE 'Europe/Stockholm', 'APPROVED', now()
         FROM generate_series(0, 79) i JOIN (SELECT id, row_number() OVER (ORDER BY name) AS n FROM "Rooms" WHERE "schoolId" = $1) r ON r.n = i + 1`,
      [s, admin, monday],
    );
    await owner.query(
      `INSERT INTO "TeacherAbsences" ("schoolId", "userId", "startsAt", "endsAt")
       SELECT $1, u.id, ($2::date + (n % 5)::int + time '08:00') AT TIME ZONE 'Europe/Stockholm', ($2::date + (n % 5)::int + time '17:00') AT TIME ZONE 'Europe/Stockholm'
         FROM (SELECT id, row_number() OVER (ORDER BY email) AS n FROM "Users" WHERE "schoolId" = $1 AND role = 'TEACHER') u WHERE u.n <= 12`,
      [s, monday],
    );
    await owner.query(
      `INSERT INTO "AvailabilityConstraints" ("schoolId", "resourceType", "userId", "dayOfWeek", "startTime", "endTime", type, "updatedAt")
       SELECT $1, 'TEACHER', u.id, 1 + (n % 5)::int, '12:00', '13:00', 'UNAVAILABLE', now()
         FROM (SELECT id, row_number() OVER (ORDER BY email DESC) AS n FROM "Users" WHERE "schoolId" = $1 AND role = 'TEACHER') u WHERE u.n <= 30`,
      [s],
    );
    await owner.query(
      `INSERT INTO "SchoolBreaks" ("schoolId", "academicYearId", name, kind, "startDate", "endDate", "minGradeLevel", "maxGradeLevel", "updatedAt") VALUES ($1, $2, 'Studiedag åk 1-3', 'STAFF_DAY', $3::date + 4, $3::date + 4, 1, 3, now())`,
      [s, year, monday],
    );
    const lessons = Number((await one<{ n: string }>(`SELECT count(*) AS n FROM "CalendarLessons" WHERE "schoolId" = $1`, [s])).n);
    console.log(`school: ${CLASSES} classes, ${TEACHERS} teachers, ${ROOMS} rooms, ${lessons} lessons in the week of ${monday}`);

    const day = new SchoolDayService(api);
    const asAdmin: AuthenticatedUser = { authId: adminAuth, role: Role.SCHOOL_ADMIN, userId: admin, schoolId: s, channel: 'WEB', adminProfile: 'FULL' as never, hrRead: false };
    const asTeacher: AuthenticatedUser = { authId: teacherAuth.authId, role: Role.TEACHER, userId: teacherAuth.id, schoolId: s, channel: 'WEB' };
    const friday = (await one<{ d: string }>(`SELECT ($1::date + 4)::text AS d`, [monday])).d;
    const measure = async (label: string, work: () => Promise<unknown>) => {
      await work();
      const times: number[] = [];
      let last: unknown;
      for (let i = 0; i < rounds; i += 1) {
        const started = performance.now();
        last = await work();
        times.push(performance.now() - started);
      }
      const json = JSON.stringify(last);
      console.log(
        `${label.padEnd(34)} min ${quantile(times, 0).toFixed(0).padStart(5)} ms   median ${quantile(times, 0.5).toFixed(0).padStart(5)} ms   p95 ${quantile(times, 0.95).toFixed(0).padStart(5)} ms   ${(json.length / 1024).toFixed(0).padStart(5)} kB raw  ${(gzipSync(json).length / 1024).toFixed(0).padStart(4)} kB gzip`,
      );
    };
    await measure('week, administrator', () => day.grid({ from: monday, to: friday }, asAdmin));
    const sunday = (await one<{ d: string }>(`SELECT ($1::date + 6)::text AS d`, [monday])).d;
    await measure('week with weekend, administrator', () => day.grid({ from: monday, to: sunday }, asAdmin));
    await measure('day, administrator', () => day.grid({ from: monday }, asAdmin));
    await measure('week, teacher ALL (marked masked)', () => day.grid({ from: monday, to: friday }, asTeacher));
    await measure('free: teachers and rooms, 1 interval', () => day.free({ date: monday, from: '10:00', to: '11:00' }, asAdmin));
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
