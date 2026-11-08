/**
 * Elevens lektion för dagen's measurement: a whole school's day still read
 * fast with moves (the requirement). Two schools of the same shape, planted by
 * the owner in a few statements, one with no moves and one where a tenth of
 * the pupils have been moved to a parallel lesson; the same reads on each,
 * alternating per round so host load moves both alike (the shared-Mac rule),
 * each read the cold read of a fresh transaction, as a request is.
 *
 *   PROBE_OWNER_URL=postgresql://postgres:…@127.0.0.1:<port>/schemapro \
 *   DATABASE_URL=postgresql://app_authenticated:…@127.0.0.1:<port>/schemapro \
 *   npx ts-node --transpile-only scripts/bench/lesson-moves.ts [rounds]
 *
 * THROWAWAY DATABASES ONLY, with the migration deployed.
 *
 * What is read, through the real services on the API's role:
 *   * the whole day's rosters, as the klassbok, the delivered time and the
 *     reporting rate read them (calendarLessonRosters over every lesson of the
 *     day, as an administrator): the price is one more statement for the day's
 *     moves, and the data it carries;
 *   * a lesson's register opening (AttendanceService.lessonRoster), as a teacher;
 *   * a guardian's week of a child (FamilyScheduleService.week);
 *   * a pupil's own read of the lessons they may see (the arms that read
 *     app.current_student_replaced_lesson_ids, which now also names the lessons
 *     a move took them from);
 *   * the calendar feed's function for fifty pupils' week.
 *
 * Not a CI check: wall-clock numbers on a shared host measure the host.
 */
import { randomUUID } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import { Client } from 'pg';
import { AttendanceService } from '../../src/attendance/attendance.service';
import { Role } from '../../src/auth/enums/role.enum';
import type { AuthenticatedUser } from '../../src/auth/interfaces/authenticated-user.interface';
import { calendarLessonRosters } from '../../src/calendar/lesson-roster';
import { PrismaService } from '../../src/database/prisma.service';
import { FamilyScheduleService } from '../../src/family/family-schedule.service';
import type { NotificationsService } from '../../src/notifications/notifications.service';

const CLASSES = 60;
const PUPILS = 25;
const SLOTS = 6;
const MOVED_SHARE = 10; // every tenth pupil
const SLUGS = ['bench-flytt-a', 'bench-flytt-b'] as const;

const quantile = (values: number[], q: number) => [...values].sort((a, b) => a - b)[Math.min(values.length - 1, Math.floor(q * values.length))]!;

interface Planted {
  school: string;
  monday: string;
  admin: AuthenticatedUser;
  teacher: AuthenticatedUser;
  pupil: AuthenticatedUser;
  guardian: AuthenticatedUser;
  lessons: string[];
  teacherLesson: string;
  fiftyPupils: string[];
  moves: number;
}

async function main() {
  const rounds = Number(process.argv[2] ?? 21);
  const owner = new Client({ connectionString: process.env['PROBE_OWNER_URL'] });
  await owner.connect();
  const api = new PrismaService();
  await api.onModuleInit();
  const one = async <T extends object>(sql: string, params: unknown[] = []): Promise<T> => (await owner.query<T>(sql, params)).rows[0]!;
  for (const slug of SLUGS) await owner.query(`DELETE FROM "Schools" WHERE slug = $1`, [slug]);
  try {
    const plant = async (slug: string, withMoves: boolean): Promise<Planted> => {
      const s = (await one<{ id: string }>(`INSERT INTO "Schools" (name, slug, timezone, "updatedAt") VALUES ($1, $1, 'Europe/Stockholm', now()) RETURNING id`, [slug])).id;
      const monday = (await one<{ d: string }>(`SELECT (date_trunc('week', current_date) + interval '7 days')::date::text AS d`)).d;
      const year = (
        await one<{ id: string }>(
          `INSERT INTO "AcademicYears" ("schoolId", name, "startDate", "endDate", "isActive", "gradeNumbering", "updatedAt") VALUES ($1, 'bench', current_date - 30, current_date + 300, true, 'NIOARIG', now()) RETURNING id`,
          [s],
        )
      ).id;
      const subject = (await one<{ id: string }>(`INSERT INTO "Subjects" ("schoolId", name, code, "updatedAt") VALUES ($1, 'Matematik', 'BFMA', now()) RETURNING id`, [s])).id;
      await owner.query(
        `INSERT INTO "StudentGroups" ("schoolId", "academicYearId", name, kind, "gradeLevel", "updatedAt")
         SELECT $1, $2, 'K' || lpad(i::text, 2, '0'), 'CLASS', 1 + (i % 9), now() FROM generate_series(1, $3) i`,
        [s, year, CLASSES],
      );
      await owner.query(
        `INSERT INTO "Users" ("schoolId", email, "firstName", "lastName", role, "authId", "isActive", "studentGroupId", "updatedAt")
         SELECT $1, 'p' || c.n || '-' || i || '@' || $3 || '.invalid', 'Elev', 'Nr ' || lpad(c.n::text, 2, '0') || lpad(i::text, 2, '0'), 'STUDENT', gen_random_uuid(), true, c.id, now()
           FROM (SELECT id, row_number() OVER (ORDER BY name) AS n FROM "StudentGroups" WHERE "schoolId" = $1) c, generate_series(1, $2) i`,
        [s, PUPILS, slug],
      );
      await owner.query(
        `INSERT INTO "Users" ("schoolId", email, "firstName", "lastName", role, "authId", "isActive", "updatedAt")
         SELECT $1, 't' || i || '@' || $3 || '.invalid', 'Lärare', 'Nr ' || lpad(i::text, 3, '0'), 'TEACHER', gen_random_uuid(), true, now() FROM generate_series(1, $2) i`,
        [s, 120, slug],
      );
      const adminAuth = randomUUID();
      const admin = (
        await one<{ id: string }>(
          `INSERT INTO "Users" ("schoolId", email, "firstName", "lastName", role, "adminProfile", "authId", "isActive", "updatedAt") VALUES ($1, 'admin@' || $3 || '.invalid', 'Admin', 'Bench', 'SCHOOL_ADMIN', 'FULL', $2, true, now()) RETURNING id`,
          [s, adminAuth, slug],
        )
      ).id;
      // Lessons: class c, slot t (1..6), the day's Monday. Every class has its lesson in every slot, so any two classes' lessons of a slot are parallel.
      await owner.query(
        `WITH classes AS (SELECT id, row_number() OVER (ORDER BY name) AS c FROM "StudentGroups" WHERE "schoolId" = $1),
              slots AS (SELECT t, ($2::date + time '08:00' + (t - 1) * interval '65 minutes') AS starts FROM generate_series(1, $3) t)
         INSERT INTO "CalendarLessons" ("schoolId", "subjectId", "studentGroupId", date, "startsAt", "endsAt", status, "updatedAt")
         SELECT $1, $4, classes.id, $2::date, slots.starts AT TIME ZONE 'Europe/Stockholm', (slots.starts + interval '45 minutes') AT TIME ZONE 'Europe/Stockholm', 'SCHEDULED', now()
           FROM classes JOIN slots ON true`,
        [s, monday, SLOTS, subject],
      );
      await owner.query(
        `WITH numbered AS (SELECT cl.id, row_number() OVER (PARTITION BY cl."startsAt" ORDER BY cl."studentGroupId") AS rn FROM "CalendarLessons" cl WHERE cl."schoolId" = $1),
              teachers AS (SELECT id, row_number() OVER (ORDER BY email) AS t FROM "Users" WHERE "schoolId" = $1 AND role = 'TEACHER')
         INSERT INTO "CalendarLessonTeachers" ("schoolId", "calendarLessonId", "teacherId", role)
         SELECT $1, numbered.id, teachers.id, 'LEAD' FROM numbered JOIN teachers ON teachers.t = ((numbered.rn - 1) % 120) + 1`,
        [s],
      );
      let moves = 0;
      if (withMoves) {
        // Every tenth pupil of every class goes to the next class's lesson of the first slot, through the table as the door would write it.
        const inserted = await owner.query(
          `WITH classes AS (SELECT id, row_number() OVER (ORDER BY name) AS c FROM "StudentGroups" WHERE "schoolId" = $1),
                pupils AS (SELECT u.id, u."studentGroupId" AS g, row_number() OVER (PARTITION BY u."studentGroupId" ORDER BY u.email) AS n FROM "Users" u WHERE u."schoolId" = $1 AND u.role = 'STUDENT'),
                first AS (SELECT cl.id, cl."studentGroupId" AS g FROM "CalendarLessons" cl WHERE cl."schoolId" = $1 AND cl."startsAt" = (SELECT min("startsAt") FROM "CalendarLessons" WHERE "schoolId" = $1)),
                pairs AS (
                  SELECT p.id AS pupil, src.id AS from_id, dst.id AS to_id
                    FROM pupils p
                    JOIN classes c ON c.id = p.g
                    JOIN first src ON src.g = p.g
                    JOIN classes c2 ON c2.c = (c.c % $2) + 1
                    JOIN first dst ON dst.g = c2.id
                   WHERE p.n % $3 = 0),
                made AS (
                  INSERT INTO "LessonPupilMoves" ("schoolId", "studentId", "fromLessonId", "toLessonId")
                  SELECT $1, pupil, from_id, to_id FROM pairs RETURNING id, "studentId", "toLessonId")
           INSERT INTO "CalendarLessonStudents" ("schoolId", "calendarLessonId", "studentId", "moveId")
           SELECT $1, "toLessonId", "studentId", id FROM made`,
          [s, CLASSES, MOVED_SHARE],
        );
        moves = inserted.rowCount ?? 0;
      }
      const pupilRow = await one<{ id: string; authId: string }>(
        `SELECT id, "authId" FROM "Users" WHERE "schoolId" = $1 AND role = 'STUDENT' ORDER BY email LIMIT 1 OFFSET ${MOVED_SHARE - 1}`,
        [s],
      );
      const guardianAuth = randomUUID();
      const guardian = (
        await one<{ id: string }>(
          `INSERT INTO "Users" ("schoolId", email, "firstName", "lastName", role, "authId", "isActive", "updatedAt") VALUES ($1, 'g@' || $3 || '.invalid', 'Vård', 'Nadshavare', 'GUARDIAN', $2, true, now()) RETURNING id`,
          [s, guardianAuth, slug],
        )
      ).id;
      await owner.query(`INSERT INTO "GuardianStudents" ("schoolId", "guardianId", "studentId") VALUES ($1, $2, $3)`, [s, guardian, pupilRow.id]);
      const teacherRow = await one<{ id: string; authId: string }>(`SELECT id, "authId" FROM "Users" WHERE "schoolId" = $1 AND role = 'TEACHER' ORDER BY email LIMIT 1`, [s]);
      const teacherLesson = (await one<{ id: string }>(`SELECT "calendarLessonId" AS id FROM "CalendarLessonTeachers" WHERE "teacherId" = $1 ORDER BY "calendarLessonId" LIMIT 1`, [teacherRow.id])).id;
      const lessons = (await owner.query<{ id: string }>(`SELECT id FROM "CalendarLessons" WHERE "schoolId" = $1`, [s])).rows.map((row) => row.id);
      const fiftyPupils = (await owner.query<{ id: string }>(`SELECT id FROM "Users" WHERE "schoolId" = $1 AND role = 'STUDENT' ORDER BY email LIMIT 50 OFFSET 5`, [s])).rows.map((row) => row.id);
      const user = (role: Role, id: string, authId: string, extra: object = {}): AuthenticatedUser => ({ authId, role, userId: id, schoolId: s, channel: 'WEB', ...extra });
      return {
        school: s,
        monday,
        admin: user(Role.SCHOOL_ADMIN, admin, adminAuth, { adminProfile: 'FULL', hrRead: false }),
        teacher: user(Role.TEACHER, teacherRow.id, teacherRow.authId),
        pupil: user(Role.STUDENT, pupilRow.id, pupilRow.authId),
        guardian: user(Role.GUARDIAN, guardian, guardianAuth),
        lessons,
        teacherLesson,
        fiftyPupils,
        moves,
      };
    };

    const plain = await plant(SLUGS[0], false);
    const moved = await plant(SLUGS[1], true);
    console.log(`two schools: ${CLASSES} classes of ${PUPILS} pupils, ${SLOTS} lessons each on ${plain.monday}; the second has ${moved.moves} pupils moved to a parallel lesson`);

    const attendance = new AttendanceService(api, {} as NotificationsService);
    const family = new FamilyScheduleService(api);
    const reads: Array<[string, (p: Planted) => Promise<unknown>]> = [
      [
        'the day’s rosters (admin)',
        (p) =>
          api.withRls(p.admin, async (tx) => {
            const rows = await (tx as unknown as PrismaClient).calendarLesson.findMany({
              where: { schoolId: p.school },
              select: { id: true, studentGroupId: true, subjectId: true, date: true, startsAt: true, endsAt: true, status: true, cancelCause: true, extraGroups: { select: { studentGroupId: true } } },
            });
            return calendarLessonRosters(tx as unknown as PrismaClient, rows as never, { pupils: 'ACTIVE' });
          }),
      ],
      ['a register opens (teacher)', (p) => attendance.lessonRoster(p.teacherLesson, p.teacher)],
      ['a child’s week (guardian)', (p) => family.week({ studentId: p.pupil.userId!, week: p.monday }, p.guardian)],
      [
        'a pupil’s own lessons',
        (p) => api.withRls(p.pupil, (tx) => (tx as unknown as PrismaClient).calendarLesson.findMany({ select: { id: true }, take: 500 })),
      ],
      [
        'the feed for 50 pupils',
        async (p) => {
          for (const id of p.fiftyPupils) {
            await owner.query(`SELECT app.calendar_feed_pupil_lessons($1::uuid, $2::uuid, $3::date, $3::date + 6, 'Europe/Stockholm', 'NONE'::"TeacherDisplay")`, [p.school, id, p.monday]);
          }
        },
      ],
    ];

    console.log(`${'read'.padEnd(30)} ${'no moves'.padStart(12)} ${'with moves'.padStart(12)}   median of the ${rounds} pairs' ratio (a pair is two adjacent reads, so host load moves both)`);
    for (const [label, read] of reads) {
      await read(plain);
      await read(moved);
      const a: number[] = [];
      const b: number[] = [];
      for (let i = 0; i < rounds; i += 1) {
        const order = i % 2 === 0 ? [plain, moved] : [moved, plain];
        const pair: Array<[Planted, number]> = [];
        for (const p of order) {
          const started = performance.now();
          try {
            await read(p);
          } catch (error) {
            // A transaction that runs out of its 15 s on a host this loaded is the host's: the pair is dropped.
            console.log(`  (a round dropped: ${error instanceof Error ? error.message.split('\n')[0] : String(error)})`);
            break;
          }
          pair.push([p, performance.now() - started]);
        }
        if (pair.length === 2) for (const [p, ms] of pair) (p === plain ? a : b).push(ms);
      }
      const ma = quantile(a, 0.5);
      const mb = quantile(b, 0.5);
      const ratio = quantile(
        a.map((x, i) => b[i]! / x),
        0.5,
      );
      console.log(`${label.padEnd(30)} ${ma.toFixed(1).padStart(12)} ${mb.toFixed(1).padStart(12)}   ${((ratio - 1) * 100).toFixed(0).padStart(5)} %`);
    }

    // What the database spends on the statements the feature adds, from the planner and not from the clock of a loaded host:
    // execution time of each (the best of ${rounds} runs), with and without moves.
    const executionMs = async (p: Planted, sql: string, params: unknown[]): Promise<number> => {
      let best = Infinity;
      for (let i = 0; i < rounds; i += 1) {
        const plan = await owner.query<{ 'QUERY PLAN': string }>(`EXPLAIN (ANALYZE, BUFFERS, TIMING OFF, FORMAT TEXT) ${sql}`, params);
        const line = plan.rows.map((row) => row['QUERY PLAN']).find((text) => text.startsWith('Execution Time'));
        best = Math.min(best, Number(/([\d.]+) ms/.exec(line ?? '')![1]));
      }
      void p;
      return best;
    };
    const statements: Array<[string, string, (p: Planted) => unknown[]]> = [
      ['the day’s moves (admin read)', `SELECT "fromLessonId", "studentId" FROM "LessonPupilMoves" WHERE "fromLessonId" = ANY($1::uuid[])`, (p) => [p.lessons]],
      ['one pupil’s departures', `SELECT "fromLessonId" FROM "LessonPupilMoves" WHERE "studentId" = $1::uuid AND "schoolId" = $2::uuid`, (p) => [p.pupil.userId, p.school]],
    ];
    console.log('');
    console.log(`${'statement (owner, best of ' + rounds + ')'.padEnd(30)} ${'no moves'.padStart(12)} ${'with moves'.padStart(12)}   execution time, ms`);
    for (const [label, sql, params] of statements) {
      console.log(`${label.padEnd(30)} ${(await executionMs(plain, sql, params(plain))).toFixed(3).padStart(12)} ${(await executionMs(moved, sql, params(moved))).toFixed(3).padStart(12)}`);
    }
  } finally {
    for (const slug of SLUGS) await owner.query(`DELETE FROM "Schools" WHERE slug = $1`, [slug]);
    await api.$disconnect();
    await owner.end();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
