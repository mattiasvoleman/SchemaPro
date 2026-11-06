/**
 * Hela skolans data measured at the size the question is asked at: a school
 * of 1 000 pupils with a year of attendance (K5).
 *
 *   BENCH_OWNER_URL='postgresql://postgres:postgres_local@localhost:5481/schemapro' \
 *   BENCH_APP_URL='postgresql://app_authenticated:app_authenticated_local@localhost:5481/schemapro?schema=public&connection_limit=4' \
 *     npx ts-node --transpile-only scripts/bench/school-export.ts [pupils=1000] [days=190]
 *
 * THROWAWAY DATABASES ONLY. It seeds a school of its own (bench-export-<tag>):
 * the pupils in classes of 25, a lesson per class, slot and school day, an
 * attendance mark per pupil per lesson (1 140 000 marks at 1 000 pupils and
 * 190 days), an absence report and a leave request every so often, a notice
 * per leave, and a handful of protected persons; orders the export as the
 * school's full administrator through the real services; lets the job build
 * it in this process while a timer samples the process's memory; fetches the
 * file the way the gateway sends it; and removes the school.
 *
 * It prints what the question asks: time, and memory (the process's resident
 * set and heap, at rest before and at their peak during the build and the
 * fetch), against the size of the file and the rows in it. "Without the whole
 * school in memory" is judged by the peak not growing with the rows: run it at
 * 250 and at 1 000 pupils and compare.
 */
import { strict as assert } from 'node:assert';
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { createWriteStream, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from 'pg';
import { MasterLessonsService } from '../../src/calendar/master-lessons.service';
import { PrismaService } from '../../src/database/prisma.service';
import { FamilyReadsService } from '../../src/family/family-reads.service';
import type { NotificationsService } from '../../src/notifications/notifications.service';
import type { RealtimeService } from '../../src/realtime/realtime.service';
import { ScheduleExchangeService } from '../../src/schedule-exchange/exchange.service';
import { SchoolExportJob } from '../../src/school-export/school-export.job';
import { SchoolExportService } from '../../src/school-export/school-export.service';

const PUPILS = Number(process.argv[2] ?? 1000);
const DAYS = Number(process.argv[3] ?? 190);
const PER_CLASS = 25;
const SLOTS = 6;

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Set ${name}.`);
  return value;
}

const mb = (bytes: number) => Math.round(bytes / 1048576);

/** Samples the process's memory on a timer; the peak is what the question asks for. */
class MemoryWatch {
  peakRss = 0;
  peakHeap = 0;
  private timer: NodeJS.Timeout | undefined;
  start(): void {
    this.peakRss = 0;
    this.peakHeap = 0;
    const sample = () => {
      const m = process.memoryUsage();
      this.peakRss = Math.max(this.peakRss, m.rss);
      this.peakHeap = Math.max(this.peakHeap, m.heapUsed);
    };
    sample();
    this.timer = setInterval(sample, 25);
  }
  stop(): void {
    if (this.timer) clearInterval(this.timer);
    const m = process.memoryUsage();
    this.peakRss = Math.max(this.peakRss, m.rss);
    this.peakHeap = Math.max(this.peakHeap, m.heapUsed);
  }
}

async function seed(db: Client, tag: string) {
  const classes = Math.ceil(PUPILS / PER_CLASS);
  const q = async (text: string, values: unknown[] = []) => (await db.query(text, values)).rows;
  const [{ id: school }] = await q(`INSERT INTO "Schools" (name, slug, timezone, "updatedAt") VALUES ($1, $2, 'Europe/Stockholm', now()) RETURNING id`, [`Mätskola ${tag}`, `bench-export-${tag}`]);
  const [{ id: year }] = await q(
    `INSERT INTO "AcademicYears" ("schoolId", name, "startDate", "endDate", "isActive", "gradeNumbering", "updatedAt")
     VALUES ($1, '2026/27', '2026-08-17', '2027-06-11', true, 'NIOARIG', now()) RETURNING id`,
    [school],
  );
  await q(`INSERT INTO "Subjects" ("schoolId", name, code, "updatedAt") SELECT $1, 'Ämne ' || n, 'A' || n, now() FROM generate_series(1, 8) n`, [school]);
  await q(
    `INSERT INTO "StudentGroups" ("schoolId", "academicYearId", name, kind, "gradeLevel", "updatedAt")
     SELECT $1, $2, 'K' || n, 'CLASS', 4 + (n % 6), now() FROM generate_series(1, $3::int) n`,
    [school, year, classes],
  );
  const [{ id: adminId, authId }] = await q(
    `INSERT INTO "Users" ("schoolId", "authId", role, "adminProfile", "hrRead", "firstName", "lastName", email, "updatedAt")
     VALUES ($1, gen_random_uuid(), 'SCHOOL_ADMIN', 'FULL', true, 'Mät', 'Admin', 'admin@bench.example.com', now()) RETURNING id, "authId"`,
    [school],
  );
  await q(
    `INSERT INTO "Users" ("schoolId", "authId", role, "firstName", "lastName", email, "updatedAt")
     SELECT $1, gen_random_uuid(), 'TEACHER', 'Lärare' || n, 'Mät', 'larare' || n || '@bench.example.com', now() FROM generate_series(1, 60) n`,
    [school],
  );
  await q(
    `INSERT INTO "Users" ("schoolId", "authId", role, "firstName", "lastName", email, "studentGroupId", "updatedAt")
     SELECT $1, gen_random_uuid(), 'STUDENT', 'Elev' || n, 'Mät' || (n % 97), 'elev' || n || '@bench.example.com',
            (SELECT id FROM "StudentGroups" WHERE "schoolId" = $1 AND name = 'K' || (1 + (n - 1) / $3::int)), now()
       FROM generate_series(1, $2::int) n`,
    [school, PUPILS, PER_CLASS],
  );
  await q(
    `INSERT INTO "Users" ("schoolId", "authId", role, "firstName", "lastName", email, "updatedAt")
     SELECT $1, gen_random_uuid(), 'GUARDIAN', 'Vårdnadshavare' || n, 'Mät' || (n % 97), 'vh' || n || '@bench.example.com', now() FROM generate_series(1, $2::int) n`,
    [school, PUPILS],
  );
  await q(
    `INSERT INTO "GuardianStudents" ("schoolId", "guardianId", "studentId")
     SELECT $1, g.id, s.id FROM "Users" g JOIN "Users" s ON s."schoolId" = $1 AND s.role = 'STUDENT' AND s.email = 'elev' || substr(g.email, 3, length(g.email) - 2 - length('@bench.example.com')) || '@bench.example.com'
      WHERE g."schoolId" = $1 AND g.role = 'GUARDIAN'`,
    [school],
  );
  const lessons = await q(
    `INSERT INTO "CalendarLessons" ("schoolId", "subjectId", "studentGroupId", date, "startsAt", "endsAt", "updatedAt")
     SELECT $1, (SELECT id FROM "Subjects" WHERE "schoolId" = $1 AND code = 'A' || (1 + (c.rn + slot) % 8)), c.id, d.d,
            ((d.d + time '08:00' + (slot - 1) * interval '55 minutes') AT TIME ZONE 'Europe/Stockholm'),
            ((d.d + time '08:50' + (slot - 1) * interval '55 minutes') AT TIME ZONE 'Europe/Stockholm'), now()
       FROM (SELECT id, row_number() OVER (ORDER BY name) AS rn FROM "StudentGroups" WHERE "schoolId" = $1) c
      CROSS JOIN (SELECT d::date AS d FROM generate_series('2026-08-17'::date, '2027-06-30'::date, '1 day') d WHERE extract(isodow FROM d) < 6 ORDER BY 1 LIMIT $2::int) d
      CROSS JOIN generate_series(1, ${SLOTS}) slot
     RETURNING id`,
    [school, DAYS],
  );
  const teacher = (await q(`SELECT id FROM "Users" WHERE "schoolId" = $1 AND role = 'TEACHER' ORDER BY email LIMIT 1`, [school]))[0].id;
  await q(
    `INSERT INTO "AttendanceRecords" ("schoolId", "calendarLessonId", "studentId", status, "recordedById", "recordedAt", note, "updatedAt")
     SELECT $1, l.id, s.id, ((ARRAY['PRESENT','PRESENT','PRESENT','ABSENT','LATE','EXCUSED'])[1 + ((extract(day FROM l.date)::int + extract(hour FROM l."startsAt")::int + s_n) % 6)])::"AttendanceStatus",
            $2, l."startsAt" + interval '5 minutes', CASE WHEN s_n % 400 = 0 THEN 'Anteckning' ELSE NULL END, now()
       FROM "CalendarLessons" l
       JOIN (SELECT id, "studentGroupId", row_number() OVER (ORDER BY id)::int AS s_n FROM "Users" WHERE "schoolId" = $1 AND role = 'STUDENT') s ON s."studentGroupId" = l."studentGroupId"
      WHERE l."schoolId" = $1`,
    [school, teacher],
  );
  await q(
    `INSERT INTO "AbsenceReports" ("schoolId", "studentId", "reportedById", date, type, note)
     SELECT $1, s.id, g.id, ('2026-09-01'::date + (n * 7) % 200), 'SICK', 'Anmälan ' || n
       FROM "Users" s JOIN "GuardianStudents" l ON l."studentId" = s.id JOIN "Users" g ON g.id = l."guardianId"
      CROSS JOIN generate_series(1, 15) n WHERE s."schoolId" = $1 AND s.role = 'STUDENT'`,
    [school],
  );
  await q(
    `INSERT INTO "LeaveRequests" ("schoolId", "studentId", "requestedById", "startDate", "endDate", reason, status, "decidedById", "decidedAt", "decidedAs")
     SELECT $1, s.id, g.id, '2026-11-02'::date + n, '2026-11-03'::date + n, 'Skäl ' || n, 'APPROVED', $2, now(), 'ADMIN'
       FROM "Users" s JOIN "GuardianStudents" l ON l."studentId" = s.id JOIN "Users" g ON g.id = l."guardianId"
      CROSS JOIN generate_series(1, 3) n WHERE s."schoolId" = $1 AND s.role = 'STUDENT'`,
    [school, adminId],
  );
  await q(
    `INSERT INTO "Notifications" ("schoolId", "userId", type, meta)
     SELECT $1, g.id, 'LEAVE_DECIDED', jsonb_build_object('note', 'Notis ' || n) FROM "Users" g CROSS JOIN generate_series(1, 20) n WHERE g."schoolId" = $1 AND g.role = 'GUARDIAN'`,
    [school],
  );
  await q(
    `INSERT INTO "PersonProtections" ("userId", "schoolId", source)
     SELECT id, $1, 'MANUAL' FROM "Users" WHERE "schoolId" = $1 AND role = 'STUDENT' ORDER BY email LIMIT 5`,
    [school],
  );
  const counts = (
    await q(
      `SELECT (SELECT count(*) FROM "CalendarLessons" WHERE "schoolId" = $1)::int AS lessons,
              (SELECT count(*) FROM "AttendanceRecords" WHERE "schoolId" = $1)::int AS attendance,
              (SELECT count(*) FROM "AbsenceReports" WHERE "schoolId" = $1)::int AS absences,
              (SELECT count(*) FROM "LeaveRequests" WHERE "schoolId" = $1)::int AS leaves,
              (SELECT count(*) FROM "Notifications" WHERE "schoolId" = $1)::int AS notices`,
      [school],
    )
  )[0];
  await db.query('ANALYZE');
  void lessons;
  return { school: school as string, adminId: adminId as string, authId: authId as string, counts };
}

async function main(): Promise<void> {
  const owner = new Client({ connectionString: requiredEnv('BENCH_OWNER_URL') });
  await owner.connect();
  process.env['DATABASE_URL'] = requiredEnv('BENCH_APP_URL');
  const api = new PrismaService();
  const realtime = { notifyMasterTimetableChanged: () => undefined } as unknown as RealtimeService;
  const exchange = new ScheduleExchangeService(api, realtime, new MasterLessonsService(api, realtime, {} as NotificationsService));
  const job = new SchoolExportJob(api, new FamilyReadsService(api), exchange);
  const service = new SchoolExportService(api);
  const tag = randomUUID().slice(0, 8);
  try {
    const seeded = await seed(owner, tag);
    console.log(`seeded: ${PUPILS} pupils, ${JSON.stringify(seeded.counts)}`);
    const user = { authId: seeded.authId, role: 'SCHOOL_ADMIN', userId: seeded.adminId, schoolId: seeded.school, adminProfile: 'FULL', hrRead: true, channel: 'OTHER' } as never;

    // Warm: the first query of a process pays for plan caches and the pool.
    await api.withRls(user, (tx) => tx.user.count());
    global.gc?.();
    const rest = process.memoryUsage();

    const order = await service.order(user);
    const watch = new MemoryWatch();
    watch.start();
    const t0 = process.hrtime.bigint();
    await job.tick();
    const buildMs = Number(process.hrtime.bigint() - t0) / 1e6;
    watch.stop();
    const [row] = await service.list(user);
    assert.equal(row!.id, order.id);
    assert.equal(row!.status, 'READY', `the export is READY (was ${row!.status} ${row!.errorClass ?? ''})`);
    const buildRss = watch.peakRss;
    const buildHeap = watch.peakHeap;

    watch.start();
    const t1 = process.hrtime.bigint();
    const opened = await service.openFile(order.id, user);
    const dir = mkdtempSync(join(tmpdir(), 'k5-bench-'));
    const hash = createHash('sha256');
    // Written out as it arrives, the way a client saves it, so the fetch is measured and not the bench's own buffer.
    const out = createWriteStream(join(dir, 'x.zip'));
    let total = 0;
    for await (const piece of opened.pieces()) {
      hash.update(piece);
      total += piece.length;
      if (!out.write(piece)) await new Promise<void>((resolve) => out.once('drain', () => resolve()));
    }
    await new Promise<void>((resolve) => out.end(() => resolve()));
    const fetchMs = Number(process.hrtime.bigint() - t1) / 1e6;
    watch.stop();
    assert.equal(total, opened.byteSize);
    assert.equal(hash.digest('hex'), opened.sha256);
    const fetchRss = watch.peakRss;
    const fetchHeap = watch.peakHeap;

    const files = (row!.files ?? []) as Array<{ path: string; rows: number; bytes: number }>;
    const rows = files.reduce((sum, file) => sum + file.rows, 0);
    const raw = files.reduce((sum, file) => sum + file.bytes, 0);
    console.log(
      JSON.stringify(
        {
          pupils: PUPILS,
          attendanceMarks: seeded.counts.attendance,
          rowsInFile: rows,
          zipMB: +(opened.byteSize / 1048576).toFixed(1),
          uncompressedMB: +(raw / 1048576).toFixed(1),
          pieces: opened.chunkCount,
          buildSeconds: +(buildMs / 1000).toFixed(1),
          rowsPerSecond: Math.round(rows / (buildMs / 1000)),
          fetchSeconds: +(fetchMs / 1000).toFixed(1),
          memoryMB: {
            restRss: mb(rest.rss),
            restHeap: mb(rest.heapUsed),
            buildPeakRss: mb(buildRss),
            buildPeakHeap: mb(buildHeap),
            fetchPeakRss: mb(fetchRss),
            fetchPeakHeap: mb(fetchHeap),
            buildHeapAboveRest: mb(buildHeap - rest.heapUsed),
            buildRssAboveRest: mb(buildRss - rest.rss),
          },
          heldOut: row!.heldOut,
          parts: files.filter((f) => f.path.startsWith('data/narvaro')).map((f) => ({ path: f.path, rows: f.rows })),
        },
        null,
        2,
      ),
    );
    // The system's unzip reads the saved file whole and checks every CRC.
    const check = execFileSync('unzip', ['-t', join(dir, 'x.zip')], { encoding: 'utf8' });
    assert.match(check, /No errors detected/);
    rmSync(dir, { recursive: true, force: true });
  } finally {
    // By slug, so a seed that stopped halfway leaves nothing behind.
    const t = Date.now();
    await owner.query(`DELETE FROM "Schools" WHERE slug = $1`, [`bench-export-${tag}`]);
    console.log(`removed the school in ${((Date.now() - t) / 1000).toFixed(1)} s`);
    await api.$disconnect();
    await owner.end();
  }
}

void main().catch((error) => {
  console.error(error);
  process.exit(1);
});
