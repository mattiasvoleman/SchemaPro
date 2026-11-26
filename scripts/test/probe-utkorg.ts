/**
 * Den utgående kön (H3, 20270309090000) against a real database, through the real delivery, as the API's role, with a Resend and
 * an Expo that are servers of the probe's own:
 *
 *   DATABASE_URL='postgresql://app_authenticated:app_authenticated_local@localhost:5432/schemapro?schema=public&connection_limit=2' \
 *   PROBE_OWNER_URL='postgresql://postgres:postgres_local@localhost:5432/schemapro' \
 *   npx ts-node --transpile-only scripts/test/probe-utkorg.ts
 *
 * The jest specs hold the delivery's rules with the queue in memory (src/notifications/notification-delivery.service.spec.ts) and the
 * RLS suite holds the database's (sections 590-592 and 590o-594o). This is what neither can see: a process that is killed, not
 * stopped, and two processes that ask for the same row at the same moment.
 *
 *   (a) A PROCESS KILLED IN THE MIDDLE OF A QUEUE. Three notices to a hundred and fifty people by mail and push, and an alarm,
 *       are written; a child process takes them up and is killed with SIGKILL while a mail is on its way to Resend (Resend has
 *       taken it, the answer never comes). The lease runs out (the database's clock is not moved: the row's lease is set a second
 *       into the past, which is what two minutes' waiting does); a second process takes the queue up where the first left it. Every
 *       mail packet reached Resend once as a delivery (the one on its way was asked for twice, under one key, and answered as it was),
 *       every device got every notice once, the rows are finished and hold nothing about a person.
 *   (a2) THE SAME FOR A PUSH. A process killed while a push packet is on its way to Expo: the packet is not sent again. Every device
 *       gets every notice at most once, and here, since Expo took the packet, once.
 *   (b) TWO PROCESSES AT ONCE take one queue between them: no row is taken twice (attempts 1), no mail is asked for twice, no device
 *       is sent to twice, and the fleet keeps one pace (the mails reach Resend a step apart whichever process sends them).
 *   (c) TWELVE CONNECTIONS AT ONCE ask for five rows: five rows are taken, each by one connection, and seven get nothing, in ten rounds.
 *
 * It builds its own school and drops it; it counts on no row the seed or an earlier step left.
 */
import { strict as assert } from 'node:assert';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Client } from 'pg';
import { PrismaService } from '../../src/database/prisma.service';
import { ExpoPushClient } from '../../src/notifications/expo-push.client';
import { NotificationDeliveryService } from '../../src/notifications/notification-delivery.service';
import type { OutboxEntry } from '../../src/notifications/notification-outbox';

const MARKER = 'h3-utkorg';
const USERS = 150;

const requiredEnv = (name: string): string => {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set; see the header of scripts/test/probe-utkorg.ts.`);
  return value;
};

// ---------------------------------------------------------------------------
// The child: a process that takes the queue up, as the gateway does, with the providers pointed at the probe's servers.

async function consume(): Promise<void> {
  const resendBase = requiredEnv('PROBE_RESEND_BASE');
  const expoBase = requiredEnv('PROBE_EXPO_BASE');
  const realFetch = globalThis.fetch;
  // The delivery posts to Resend's own address; the real fetch is pointed at the probe's server instead.
  globalThis.fetch = ((url: string, init?: RequestInit) => realFetch(String(url).replace('https://api.resend.com', resendBase), init)) as typeof fetch;
  const channels = (process.env['PROBE_CHANNELS'] ?? 'mail,push').split(',');
  if (!channels.includes('mail')) delete process.env['RESEND_API_KEY'];
  const config = { get: (key: string) => (key === 'push' ? { enabled: channels.includes('push'), apiUrl: expoBase } : undefined) };
  const api = new PrismaService();
  const delivery = new NotificationDeliveryService(api, config as never, new ExpoPushClient({ apiUrl: expoBase }));
  await delivery.tick();
  console.log(`CHILD ${JSON.stringify((delivery as unknown as { stats: Record<string, number> }).stats)}`);
  await api.$disconnect();
  process.exit(0);
}

// ---------------------------------------------------------------------------
// The providers: Resend as it answers a repeated key (the first request sends, a repeat is answered as it was), and Expo.

interface Resend {
  server: Server;
  base: string;
  /** key -> how many times it was asked for */
  asked: Map<string, number>;
  /** key -> the BCC list and subject of the delivery the first request made */
  sent: Map<string, { bcc: string[]; subject: string }>;
  arrivals: number[];
  heldKey: string | null;
  /** Holds the Nth first-time request: it is taken (sent) and its answer never comes. */
  holdAt: number | null;
  firstTime: number;
}

const readBody = (req: IncomingMessage): Promise<string> =>
  new Promise((resolve) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
  });

async function listen(handler: (req: IncomingMessage, res: ServerResponse) => void): Promise<{ server: Server; base: string }> {
  const server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { server, base: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
}

async function resendServer(holdAt: number | null): Promise<Resend> {
  const state = { asked: new Map<string, number>(), sent: new Map<string, { bcc: string[]; subject: string }>(), arrivals: [] as number[], heldKey: null as string | null, holdAt, firstTime: 0 };
  const { server, base } = await listen(async (req, res) => {
    const body = JSON.parse(await readBody(req)) as { bcc: string[]; subject: string };
    const key = String(req.headers['idempotency-key']);
    state.arrivals.push(Date.now());
    const times = (state.asked.get(key) ?? 0) + 1;
    state.asked.set(key, times);
    if (times === 1) {
      state.sent.set(key, { bcc: body.bcc, subject: body.subject });
      state.firstTime += 1;
      if (state.holdAt === state.firstTime) {
        state.heldKey = key;
        return; // taken, and the answer never comes: the process dies before it hears
      }
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ id: `mail-${key.length}` }));
  });
  return { server, base, ...state, get heldKey() { return state.heldKey; }, get firstTime() { return state.firstTime; } } as Resend;
}

interface Expo {
  server: Server;
  base: string;
  /** "<token>|<notificationId>" -> how many times it was sent */
  received: Map<string, number>;
  requests: { n: number; heldAt: number | null };
}

async function expoServer(holdAt: number | null): Promise<Expo> {
  const received = new Map<string, number>();
  const requests = { n: 0, heldAt: null as number | null };
  let tickets = 0;
  const { server, base } = await listen(async (req, res) => {
    const messages = JSON.parse(await readBody(req)) as Array<{ to: string; data: { notificationId: string } }>;
    requests.n += 1;
    for (const m of messages) received.set(`${m.to}|${m.data.notificationId}`, (received.get(`${m.to}|${m.data.notificationId}`) ?? 0) + 1);
    if (holdAt === requests.n) {
      requests.heldAt = requests.n;
      return; // taken, and the answer never comes
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ data: messages.map(() => ({ status: 'ok', id: `probe-ticket-${(tickets += 1)}-abcdef` })) }));
  });
  return { server, base, received, requests };
}

const close = (server: Server): Promise<void> =>
  new Promise((resolve) => {
    server.closeAllConnections();
    server.close(() => resolve());
  });

// ---------------------------------------------------------------------------

interface Child {
  done: Promise<{ code: number | null; signal: NodeJS.Signals | null; out: string }>;
  kill: () => void;
}

function spawnChild(env: Record<string, string>): Child {
  // Its own process group, so that a kill takes npx and the node under it together and at once.
  const child = spawn('npx', ['ts-node', '--transpile-only', 'scripts/test/probe-utkorg.ts', 'consume'], {
    env: { ...process.env, RESEND_API_KEY: 'probe-key', ...env },
    stdio: ['ignore', 'pipe', 'inherit'],
    detached: true,
  });
  let out = '';
  child.stdout.on('data', (chunk: Buffer) => (out += chunk.toString('utf8')));
  return {
    done: new Promise((resolve) => child.on('exit', (code, signal) => resolve({ code, signal, out }))),
    kill: () => {
      try {
        process.kill(-child.pid!, 'SIGKILL');
      } catch {
        /* gone already */
      }
    },
  };
}

const until = async (what: string, condition: () => boolean | Promise<boolean>, limitMs = 120_000): Promise<void> => {
  const stop = Date.now() + limitMs;
  while (!(await condition())) {
    if (Date.now() > stop) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
};

interface Fixture {
  schoolId: string;
  userIds: string[];
  emails: string[];
  tokens: string[];
}

async function main(): Promise<void> {
  const owner = new Client({ connectionString: requiredEnv('PROBE_OWNER_URL') });
  await owner.connect();
  const api = new PrismaService();
  let failures = 0;
  const check = async (label: string, body: () => Promise<void>): Promise<void> => {
    try {
      await body();
      console.log(`  ok   ${label}`);
    } catch (error) {
      failures += 1;
      console.error(`  FAIL ${label}\n       ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  const drop = () => owner.query(`DELETE FROM "Schools" WHERE slug = $1`, [MARKER]);
  await drop();
  const fixture: Fixture = await (async () => {
    const school = (await owner.query<{ id: string }>(`INSERT INTO "Schools" (name, slug, timezone, "updatedAt") VALUES ($1, $2, 'Europe/Stockholm', now()) RETURNING id`, [`${MARKER} kön`, MARKER])).rows[0]!.id;
    const users = (
      await owner.query<{ id: string; email: string }>(
        `INSERT INTO "Users" ("schoolId", email, "firstName", "lastName", role, "authId", "updatedAt")
         SELECT $1, 'h3-' || i || '@example.invalid', 'H', 'U' || i, 'GUARDIAN', gen_random_uuid(), now() FROM generate_series(1, $2::int) i RETURNING id, email`,
        [school, USERS],
      )
    ).rows;
    const tokens = (
      await owner.query<{ token: string }>(
        `INSERT INTO "DevicePushTokens" ("schoolId", "userId", token, platform)
         SELECT $1, u.id, 'ExponentPushToken[h3probe' || row_number() OVER (ORDER BY u.id) || 'xxxxxxxx]', 'IOS' FROM "Users" u WHERE u."schoolId" = $1 RETURNING token`,
        [school],
      )
    ).rows;
    return { schoolId: school, userIds: users.map((u) => u.id), emails: users.map((u) => u.email), tokens: tokens.map((t) => t.token) };
  })();

  // What the delivery is handed after a commit: entries, with the addresses the producers knew (the queue keeps none).
  const entry = (people: string[], subject: string, type: OutboxEntry['type'] = 'LESSON_CANCELLED'): OutboxEntry => ({
    schoolId: fixture.schoolId,
    type,
    meta: { subjectName: subject, startsAt: '2026-10-13T06:00:00.000Z' },
    recipients: people.map((userId) => ({ userId, notificationId: randomUUID() })),
    email: { subject, body: 'B', recipients: [] },
  });
  /** A delivery that only writes: its lanes are stopped, so the rows wait for the children. */
  const writer = (channels: string[]): NotificationDeliveryService => {
    process.env['RESEND_API_KEY'] = channels.includes('mail') ? 'probe-key' : '';
    const config = { get: (key: string) => (key === 'push' ? { enabled: channels.includes('push'), apiUrl: 'http://127.0.0.1:1' } : undefined) };
    const delivery = new NotificationDeliveryService(api, config as never, new ExpoPushClient({ apiUrl: 'http://127.0.0.1:1' }));
    (delivery as unknown as { stopping: boolean }).stopping = true;
    return delivery;
  };
  const queueRows = async () =>
    (
      await owner.query<{ status: string; attempts: number; people: number; noplan: boolean; mail_done: number; push_done: number; urgent: boolean }>(
        `SELECT status, attempts, cardinality("recipientIds") AS people, plan IS NULL AS noplan, "mailDone" AS mail_done, "pushDone" AS push_done, urgent
           FROM "OutboundNotices" WHERE "schoolId" = $1 ORDER BY "createdAt"`,
        [fixture.schoolId],
      )
    ).rows;
  const clear = () => owner.query(`DELETE FROM "OutboundNotices" WHERE "schoolId" = $1`, [fixture.schoolId]);
  const expireLeases = () => owner.query(`UPDATE "OutboundNotices" SET "leaseUntil" = clock_timestamp() - interval '1 second' WHERE status = 'CLAIMED' AND "schoolId" = $1`, [fixture.schoolId]);

  try {
    // (a) -------------------------------------------------------------------
    await check('(a) a process killed with a mail on its way: the next takes the queue up and every mail reaches Resend once, every device every notice once', async () => {
      await clear();
      const resend = await resendServer(5);
      const expo = await expoServer(null);
      try {
        const people = fixture.userIds;
        const notices = ['S1', 'S2', 'S3'].map((subject) => entry(people, subject));
        const alarm = entry(people.slice(0, 10), 'ALARM', 'CRISIS_ALARM');
        const delivery = writer(['mail', 'push']);
        for (const one of notices) await delivery.enqueue([one]);
        await delivery.enqueue([alarm]);
        assert.equal((await queueRows()).length, 4, 'four rows are waiting');

        const first = spawnChild({ PROBE_RESEND_BASE: resend.base, PROBE_EXPO_BASE: expo.base });
        await until('the fifth mail to be on its way', () => resend.firstTime >= 5 && resend.heldKey !== null);
        first.kill();
        const ended = await first.done;
        assert.ok(ended.signal === 'SIGKILL' || ended.code === null || ended.code !== 0, `the first process was killed, not finished: ${JSON.stringify({ code: ended.code, signal: ended.signal })}`);
        const mid = await queueRows();
        console.log(`       (a) the process was killed with ${resend.firstTime} mails taken by Resend and ${mid.filter((row) => row.status !== 'DONE').length} of 4 rows not done`);
        assert.ok(mid.some((row) => row.status === 'CLAIMED'), 'a row is held by the dead process');
        assert.ok(mid.some((row) => row.status !== 'DONE'), 'the queue is not empty');
        const held = resend.heldKey!;

        // Two minutes pass: the dead process's lease has run out.
        await expireLeases();
        const second = await spawnChild({ PROBE_RESEND_BASE: resend.base, PROBE_EXPO_BASE: expo.base }).done;
        assert.equal(second.code, 0, `the second process finished: ${second.out}`);

        const rows = await queueRows();
        assert.deepEqual(rows.map((r) => r.status), ['DONE', 'DONE', 'DONE', 'DONE'], 'every row is done');
        assert.ok(rows.every((r) => r.people === 0 && r.noplan), 'nothing about a person is left on a finished row');
        assert.ok(rows.some((r) => r.attempts === 2), 'the row the first process held was taken a second time');

        // Resend: 12 packets for the three notices (4 each) and 1 for the alarm. Each was delivered once; the one on its way was asked for twice.
        assert.equal(resend.sent.size, 13, 'thirteen different mails reached Resend');
        const repeats = [...resend.asked].filter(([, times]) => times > 1);
        assert.deepEqual(repeats, [[held, 2]], 'only the mail that was on its way was asked for again, and under the same key');
        for (const subject of ['S1', 'S2', 'S3']) {
          const addresses = [...resend.sent.values()].filter((s) => s.subject === subject).flatMap((s) => s.bcc);
          assert.equal(addresses.length, USERS, `${subject}: a hundred and fifty addresses`);
          assert.deepEqual([...new Set(addresses)].sort(), [...fixture.emails].sort(), `${subject}: everybody once`);
        }

        // Expo: every (device, notice) once. 3 x 150 and the alarm's 10.
        assert.equal(expo.received.size, 3 * USERS + 10, 'every notice reached every device');
        assert.ok([...expo.received.values()].every((n) => n === 1), 'and none twice');
        assert.equal(expo.requests.n, 3 * 2 + 1, 'in seven requests, none repeated');
        console.log(`       (a) after the restart: ${resend.sent.size} mails delivered once (${[...resend.asked.values()].reduce((a, b) => a + b, 0)} requests), ${expo.received.size} pushes once (${expo.requests.n} requests)`);
      } finally {
        await close(resend.server);
        await close(expo.server);
      }
    });

    // (a2) ------------------------------------------------------------------
    await check('(a2) a process killed with a push on its way: the packet is not sent again, and the rest of the queue goes', async () => {
      await clear();
      const expo = await expoServer(2);
      const resend = await resendServer(null);
      try {
        const delivery = writer(['push']);
        const notice = entry(fixture.userIds, 'P1');
        // Two notices of one kind to one person in one transaction are one push ("2 lektioner är inställda"): 150 pushes in two packets.
        await delivery.enqueue([notice, entry(fixture.userIds, 'P2')]);
        const sent = await queueRows();
        assert.equal(sent.length, 1);

        const first = spawnChild({ PROBE_RESEND_BASE: resend.base, PROBE_EXPO_BASE: expo.base, PROBE_CHANNELS: 'push' });
        await until('the second push request to be on its way', () => expo.requests.heldAt !== null);
        first.kill();
        await first.done;
        const mid = (await queueRows())[0]!;
        assert.equal(mid.status, 'CLAIMED');
        // The counter was moved before the request: the second packet is begun and counted.
        assert.equal(mid.push_done, 2, 'two packets were begun');
        const requestsBefore = expo.requests.n;
        await expireLeases();
        const second = await spawnChild({ PROBE_RESEND_BASE: resend.base, PROBE_EXPO_BASE: expo.base, PROBE_CHANNELS: 'push' }).done;
        assert.equal(second.code, 0, `the second process finished: ${second.out}`);
        const row = (await queueRows())[0]!;
        assert.equal(row.status, 'DONE');
        assert.equal(row.attempts, 2);
        // 150 devices, 2 packets (100 and 50), none repeated.
        assert.equal(requestsBefore, 2, 'two requests were made by the first process');
        assert.equal(expo.requests.n, 2, 'the second process asked for nothing again');
        assert.equal(expo.received.size, USERS, 'every device was sent one push');
        assert.ok([...expo.received.values()].every((n) => n === 1), 'none twice');
      } finally {
        await close(resend.server);
        await close(expo.server);
      }
    });

    // (b) -------------------------------------------------------------------
    await check('(b) two processes at once take one queue between them: no row twice, no mail asked for twice, no device sent to twice, one pace', async () => {
      await clear();
      const resend = await resendServer(null);
      const expo = await expoServer(null);
      try {
        const delivery = writer(['mail', 'push']);
        const people = fixture.userIds.slice(0, 100);
        for (let i = 1; i <= 6; i++) await delivery.enqueue([entry(people, `B${i}`)]);
        assert.equal((await queueRows()).length, 6);

        const env = { PROBE_RESEND_BASE: resend.base, PROBE_EXPO_BASE: expo.base };
        const children = [spawnChild(env), spawnChild(env)];
        const ended = await Promise.all(children.map((child) => child.done));
        assert.deepEqual(ended.map((e) => e.code), [0, 0], `both finished: ${ended.map((e) => e.out).join(' / ')}`);
        const claimed = ended.map((e) => (JSON.parse(/CHILD (.*)/.exec(e.out)![1]!) as { claimed?: number }).claimed ?? 0);

        const rows = await queueRows();
        assert.deepEqual(rows.map((r) => r.status), Array(6).fill('DONE'));
        assert.deepEqual(rows.map((r) => r.attempts), Array(6).fill(1), 'every row was taken once');
        assert.equal(claimed[0]! + claimed[1]!, 6, `six claims between them (${claimed.join(' + ')})`);
        assert.equal(resend.sent.size, 18, 'eighteen different mails (three a notice)');
        assert.ok([...resend.asked.values()].every((n) => n === 1), 'none asked for twice');
        assert.equal(expo.requests.n, 6, 'six push requests');
        assert.equal(expo.received.size, 6 * 100);
        assert.ok([...expo.received.values()].every((n) => n === 1), 'no device twice');

        // The fleet's pace: the mails arrive a step apart (500 ms) whoever sent them. Without it two processes would be twice as close.
        const gaps = resend.arrivals.slice(1).map((at, i) => at - resend.arrivals[i]!);
        const mean = gaps.reduce((a, b) => a + b, 0) / gaps.length;
        console.log(`       (b) ${gaps.length + 1} mails from ${claimed.join(' + ')} claims: ${Math.round(mean)} ms apart on average, the closest ${Math.min(...gaps)} ms (a step is 500)`);
        assert.ok(mean >= 400, `the mails came ${Math.round(mean)} ms apart on average (a step is 500)`);
        assert.ok(Math.min(...gaps) >= 100, `and never closer than 100 ms (the closest was ${Math.min(...gaps)})`);
      } finally {
        await close(resend.server);
        await close(expo.server);
      }
    });

    // (c) -------------------------------------------------------------------
    await check('(c) twelve connections ask for five rows at once: five are taken, each by one, in ten rounds', async () => {
      await clear();
      const delivery = writer(['mail']);
      for (let round = 0; round < 10; round++) {
        await clear();
        for (let i = 0; i < 5; i++) await delivery.enqueue([entry(fixture.userIds.slice(0, 3), `C${i}`)]);
        const clients = await Promise.all(Array.from({ length: 12 }, async () => {
          const client = new Client({ connectionString: requiredEnv('DATABASE_URL') });
          await client.connect();
          return client;
        }));
        try {
          const answers = await Promise.all(
            clients.map((client, i) => client.query<{ notice_id: string }>(`SELECT notice_id::text FROM app.outbound_claim($1, false, interval '2 minutes')`, [`probe-${i}`])),
          );
          const taken = answers.flatMap((a) => a.rows.map((r) => r.notice_id));
          assert.equal(taken.length, 5, `round ${round}: five rows taken, not ${taken.length}`);
          assert.equal(new Set(taken).size, 5, `round ${round}: each row by one connection`);
          const rows = await queueRows();
          assert.ok(rows.every((r) => r.status === 'CLAIMED' && r.attempts === 1), `round ${round}: five rows held, tried once`);
        } finally {
          await Promise.all(clients.map((client) => client.end()));
        }
      }
    });
  } finally {
    await drop();
    await api.$disconnect();
    await owner.end();
  }
  if (failures > 0) {
    console.error(`\n${failures} check(s) failed.`);
    process.exit(1);
  }
  console.log('\nutkorg probe passed.');
}

(process.argv[2] === 'consume' ? consume() : main()).catch((error) => {
  console.error(error);
  process.exit(1);
});
