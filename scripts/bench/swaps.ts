/**
 * Byten och flyttar's measurement: the swaps and chains of one lesson in a
 * högstadium test school, through the real service on the API's role and real
 * Postgres, and one real apply and its undo.
 *
 *   PROBE_OWNER_URL=postgresql://postgres:…@127.0.0.1:<port>/schemapro \
 *   DATABASE_URL=postgresql://app_authenticated:…@127.0.0.1:<port>/schemapro \
 *   npx ts-node --transpile-only scripts/bench/swaps.ts [lessons] [rounds]
 *
 * THE SCHOOL is the shape optimization-engine/benchmarks/hogstadium.py
 * measures the generator on: three years of six classes of 25 pupils, per class
 * and week matematik 3, svenska 3, engelska 2, NO 3, SO 3, idrott 2, bild 1,
 * musik 1, slöjd 1, hem- och konsumentkunskap 1 and teknik 1 in lessons of 60
 * minutes; per year two parallel blocks of five teaching groups of 30 (språkval
 * 2 × 60, elevens val 1 × 60) cut across the classes, each group with its own
 * teacher and room. Laid by a seeded randomised greedy so that nothing
 * double-books: this measures the search over a school with that many lessons
 * and that many parallel structures, not the quality of the timetable.
 *
 * WHAT IS MEASURED. Per lesson, the whole request as the API serves it in a
 * fresh transaction: the snapshot read, the cohorts, the search, the judging.
 * Every request is PAIRED with a fixed CPU calibration taken immediately
 * before it, because the host is shared and its load inflates wall-clock
 * latency (CPU time much less; both are printed, and the calibration is
 * constant work, so request / calibration is the load-free figure). Then
 * rounds of eight requests at once, the way eight browsers ask one API instance.
 *
 * Not a CI check: wall-clock numbers on a shared host measure the host.
 */
import os from 'node:os';
import { Client } from 'pg';
import { Role } from '../../src/auth/enums/role.enum';
import type { AuthenticatedUser } from '../../src/auth/interfaces/authenticated-user.interface';
import { MasterLessonsService } from '../../src/calendar/master-lessons.service';
import { ScheduleVersionsService } from '../../src/calendar/schedule-versions.service';
import { PrismaService } from '../../src/database/prisma.service';
import { SwapsService } from '../../src/swaps/swaps.service';
import { seedHogstadium, YEARS } from '../fixtures/hogstadium-week';

const SLUG = 'bench-byten';

const quantile = (values: number[], q: number) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]!;
};

/** Milliseconds of CPU this process has used: user plus system. */
const cpuMs = (): number => {
  const usage = process.cpuUsage();
  return (usage.user + usage.system) / 1000;
};

/**
 * A fixed amount of CPU work, timed in wall clock and in CPU time: what the
 * host charges for it right now. Measured alone on this Mac it takes about
 * 175 ms of CPU; on an oversubscribed one the wall clock takes whatever the
 * queue does, and the CPU time stays near that floor.
 */
function calibrate(): { wall: number; cpu: number } {
  const started = process.hrtime.bigint();
  const cpu = cpuMs();
  let x = 1;
  for (let i = 0; i < 4_000_000; i++) x = (x * 1664525 + 1013904223) % 4294967296;
  if (x === -1) console.log(x);
  return { wall: Number(process.hrtime.bigint() - started) / 1e6, cpu: cpuMs() - cpu };
}

async function main() {
  const sample = Number(process.argv[2] ?? 40);
  const rounds = Number(process.argv[3] ?? 5);
  const owner = new Client({ connectionString: process.env['PROBE_OWNER_URL'] });
  await owner.connect();
  const api = new PrismaService();
  await api.onModuleInit();
  // withRls gives a transaction 15 s. On a host that other work has taken to a load average
  // of a hundred a single request outlives that, which measures the host; WAIT_MS lifts it.
  const patience = Number(process.env['WAIT_MS'] ?? 0);
  if (patience > 0) {
    const withRls = api.withRls.bind(api) as (user: unknown, run: unknown, options?: object) => Promise<unknown>;
    (api as unknown as { withRls: typeof withRls }).withRls = (user, run, options) => withRls(user, run, { ...options, timeoutMs: patience });
    // ...and a transaction waits 2 s for a connection by default, which a host that busy does not give.
    const transaction = api.$transaction.bind(api) as (fn: unknown, options?: object) => Promise<unknown>;
    (api as unknown as { $transaction: typeof transaction }).$transaction = (fn, options) => transaction(fn, { ...options, maxWait: patience });
  }
  const one = async <T extends object>(sql: string, params: unknown[] = []): Promise<T> => (await owner.query<T>(sql, params)).rows[0]!;
  await owner.query(`DELETE FROM "Schools" WHERE slug = $1`, [SLUG]);
  try {
    const seeded = await seedHogstadium(owner, { slug: SLUG });
    const { school, admin, adminAuth, classes, lessons } = seeded;
    const one = async <T extends object>(sql: string, params: unknown[] = []): Promise<T> => (await owner.query<T>(sql, params)).rows[0]!;
    console.log(
      `school: ${classes.length} classes, ${classes.length * 25} pupils, ${seeded.teacherIds.length} teachers, ${lessons.length} lessons ` +
        `(${lessons.filter((l) => l.groupId !== l.classId).length} in ${YEARS.length * 3} block cards), load average ${os.loadavg().map((v) => v.toFixed(0)).join('/')}`,
    );

    // --- the service, on the API's role ----------------------------------------------------------
    const realtime = { notifyMasterTimetableChanged: () => undefined };
    const notifications = { recipientsForLessons: async () => [], notifyUsers: async () => undefined };
    const masterLessons = new MasterLessonsService(api, realtime as never, notifications as never);
    const swaps = new SwapsService(api, masterLessons, new ScheduleVersionsService(api), realtime as never, notifications as never);
    const asAdmin: AuthenticatedUser = { authId: adminAuth, role: Role.SCHOOL_ADMIN, userId: admin, schoolId: school, channel: 'WEB', adminProfile: 'FULL' as never, hrRead: false };

    // A spread of lessons: every class, every kind of subject, the block cards.
    const picked = lessons.filter((_, i) => i % Math.max(1, Math.floor(lessons.length / sample)) === 0).slice(0, sample);
    await swaps.suggest({ lessonId: picked[0]!.id }, asAdmin); // warm the pool and the JIT
    const timed: Array<{ ms: number; cpu: number; calibration: number; calibrationCpu: number; proposals: number; swaps: number; chains: number; truncated: boolean; chainsCut: boolean; candidates: number; judged: number; refused: number; unit: number; phases: { read: number; index: number; warm: number; search: number } }> = [];
    for (const lesson of picked) {
      const calibration = calibrate();
      const started = Date.now();
      const cpuStarted = cpuMs();
      const answer = await swaps.suggest({ lessonId: lesson.id }, asAdmin);
      timed.push({
        ms: Date.now() - started,
        cpu: cpuMs() - cpuStarted,
        calibration: calibration.wall,
        calibrationCpu: calibration.cpu,
        proposals: answer.proposals.length,
        swaps: answer.proposals.filter((p) => p.kind === 'SWAP').length,
        chains: answer.proposals.filter((p) => p.kind === 'CHAIN').length,
        truncated: answer.stats.truncated,
        chainsCut: answer.stats.chainsCut,
        candidates: answer.stats.candidates,
        judged: answer.stats.judged,
        refused: answer.stats.refused,
        unit: answer.unit.lessonIds.length,
        phases: answer.stats.phasesMs,
      });
    }
    const ms = timed.map((t) => t.ms);
    const ratio = timed.map((t) => t.ms / t.calibration);
    const cpuRatio = timed.map((t) => t.cpu / t.calibrationCpu);
    console.log(`\nsequential, ${timed.length} lessons, load average ${os.loadavg().map((v) => v.toFixed(0)).join('/')} (each request paired with a fixed CPU calibration taken just before it)`);
    console.log(`  calibration   median ${quantile(timed.map((t) => t.calibration), 0.5).toFixed(0)} ms wall, ${quantile(timed.map((t) => t.calibrationCpu), 0.5).toFixed(0)} ms CPU`);
    console.log(`  request       min ${Math.min(...ms)} ms   median ${quantile(ms, 0.5)} ms   p95 ${quantile(ms, 0.95)} ms   max ${Math.max(...ms)} ms   (CPU median ${quantile(timed.map((t) => t.cpu), 0.5).toFixed(0)} ms)`);
    console.log(`  request ÷ calibration   wall median ${quantile(ratio, 0.5).toFixed(2)} p95 ${quantile(ratio, 0.95).toFixed(2)};  CPU median ${quantile(cpuRatio, 0.5).toFixed(2)} p95 ${quantile(cpuRatio, 0.95).toFixed(2)}`);
    console.log(
      `  answers   proposals median ${quantile(timed.map((t) => t.proposals), 0.5)} (swaps ${quantile(timed.map((t) => t.swaps), 0.5)}, chains ${quantile(timed.map((t) => t.chains), 0.5)}), ` +
        `candidates median ${quantile(timed.map((t) => t.candidates), 0.5)}, judged median ${quantile(timed.map((t) => t.judged), 0.5)}, refused median ${quantile(timed.map((t) => t.refused), 0.5)}, ` +
        `ended by the budget ${timed.filter((t) => t.truncated).length}, chains cut to the cheapest ${timed.filter((t) => t.chainsCut).length}, units of more than one lesson ${timed.filter((t) => t.unit > 1).length}`,
    );
    for (const phase of ['read', 'index', 'warm', 'search'] as const) {
      console.log(`  ${phase.padEnd(7)} median ${quantile(timed.map((t) => t.phases[phase]), 0.5)} ms   p95 ${quantile(timed.map((t) => t.phases[phase]), 0.95)} ms`);
    }
    // The host's load only ever ADDS to a request, so the best of a few identical requests is the
    // closest thing to the request on a quiet machine: the minimum per lesson, then their median and p95.
    const repeats = Number(process.env['BEST_OF'] ?? 5);
    if (repeats > 1) {
      const best: Array<{ ms: number; cpu: number; read: number; index: number; warm: number; search: number }> = [];
      for (const lesson of picked.slice(0, 12)) {
        const runs: typeof best = [];
        for (let i = 0; i < repeats; i++) {
          const wall = Date.now();
          const cpu = cpuMs();
          const answer = await swaps.suggest({ lessonId: lesson.id }, asAdmin);
          runs.push({ ms: Date.now() - wall, cpu: cpuMs() - cpu, ...answer.stats.phasesMs });
        }
        best.push({
          ms: Math.min(...runs.map((r) => r.ms)),
          cpu: Math.min(...runs.map((r) => r.cpu)),
          read: Math.min(...runs.map((r) => r.read)),
          index: Math.min(...runs.map((r) => r.index)),
          warm: Math.min(...runs.map((r) => r.warm)),
          search: Math.min(...runs.map((r) => r.search)),
        });
      }
      console.log(`best of ${repeats}, ${best.length} lessons (per lesson the minimum, then median and p95 of those)`);
      for (const key of ['ms', 'cpu', 'read', 'index', 'warm', 'search'] as const) {
        console.log(`  ${key === 'ms' ? 'wall' : key === 'cpu' ? 'CPU' : key} ${quantile(best.map((b) => b[key]), 0.5).toFixed(0)} ms median, ${quantile(best.map((b) => b[key]), 0.95).toFixed(0)} ms p95`);
      }
    }
    const concurrent: number[] = [];
    const concurrentCalibration: number[] = [];
    for (let round = 0; round < rounds; round++) {
      const eight = picked.slice(round * 8, round * 8 + 8);
      if (eight.length < 8) break;
      const calibration = calibrate();
      const started = Date.now();
      const answers = await Promise.all(
        eight.map(async (lesson) => {
          const at = Date.now();
          await swaps.suggest({ lessonId: lesson.id }, asAdmin);
          return Date.now() - at;
        }),
      );
      concurrent.push(...answers);
      concurrentCalibration.push(calibration.wall);
      console.log(`  round ${round + 1}: eight at once in ${Date.now() - started} ms (calibration ${calibration.wall.toFixed(0)} ms)`);
    }
    if (concurrent.length > 0) {
      console.log(`eight at once   request median ${quantile(concurrent, 0.5)} ms   p95 ${quantile(concurrent, 0.95)} ms   (${concurrent.length} requests)`);
    }

    // --- one real apply and its undo ----------------------------------------------------------------
    const target = picked.find((l) => l.groupId === l.classId)!;
    const offer = await swaps.suggest({ lessonId: target.id }, asAdmin);
    const swap = offer.proposals.find((p) => p.kind === 'SWAP');
    if (swap) {
      const clock = (m: number) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
      const body = (moves: typeof swap.moves) => ({
        lessonId: target.id,
        moves: moves.map((m) => ({
          lessonId: m.lessonId,
          from: { dayOfWeek: m.from.dayOfWeek, startTime: clock(m.from.startMinutes), endTime: clock(m.from.endMinutes) },
          to: { dayOfWeek: m.to.dayOfWeek, startTime: clock(m.to.startMinutes), endTime: clock(m.to.endMinutes) },
        })),
      });
      const before = await owner.query(`SELECT id, "dayOfWeek", "startTime"::text FROM "MasterLessons" WHERE id = ANY($1::uuid[]) ORDER BY id`, [swap.moves.map((m) => m.lessonId)]);
      const applied = await swaps.apply(body(swap.moves), asAdmin);
      const during = await owner.query(`SELECT id, "dayOfWeek", "startTime"::text FROM "MasterLessons" WHERE id = ANY($1::uuid[]) ORDER BY id`, [swap.moves.map((m) => m.lessonId)]);
      const logs = Number((await one<{ n: string }>(`SELECT count(*) AS n FROM "ScheduleChangeLogs" WHERE "schoolId" = $1`, [school])).n);
      const versions = await owner.query(`SELECT name, "lessonCount" FROM "ScheduleVersions" WHERE "schoolId" = $1`, [school]);
      await swaps.apply(body(applied.undo), asAdmin);
      const after = await owner.query(`SELECT id, "dayOfWeek", "startTime"::text FROM "MasterLessons" WHERE id = ANY($1::uuid[]) ORDER BY id`, [swap.moves.map((m) => m.lessonId)]);
      console.log(
        `\napply: ${swap.moves.length} lessons moved (${JSON.stringify(before.rows) === JSON.stringify(during.rows) ? 'NOTHING CHANGED' : 'changed'}), ` +
          `${logs} change-log rows, versions ${JSON.stringify(versions.rows)}, undo ${JSON.stringify(before.rows) === JSON.stringify(after.rows) ? 'restored every lesson' : 'DID NOT RESTORE'}`,
      );
    } else {
      console.log('\napply: no swap to apply for the sampled lesson');
    }
  } finally {
    // KEEP=1 leaves the school for a closer look (the next run replaces it).
    if (!process.env['KEEP']) await owner.query(`DELETE FROM "Schools" WHERE slug = $1`, [SLUG]);
    await owner.end();
    await api.onModuleDestroy?.();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
