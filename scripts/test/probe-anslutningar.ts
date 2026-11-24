/**
 * Anslutningarna: what a long fetch of a school's week does to the rest of the API, against a real
 * database and a real pool, as the API role under row security.
 *
 *   DATABASE_URL='postgresql://app_authenticated:app_authenticated_local@localhost:5432/schemapro?schema=public&connection_limit=2' \
 *   PROBE_OWNER_URL='postgresql://postgres:postgres_local@localhost:5432/schemapro' \
 *   npx ts-node --transpile-only scripts/test/probe-anslutningar.ts
 *
 * THE INCIDENT (2026-11-23). The real school ran Kontrollera veckan and Generera, and for 26 s every other request
 * answered 500 "Unable to start a transaction in the given time" and ten background jobs' ticks failed with the same
 * words. Both start with the same step, prepareSchedule: the whole week of the school read in ONE transaction, some forty
 * statements one after the other, each a round trip to the database. On this machine that is 60 ms. Between a Railway
 * service and a Supabase region 100 ms apart it is four seconds with one connection held and the database idle
 * (idle in transaction) for nearly all of them. With DEPLOYMENT's old connection_limit=1 that connection is the pool, and
 * Prisma gave an interactive transaction 2 s to get one.
 *
 * WHAT IT RUNS. A högstadium of 228 posts (scripts/fixtures/hogstadium-week.ts), and the real services on it:
 * WeekCheckService.check (the engine's answer stubbed) and the fetch Generera makes (prepareSchedule in withRls) AT ONCE,
 * and while they run
 *   - a request every 250 ms (every 1.2 s at a pool of one, which cannot take more): the authenticating batch
 *     (withVerifiedSubject), then a read under the person's claims (withRls), as a page load makes;
 *   - a burst of job ticks at once: the delivery door (withDeliveryService) every job's pass reads or writes through,
 *     which is how ten timers that were registered together all fire together every five minutes.
 * The round trip is made 50 ms long by a pause in pg's Client.query for the API role's connections: what the real
 * statements would cost over a longer wire, and the only thing that is not real.
 *
 *   (a) the fetch really is long: the week is ready, and each takes at least 1.5 s with the shim, or this proves nothing;
 *   (b) A POOL OF 10, the size DEPLOYMENT §3 recommends: no request and no tick fails, none waits for a fetch to end, the
 *       two fetches are held at once and every other call finds a free connection;
 *   (c) A POOL OF 3: two fetches take two of the three connections, and everything else shares the third. Nothing fails
 *       (it waited: CONNECTION_WAIT_MS), where Prisma's own 2 s refused the later calls;
 *   (d) A POOL OF 1, the size DEPLOYMENT used to recommend: the fetches run one after the other and everything queues
 *       behind them. Nothing fails while the queue is shorter than the wait, and it is slow: the probe says by how much;
 *   (e) THE REFUSAL IS A BUSY SERVER: a call that does wait out the pool gets Prisma's P2028 or pg's own "timeout exceeded
 *       when trying to connect", both read by isPoolBusy, and the exception filter answers each as a 503 DATABASE_BUSY.
 *
 * It builds its own school and drops it, and counts on no number the seed or an earlier CI step left.
 */
import { strict as assert } from 'node:assert';
import type { ArgumentsHost } from '@nestjs/common';
import { Client } from 'pg';
import { Role } from '../../src/auth/enums/role.enum';
import type { AuthenticatedUser } from '../../src/auth/interfaces/authenticated-user.interface';
import { HttpExceptionFilter } from '../../src/common/filters/http-exception.filter';
import { isPoolBusy } from '../../src/database/pool-wait';
import { PrismaService } from '../../src/database/prisma.service';
import { OptimizationProxyService } from '../../src/optimization/optimization-proxy.service';
import { WeekCheckService } from '../../src/optimization/week-check.service';
import { seedHogstadium, type SeededSchool } from '../fixtures/hogstadium-week';

const SLUG = 'probe-anslutningar';
/** One way to the database, in ms, added to every statement the API role sends: a round trip is this long. */
const ROUND_TRIP_MS = 50;

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Set ${name}.`);
  return value;
}

let failures = 0;
async function check(label: string, body: () => Promise<void>): Promise<void> {
  try {
    await body();
    console.log(`ok   ${label}`);
  } catch (error) {
    failures += 1;
    console.error(`FAIL ${label}\n     ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** A pause before every statement the API role sends, while `latency.ms` is above zero. The owner's connection is left alone. */
const latency = { ms: 0 };
function installLatency(): () => void {
  const prototype = Client.prototype as unknown as { query: (...args: unknown[]) => unknown };
  const original = prototype.query;
  prototype.query = function (this: { user?: string }, ...args: unknown[]) {
    if (latency.ms <= 0 || this.user !== 'app_authenticated' || typeof args[args.length - 1] === 'function') {
      return original.apply(this, args);
    }
    return sleep(latency.ms).then(() => original.apply(this, args));
  };
  return () => {
    prototype.query = original;
  };
}

function withUrlParams(databaseUrl: string, params: Record<string, string>): string {
  const queryStart = databaseUrl.indexOf('?');
  const base = queryStart === -1 ? databaseUrl : databaseUrl.slice(0, queryStart);
  const query = new URLSearchParams(queryStart === -1 ? '' : databaseUrl.slice(queryStart + 1));
  for (const [key, value] of Object.entries(params)) query.set(key, value);
  return `${base}?${query.toString()}`;
}

/** A PrismaService built as Nest builds it, from DATABASE_URL, for this URL. */
async function openApi(databaseUrl: string): Promise<PrismaService> {
  const previous = process.env['DATABASE_URL'];
  process.env['DATABASE_URL'] = databaseUrl;
  try {
    const api = new PrismaService();
    await api.onModuleInit();
    return api;
  } finally {
    process.env['DATABASE_URL'] = previous;
  }
}

type Kind = 'fetch' | 'request' | 'tick';
interface Outcome {
  kind: Kind;
  ok: boolean;
  ms: number;
  error?: string;
}

interface Run {
  outcomes: Outcome[];
  /** The fetches' own durations, from asking for a connection to the answer. */
  fetchMs: number[];
}

async function scenario(
  appUrl: string,
  seeded: SeededSchool,
  poolSize: number,
  ticks: number,
  /** Between one page load and the next, while a fetch is held. */
  requestEveryMs: number,
): Promise<Run> {
  const api = await openApi(withUrlParams(appUrl, { connection_limit: String(poolSize) }));
  try {
    const user: AuthenticatedUser = {
      authId: seeded.adminAuth,
      role: Role.SCHOOL_ADMIN,
      userId: seeded.admin,
      schoolId: seeded.school,
      channel: 'WEB',
      adminProfile: 'FULL' as never,
      hrRead: false,
    };
    const config = { getOrThrow: () => ({ baseUrl: 'http://127.0.0.1:1', apiKey: 'x', timeoutMs: 1000 }) } as never;
    const http = { post: () => Promise.reject(new Error('the preparation wakes no engine')) } as never;
    const proxy = new OptimizationProxyService(api, http, config, undefined);
    // The engine's answer: Kontrollera veckan's own, so the service runs as it does and only the wait for the engine is left out.
    Object.assign(proxy, {
      callAiEngine: async () => ({ verdict: 'OK', years: [], conflicts: null, skipped: [], elapsedMs: 1 }),
    });
    const weekCheck = new WeekCheckService(api, proxy);

    const outcomes: Outcome[] = [];
    const record = async (kind: Kind, work: () => Promise<unknown>): Promise<number> => {
      const started = Date.now();
      try {
        await work();
        outcomes.push({ kind, ok: true, ms: Date.now() - started });
      } catch (error) {
        outcomes.push({
          kind,
          ok: false,
          ms: Date.now() - started,
          error: error instanceof Error ? error.message.slice(0, 90) : String(error),
        });
      }
      return Date.now() - started;
    };

    // The pool's connections are opened before the pause is switched on, so the run is the wait for one and not the handshake.
    await Promise.all(Array.from({ length: poolSize }, () => api.withRls(user, () => Promise.resolve(null))));
    const prepared = await api.withRls(user, (tx) => proxy.prepareSchedule(tx, seeded.year, user, { requestId: 'probe-ready' }));
    assert.ok(prepared.ready, 'the week is ready to send, or the fetch stops early and is not the long one');
    assert.ok(prepared.payload.requirements.length > 150, `a school of some hundred posts, got ${prepared.payload.requirements.length}`);

    latency.ms = ROUND_TRIP_MS;
    const fetchMs: number[] = [];
    let fetching = 2;
    const finished = (ms: number) => {
      fetchMs.push(ms);
      fetching -= 1;
    };
    const work: Array<Promise<unknown>> = [
      // Kontrollera veckan, as the service runs it.
      record('fetch', () => weekCheck.check(seeded.year, user)).then(finished),
      // Generera's first step (triggerScheduling): the same fetch in the caller's transaction.
      record('fetch', () =>
        api.withRls(user, (tx) => proxy.prepareSchedule(tx, seeded.year, user, { requestId: 'probe-generera' })),
      ).then(finished),
    ];

    // The job ticks, all at once, a moment after the fetches took their connections.
    await sleep(300);
    for (let i = 0; i < ticks; i += 1) {
      work.push(
        record('tick', () => api.withDeliveryService((tx) => tx.$queryRaw`SELECT job FROM app.job_runs_latest()`)),
      );
    }
    // A page load every `requestEveryMs` for as long as a fetch is held: the batch that authenticates, then a read as the person.
    while (fetching > 0) {
      work.push(
        record('request', async () => {
          await api.withVerifiedSubject(user.authId, (db) => db.user.findFirst({ where: { authId: user.authId }, select: { id: true } }));
          await api.withRls(user, (tx) => tx.user.count({ where: { role: 'TEACHER' } }));
        }),
      );
      await sleep(requestEveryMs);
    }
    await Promise.all(work);
    return { outcomes, fetchMs };
  } finally {
    latency.ms = 0;
    await api.$disconnect();
  }
}

const slowest = (outcomes: Outcome[], kind: Kind): number => Math.max(0, ...outcomes.filter((o) => o.kind === kind).map((o) => o.ms));
const failed = (outcomes: Outcome[]): Outcome[] => outcomes.filter((o) => !o.ok);
function say(label: string, run: Run): void {
  const count = (kind: Kind) => run.outcomes.filter((o) => o.kind === kind).length;
  console.log(
    `     ${label}: fetches ${run.fetchMs.map((ms) => `${(ms / 1000).toFixed(1)} s`).join(' and ')}; ` +
      `${count('request')} requests (slowest ${slowest(run.outcomes, 'request')} ms), ` +
      `${count('tick')} ticks (slowest ${slowest(run.outcomes, 'tick')} ms); ${failed(run.outcomes).length} failed`,
  );
}

async function main(): Promise<void> {
  const appUrl = requiredEnv('DATABASE_URL');
  const owner = new Client({ connectionString: requiredEnv('PROBE_OWNER_URL') });
  await owner.connect();
  const restore = installLatency();
  let seeded: SeededSchool | undefined;
  try {
    await owner.query(`DELETE FROM "Schools" WHERE slug = $1`, [SLUG]);
    seeded = await seedHogstadium(owner, { slug: SLUG, letters: 'ABCDEF', pupils: 25 });
    const school = seeded;

    await check('(a)(b) a pool of 10, what DEPLOYMENT recommends: two fetches held at once and no request or tick fails or waits for them', async () => {
      const run = await scenario(appUrl, school, 10, 10, 250);
      say('pool 10', run);
      assert.ok(Math.min(...run.fetchMs) >= 1500, `the fetch is long (${run.fetchMs.join(', ')} ms), or the shim did not take`);
      assert.deepEqual(failed(run.outcomes), []);
      // Nobody queued behind a fetch: the slowest page load is a few round trips, not the length of a fetch.
      assert.ok(slowest(run.outcomes, 'request') < Math.min(...run.fetchMs) * 0.75, 'a request waited for a fetch to end');
      assert.ok(slowest(run.outcomes, 'tick') < Math.min(...run.fetchMs) * 0.75, 'a tick waited for a fetch to end');
    });

    await check('(c) a pool of 3: the two fetches take two connections, everything else shares the third and waits its turn instead of failing', async () => {
      const run = await scenario(appUrl, school, 3, 10, 250);
      say('pool 3', run);
      assert.deepEqual(failed(run.outcomes), []);
    });

    await check('(d) a pool of 1, the old recommendation: a queue behind the fetches, but a queue that is shorter than the wait', async () => {
      const run = await scenario(appUrl, school, 1, 4, 1200);
      say('pool 1', run);
      assert.deepEqual(failed(run.outcomes), []);
      // Slow is what a pool of one is: some call waited for both fetches. That is why DEPLOYMENT no longer recommends it.
      assert.ok(
        Math.max(slowest(run.outcomes, 'request'), slowest(run.outcomes, 'tick')) > Math.min(...run.fetchMs),
        'a call waited behind the fetches',
      );
    });

    await check('(e) a call that waits out the pool is refused as a busy server: Prisma\'s P2028 and pg\'s own timeout are both read, and both are a 503', async () => {
      const filter = new HttpExceptionFilter();
      Object.assign(filter, { logger: { warn: () => undefined, error: () => undefined } });
      const answer = (error: unknown): { status: number; body: { code?: string } } => {
        let status = 0;
        let body: { code?: string } = {};
        const response = {
          status: (value: number) => ((status = value), response),
          setHeader: () => response,
          json: (value: { code?: string }) => ((body = value), response),
        };
        const host = {
          switchToHttp: () => ({ getRequest: () => ({ method: 'GET', url: '/api/v1/users' }), getResponse: () => response }),
        } as unknown as ArgumentsHost;
        filter.catch(error, host);
        return { status, body };
      };
      const user: AuthenticatedUser = { authId: school.adminAuth, role: Role.SCHOOL_ADMIN, userId: school.admin, schoolId: school.school, channel: 'WEB' };

      // Prisma's wait: a pool of one, held for a second and a half, asked for a connection that waits 300 ms.
      const prisma = await openApi(withUrlParams(appUrl, { connection_limit: '1' }));
      try {
        const holder = prisma.withRls(user, () => sleep(1500));
        await sleep(200);
        const error = await prisma.$transaction(async (tx) => tx.$queryRaw`SELECT 1`, { maxWait: 300 }).then(
          () => undefined,
          (thrown: unknown) => thrown,
        );
        await holder;
        assert.ok(error, 'the wait ended in an error');
        assert.ok(isPoolBusy(error), `isPoolBusy reads Prisma's own error: ${String((error as Error).message)}`);
        assert.deepEqual([answer(error).status, answer(error).body.code], [503, 'DATABASE_BUSY']);
      } finally {
        await prisma.$disconnect();
      }

      // pg's wait: the URL's pool_timeout is one second, so pg gives up before Prisma's ten.
      const impatient = await openApi(withUrlParams(appUrl, { connection_limit: '1', pool_timeout: '1' }));
      try {
        const holder = impatient.withRls(user, () => sleep(2500));
        await sleep(200);
        const error = await impatient.withRls(user, () => Promise.resolve(null)).then(
          () => undefined,
          (thrown: unknown) => thrown,
        );
        await holder;
        assert.ok(error, 'pg gave up waiting');
        assert.ok(isPoolBusy(error), `isPoolBusy reads pg's own error: ${String((error as Error).message)}`);
        assert.deepEqual([answer(error).status, answer(error).body.code], [503, 'DATABASE_BUSY']);
      } finally {
        await impatient.$disconnect();
      }
    });
  } finally {
    restore();
    await owner.query(`DELETE FROM "Schools" WHERE slug = $1`, [SLUG]);
    await owner.end();
  }
  if (failures > 0) {
    console.error(`\n${failures} check(s) failed.`);
    process.exit(1);
  }
  console.log('\nAll connection checks passed.');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
