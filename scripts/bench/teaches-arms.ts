/**
 * The teacher's own arms of 20270216090000 (a teaching administrator, Users.teaches), measured where they cost: the
 * statements a teacher, an administrator and a marked administrator run against the tables whose arms were widened.
 *
 *   BENCH_OWNER_URL='postgresql://postgres:postgres_local@localhost:5609/bench17' \
 *     npx ts-node --transpile-only scripts/bench/teaches-arms.ts [a|b]
 *
 * THROWAWAY DATABASES ONLY, migrated to main and NOT to 20270216090000 (the run applies the migration inside each
 * measured transaction and rolls it back). It seeds timplan-delivered's school of the given scale (a full published
 * year, ~30 000 lessons on scale a), adds attendance for three weeks, notes to the substitute, absences, a marked
 * administrator with a post who stands on lessons, and deletes the school again.
 *
 * Paired A/B on one connection, alternating per round so host load moves both alike (the shared-Mac rule). Each round
 * opens a transaction as the owner and, for A, re-issues the 16 policies and the three functions as they are (the same
 * DDL churn, no change), for B applies the migration file itself; then, per statement, SET LOCAL ROLE with the
 * reader's claims and EXPLAIN (ANALYZE). Rolled back either way. The verdict is the median execution time of each
 * side against the 5 % budget the guardian work set for the personnel's reads; the first relation of each plan is
 * printed per variant (rls-arm-cost-bitmapor: a flipped join order is the cost, not the arm's own text).
 *
 * What is measured, as app_authenticated (the API) unless it says "authenticated" (PostgREST's door):
 *   - a teacher's, an administrator's and a marked administrator's week of lessons, and the school's week;
 *   - the same three reading a class's attendance for the week, and writing it (UPDATE, INSERT);
 *   - the same three reading the notes to the substitute (which asks app.lesson_teacher_role per row);
 *   - the teacher and the marked administrator reading their own post and absences through "authenticated".
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Client } from 'pg';
import { SCALES, seed } from './timplan-delivered';

const ROUNDS = Number(process.env.BENCH_ROUNDS ?? 61);
const WEEK = { from: '2026-10-12', to: '2026-10-18' };
const WEEKS_OF_ATTENDANCE = { from: '2026-09-28', to: '2026-10-25' };

const MIGRATION = readFileSync(
  join(__dirname, '../../prisma/migrations/20270216090000_en_undervisande_administrator_far_lararens_egna_armar/migration.sql'),
  'utf8',
);

// A: the same DDL as the migration, with nothing changed: every one of the 16 policies is altered to the text it has, and
// the three functions are created again from their own text.
const IDENTITY = `
DO $$
DECLARE r record; clauses text; fn oid;
BEGIN
  FOR r IN
    SELECT c.relname, p.polname, pg_get_expr(p.polqual, p.polrelid) AS q, pg_get_expr(p.polwithcheck, p.polrelid) AS w
      FROM pg_policy p JOIN pg_class c ON c.oid = p.polrelid
     WHERE c.relnamespace = 'public'::regnamespace AND p.polname IN (
       'attendance_teacher_insert', 'attendance_teacher_update', 'availability_teacher_modify',
       'lesson_substitute_notes_teacher_delete', 'lesson_substitute_notes_teacher_insert',
       'lesson_substitute_notes_teacher_select', 'lesson_substitute_notes_teacher_update',
       'teacher_absence_covers_own_select', 'teacher_absences_own_insert', 'teacher_absences_own_select',
       'teacher_absences_own_update', 'teacher_duties_teacher_own_select', 'teacher_employment_logs_teacher_own_select',
       'teacher_employment_periods_teacher_own_select', 'teacher_employments_teacher_own_select', 'teacher_work_rules_teacher_own')
  LOOP
    clauses := '';
    IF r.q IS NOT NULL THEN clauses := clauses || format(' USING (%s)', r.q); END IF;
    IF r.w IS NOT NULL THEN clauses := clauses || format(' WITH CHECK (%s)', r.w); END IF;
    EXECUTE format('ALTER POLICY %I ON %I%s', r.polname, r.relname, clauses);
  END LOOP;
  FOREACH fn IN ARRAY ARRAY['app.lesson_teacher_role(uuid)'::regprocedure::oid,
                            'app.availability_constraints_keep_duty_blocks()'::regprocedure::oid,
                            'app.cover_policy_arm_is_narrow(text, text, text)'::regprocedure::oid] LOOP
    EXECUTE pg_get_functiondef(fn);
  END LOOP;
END $$;
`;

interface Principal {
  name: string;
  sub: string;
  via: 'app_authenticated' | 'authenticated';
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
      await owner.query(`SET LOCAL ROLE ${m.who.via}`);
      await owner.query(`SELECT set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ sub: m.who.sub, role: 'authenticated' })]);
      const r = await owner.query<{ 'QUERY PLAN': Array<{ 'Execution Time': number; Plan: any }> }>(
        `EXPLAIN (ANALYZE, FORMAT JSON) ${m.sql}`,
        m.params ?? [],
      );
      const doc = r.rows[0]!['QUERY PLAN'][0]!;
      const seen = { rels: [] as string[], nodes: new Set<string>() };
      walk(doc.Plan, seen);
      result.set(m.name, { ms: doc['Execution Time'], first: seen.rels[0] ?? '-', nodes: [...seen.nodes].sort().join('+') });
      await owner.query('RESET ROLE');
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
    // The teacher with the most lessons in the week, who has a post.
    const [t] = await q<{ id: string; authId: string }>(
      `SELECT u.id, u."authId" FROM "Users" u JOIN "CalendarLessonTeachers" clt ON clt."teacherId" = u.id
         JOIN "CalendarLessons" l ON l.id = clt."calendarLessonId"
        WHERE u."schoolId" = $1 AND u.role = 'TEACHER' AND l.date BETWEEN $2 AND $3
        GROUP BY u.id, u."authId" ORDER BY count(*) DESC, u.id LIMIT 1`,
      [school, WEEK.from, WEEK.to],
    );
    await q(
      `INSERT INTO "TeacherEmployments" ("schoolId", "userId", "academicYearId", "employmentPercent", "updatedAt")
       SELECT $1, u.id, $2, 100, now() FROM "Users" u WHERE u."schoolId" = $1 AND u.role IN ('TEACHER')`,
      [school, world.yearId],
    );
    // The marked administrator: a schemaläggare with a post, then the mark (a mark is refused without a post).
    const [m] = await q<{ id: string; authId: string }>(
      `INSERT INTO "Users" ("schoolId", email, "firstName", "lastName", role, "adminProfile", "authId", "isActive", "updatedAt")
       VALUES ($1, 'bench-marked@example.invalid', 'Bench', 'Marked', 'SCHOOL_ADMIN', 'SCHEMALAGGARE', gen_random_uuid(), true, now())
       RETURNING id, "authId"`,
      [school],
    );
    await q(
      `INSERT INTO "TeacherEmployments" ("schoolId", "userId", "academicYearId", "employmentPercent", "updatedAt") VALUES ($1, $2, $3, 40, now())`,
      [school, m!.id, world.yearId],
    );
    await q(`UPDATE "Users" SET teaches = true WHERE id = $1`, [m!.id]);
    // The marked administrator stands on a teacher's worth of lessons in the week (the lessons of the teacher's, as a second LEAD).
    await q(
      `INSERT INTO "CalendarLessonTeachers" ("schoolId", "calendarLessonId", "teacherId", role)
       SELECT $1, clt."calendarLessonId", $2, 'ASSISTANT' FROM "CalendarLessonTeachers" clt JOIN "CalendarLessons" l ON l.id = clt."calendarLessonId"
        WHERE clt."teacherId" = $3 AND l.date BETWEEN $4 AND $5`,
      [school, m!.id, t!.id, WEEK.from, WEEK.to],
    );
    // Attendance for three weeks of every class lesson (the pupils of the lesson's class).
    await q(
      `INSERT INTO "AttendanceRecords" ("schoolId", "calendarLessonId", "studentId", status, "recordedById", "recordedAt", "updatedAt")
       SELECT $1, l.id, u.id, 'PRESENT', $4, now(), now()
         FROM "CalendarLessons" l JOIN "Users" u ON u."studentGroupId" = l."studentGroupId" AND u.role = 'STUDENT'
        WHERE l."schoolId" = $1 AND l.date BETWEEN $2 AND $3`,
      [school, WEEKS_OF_ATTENDANCE.from, WEEKS_OF_ATTENDANCE.to, t!.id],
    );
    // Notes to the substitute on a lesson in six of the teacher's lessons and on the marked administrator's, and a sprinkling elsewhere.
    await q(
      `INSERT INTO "LessonSubstituteNotes" ("schoolId", "calendarLessonId", body, "writtenById")
       SELECT $1, l.id, 'Bench note', $2 FROM "CalendarLessons" l WHERE l."schoolId" = $1 AND l.date BETWEEN $3 AND $4 AND random() < 0.2`,
      [school, t!.id, WEEK.from, WEEK.to],
    );
    // Absences: one a teacher in the autumn.
    await q(
      `INSERT INTO "TeacherAbsences" ("schoolId", "userId", "startsAt", "endsAt", "createdByUserId", "updatedAt")
       SELECT $1, u.id, '2026-10-14T06:00:00Z', '2026-10-14T15:00:00Z', u.id, now() FROM "Users" u WHERE u."schoolId" = $1 AND u.role = 'TEACHER'`,
      [school],
    );
    await q(
      `INSERT INTO "TeacherAbsences" ("schoolId", "userId", "startsAt", "endsAt", "createdByUserId", "updatedAt")
       VALUES ($1, $2, '2026-10-15T06:00:00Z', '2026-10-15T15:00:00Z', $2, now())`,
      [school, m!.id],
    );
    const [counts] = await q<{ lessons: string; attendance: string; notes: string }>(
      `SELECT (SELECT count(*) FROM "CalendarLessons" WHERE "schoolId" = $1 AND date BETWEEN $2 AND $3) AS lessons,
              (SELECT count(*) FROM "AttendanceRecords" WHERE "schoolId" = $1) AS attendance,
              (SELECT count(*) FROM "LessonSubstituteNotes" WHERE "schoolId" = $1) AS notes`,
      [school, WEEK.from, WEEK.to],
    );
    const [lesson] = await q<{ id: string }>(
      `SELECT l.id FROM "CalendarLessons" l JOIN "CalendarLessonTeachers" clt ON clt."calendarLessonId" = l.id
        WHERE clt."teacherId" = $1 AND l.date BETWEEN $2 AND $3 ORDER BY l.id LIMIT 1`,
      [t!.id, WEEK.from, WEEK.to],
    );
    console.log(
      `scale ${scale.name}: ${counts!.lessons} lessons in the week, ${counts!.attendance} attendance rows, ${counts!.notes} notes, ${ROUNDS} paired rounds`,
    );

    const teacher: Principal = { name: 'teacher', sub: t!.authId, via: 'app_authenticated' };
    const admin: Principal = { name: 'admin', sub: world.admin, via: 'app_authenticated' };
    const marked: Principal = { name: 'marked', sub: m!.authId, via: 'app_authenticated' };
    const teacherPg: Principal = { ...teacher, name: 'teacher/pg', via: 'authenticated' };
    const markedPg: Principal = { ...marked, name: 'marked/pg', via: 'authenticated' };
    const weekOfLessons = (who: Principal): Measure => ({
      name: `${who.name}: week of lessons (own)`,
      who,
      sql: `SELECT t.role, l.id, l."subjectId", l."studentGroupId", l."roomId", l.date, l."startsAt", l."endsAt", l.status, l.note
              FROM "CalendarLessonTeachers" t JOIN "CalendarLessons" l ON l.id = t."calendarLessonId"
             WHERE t."teacherId" = $1 AND l.date BETWEEN $2 AND $3`,
      params: [who === teacher || who === teacherPg ? t!.id : m!.id, WEEK.from, WEEK.to],
    });
    const attendanceRead = (who: Principal): Measure => ({
      name: `${who.name}: attendance of the week`,
      who,
      sql: `SELECT a.id, a."studentId", a.status FROM "AttendanceRecords" a JOIN "CalendarLessons" l ON l.id = a."calendarLessonId"
             WHERE l.date BETWEEN $1 AND $2`,
      params: [WEEK.from, WEEK.to],
    });
    const attendanceUpdate = (who: Principal): Measure => ({
      name: `${who.name}: save a lesson's attendance (UPDATE)`,
      who,
      sql: `UPDATE "AttendanceRecords" SET status = 'LATE', "updatedAt" = now() WHERE "calendarLessonId" = $1`,
      params: [lesson!.id],
    });
    const notesRead = (who: Principal): Measure => ({
      name: `${who.name}: notes of the week`,
      who,
      sql: `SELECT n.id, n.body FROM "LessonSubstituteNotes" n JOIN "CalendarLessons" l ON l.id = n."calendarLessonId" WHERE l.date BETWEEN $1 AND $2`,
      params: [WEEK.from, WEEK.to],
    });
    const measures: Measure[] = [
      weekOfLessons(teacher),
      weekOfLessons(marked),
      { name: 'admin: school week of lessons', who: admin, sql: `SELECT id, "subjectId", "studentGroupId", "roomId", date, "startsAt", "endsAt", status, note FROM "CalendarLessons" WHERE date BETWEEN $1 AND $2 ORDER BY "startsAt"`, params: [WEEK.from, WEEK.to] },
      attendanceRead(teacher),
      attendanceRead(admin),
      attendanceRead(marked),
      attendanceUpdate(teacher),
      attendanceUpdate(admin),
      attendanceUpdate(marked),
      notesRead(teacher),
      notesRead(marked),
      { name: 'teacher/pg: own post', who: teacherPg, sql: `SELECT * FROM "TeacherEmployments"` },
      { name: 'marked/pg: own post', who: markedPg, sql: `SELECT * FROM "TeacherEmployments"` },
      { name: 'teacher: absences', who: teacher, sql: `SELECT * FROM "TeacherAbsences" WHERE "startsAt" >= '2026-10-01'` },
      { name: 'admin: absences', who: admin, sql: `SELECT * FROM "TeacherAbsences" WHERE "startsAt" >= '2026-10-01'` },
      { name: 'marked: absences', who: marked, sql: `SELECT * FROM "TeacherAbsences" WHERE "startsAt" >= '2026-10-01'` },
      { name: 'teacher/pg: own absences', who: teacherPg, sql: `SELECT * FROM "TeacherAbsences"` },
      { name: 'marked/pg: own absences', who: markedPg, sql: `SELECT * FROM "TeacherAbsences"` },
    ];

    // Warm both sides first.
    await explain(owner, 'A', measures);
    await explain(owner, 'B', measures);
    const a = new Map<string, number[]>();
    const b = new Map<string, number[]>();
    const shape = new Map<string, { A: string; B: string }>();
    for (let i = 0; i < ROUNDS; i++) {
      const order: Array<'A' | 'B'> = i % 2 === 0 ? ['A', 'B'] : ['B', 'A'];
      for (const v of order) {
        const runs = await explain(owner, v, measures);
        for (const [name, run] of runs) {
          const sink = v === 'A' ? a : b;
          sink.set(name, [...(sink.get(name) ?? []), run.ms]);
          const s = shape.get(name) ?? { A: '', B: '' };
          s[v] = `${run.first} [${run.nodes}]`;
          shape.set(name, s);
        }
      }
    }
    let worst = -Infinity;
    for (const m of measures) {
      const ma = median(a.get(m.name)!);
      const mb = median(b.get(m.name)!);
      const delta = ((mb - ma) / ma) * 100;
      worst = Math.max(worst, delta);
      const s = shape.get(m.name)!;
      console.log(
        `${m.name}: A ${ma.toFixed(3)} ms, B ${mb.toFixed(3)} ms, ${delta >= 0 ? '+' : ''}${delta.toFixed(1)} %` +
          (s.A === s.B ? `  plan ${s.A}` : `  PLAN DIFFERS  A ${s.A}  B ${s.B}`),
      );
    }
    console.log(worst <= 5 ? `PASS: worst ${worst.toFixed(1)} % ≤ 5 %` : `OVER: worst ${worst.toFixed(1)} % > 5 %`);
  } finally {
    if (!process.env.BENCH_KEEP) await owner.query(`DELETE FROM "Schools" WHERE slug = $1`, [`bench-timplan-${scale.name}`]);
    await owner.end();
  }
}

void main();
