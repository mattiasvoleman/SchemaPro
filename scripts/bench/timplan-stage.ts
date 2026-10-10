/**
 * Stadiesummor (timplan P4), measured on the layer-3 bench's world: the
 * Stadium view and the families' statement at 2 000 pupils.
 *
 *   DATABASE_URL='postgresql://app_authenticated:app_authenticated_local@localhost:5662/schemapro?schema=public&connection_limit=4' \
 *   BENCH_OWNER_URL='postgresql://postgres:postgres_local@localhost:5662/schemapro' \
 *     npx ts-node --transpile-only scripts/bench/timplan-stage.ts [a|b]
 *
 * THROWAWAY DATABASES ONLY. It seeds scale (a) or (b) of
 * scripts/bench/timplan-delivered.ts (a full published year, ~118 000
 * calendar lessons at b), records every pupil in their class from the year's
 * first day — the class history as the owner writes it, with the history's
 * guard set aside inside the bench's own transaction — and moves 5 % of the
 * pupils to another class on 40 distinct dates (the review's C16 world). Then
 * the view's warm median of 5, each paired with a concurrent layer=planned
 * read (the shared-Mac rule), the drill-down, the publish, and the sizes. It
 * deletes the school again, before it starts too.
 */
import { performance } from 'node:perf_hooks';
import { Client } from 'pg';
import { Role } from '../../src/auth/enums/role.enum';
import { PrismaService } from '../../src/database/prisma.service';
import { TimplanCoverageService } from '../../src/timplan/timplan-coverage.service';
import { TimplanStageService } from '../../src/timplan/timplan-stage.service';
import { SCALES, YEAR_END, YEAR_START, seed } from './timplan-delivered';

const median = (values: number[]) => [...values].sort((a, b) => a - b)[values.length >> 1]!;

async function main(): Promise<void> {
  const scale = SCALES[(process.argv[2] ?? 'b') as 'a' | 'b'];
  const owner = new Client({ connectionString: process.env.BENCH_OWNER_URL });
  await owner.connect();
  const started = performance.now();
  const world = await seed(owner, scale);
  // The 17 counted subjects mapped to bilaga 1's codes, so every cell is judged.
  await owner.query(
    `UPDATE "Subjects" s SET "nationalCode" = (ARRAY['MA','SV_SVA','EN','BL','IDH','MU','SL','TK','HKK','BI','FY','KE','GE','HI','RE','SH','M2'])[r.n]
       FROM (SELECT id, row_number() OVER (ORDER BY name)::int AS n FROM "Subjects" WHERE "schoolId" = $1 AND "countsTowardTimplan") r
      WHERE s.id = r.id`,
    [world.schoolId],
  );
  // The class history: from the year's first day, and 5 % moved on 40 dates.
  await owner.query('BEGIN');
  await owner.query('ALTER TABLE "StudentEnrollments" DISABLE TRIGGER "StudentEnrollments_written_by_trigger"');
  await owner.query(`UPDATE "StudentEnrollments" SET "validFrom" = $2::date WHERE "schoolId" = $1`, [world.schoolId, YEAR_START]);
  const movers = (
    await owner.query<{ id: string; studentId: string; studentGroupId: string; n: number }>(
      `SELECT id, "studentId", "studentGroupId", row_number() OVER (ORDER BY "studentId")::int AS n
         FROM "StudentEnrollments" WHERE "schoolId" = $1 ORDER BY "studentId"`,
      [world.schoolId],
    )
  ).rows.filter((row) => row.n % 20 === 0);
  const classes = (
    await owner.query<{ id: string; gradeLevel: number }>(
      `SELECT id, "gradeLevel" FROM "StudentGroups" WHERE "academicYearId" = $1 AND kind = 'CLASS' ORDER BY id`,
      [world.yearId],
    )
  ).rows;
  for (const [index, mover] of movers.entries()) {
    const day = new Date(Date.UTC(2026, 8, 1) + (index % 40) * 3 * 86_400_000).toISOString().slice(0, 10);
    const target = classes.find((candidate) => candidate.id !== mover.studentGroupId)!;
    await owner.query(`UPDATE "StudentEnrollments" SET "validTo" = $2::date WHERE id = $1`, [mover.id, day]);
    await owner.query(
      `INSERT INTO "StudentEnrollments" ("schoolId", "studentId", "academicYearId", "studentGroupId", "gradeLevel", "validFrom")
       VALUES ($1, $2, $3, $4, $5, $6::date)`,
      [world.schoolId, mover.studentId, world.yearId, target.id, target.gradeLevel, day],
    );
    await owner.query(`UPDATE "Users" SET "studentGroupId" = $2 WHERE id = $1`, [mover.studentId, target.id]);
  }
  await owner.query('ALTER TABLE "StudentEnrollments" ENABLE TRIGGER "StudentEnrollments_written_by_trigger"');
  await owner.query('COMMIT');
  console.log(
    `scale ${scale.name}: ${scale.classes * scale.pupilsPerClass} pupils, ${movers.length} moved on 40 dates; seeded in ${((performance.now() - started) / 1000).toFixed(1)} s`,
  );

  const api = new PrismaService();
  await api.onModuleInit();
  const stages = new TimplanStageService(api);
  const coverage = new TimplanCoverageService(api);
  const admin = { authId: world.admin, schoolId: world.schoolId, role: Role.SCHOOL_ADMIN, userId: undefined } as never;
  const view: number[] = [];
  const planned: number[] = [];
  let size = 0;
  for (let i = 0; i < 6; i += 1) {
    const time = async <T>(body: () => Promise<T>): Promise<[number, T]> => {
      const t0 = performance.now();
      const value = await body();
      return [performance.now() - t0, value];
    };
    const [[v, answer], [p]] = await Promise.all([
      time(() => stages.overview({ academicYearId: world.yearId }, admin)),
      time(() => coverage.planned({ academicYearId: world.yearId }, admin)),
    ]);
    if (i === 0) continue;
    view.push(v);
    planned.push(p);
    size = Buffer.byteLength(JSON.stringify(answer));
  }
  const t0 = performance.now();
  const drill = await stages.overview({ academicYearId: world.yearId, studentGroupId: world.classId }, admin);
  const drillMs = performance.now() - t0;
  const t1 = performance.now();
  const published = await stages.publish({ academicYearId: world.yearId }, admin);
  const publishMs = performance.now() - t1;
  console.log(
    `  Stadium view (warm median of 5, each paired with a concurrent layer=planned): ${median(view).toFixed(0)} ms, planned ${median(planned).toFixed(0)} ms; ${(size / 1024).toFixed(0)} kB`,
  );
  console.log(`  drill-down ${drillMs.toFixed(0)} ms, ${(Buffer.byteLength(JSON.stringify(drill)) / 1024).toFixed(0)} kB`);
  console.log(`  publish ${publishMs.toFixed(0)} ms: ${published.pupils} pupils, ${published.rows} rows (year ${YEAR_START} – ${YEAR_END})`);
  await api.$disconnect();
  if (!process.env.BENCH_KEEP) await owner.query(`DELETE FROM "Schools" WHERE id = $1`, [world.schoolId]);
  await owner.end();
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
