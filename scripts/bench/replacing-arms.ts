/**
 * The pupil's three arms 20261211090000 narrows (Ersättande grupper), measured
 * where they cost: the staff reads of the calendar they are ORed into, and the
 * pupil's own week.
 *
 *   BENCH_OWNER_URL='postgresql://postgres:postgres_local@localhost:5441/schemapro' \
 *     npx ts-node --transpile-only scripts/bench/replacing-arms.ts [a|b]
 *
 * THROWAWAY DATABASES ONLY, with the migration deployed. It seeds
 * timplan-delivered's school of the given scale (bench-timplan-<scale>, a full
 * published year), adds a group replacing the class's first subject with three
 * of its pupils, measures, and deletes the school again.
 *
 * Paired A/B on one connection, alternating per round so host load moves both
 * alike (the shared-Mac rule), as family-arms.ts does: each round opens a
 * transaction as the owner and ALTERs the three arms, for A to their
 * predicates before the migration and for B to the migration's own (the same
 * DDL on both sides, so neither pays for catalog invalidation the other does
 * not), then SET LOCAL ROLE app_authenticated with the reader's claims and
 * EXPLAIN (ANALYZE) the read. Rolled back either way. The verdict is the
 * median execution time of each side against a 5 % budget for the staff
 * reads, the budget #193 and the guardian arms were held to. A pupil's own
 * week is printed beside them, A and B for a pupil in no replacing group and
 * for one in it: that is the price of the feature, paid by pupils, as #193's
 * was.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Client } from 'pg';
import { SCALES, seed } from './timplan-delivered';

const ROUNDS = Number(process.env.BENCH_ROUNDS ?? 61);
const WEEK = { from: '2026-10-12', to: '2026-10-18' };

const MIGRATION = readFileSync(
  join(__dirname, '../../prisma/migrations/20261211090000_en_ersattande_grupp_tar_sina_elever_fran_klassens_lektion/migration.sql'),
  'utf8',
);
const statement = (start: string) => {
  const from = MIGRATION.indexOf(start);
  return MIGRATION.slice(from, MIGRATION.indexOf(';\n\n', from) + 1);
};
// As the migration writes them, read from the file so the bench cannot drift.
const NEW_ARMS = [
  statement('ALTER POLICY "calendar_lessons_student_select"'),
  statement('ALTER POLICY "calendar_lessons_teaching_group_select"'),
  statement('ALTER POLICY "calendar_lessons_participant_select"'),
].join('\n');
// As 20260822120000 and 20261208090000 left them: the same statements, the
// narrowing taken off.
const OLD_ARMS = NEW_ARMS.replace(
  /\n {8}AND NOT \("id" = ANY \(\(select CASE WHEN app\.current_user_role\(\) = 'STUDENT'\n {42}THEN app\.current_student_replaced_lesson_ids\(\)\n {42}ELSE '\{\}'::uuid\[\] END\)::uuid\[\]\)\)\n/g,
  '\n',
);
if (OLD_ARMS === NEW_ARMS || OLD_ARMS.includes('replaced_lesson_ids')) throw new Error('bench: the old arms did not come out of the migration');

interface Read {
  name: string;
  sub: () => string;
  sql: string;
  params: () => unknown[];
}

async function explainMs(owner: Client, old: boolean, read: Read): Promise<number> {
  await owner.query('BEGIN');
  try {
    await owner.query('SET LOCAL search_path = public, pg_temp');
    await owner.query(old ? OLD_ARMS : NEW_ARMS);
    await owner.query('RESET search_path');
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
    const pupils = (
      await owner.query<{ id: string; authId: string }>(
        `SELECT id, "authId" FROM "Users" WHERE "studentGroupId" = $1 AND role = 'STUDENT' AND "authId" IS NOT NULL ORDER BY id LIMIT 4`,
        [world.classId],
      )
    ).rows;
    if (pupils.length < 4) throw new Error('bench: the class needs four pupils with a login');
    const subject = (
      await owner.query<{ subjectId: string }>(
        `SELECT "subjectId" FROM "CalendarLessons" WHERE "studentGroupId" = $1 GROUP BY 1 ORDER BY count(*) DESC, 1 LIMIT 1`,
        [world.classId],
      )
    ).rows[0]!.subjectId;
    // A group replacing the class's most-taught subject, with three of its pupils.
    const replacing = (
      await owner.query<{ id: string }>(
        `INSERT INTO "StudentGroups" ("schoolId", "academicYearId", name, kind, "replacesSubjectId", "updatedAt")
         VALUES ($1, $2, 'Bench ersättande', 'TEACHING_GROUP', $3, now()) RETURNING id`,
        [world.schoolId, world.yearId, subject],
      )
    ).rows[0]!.id;
    for (const pupil of pupils.slice(1)) {
      await owner.query(`INSERT INTO "StudentGroupMembers" ("schoolId", "studentGroupId", "studentId") VALUES ($1, $2, $3)`, [
        world.schoolId,
        replacing,
        pupil.id,
      ]);
    }
    const lessonsThisWeek = (
      await owner.query<{ n: string }>(`SELECT count(*) AS n FROM "CalendarLessons" WHERE "schoolId" = $1 AND date BETWEEN $2 AND $3`, [
        world.schoolId,
        WEEK.from,
        WEEK.to,
      ])
    ).rows[0]!.n;
    const pupilWeek = `SELECT id, "subjectId", "studentGroupId", "roomId", date, "startsAt", "endsAt", status, note
                         FROM "CalendarLessons" WHERE date BETWEEN $1 AND $2 ORDER BY "startsAt"`;

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
        sql: pupilWeek,
        params: () => [WEEK.from, WEEK.to],
      },
    ];
    const pupilReads: Read[] = [
      { name: 'pupil week, in no replacing group', sub: () => pupils[0]!.authId, sql: pupilWeek, params: () => [WEEK.from, WEEK.to] },
      { name: 'pupil week, in the replacing group', sub: () => pupils[1]!.authId, sql: pupilWeek, params: () => [WEEK.from, WEEK.to] },
    ];

    console.log(`scale ${scale.name}: ${lessonsThisWeek} lessons in ${WEEK.from}..${WEEK.to}, ${ROUNDS} paired rounds`);
    let worst = 0;
    for (const read of reads) {
      await explainMs(owner, true, read);
      await explainMs(owner, false, read);
      const a: number[] = [];
      const b: number[] = [];
      for (let i = 0; i < ROUNDS; i++) {
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
    for (const read of pupilReads) {
      const a: number[] = [];
      const b: number[] = [];
      for (let i = 0; i < 31; i++) {
        a.push(await explainMs(owner, true, read));
        b.push(await explainMs(owner, false, read));
      }
      const ma = median(a);
      const mb = median(b);
      console.log(`${read.name} (informative): A ${ma.toFixed(2)} ms, B ${mb.toFixed(2)} ms, +${(mb - ma).toFixed(2)} ms`);
    }
    console.log(worst <= 5 ? `PASS: staff reads' worst ${worst.toFixed(1)} % ≤ 5 %` : `FAIL: staff reads' worst ${worst.toFixed(1)} % > 5 %`);
    if (worst > 5) process.exitCode = 1;
  } finally {
    if (!process.env.BENCH_KEEP) await owner.query(`DELETE FROM "Schools" WHERE slug = $1`, [`bench-timplan-${scale.name}`]);
    await owner.end();
  }
}

void main();
