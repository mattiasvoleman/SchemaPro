/**
 * Timplanstäckning, layer 3 (genomfört mot schemalagt), measured on a seeded
 * year: the four aggregate statements under RLS and the whole endpoint.
 *
 *   DATABASE_URL='postgresql://app_authenticated:app_authenticated_local@localhost:5662/schemapro?schema=public&connection_limit=4' \
 *   BENCH_OWNER_URL='postgresql://postgres:postgres_local@localhost:5662/schemapro' \
 *     npx ts-node --transpile-only scripts/bench/timplan-delivered.ts [a|b|both]
 *
 * THROWAWAY DATABASES ONLY. It writes a school of its own (slug
 * bench-timplan-<scale>) with a full published year, measures, and deletes the
 * school again — before it starts too, for a run that was killed. Never point
 * it at a shared database.
 *
 * Two scales (spec §8.6, review R21):
 *   (a)  600 pupils, 24 classes, 36 teaching groups, ~750 master lessons, a
 *        full published year (~30 000 CalendarLessons: 2 % cancelled across
 *        causes, 1 % teacherless, 3 % shared), 10 credits;
 *   (b) 2 000 pupils, 80 classes, 120 teaching groups, ~3 100 master lessons,
 *       ~118 000 CalendarLessons with 30 % shared.
 *
 * What it prints, per scale: EXPLAIN (ANALYZE, BUFFERS) execution time of
 * each statement (A_B: minutes per audience; C: horizons and the published
 * range; D: delivered minutes on given dates) as app_authenticated with an ADMIN's claims and a TEACHER's,
 * the teacher test written as a correlated EXISTS and as IN (a hashed
 * SubPlan); the service's warm median of 7, each run paired with a concurrent
 * layer=planned read (the shared-Mac rule: host load moves both alike); and
 * the response size in bytes, overview and drill-down.
 */
import { performance } from 'node:perf_hooks';
import { Client } from 'pg';
import { Role } from '../../src/auth/enums/role.enum';
import { PrismaService } from '../../src/database/prisma.service';
import { TimplanCoverageService } from '../../src/timplan/timplan-coverage.service';
import {
  audienceStatement,
  datesStatement,
  horizonStatement,
  type DeliveredWindow,
} from '../../src/timplan/timplan-delivered.sql';

interface Scale {
  name: 'a' | 'b';
  classes: number;
  pupilsPerClass: number;
  teachingGroups: number;
  lessonsPerClass: number;
  sharedPercent: number;
}

const SCALES: Record<'a' | 'b', Scale> = {
  a: { name: 'a', classes: 24, pupilsPerClass: 25, teachingGroups: 36, lessonsPerClass: 30, sharedPercent: 3 },
  b: { name: 'b', classes: 80, pupilsPerClass: 25, teachingGroups: 120, lessonsPerClass: 36, sharedPercent: 30 },
};

const YEAR_START = '2026-08-17';
const YEAR_END = '2027-06-11';
const LOV: [string, string][] = [
  ['2026-10-26', '2026-10-30'],
  ['2026-12-21', '2027-01-08'],
  ['2027-03-01', '2027-03-05'],
  ['2027-03-29', '2027-04-02'],
  ['2027-05-06', '2027-05-07'],
];

async function seed(owner: Client, scale: Scale): Promise<{ schoolId: string; yearId: string; admin: string; teacher: string; classId: string }> {
  const slug = `bench-timplan-${scale.name}`;
  await owner.query(`DELETE FROM "Schools" WHERE slug = $1`, [slug]);
  const q = async <T extends object>(sql: string, params: unknown[] = []) => (await owner.query<T>(sql, params)).rows;
  const [school] = await q<{ id: string }>(
    `INSERT INTO "Schools" (name, slug, timezone, "updatedAt") VALUES ($1, $1, 'Europe/Stockholm', now()) RETURNING id`,
    [slug],
  );
  const s = school!.id;
  await owner.query(`SELECT setseed(0.42)`);
  const [year] = await q<{ id: string }>(
    `INSERT INTO "AcademicYears" ("schoolId", name, "startDate", "endDate", "isActive", "updatedAt")
     VALUES ($1, '2026/27', $2::date, $3::date, true, now()) RETURNING id`,
    [s, YEAR_START, YEAR_END],
  );
  const y = year!.id;
  for (const [from, to] of LOV) {
    await owner.query(
      `INSERT INTO "SchoolBreaks" ("schoolId", "academicYearId", name, "startDate", "endDate", "updatedAt")
       VALUES ($1, $2, 'Lov', $3::date, $4::date, now())`,
      [s, y, from, to],
    );
  }
  // 17 counted subjects and one that is not undervisning.
  await owner.query(
    `INSERT INTO "Subjects" ("schoolId", name, "countsTowardTimplan", "updatedAt")
     SELECT $1, 'Ämne ' || n, n <= 17, now() FROM generate_series(1, 18) n`,
    [s],
  );
  await owner.query(
    `INSERT INTO "StudentGroups" ("schoolId", "academicYearId", name, kind, "gradeLevel", "updatedAt")
     SELECT $1, $2, (7 + (n % 3)) || '-' || n, 'CLASS', 7 + (n % 3), now() FROM generate_series(1, $3::int) n`,
    [s, y, scale.classes],
  );
  await owner.query(
    `INSERT INTO "StudentGroups" ("schoolId", "academicYearId", name, kind, "updatedAt")
     SELECT $1, $2, 'Grupp ' || n, 'TEACHING_GROUP', now() FROM generate_series(1, $3::int) n`,
    [s, y, scale.teachingGroups],
  );
  const users = (role: string, count: number, prefix: string) =>
    owner.query(
      `INSERT INTO "Users" ("schoolId", email, "firstName", "lastName", role, "authId", "isActive", "updatedAt")
       SELECT $1, $2 || '-' || n || '@example.invalid', 'Bench', $3::text, $4::"UserRole", gen_random_uuid(), true, now()
         FROM generate_series(1, $5::int) n`,
      [s, `${slug}-${prefix}`, prefix, role, count],
    );
  await users('SCHOOL_ADMIN', 1, 'admin');
  await users('TEACHER', Math.ceil((scale.classes * scale.pupilsPerClass) / 12), 'teacher');
  await users('STUDENT', scale.classes * scale.pupilsPerClass, 'pupil');
  // Home classes in order, 25 a class; every pupil in one teaching group.
  await owner.query(
    `WITH p AS (SELECT id, row_number() OVER (ORDER BY email) - 1 AS i FROM "Users" WHERE "schoolId" = $1 AND role = 'STUDENT'),
          c AS (SELECT id, row_number() OVER (ORDER BY name) - 1 AS i FROM "StudentGroups" WHERE "academicYearId" = $2 AND kind = 'CLASS')
     UPDATE "Users" u SET "studentGroupId" = c.id FROM p, c WHERE u.id = p.id AND c.i = p.i / $3`,
    [s, y, scale.pupilsPerClass],
  );
  await owner.query(
    `WITH p AS (SELECT id, row_number() OVER (ORDER BY email) - 1 AS i FROM "Users" WHERE "schoolId" = $1 AND role = 'STUDENT'),
          g AS (SELECT id, row_number() OVER (ORDER BY name) - 1 AS i FROM "StudentGroups" WHERE "academicYearId" = $2 AND kind = 'TEACHING_GROUP')
     INSERT INTO "StudentGroupMembers" ("schoolId", "studentGroupId", "studentId")
     SELECT $1, g.id, p.id FROM p JOIN g ON g.i = p.i % $3`,
    [s, y, scale.teachingGroups],
  );
  // Posts: each class a lesson of 60 a week per slot over the 17 subjects; each
  // teaching group 2 × 60 of subject 17.
  await owner.query(
    `WITH c AS (SELECT id, row_number() OVER (ORDER BY name) - 1 AS i FROM "StudentGroups" WHERE "academicYearId" = $2 AND kind = 'CLASS'),
          sub AS (SELECT id, row_number() OVER (ORDER BY name) - 1 AS i FROM "Subjects" WHERE "schoolId" = $1 AND "countsTowardTimplan")
     INSERT INTO "TeachingRequirements" ("schoolId", "academicYearId", "subjectId", "studentGroupId", "lessonsPerWeek", "minutesPerLesson", "updatedAt")
     SELECT $1, $2, sub.id, c.id, CASE WHEN sub.i < $3::int % 17 THEN $3::int / 17 + 1 ELSE $3::int / 17 END, 60, now()
       FROM c CROSS JOIN sub WHERE sub.i < 16`,
    [s, y, scale.lessonsPerClass],
  );
  // Master lessons: lessonsPerClass a class over the week, subject by slot;
  // teachers round-robin; a share of them with the next class of the grade as
  // an extra group (combined lessons).
  await owner.query(
    `WITH c AS (SELECT id, "gradeLevel", row_number() OVER (ORDER BY name) - 1 AS i FROM "StudentGroups" WHERE "academicYearId" = $2 AND kind = 'CLASS'),
          sub AS (SELECT id, row_number() OVER (ORDER BY name) - 1 AS i FROM "Subjects" WHERE "schoolId" = $1 AND "countsTowardTimplan"),
          t AS (SELECT id, row_number() OVER (ORDER BY email) - 1 AS i, count(*) OVER () AS n FROM "Users" WHERE "schoolId" = $1 AND role = 'TEACHER'),
          slots AS (SELECT c.id AS gid, c.i AS ci, k FROM c CROSS JOIN generate_series(0, $3::int - 1) k)
     INSERT INTO "MasterLessons" ("schoolId", "academicYearId", "subjectId", "studentGroupId", "teacherId", "dayOfWeek", "startTime", "endTime", "updatedAt")
     SELECT $1, $2, sub.id, slots.gid, t.id, 1 + (slots.k % 5), make_time(8 + (slots.k / 5) % 8, 0, 0), make_time(9 + (slots.k / 5) % 8, 0, 0), now()
       FROM slots JOIN sub ON sub.i = slots.k % 16 JOIN t ON t.i = (slots.ci * 7 + slots.k) % t.n`,
    [s, y, scale.lessonsPerClass],
  );
  await owner.query(
    `WITH g AS (SELECT id, row_number() OVER (ORDER BY name) - 1 AS i FROM "StudentGroups" WHERE "academicYearId" = $2 AND kind = 'TEACHING_GROUP'),
          sub AS (SELECT id FROM "Subjects" WHERE "schoolId" = $1 AND name = 'Ämne 17'),
          t AS (SELECT id, row_number() OVER (ORDER BY email) - 1 AS i, count(*) OVER () AS n FROM "Users" WHERE "schoolId" = $1 AND role = 'TEACHER')
     INSERT INTO "MasterLessons" ("schoolId", "academicYearId", "subjectId", "studentGroupId", "teacherId", "dayOfWeek", "startTime", "endTime", "updatedAt")
     SELECT $1, $2, sub.id, g.id, t.id, d, '15:00', '16:00', now()
       FROM g CROSS JOIN sub CROSS JOIN (VALUES (2), (4)) w(d) JOIN t ON t.i = g.i % t.n`,
    [s, y],
  );
  await owner.query(
    `WITH c AS (SELECT id, "gradeLevel", row_number() OVER (PARTITION BY "gradeLevel" ORDER BY name) AS r FROM "StudentGroups" WHERE "academicYearId" = $2 AND kind = 'CLASS'),
          pair AS (SELECT a.id AS gid, b.id AS other FROM c a JOIN c b ON b."gradeLevel" = a."gradeLevel" AND b.r = a.r + 1)
     INSERT INTO "MasterLessonGroups" ("schoolId", "masterLessonId", "studentGroupId")
     SELECT $1, m.id, pair.other FROM "MasterLessons" m JOIN pair ON pair.gid = m."studentGroupId"
      WHERE m."academicYearId" = $2 AND random() * 100 < $3`,
    [s, y, scale.sharedPercent],
  );
  // The whole year published: every master lesson on its weekday, lov out.
  await owner.query(
    `INSERT INTO "CalendarLessons" ("schoolId", "masterLessonId", "subjectId", "studentGroupId", date, "startsAt", "endsAt", status, "cancelCause", "updatedAt")
     SELECT $1, m.id, m."subjectId", m."studentGroupId", d::date,
            (d::date + m."startTime") AT TIME ZONE 'Europe/Stockholm', (d::date + m."endTime") AT TIME ZONE 'Europe/Stockholm',
            CASE WHEN r < 0.02 THEN 'CANCELLED'::"LessonStatus" ELSE 'SCHEDULED'::"LessonStatus" END,
            CASE WHEN r < 0.008 THEN 'TEACHER_UNAVAILABLE'::"LessonCancelCause" WHEN r < 0.012 THEN 'ROOM_UNAVAILABLE'::"LessonCancelCause"
                 WHEN r < 0.016 THEN 'MANUAL'::"LessonCancelCause" ELSE NULL END,
            now()
       FROM "MasterLessons" m
       CROSS JOIN generate_series($2::date, $3::date, interval '1 day') d
       CROSS JOIN LATERAL (SELECT random() AS r) x
      WHERE m."academicYearId" = $4 AND extract(isodow FROM d) = m."dayOfWeek"
        AND NOT EXISTS (SELECT 1 FROM "SchoolBreaks" b WHERE b."academicYearId" = $4 AND d::date BETWEEN b."startDate" AND b."endDate")`,
    [s, YEAR_START, YEAR_END, y],
  );
  await owner.query(
    `INSERT INTO "CalendarLessonTeachers" ("schoolId", "calendarLessonId", "teacherId", role)
     SELECT $1, cl.id, m."teacherId", 'LEAD' FROM "CalendarLessons" cl JOIN "MasterLessons" m ON m.id = cl."masterLessonId"
      WHERE m."academicYearId" = $2 AND random() >= 0.01`,
    [s, y],
  );
  await owner.query(
    `INSERT INTO "CalendarLessonGroups" ("schoolId", "calendarLessonId", "studentGroupId")
     SELECT $1, cl.id, x."studentGroupId" FROM "CalendarLessons" cl JOIN "MasterLessonGroups" x ON x."masterLessonId" = cl."masterLessonId"
      WHERE x."schoolId" = $1`,
    [s],
  );
  await owner.query(
    `INSERT INTO "TimplanCredits" ("schoolId", "academicYearId", date, minutes, "subjectId", "minGradeLevel", "maxGradeLevel", name, "updatedAt")
     SELECT $1, $2, date '2026-09-01' + n * 21, 300, (SELECT id FROM "Subjects" WHERE "schoolId" = $1 AND name = 'Ämne 3'), 7, 9, 'Friluftsdag ' || n, now()
       FROM generate_series(1, 10) n`,
    [s, y],
  );
  await owner.query('ANALYZE');
  const [admin] = await q<{ authId: string }>(`SELECT "authId" FROM "Users" WHERE "schoolId" = $1 AND role = 'SCHOOL_ADMIN'`, [s]);
  const [teacher] = await q<{ authId: string }>(`SELECT "authId" FROM "Users" WHERE "schoolId" = $1 AND role = 'TEACHER' ORDER BY email LIMIT 1`, [s]);
  const [cls] = await q<{ id: string }>(`SELECT id FROM "StudentGroups" WHERE "academicYearId" = $1 AND kind = 'CLASS' ORDER BY name LIMIT 1`, [y]);
  return { schoolId: s, yearId: y, admin: admin!.authId, teacher: teacher!.authId, classId: cls!.id };
}

const median = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[sorted.length >> 1]!;
};

async function explain(appUrl: string, authId: string, sql: { text: string; values: unknown[] }): Promise<number> {
  const client = new Client({ connectionString: appUrl.replace(/[?&]connection_limit=\d+/, '').replace(/\?schema=public/, '') });
  await client.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `SELECT set_config('request.jwt.claims', $1, true), set_config('request.jwt.claim.sub', $2, true), set_config('request.jwt.claim.role', 'authenticated', true)`,
      [JSON.stringify({ sub: authId, role: 'authenticated' }), authId],
    );
    const times: number[] = [];
    for (let i = 0; i < 3; i += 1) {
      const { rows } = await client.query<{ 'QUERY PLAN': string }>(`EXPLAIN (ANALYZE, BUFFERS) ${sql.text}`, sql.values);
      const line = rows.map((r) => r['QUERY PLAN']).find((text) => text.startsWith('Execution Time'));
      times.push(Number(/([\d.]+) ms/.exec(line ?? '')?.[1] ?? NaN));
      // BENCH_PLAN=1 prints the last plan in full.
      if (i === 2 && process.env.BENCH_PLAN) console.log(rows.map((r) => r['QUERY PLAN']).join('\n'));
    }
    await client.query('ROLLBACK');
    return median(times);
  } finally {
    await client.end();
  }
}

async function run(scaleName: 'a' | 'b'): Promise<void> {
  const appUrl = process.env.DATABASE_URL!;
  const owner = new Client({ connectionString: process.env.BENCH_OWNER_URL });
  await owner.connect();
  const scale = SCALES[scaleName];
  const started = performance.now();
  const world = await seed(owner, scale);
  const [{ n: lessons }] = (
    await owner.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM "CalendarLessons" cl JOIN "StudentGroups" g ON g.id = cl."studentGroupId" WHERE g."academicYearId" = $1`,
      [world.yearId],
    )
  ).rows;
  const [{ n: shared }] = (
    await owner.query<{ n: number }>(`SELECT count(DISTINCT "calendarLessonId")::int AS n FROM "CalendarLessonGroups" WHERE "schoolId" = $1`, [world.schoolId])
  ).rows;
  const [{ n: masters }] = (
    await owner.query<{ n: number }>(`SELECT count(*)::int AS n FROM "MasterLessons" WHERE "academicYearId" = $1`, [world.yearId])
  ).rows;
  console.log(
    `scale ${scale.name}: ${scale.classes * scale.pupilsPerClass} pupils, ${scale.classes} classes, ${scale.teachingGroups} teaching groups, ` +
      `${masters} master lessons, ${lessons} calendar lessons (${((100 * shared) / lessons).toFixed(1)} % shared); seeded in ${((performance.now() - started) / 1000).toFixed(1)} s`,
  );

  const window: DeliveredWindow = { academicYearId: world.yearId, yearStart: YEAR_START, yearEnd: YEAR_END, asOf: new Date() };
  const dates = ['2026-09-22', '2026-10-13', '2026-11-03', '2026-10-26', '2026-10-27'];
  const exists = { A_B: audienceStatement(window), C: horizonStatement(window), D: datesStatement(window, dates) };
  const asIn = (sql: { text: string; values: unknown[] }) => ({
    text: sql.text.replaceAll(
      'EXISTS (SELECT 1 FROM "CalendarLessonTeachers" t WHERE t."calendarLessonId" = cl."id")',
      'cl."id" IN (SELECT t."calendarLessonId" FROM "CalendarLessonTeachers" t)',
    ),
    values: sql.values,
  });
  for (const [who, authId] of [['ADMIN', world.admin], ['TEACHER', world.teacher]] as const) {
    const row: string[] = [];
    let total = 0;
    for (const [name, sql] of Object.entries(exists)) {
      const ms = await explain(appUrl, authId, sql);
      total += ms;
      row.push(`${name} ${ms.toFixed(0)}`);
    }
    const inAB = await explain(appUrl, authId, asIn(exists.A_B));
    const inD = await explain(appUrl, authId, asIn(exists.D));
    console.log(`  EXPLAIN ANALYZE as ${who} (EXISTS): ${row.join(', ')} → ${total.toFixed(0)} ms; as IN: A_B ${inAB.toFixed(0)}, D ${inD.toFixed(0)} ms`);
  }

  const previous = process.env.DATABASE_URL;
  const api = new PrismaService();
  process.env.DATABASE_URL = previous;
  await api.onModuleInit();
  const coverage = new TimplanCoverageService(api);
  const admin = { authId: world.admin, schoolId: world.schoolId, role: Role.SCHOOL_ADMIN, userId: undefined } as never;
  const query = { academicYearId: world.yearId, layer: 'delivered' as const };
  const delivered: number[] = [];
  const planned: number[] = [];
  let size = 0;
  for (let i = 0; i < 8; i += 1) {
    const time = async <T>(body: () => Promise<T>): Promise<[number, T]> => {
      const t0 = performance.now();
      const value = await body();
      return [performance.now() - t0, value];
    };
    const [[d, answer], [p]] = await Promise.all([
      time(() => coverage.delivered(query, admin)),
      time(() => coverage.planned({ academicYearId: world.yearId }, admin)),
    ]);
    if (i === 0) continue; // warm-up
    delivered.push(d);
    planned.push(p);
    size = Buffer.byteLength(JSON.stringify(answer));
  }
  const drill = await coverage.delivered({ ...query, studentGroupId: world.classId }, admin);
  const teacherAnswer = await coverage.delivered(query, { authId: world.teacher, schoolId: world.schoolId, role: Role.TEACHER } as never);
  console.log(
    `  service (warm median of 7, each paired with a concurrent layer=planned): delivered ${median(delivered).toFixed(0)} ms, planned ${median(planned).toFixed(0)} ms`,
  );
  const last = await coverage.delivered(query, admin);
  const kb = (value: unknown) => (Buffer.byteLength(JSON.stringify(value)) / 1024).toFixed(0);
  console.log(
    `  overview parts: groups ${kb(last.groups)} kB, pupils ${kb(last.pupils)} kB (${last.pupils?.length ?? 0} listed), verdicts ${kb(last.verdicts)} kB (${last.verdicts.length})`,
  );
  console.log(
    `  response: overview ${(size / 1024).toFixed(0)} kB (admin), ${(Buffer.byteLength(JSON.stringify(teacherAnswer)) / 1024).toFixed(0)} kB (teacher), drill-down ${(Buffer.byteLength(JSON.stringify(drill)) / 1024).toFixed(0)} kB`,
  );
  await api.$disconnect();
  // BENCH_KEEP=1 leaves the seeded school for a closer look; the next run deletes it first.
  if (!process.env.BENCH_KEEP) await owner.query(`DELETE FROM "Schools" WHERE id = $1`, [world.schoolId]);
  await owner.end();
}

async function main(): Promise<void> {
  const which = process.argv[2] ?? 'both';
  for (const name of which === 'both' ? (['a', 'b'] as const) : [which as 'a' | 'b']) await run(name);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
