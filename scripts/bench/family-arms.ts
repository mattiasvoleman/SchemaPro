/**
 * The guardian arms of 20261013090000, measured where they cost: the staff
 * reads of the calendar they are ORed into.
 *
 *   BENCH_OWNER_URL='postgresql://postgres:postgres_local@localhost:5732/schemapro' \
 *     npx ts-node --transpile-only scripts/bench/family-arms.ts [a|b]
 *
 * THROWAWAY DATABASES ONLY. It seeds timplan-delivered's school of the given
 * scale (bench-timplan-<scale>, a full published year), measures, and deletes
 * the school again.
 *
 * Paired A/B on one connection, alternating per round so host load moves both
 * alike (the shared-Mac rule): each round opens a transaction as the owner,
 * drops the deployed arms and creates, for A, the arms as they were before
 * the migration (the old teaching-group arm, no arm on CalendarLessonGroups
 * or CalendarLessonStudents, the old meal arms) and, for B, the migration's
 * own (the same DDL on both sides, so neither pays for catalog invalidation
 * the other does not), then SET LOCAL ROLE
 * app_authenticated with the reader's claims and EXPLAIN (ANALYZE) the read;
 * B is the migration as deployed. Rolled back either way. The verdict is the
 * median execution time of each side, against a 5 % budget:
 *
 *   * a teacher's week read: useTeacherLessons (CalendarLessonTeachers of the
 *     teacher, !inner CalendarLessons of the week);
 *   * an admin's school week: useCalendarLessons (every CalendarLessons row of
 *     the week) and the same week's CalendarLessonGroups.
 *
 * A guardian's read of their child's week is printed beside it, B only.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Client } from 'pg';
import { SCALES, seed } from './timplan-delivered';

const ROUNDS = Number(process.env.BENCH_ROUNDS ?? 61);
const WEEK = { from: '2026-10-12', to: '2026-10-18' };

// Both sides drop the deployed arms and create a set in the same transaction,
// so catalog invalidation and DDL cost the same on A and B.
const DROP_ARMS = `
  DROP POLICY "calendar_lessons_guardian_select" ON "CalendarLessons";
  DROP POLICY "calendar_lesson_groups_guardian_select" ON "CalendarLessonGroups";
  DROP POLICY "calendar_lesson_students_guardian_select" ON "CalendarLessonStudents";
  DROP POLICY "calendar_lunches_guardian_select" ON "CalendarLunches";
  DROP POLICY "calendar_rasts_guardian_select" ON "CalendarRasts";
`;

// As 20261013090000 creates them: the migration's own arm block, read from
// the file, so the bench cannot drift from what is deployed. Its DROP POLICY
// IF EXISTS lines find nothing once DROP_ARMS has run.
const MIGRATION = readFileSync(
  join(__dirname, '../../prisma/migrations/20261013090000_en_vardnadshavare_ser_sina_barns_schema/migration.sql'),
  'utf8',
);
const NEW_ARMS = MIGRATION.slice(
  MIGRATION.indexOf('-- The arms.'),
  MIGRATION.indexOf('-- What a family is told about a lesson'),
);

const OLD_ARMS = `
  CREATE POLICY "calendar_lessons_guardian_teaching_group_select" ON "CalendarLessons" FOR SELECT TO "authenticated"
    USING ("schoolId" = (select app.current_school_id()) AND "studentGroupId" IN (
      SELECT sgm."studentGroupId" FROM "StudentGroupMembers" sgm JOIN "GuardianStudents" gs ON gs."studentId" = sgm."studentId"
       WHERE gs."guardianId" = (select app.current_user_id()) AND gs."schoolId" = (select app.current_school_id())));
  CREATE POLICY "calendar_lunches_guardian_select" ON "CalendarLunches" FOR SELECT TO "authenticated"
    USING ("schoolId" = (select app.current_school_id()) AND "studentGroupId" IN (
      SELECT u."studentGroupId" FROM "Users" u JOIN "GuardianStudents" gs ON gs."studentId" = u."id"
       WHERE gs."guardianId" = (select app.current_user_id()) AND gs."schoolId" = (select app.current_school_id())
         AND u."studentGroupId" IS NOT NULL));
  CREATE POLICY "calendar_rasts_guardian_select" ON "CalendarRasts" FOR SELECT TO "authenticated"
    USING ("schoolId" = (select app.current_school_id()) AND "studentGroupId" IN (
      SELECT u."studentGroupId" FROM "Users" u JOIN "GuardianStudents" gs ON gs."studentId" = u."id"
       WHERE gs."guardianId" = (select app.current_user_id()) AND gs."schoolId" = (select app.current_school_id())
         AND u."studentGroupId" IS NOT NULL));
`;

interface Read {
  name: string;
  sub: () => string;
  sql: string;
  params: () => unknown[];
}

async function explainMs(owner: Client, old: boolean, read: Read): Promise<number> {
  await owner.query('BEGIN');
  try {
    await owner.query(DROP_ARMS);
    await owner.query(old ? OLD_ARMS : NEW_ARMS);
    await owner.query('SET LOCAL ROLE app_authenticated');
    await owner.query(`SELECT set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ sub: read.sub(), role: 'authenticated' })]);
    const result = await owner.query<{ 'QUERY PLAN': Array<{ 'Execution Time': number }> }>(
      `EXPLAIN (ANALYZE, FORMAT JSON) ${read.sql}`,
      read.params(),
    );
    return result.rows[0]!['QUERY PLAN'][0]!['Execution Time'];
  } finally {
    await owner.query('ROLLBACK');
  }
}

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)]!;
};

async function main(): Promise<void> {
  const scale = SCALES[(process.argv[2] ?? 'a') as 'a' | 'b'];
  const owner = new Client({ connectionString: process.env.BENCH_OWNER_URL });
  await owner.connect();
  const world = await seed(owner, scale);
  try {
    const teacherId = (await owner.query<{ id: string }>(`SELECT id FROM "Users" WHERE "authId" = $1`, [world.teacher])).rows[0]!.id;
    // A guardian of one pupil of the class, for the informative B-only read.
    const pupil = (
      await owner.query<{ id: string }>(`SELECT id FROM "Users" WHERE "studentGroupId" = $1 AND role = 'STUDENT' ORDER BY id LIMIT 1`, [
        world.classId,
      ])
    ).rows[0]!.id;
    const guardian = (
      await owner.query<{ authId: string; id: string }>(
        `INSERT INTO "Users" ("schoolId", email, "firstName", "lastName", role, "authId", "isActive", "updatedAt")
         VALUES ($1, 'bench-guardian@example.invalid', 'Bench', 'Guardian', 'GUARDIAN', gen_random_uuid(), true, now())
         RETURNING "authId", id`,
        [world.schoolId],
      )
    ).rows[0]!;
    await owner.query(`INSERT INTO "GuardianStudents" ("schoolId", "guardianId", "studentId") VALUES ($1, $2, $3)`, [
      world.schoolId,
      guardian.id,
      pupil,
    ]);
    const lessonsThisWeek = (
      await owner.query<{ n: string }>(`SELECT count(*) AS n FROM "CalendarLessons" WHERE "schoolId" = $1 AND date BETWEEN $2 AND $3`, [
        world.schoolId,
        WEEK.from,
        WEEK.to,
      ])
    ).rows[0]!.n;

    const reads: Read[] = [
      {
        name: 'teacher week (useTeacherLessons)',
        sub: () => world.teacher,
        sql: `SELECT t.role, l.id, l."subjectId", l."studentGroupId", l."roomId", l.date, l."startsAt", l."endsAt", l.status, l.note
                FROM "CalendarLessonTeachers" t JOIN "CalendarLessons" l ON l.id = t."calendarLessonId"
               WHERE t."teacherId" = $1 AND l.date BETWEEN $2 AND $3`,
        params: () => [teacherId, WEEK.from, WEEK.to],
      },
      {
        name: 'admin school week (useCalendarLessons)',
        sub: () => world.admin,
        sql: `SELECT id, "subjectId", "studentGroupId", "roomId", date, "startsAt", "endsAt", status, note
                FROM "CalendarLessons" WHERE date BETWEEN $1 AND $2 ORDER BY "startsAt"`,
        params: () => [WEEK.from, WEEK.to],
      },
      {
        name: 'admin school week extra groups',
        sub: () => world.admin,
        sql: `SELECT x.* FROM "CalendarLessonGroups" x JOIN "CalendarLessons" l ON l.id = x."calendarLessonId"
               WHERE l.date BETWEEN $1 AND $2`,
        params: () => [WEEK.from, WEEK.to],
      },
    ];

    console.log(`scale ${scale.name}: ${lessonsThisWeek} lessons in ${WEEK.from}..${WEEK.to}, ${ROUNDS} paired rounds`);
    let worst = 0;
    for (const read of reads) {
      // Warm both sides first.
      await explainMs(owner, true, read);
      await explainMs(owner, false, read);
      const a: number[] = [];
      const b: number[] = [];
      for (let i = 0; i < ROUNDS; i++) {
        // Alternate which side goes first, so neither always reads a warmer cache.
        if (i % 2 === 0) {
          a.push(await explainMs(owner, true, read));
          b.push(await explainMs(owner, false, read));
        } else {
          b.push(await explainMs(owner, false, read));
          a.push(await explainMs(owner, true, read));
        }
      }
      const ma = median(a);
      const mb = median(b);
      const delta = ((mb - ma) / ma) * 100;
      worst = Math.max(worst, delta);
      console.log(`${read.name}: A (before) ${ma.toFixed(2)} ms, B (after) ${mb.toFixed(2)} ms, ${delta >= 0 ? '+' : ''}${delta.toFixed(1)} %`);
    }
    const guardianRead: Read = {
      name: 'guardian child week',
      sub: () => guardian.authId,
      sql: `SELECT id FROM "CalendarLessons" WHERE date BETWEEN $1 AND $2`,
      params: () => [WEEK.from, WEEK.to],
    };
    const g: number[] = [];
    for (let i = 0; i < 9; i++) g.push(await explainMs(owner, false, guardianRead));
    console.log(`guardian child week (B only): ${median(g).toFixed(2)} ms`);
    console.log(worst <= 5 ? `PASS: worst ${worst.toFixed(1)} % ≤ 5 %` : `FAIL: worst ${worst.toFixed(1)} % > 5 %`);
    if (worst > 5) process.exitCode = 1;
  } finally {
    if (!process.env.BENCH_KEEP) await owner.query(`DELETE FROM "Schools" WHERE slug = $1`, [`bench-timplan-${scale.name}`]);
    await owner.end();
  }
}

void main();
