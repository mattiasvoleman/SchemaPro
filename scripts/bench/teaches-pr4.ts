/**
 * Krisläge, mentor och rapporteringsgrad för en markerad administratör (20270219090000, Users.teaches), measured where it costs: the
 * ten functions that now ask "does this person teach like a teacher" (the new app.teaches_like among them). The three arms of
 * CrisisReports are a cold table (written only during an alarm) and are not benched.
 *
 *   BENCH_OWNER_URL='postgresql://postgres:postgres_local@localhost:5619/bench17' \
 *     npx ts-node --transpile-only scripts/bench/teaches-pr4.ts [a|b]
 *
 * THROWAWAY DATABASES ONLY, migrated to main and NOT to 20270219090000 (the run applies the migration inside each measured transaction and
 * rolls it back). It seeds timplan-delivered's school of the given scale (a full published year, ~30 000 lessons on scale a), plants
 * mentors (a MENTORSKAP duty for every class, a marked administrator who mentors two of them), a register on the last weeks'
 * lessons, and deletes the school again.
 *
 * Paired A/B on one connection, alternating per round so host load moves both alike (the shared-Mac rule). Each round opens a
 * transaction as the owner and, for A, re-issues the ten functions and the three policies as they are (the same DDL churn, no change),
 * for B applies the migration file itself; then, per statement, EXPLAIN (ANALYZE). Rolled back either way. The verdict is the median
 * execution time of each side against the 5 % budget the guardian work set for the personnel's reads; the first relation of each plan is
 * printed per variant, and whether a call to app.teaches_like is left in the plan (it must not be: the function is inlined).
 *
 * What is measured (as the owner for the functions no role may call, as app_authenticated with a person's claims for the others):
 *   - app.reporting_lessons and app.absence_stats_lessons over four weeks of lessons (the night's count and the history's month);
 *   - app.absence_watch_mentees and app.absence_watch_digest_plan (the mentor's pupils; the weekly digest's recipients);
 *   - app.leave_mentors for every pupil of the school (a lateral call per pupil: who is told of a leave request);
 *   - app.reporting_compute for yesterday (the nightly count, 90 days of lessons; writes, rolled back);
 *   - as a teacher and as a marked administrator: app.reporting_open_lessons(90) (the page of the teacher), and the four functions that
 *     ask the caller (app.ack_mentee_ids, app.absence_watch_is_mentor_of for every pupil, app.lesson_move_is_mentor for every pupil,
 *     app.leave_mine_to_decide for every pupil).
 */
import { Client } from 'pg';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { SCALES, seed } from './timplan-delivered';

const ROUNDS = Number(process.env.BENCH_ROUNDS ?? 31);
const FROM = '2026-09-28';
const TO = '2026-10-25';

const MIGRATION = readFileSync(
  join(__dirname, '../../prisma/migrations/20270219090000_en_undervisande_administrator_svarar_i_larmet_ar_mentor_och_rapporterar/migration.sql'),
  'utf8',
);

// A: the same DDL as the migration, with nothing changed: the ten functions are created again from their own text and the three arms
// are altered to the text they have. The migration creates and drops two functions in pg_temp, which brings the session's temporary
// schema into being; A does the same, so that the two sides differ in the change and not in the session.
const IDENTITY = `
CREATE FUNCTION pg_temp.tk_noop() RETURNS void LANGUAGE sql AS 'SELECT';
DROP FUNCTION pg_temp.tk_noop();
DO $$
DECLARE r record; clauses text; fn oid;
BEGIN
  FOR r IN
    SELECT c.relname, p.polname, pg_get_expr(p.polqual, p.polrelid) AS q, pg_get_expr(p.polwithcheck, p.polrelid) AS w
      FROM pg_policy p JOIN pg_class c ON c.oid = p.polrelid
     WHERE c.relnamespace = 'public'::regnamespace AND c.relname = 'CrisisReports'
       AND p.polname IN ('crisis_reports_teacher_insert', 'crisis_reports_teacher_found_insert', 'crisis_reports_teacher_free_insert')
  LOOP
    clauses := '';
    IF r.q IS NOT NULL THEN clauses := clauses || format(' USING (%s)', r.q); END IF;
    IF r.w IS NOT NULL THEN clauses := clauses || format(' WITH CHECK (%s)', r.w); END IF;
    EXECUTE format('ALTER POLICY %I ON %I%s', r.polname, r.relname, clauses);
  END LOOP;
  FOREACH fn IN ARRAY ARRAY['app.reporting_lessons(uuid, date, date, timestamptz)'::regprocedure::oid,
                            'app.absence_stats_lessons(uuid, date, date, timestamptz)'::regprocedure::oid,
                            'app.leave_mentors(uuid, uuid, date, date)'::regprocedure::oid,
                            'app.absence_watch_mentees(uuid, date)'::regprocedure::oid,
                            'app.absence_watch_digest_plan(uuid, "AbsenceWatchGroup", date, date, date)'::regprocedure::oid,
                            'app.leave_mine_to_decide(uuid, uuid, date, date)'::regprocedure::oid,
                            'app.leave_request_taken(uuid)'::regprocedure::oid,
                            'app.absence_watch_is_mentor_of(uuid)'::regprocedure::oid,
                            'app.ack_mentee_ids()'::regprocedure::oid,
                            'app.lesson_move_is_mentor(uuid, date)'::regprocedure::oid] LOOP
    EXECUTE pg_get_functiondef(fn);
  END LOOP;
END $$;
`;

interface Principal {
  name: string;
  /** 'owner' runs as the connection's own role; the others set the role and the claims. */
  via: 'owner' | 'app_authenticated';
  sub?: string;
}

interface Measure {
  name: string;
  who: Principal;
  sql: string;
  params?: unknown[];
}

interface Run {
  ms: number;
  first: string;
  nodes: string;
  plan: string;
}

function walk(plan: any, out: { rels: string[]; nodes: Set<string> }): void {
  if (plan['Relation Name']) out.rels.push(plan['Relation Name']);
  out.nodes.add(plan['Node Type']);
  for (const child of plan.Plans ?? []) walk(child, out);
}

async function explain(owner: Client, variant: 'A' | 'B', measures: Measure[]): Promise<Map<string, Run>> {
  const result = new Map<string, Run>();
  await owner.query('BEGIN');
  try {
    await owner.query(variant === 'A' ? IDENTITY : MIGRATION);
    for (const m of measures) {
      if (m.who.via !== 'owner') {
        await owner.query(`SET LOCAL ROLE ${m.who.via}`);
        await owner.query(`SELECT set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ sub: m.who.sub, role: 'authenticated' })]);
      }
      const r = await owner.query<{ 'QUERY PLAN': Array<{ 'Execution Time': number; Plan: any }> }>(`EXPLAIN (ANALYZE, VERBOSE, FORMAT JSON) ${m.sql}`, m.params ?? []);
      const doc = r.rows[0]!['QUERY PLAN'][0]!;
      const seen = { rels: [] as string[], nodes: new Set<string>() };
      walk(doc.Plan, seen);
      result.set(m.name, { ms: doc['Execution Time'], first: seen.rels[0] ?? '-', nodes: [...seen.nodes].sort().join('+'), plan: JSON.stringify(doc.Plan) });
      if (m.who.via !== 'owner') await owner.query('RESET ROLE');
    }
  } finally {
    await owner.query('ROLLBACK');
  }
  return result;
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
  const q = async <T extends object>(sql: string, params: unknown[] = []) => (await owner.query<T>(sql, params)).rows;
  try {
    const school = world.schoolId;
    const teachers = await q<{ id: string; authId: string }>(`SELECT id, "authId" FROM "Users" WHERE "schoolId" = $1 AND role = 'TEACHER' ORDER BY id`, [school]);
    const classes = await q<{ id: string }>(`SELECT id FROM "StudentGroups" WHERE "schoolId" = $1 AND kind = 'CLASS' ORDER BY id`, [school]);
    // A teacher with the most lessons in the window is "the teacher"; the marked administrator stands on the same lessons.
    const [t] = await q<{ id: string; authId: string }>(
      `SELECT u.id, u."authId" FROM "Users" u JOIN "CalendarLessonTeachers" clt ON clt."teacherId" = u.id JOIN "CalendarLessons" l ON l.id = clt."calendarLessonId"
        WHERE u."schoolId" = $1 AND u.role = 'TEACHER' AND l.date BETWEEN $2 AND $3 GROUP BY u.id, u."authId" ORDER BY count(*) DESC, u.id LIMIT 1`,
      [school, FROM, TO],
    );
    await q(`INSERT INTO "TeacherEmployments" ("schoolId", "userId", "academicYearId", "employmentPercent", "updatedAt") SELECT $1, u.id, $2, 100, now() FROM "Users" u WHERE u."schoolId" = $1 AND u.role = 'TEACHER'`, [school, world.yearId]);
    const [m] = await q<{ id: string; authId: string }>(
      `INSERT INTO "Users" ("schoolId", email, "firstName", "lastName", role, "adminProfile", "authId", "isActive", "updatedAt")
       VALUES ($1, 'bench-marked@example.invalid', 'Bench', 'Marked', 'SCHOOL_ADMIN', 'SCHEMALAGGARE', gen_random_uuid(), true, now()) RETURNING id, "authId"`,
      [school],
    );
    await q(`INSERT INTO "TeacherEmployments" ("schoolId", "userId", "academicYearId", "employmentPercent", "updatedAt") VALUES ($1, $2, $3, 40, now())`, [school, m!.id, world.yearId]);
    await q(`UPDATE "Users" SET teaches = true WHERE id = $1`, [m!.id]);
    await q(
      `INSERT INTO "CalendarLessonTeachers" ("schoolId", "calendarLessonId", "teacherId", role)
       SELECT $1, clt."calendarLessonId", $2, 'ASSISTANT' FROM "CalendarLessonTeachers" clt JOIN "CalendarLessons" l ON l.id = clt."calendarLessonId"
        WHERE clt."teacherId" = $3 AND l.date BETWEEN $4 AND $5`,
      [school, m!.id, t!.id, FROM, TO],
    );
    // Mentors: a MENTORSKAP duty for every class (the teachers in turn), and two of them are the marked administrator's.
    await q(
      `INSERT INTO "TeacherDuties" ("schoolId", "userId", "academicYearId", kind, label, "minutesPerWeek", "studentGroupId", "updatedAt")
       SELECT $1, CASE WHEN g.n IN (1, 2) THEN $4::uuid ELSE (($5::uuid[])[1 + (g.n % $6::int)]) END, $2, 'MENTORSKAP', 'Bench mentor ' || g.n, 60, g.id, now()
         FROM (SELECT id, row_number() OVER (ORDER BY id) AS n FROM unnest($3::uuid[]) id) g`,
      [school, world.yearId, classes.map((c) => c.id), m!.id, teachers.map((x) => x.id), teachers.length],
    );
    // A register on every lesson of the window (the pupils of the class), saved by the teacher.
    await q(
      `INSERT INTO "AttendanceRecords" ("schoolId", "calendarLessonId", "studentId", status, "recordedById", "recordedAt", "updatedAt")
       SELECT $1, l.id, u.id, 'PRESENT', $4, now(), now() FROM "CalendarLessons" l JOIN "Users" u ON u."studentGroupId" = l."studentGroupId" AND u.role = 'STUDENT'
        WHERE l."schoolId" = $1 AND l.date BETWEEN $2 AND $3 AND random() < 0.8`,
      [school, FROM, TO, t!.id],
    );
    const [counts] = await q<{ lessons: string; duties: string; pupils: string; mentees: string }>(
      `SELECT (SELECT count(*) FROM "CalendarLessons" WHERE "schoolId" = $1 AND date BETWEEN $2 AND $3) AS lessons,
              (SELECT count(*) FROM "TeacherDuties" WHERE "schoolId" = $1 AND kind = 'MENTORSKAP') AS duties,
              (SELECT count(*) FROM "Users" WHERE "schoolId" = $1 AND role = 'STUDENT') AS pupils,
              (SELECT count(*) FROM app.absence_watch_mentees($1, current_date)) AS mentees`,
      [school, FROM, TO],
    );
    console.log(`scale ${scale.name}: ${counts!.lessons} lessons in the window, ${counts!.duties} mentor duties, ${counts!.pupils} pupils, ${counts!.mentees} mentor/pupil pairs today, ${ROUNDS} paired rounds`);

    const owned: Principal = { name: 'owner', via: 'owner' };
    const teacher: Principal = { name: 'teacher', via: 'app_authenticated', sub: t!.authId };
    const marked: Principal = { name: 'marked', via: 'app_authenticated', sub: m!.authId };
    const forEveryPupil = (who: Principal, fn: string): Measure => ({
      name: `${who.name}: ${fn} for every pupil`,
      who,
      sql: `SELECT count(*) FROM "Users" p WHERE p."schoolId" = $1 AND p.role = 'STUDENT' AND ${fn.replace('PUPIL', 'p.id')}`,
      params: [school],
    });
    const measures: Measure[] = [
      { name: 'owner: reporting_lessons, four weeks', who: owned, sql: `SELECT count(*) FROM app.reporting_lessons($1::uuid, $2::date, $3::date, now())`, params: [school, FROM, TO] },
      { name: 'owner: absence_stats_lessons, four weeks', who: owned, sql: `SELECT count(*) FROM app.absence_stats_lessons($1::uuid, $2::date, $3::date, now())`, params: [school, FROM, TO] },
      { name: 'owner: absence_watch_mentees, today', who: owned, sql: `SELECT count(*) FROM app.absence_watch_mentees($1::uuid, current_date)`, params: [school] },
      { name: 'owner: absence_watch_digest_plan, MENTOR', who: owned, sql: `SELECT count(*) FROM app.absence_watch_digest_plan($1::uuid, 'MENTOR', current_date - 7, current_date, current_date)`, params: [school] },
      {
        name: 'owner: leave_mentors for every pupil',
        who: owned,
        sql: `SELECT count(*) FROM "Users" p CROSS JOIN LATERAL app.leave_mentors($1::uuid, p.id, current_date + 3, current_date + 4) x(id) WHERE p."schoolId" = $1 AND p.role = 'STUDENT'`,
        params: [school],
      },
      { name: 'owner: reporting_compute, yesterday (90 days)', who: owned, sql: `SELECT count(*) FROM app.reporting_compute($1::uuid, current_date - 1)`, params: [school] },
      { name: 'teacher: reporting_open_lessons(90)', who: teacher, sql: `SELECT count(*) FROM app.reporting_open_lessons(90)` },
      { name: 'marked: reporting_open_lessons(90)', who: marked, sql: `SELECT count(*) FROM app.reporting_open_lessons(90)` },
      { name: 'teacher: ack_mentee_ids', who: teacher, sql: `SELECT cardinality(app.ack_mentee_ids())` },
      { name: 'marked: ack_mentee_ids', who: marked, sql: `SELECT cardinality(app.ack_mentee_ids())` },
      forEveryPupil(teacher, 'app.absence_watch_is_mentor_of(PUPIL)'),
      forEveryPupil(marked, 'app.absence_watch_is_mentor_of(PUPIL)'),
      forEveryPupil(teacher, 'app.lesson_move_is_mentor(PUPIL, current_date)'),
      forEveryPupil(marked, 'app.lesson_move_is_mentor(PUPIL, current_date)'),
      forEveryPupil(teacher, 'app.leave_mine_to_decide($1::uuid, PUPIL, current_date + 3, current_date + 4)'),
      forEveryPupil(marked, 'app.leave_mine_to_decide($1::uuid, PUPIL, current_date + 3, current_date + 4)'),
    ];

    // Warm both sides first.
    await explain(owner, 'A', measures);
    await explain(owner, 'B', measures);
    const a = new Map<string, number[]>();
    const b = new Map<string, number[]>();
    const shape = new Map<string, { A: string; B: string; callLeft: boolean }>();
    for (let i = 0; i < ROUNDS; i++) {
      const order: Array<'A' | 'B'> = i % 2 === 0 ? ['A', 'B'] : ['B', 'A'];
      for (const v of order) {
        const runs = await explain(owner, v, measures);
        for (const [name, run] of runs) {
          const sink = v === 'A' ? a : b;
          sink.set(name, [...(sink.get(name) ?? []), run.ms]);
          const s = shape.get(name) ?? { A: '', B: '', callLeft: false };
          s[v] = `${run.first} [${run.nodes}]`;
          if (v === 'B' && run.plan.includes('teaches_like')) s.callLeft = true;
          shape.set(name, s);
        }
      }
    }
    let worst = -Infinity;
    let left = false;
    for (const meas of measures) {
      const ma = median(a.get(meas.name)!);
      const mb = median(b.get(meas.name)!);
      const delta = ((mb - ma) / ma) * 100;
      worst = Math.max(worst, delta);
      const s = shape.get(meas.name)!;
      left = left || s.callLeft;
      console.log(
        `${meas.name}: A ${ma.toFixed(3)} ms, B ${mb.toFixed(3)} ms, ${delta >= 0 ? '+' : ''}${delta.toFixed(1)} %` +
          (s.A === s.B ? `  plan ${s.A}` : `  PLAN DIFFERS  A ${s.A}  B ${s.B}`) +
          (s.callLeft ? '  CALL TO teaches_like LEFT IN THE PLAN' : ''),
      );
    }
    console.log(left ? 'A call to app.teaches_like is left in a plan: it is not inlined' : 'no call to app.teaches_like is left in any plan (inlined)');
    console.log(worst <= 5 ? `PASS: worst ${worst.toFixed(1)} % <= 5 %` : `OVER: worst ${worst.toFixed(1)} % > 5 %`);
  } finally {
    if (!process.env.BENCH_KEEP) await owner.query(`DELETE FROM "Schools" WHERE slug = $1`, [`bench-timplan-${scale.name}`]);
    await owner.end();
  }
}

void main();
