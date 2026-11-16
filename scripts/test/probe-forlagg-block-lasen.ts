/**
 * Ett block kan förläggas (20270218090000): the locks, between TWO sessions.
 *
 * The RLS suite (sections 500-504) reads the rules of BP409 in one session; a lock cannot be seen from one. This probe runs two
 * real connections, each in a transaction of its own, interleaved with a wait, against Postgres, and reads what the committed rows
 * are afterwards. The triggers are judged AFTER the statement and take the block's row FOR NO KEY UPDATE first, on every path:
 *
 *   race 1  a placement is written for a block while its members' length is changed so that the placement no longer fits: exactly
 *           one of them is refused (BP409 LENGTH) and the block never ends in a set that does not fit;
 *   race 2  a placement is written while a share (a lesson shared between teachers) is written for a member: exactly one is
 *           refused (BP409 SHARES) and the block never ends with both;
 *   race 3  a room row is written for a post while the post LEAVES the block: afterwards no room row is for a post that is not a
 *           member of the placement's block (the leave trigger takes the old block's row first, so it sees the row or the
 *           insert is refused as MEMBER);
 *   race 4  two placements of a block with ONE lesson are written at once: exactly one is refused (BP409 COUNT), which the rule
 *           of the members (TB409) cannot see for it, since no member changes.
 *
 * Each race is run ten times (RACES_N) and no iteration may end in a deadlock (40P01) or a serialization failure.
 *
 * Two hunts then ask a question the races do not: do two paths that take the same two rows in the OPPOSITE order deadlock? Each is a tight
 * loop (HUNT_N attempts) over one planted world, as sessions of the owner with a short deadlock_timeout (the locks are the same whoever
 * asks; a deadlock is found in 20 ms instead of a second):
 *
 *   hunt 1  a member's change of lessons (the post's row, then TB409: the block FOR UPDATE) against a share written for the same member (BP409:
 *           the block FOR NO KEY UPDATE, then TS409: the post FOR NO KEY UPDATE);
 *   hunt 2  one post moves from block X to block Y while another moves from Y to X (TB409: the block it comes to FOR UPDATE, then the leave
 *           trigger: the block it leaves FOR NO KEY UPDATE).
 *
 *   DATABASE_URL='postgresql://app_authenticated:app_authenticated_local@127.0.0.1:5617/schemapro' \
 *   PROBE_OWNER_URL='postgresql://postgres:postgres_local@127.0.0.1:5617/schemapro' \
 *   npx ts-node --transpile-only scripts/test/probe-forlagg-block-lasen.ts
 *
 * DATABASE_URL is the API's role (the races run as the school's own administrator, through the policies); PROBE_OWNER_URL plants and
 * drops the probe's school and, in the mutant run, replaces the functions. Both may point at any database that has the migration.
 *
 * The probe BITES: PROBE_MUTANT=matrix runs each race against the mutant of the function that should lose it (the fit function without
 * its row lock; the leave function without its row lock; both without the lock of TB409 as well, for race 1) and a race that ends in a
 * wrong state at least once in ten "ok"s, one that does not FAILs. The functions are put back verbatim and md5(prosrc) is compared; the
 * originals are also written to a file in the temp directory, which the next run puts back if this one died on the way.
 *
 * A check that fails prints its FAIL line and the run goes on. The exit code is 1 for any FAIL.
 *
 * Independent of what earlier runs left: a school of its own, planted and dropped by this probe, in the year 2095/96.
 */
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from 'pg';

const SLUG = 'probe-forlagg-block-lasen';
const RACES_N = Number(process.env['RACES_N'] ?? 10);
const HUNT_N = Number(process.env['HUNT_N'] ?? 300);
const FIT = 'app.teaching_block_placements_fit()';
const LEAVE = 'app.teaching_block_placement_rooms_leave()';
const TB409 = 'app.teaching_block_members_agree()';
const ORIGINALS_FILE = join(tmpdir(), `${SLUG}.originals.sql`);

// ---------------------------------------------------------------------------
// The checks' own bookkeeping
// ---------------------------------------------------------------------------

let failures = 0;

function summarise(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  return String(error);
}

async function check(label: string, body: () => Promise<string | void>): Promise<void> {
  try {
    const note = await body();
    console.log(`ok   ${label}${note ? ` (${note})` : ''}`);
  } catch (error) {
    failures += 1;
    console.error(`FAIL ${label}\n     ${summarise(error).replace(/\n/g, '\n     ')}`);
  }
}

function must(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** pg does not know Prisma's connection-string options. */
function pgConfig(url: string | undefined, name: string) {
  if (!url) {
    console.error(`${name} is not set (see the head of this file).`);
    process.exit(2);
  }
  const u = new URL(url);
  u.searchParams.delete('schema');
  u.searchParams.delete('connection_limit');
  return { connectionString: u.toString() };
}

// ---------------------------------------------------------------------------
// The world: a school with a year, a class, a teacher, an administrator and two rooms; every iteration plants a block of its own
// ---------------------------------------------------------------------------

interface Ctx {
  school: string;
  year: string;
  group: string;
  teacher: string;
  adminAuthId: string;
  room1: string;
  room2: string;
}

interface World {
  block: string;
  posts: string[];
  placement?: string;
}

async function plantSchool(owner: Client): Promise<Ctx> {
  const one = async <T extends object>(sql: string, params: unknown[] = []): Promise<T> => (await owner.query<T>(sql, params)).rows[0]!;
  const school = (await one<{ id: string }>(`INSERT INTO "Schools" (name, slug, timezone, "updatedAt") VALUES ('Probe block-lås', $1, 'Europe/Stockholm', now()) RETURNING id`, [SLUG])).id;
  const year = (
    await one<{ id: string }>(`INSERT INTO "AcademicYears" ("schoolId", name, "startDate", "endDate", "isActive", "updatedAt") VALUES ($1, 'Probe 2095/96', '2095-08-15', '2096-06-10', true, now()) RETURNING id`, [school])
  ).id;
  const group = (await one<{ id: string }>(`INSERT INTO "StudentGroups" ("schoolId", "academicYearId", name, kind, "gradeLevel", "updatedAt") VALUES ($1, $2, 'PBL 7A', 'CLASS', 7, now()) RETURNING id`, [school, year])).id;
  const person = async (label: string, role: string, adminProfile: string | null) => {
    const authId = randomUUID();
    const row = await one<{ id: string }>(
      `INSERT INTO "Users" ("schoolId", email, "firstName", "lastName", role, "adminProfile", "authId", "isActive", "updatedAt") VALUES ($1, $2, $3, 'Lås', $4, $5, $6, true, now()) RETURNING id`,
      [school, `${SLUG}-${label}@example.invalid`, label, role, adminProfile, authId],
    );
    return { id: row.id, authId };
  };
  const admin = await person('admin', 'SCHOOL_ADMIN', 'FULL');
  const teacher = await person('teacher', 'TEACHER', null);
  const room = async (name: string) => (await one<{ id: string }>(`INSERT INTO "Rooms" ("schoolId", name, "updatedAt") VALUES ($1, $2, now()) RETURNING id`, [school, name])).id;
  return { school, year, group, teacher: teacher.id, adminAuthId: admin.authId, room1: await room('PBL sal 1'), room2: await room('PBL sal 2') };
}

let serial = 0;

/** A block of `members` posts of `lessons` lessons of 60 minutes every week, in subjects of their own, with a placement when asked. */
async function plantBlock(owner: Client, ctx: Ctx, label: string, opts: { members: number; lessons: number; placement?: boolean }): Promise<World> {
  serial += 1;
  const tag = `${label}${serial}`;
  const block = (await owner.query<{ id: string }>(`INSERT INTO "TeachingBlocks" ("schoolId", "academicYearId", name, "updatedAt") VALUES ($1, $2, $3, now()) RETURNING id`, [ctx.school, ctx.year, `pbl ${tag}`])).rows[0]!.id;
  const posts: string[] = [];
  for (let k = 0; k < opts.members; k += 1) {
    const subject = (await owner.query<{ id: string }>(`INSERT INTO "Subjects" ("schoolId", name, code, "updatedAt") VALUES ($1, $2, $3, now()) RETURNING id`, [ctx.school, `pbl ${tag} ${k}`, `PBL${tag}X${k}`.toUpperCase()])).rows[0]!.id;
    posts.push(
      (
        await owner.query<{ id: string }>(
          `INSERT INTO "TeachingRequirements" ("schoolId", "academicYearId", "subjectId", "studentGroupId", "lessonsPerWeek", "minutesPerLesson", "blockId", "updatedAt") VALUES ($1, $2, $3, $4, $5, 60, $6, now()) RETURNING id`,
          [ctx.school, ctx.year, subject, ctx.group, opts.lessons, block],
        )
      ).rows[0]!.id,
    );
  }
  let placement: string | undefined;
  if (opts.placement) {
    placement = (
      await owner.query<{ id: string }>(`INSERT INTO "TeachingBlockPlacements" ("schoolId", "blockId", "academicYearId", "dayOfWeek", "startTime", minutes, "updatedAt") VALUES ($1, $2, $3, 1, '08:00', 60, now()) RETURNING id`, [ctx.school, block, ctx.year])
    ).rows[0]!.id;
  }
  return { block, posts, placement };
}

const insertPlacement = (ctx: Ctx, w: World, day: number): [string, unknown[]] => [
  `INSERT INTO "TeachingBlockPlacements" ("schoolId", "blockId", "academicYearId", "dayOfWeek", "startTime", minutes, "updatedAt") VALUES ($1, $2, $3, $4, '09:00', 60, now())`,
  [ctx.school, w.block, ctx.year, day],
];

// ---------------------------------------------------------------------------
// The two sessions
// ---------------------------------------------------------------------------

interface Outcome {
  ok: boolean;
  code?: string;
  reason?: string;
  message?: string;
}

type Body = (c: Client) => Promise<void>;

/** One transaction as the school's administrator: start after `delay`, run the statement, hold the transaction open for `hold`, commit. */
async function side(c: Client, ctx: Ctx, delay: number, hold: number, body: Body): Promise<Outcome> {
  await sleep(delay);
  try {
    await c.query('BEGIN');
    await c.query(`SELECT set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ sub: ctx.adminAuthId })]);
    await c.query(`SELECT set_config('lock_timeout', '20s', true)`);
    await body(c);
    await sleep(hold);
    await c.query('COMMIT');
    return { ok: true };
  } catch (error) {
    await c.query('ROLLBACK').catch(() => undefined);
    const e = error as { code?: string; detail?: string; message?: string };
    return { ok: false, code: e.code, reason: /reason=([A-Z_]+)/.exec(e.detail ?? '')?.[1], message: e.message };
  }
}

interface Tally {
  iterations: number;
  bad: number;
  deadlocks: number;
  otherErrors: string[];
  /** how the refusals fell: 'BP409 LENGTH' -> count */
  refusals: Map<string, number>;
  /** iterations where exactly one side was refused with BP409 */
  oneRefusal: number;
  /** iterations where neither was refused */
  noRefusal: number;
}

interface RaceSpec {
  label: string;
  plant: (owner: Client, ctx: Ctx) => Promise<World>;
  a: (ctx: Ctx, w: World) => Body;
  b: (ctx: Ctx, w: World) => Body;
  /** the committed rows say the block ended in a state the rules refuse */
  bad: (owner: Client, ctx: Ctx, w: World) => Promise<boolean>;
}

async function race(owner: Client, ctx: Ctx, ca: Client, cb: Client, spec: RaceSpec, n: number, hold = 120): Promise<Tally> {
  const t: Tally = { iterations: 0, bad: 0, deadlocks: 0, otherErrors: [], refusals: new Map(), oneRefusal: 0, noRefusal: 0 };
  for (let i = 0; i < n; i += 1) {
    const w = await spec.plant(owner, ctx);
    // Who starts first alternates; the other starts a little after, inside the first one's open transaction.
    const jitter = 15 + Math.floor(Math.random() * 50);
    const [ra, rb] = await Promise.all([side(ca, ctx, i % 2 === 0 ? 0 : jitter, hold, spec.a(ctx, w)), side(cb, ctx, i % 2 === 0 ? jitter : 0, hold, spec.b(ctx, w))]);
    t.iterations += 1;
    let refused = 0;
    for (const r of [ra, rb]) {
      if (r.ok) continue;
      if (r.code === '40P01') t.deadlocks += 1;
      else if (r.code === 'BP409') {
        refused += 1;
        const key = `BP409 ${r.reason ?? '?'}`;
        t.refusals.set(key, (t.refusals.get(key) ?? 0) + 1);
      } else t.otherErrors.push(`${r.code ?? '?'} ${r.message ?? ''}`.slice(0, 160));
    }
    if (refused === 1) t.oneRefusal += 1;
    if (refused === 0) t.noRefusal += 1;
    if (await spec.bad(owner, ctx, w)) t.bad += 1;
  }
  return t;
}

const tallyText = (t: Tally) =>
  `${t.iterations} runs: ${t.bad} ended wrong, ${t.deadlocks} deadlocks, one refusal in ${t.oneRefusal}, none in ${t.noRefusal}, refusals ${[...t.refusals].map(([k, v]) => `${k} x${v}`).join(', ') || 'none'}`;

// ---------------------------------------------------------------------------
// The races
// ---------------------------------------------------------------------------

const RACES: Record<string, RaceSpec & { refusalReason?: string; mustRefuseOne: boolean }> = {
  // 1. A placement of 60 minutes is written while the members' length is changed to 45.
  length: {
    label: "a placement is written while the members' length is changed so that it no longer fits",
    mustRefuseOne: true,
    refusalReason: 'BP409 LENGTH',
    plant: (owner, ctx) => plantBlock(owner, ctx, 'len', { members: 2, lessons: 2 }),
    a: (ctx, w) => async (c) => void (await c.query(...insertPlacement(ctx, w, 2))),
    b: (_ctx, w) => async (c) => void (await c.query(`UPDATE "TeachingRequirements" SET "minutesPerLesson" = 45 WHERE "blockId" = $1`, [w.block])),
    bad: async (owner, _ctx, w) =>
      (
        await owner.query<{ bad: boolean }>(
          `SELECT EXISTS (SELECT 1 FROM "TeachingBlockPlacements" p JOIN "TeachingRequirements" r ON r."blockId" = p."blockId" WHERE p."blockId" = $1 AND p.minutes <> r."minutesPerLesson") AS bad`,
          [w.block],
        )
      ).rows[0]!.bad,
  },
  // 2. A placement is written while a member gets a shared lesson.
  share: {
    label: 'a placement is written while a share is written for a member',
    mustRefuseOne: true,
    refusalReason: 'BP409 SHARES',
    plant: (owner, ctx) => plantBlock(owner, ctx, 'shr', { members: 2, lessons: 2 }),
    a: (ctx, w) => async (c) => void (await c.query(...insertPlacement(ctx, w, 2))),
    b: (ctx, w) => async (c) =>
      void (await c.query(`INSERT INTO "TeachingRequirementShares" ("schoolId", "requirementId", "teacherId", lessons, minutes, "updatedAt") VALUES ($1, $2, $3, 1, 60, now())`, [ctx.school, w.posts[0], ctx.teacher])),
    bad: async (owner, _ctx, w) =>
      (
        await owner.query<{ bad: boolean }>(
          `SELECT EXISTS (SELECT 1 FROM "TeachingBlockPlacements" WHERE "blockId" = $1) AND EXISTS (SELECT 1 FROM "TeachingRequirementShares" WHERE "requirementId" = ANY ($2::uuid[])) AS bad`,
          [w.block, w.posts],
        )
      ).rows[0]!.bad,
  },
  // 3. A room row is written for a post while the post leaves the block.
  leave: {
    label: 'a room row is written for a post while the post leaves the block',
    mustRefuseOne: false,
    plant: (owner, ctx) => plantBlock(owner, ctx, 'lev', { members: 2, lessons: 2, placement: true }),
    a: (ctx, w) => async (c) =>
      void (await c.query(`INSERT INTO "TeachingBlockPlacementRooms" ("schoolId", "placementId", "requirementId", "roomId", "updatedAt") VALUES ($1, $2, $3, $4, now())`, [ctx.school, w.placement, w.posts[0], ctx.room1])),
    b: (_ctx, w) => async (c) => void (await c.query(`UPDATE "TeachingRequirements" SET "blockId" = NULL WHERE id = $1`, [w.posts[0]])),
    // A room row for a post that is not a member of the placement's block.
    bad: async (owner, _ctx, w) =>
      (
        await owner.query<{ bad: boolean }>(
          `SELECT EXISTS (SELECT 1 FROM "TeachingBlockPlacementRooms" x JOIN "TeachingBlockPlacements" p ON p.id = x."placementId" JOIN "TeachingRequirements" r ON r.id = x."requirementId"
                           WHERE p."blockId" = $1 AND r."blockId" IS DISTINCT FROM p."blockId") AS bad`,
          [w.block],
        )
      ).rows[0]!.bad,
  },
  // 4. Two placements of a block that has ONE lesson.
  count: {
    label: 'two placements are written for a block of one lesson',
    mustRefuseOne: true,
    refusalReason: 'BP409 COUNT',
    plant: (owner, ctx) => plantBlock(owner, ctx, 'cnt', { members: 2, lessons: 1 }),
    a: (ctx, w) => async (c) => void (await c.query(...insertPlacement(ctx, w, 2))),
    b: (ctx, w) => async (c) => void (await c.query(...insertPlacement(ctx, w, 3))),
    bad: async (owner, _ctx, w) => Number((await owner.query<{ n: string }>(`SELECT count(*) AS n FROM "TeachingBlockPlacements" WHERE "blockId" = $1`, [w.block])).rows[0]!.n) > 1,
  },
};

// ---------------------------------------------------------------------------
// The hunts: a tight loop over one world
// ---------------------------------------------------------------------------

async function bareSide(c: Client, delay: number, sql: string, params: unknown[]): Promise<Outcome> {
  await sleep(delay);
  try {
    await c.query('BEGIN');
    await c.query(sql, params);
    await c.query('COMMIT');
    return { ok: true };
  } catch (error) {
    await c.query('ROLLBACK').catch(() => undefined);
    const e = error as { code?: string; detail?: string; message?: string };
    return { ok: false, code: e.code, reason: /reason=([A-Z_]+)/.exec(e.detail ?? '')?.[1], message: e.message };
  }
}

async function hunt(h1: Client, h2: Client, n: number, a: (i: number) => [string, unknown[]], b: (i: number) => [string, unknown[]], reset: (i: number) => Promise<void>): Promise<Tally> {
  const t: Tally = { iterations: 0, bad: 0, deadlocks: 0, otherErrors: [], refusals: new Map(), oneRefusal: 0, noRefusal: 0 };
  for (let i = 0; i < n; i += 1) {
    // The two statements start within a few milliseconds of each other, in either order.
    const jitter = Math.floor(Math.random() * 4);
    const [ra, rb] = await Promise.all([bareSide(h1, i % 3 === 0 ? jitter : 0, ...a(i)), bareSide(h2, i % 3 === 0 ? 0 : jitter, ...b(i))]);
    t.iterations += 1;
    for (const r of [ra, rb]) {
      if (r.ok) continue;
      if (r.code === '40P01') t.deadlocks += 1;
      else t.otherErrors.push(`${r.code ?? '?'} ${r.message ?? ''}`.slice(0, 160));
    }
    await reset(i);
  }
  return t;
}

// ---------------------------------------------------------------------------
// The mutants: the functions as the migration made them, with the lock taken out
// ---------------------------------------------------------------------------

const LOCK = /\s+FOR NO KEY UPDATE;/;

async function definitions(owner: Client): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const fn of [FIT, LEAVE, TB409]) out[fn] = (await owner.query<{ d: string }>(`SELECT pg_get_functiondef('${fn}'::regprocedure) AS d`)).rows[0]!.d.replace(/\s+$/, '') + ';\n';
  return out;
}

async function md5s(owner: Client): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const fn of [FIT, LEAVE, TB409]) out[fn] = (await owner.query<{ m: string }>(`SELECT md5(prosrc) AS m FROM pg_proc WHERE oid = '${fn}'::regprocedure`)).rows[0]!.m;
  return out;
}

function mutate(originals: Record<string, string>, which: string): Array<[string, string]> {
  const changed = (fn: string, text: string) => {
    if (text === originals[fn]) throw new Error(`the mutant ${which} did not change ${fn}`);
    return [fn, text] as [string, string];
  };
  const noFit = changed(FIT, originals[FIT]!.replace(LOCK, ';'));
  const noLeave = changed(LEAVE, originals[LEAVE]!.replace(/\s+FOR NO KEY UPDATE;/, ';'));
  // TB409 takes the block FOR UPDATE twice (a change of lessons: the block and the blocks on its times in id order; then the block's name).
  const noTb409 = changed(TB409, originals[TB409]!.replace(/\s+FOR UPDATE;/g, ';'));
  switch (which) {
    case 'fit-lock':
      return [noFit];
    case 'leave-lock':
      return [noLeave];
    case 'fit-lock+tb409-lock':
      return [noFit, noTb409];
    default:
      throw new Error(`unknown mutant ${which}`);
  }
}

async function install(owner: Client, defs: Array<[string, string]>): Promise<void> {
  for (const [, text] of defs) await owner.query(text);
}

async function restore(owner: Client, originals: Record<string, string>, expected: Record<string, string>): Promise<void> {
  for (const text of Object.values(originals)) await owner.query(text);
  const now = await md5s(owner);
  for (const fn of Object.keys(expected)) must(now[fn] === expected[fn], `${fn} is not the function it was: md5 ${now[fn]} against ${expected[fn]}`);
}

// ---------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const started = Date.now();
  const owner = new Client(pgConfig(process.env['PROBE_OWNER_URL'], 'PROBE_OWNER_URL'));
  const ca = new Client(pgConfig(process.env['DATABASE_URL'], 'DATABASE_URL'));
  const cb = new Client(pgConfig(process.env['DATABASE_URL'], 'DATABASE_URL'));
  await Promise.all([owner.connect(), ca.connect(), cb.connect()]);
  let originals: Record<string, string> | null = null;
  let expected: Record<string, string> | null = null;
  let mutated = false;
  const putBack = async () => {
    if (mutated && originals && expected) {
      await restore(owner, originals, expected);
      if (existsSync(ORIGINALS_FILE)) unlinkSync(ORIGINALS_FILE);
    }
  };
  try {
    // A run that died inside a mutant left the originals here: put them back before anything is asked of the database.
    if (existsSync(ORIGINALS_FILE)) {
      console.error(`an earlier run died with a mutant installed: putting back the functions from ${ORIGINALS_FILE}`);
      await owner.query(readFileSync(ORIGINALS_FILE, 'utf8'));
      unlinkSync(ORIGINALS_FILE);
    }
    await owner.query(`DELETE FROM "Schools" WHERE slug = $1`, [SLUG]);
    originals = await definitions(owner);
    expected = await md5s(owner);
    const ctx = await plantSchool(owner);
    const version = (await owner.query<{ v: string }>(`SELECT current_setting('server_version') AS v`)).rows[0]!.v;
    console.log(`Postgres ${version}, ${RACES_N} runs of each race`);

    if (process.env['PROBE_MUTANT'] === 'matrix') {
      mutated = true;
      writeFileSync(ORIGINALS_FILE, Object.values(originals).join('\n'));
      // Each race against the mutant that should lose it; and the one pair that should NOT bite, because another lock orders the same two writers (race 1 without BP409's lock alone).
      const matrix: Array<[keyof typeof RACES, string, boolean, string]> = [
        ['length', 'fit-lock+tb409-lock', true, 'without the block lock of BP409 and of TB409'],
        ['length', 'fit-lock', false, "without the block lock of BP409 alone: TB409 takes the block FOR UPDATE for a change of lessons, and the placement's key holds KEY SHARE on it, so the two writers are ordered anyway"],
        ['share', 'fit-lock', true, 'without the block lock of BP409'],
        ['leave', 'leave-lock', true, "without the old block's lock in the leave function"],
        ['leave', 'fit-lock', true, "without the block lock of BP409 alone: the leave function's lock orders nothing when the insert does not take it"],
        ['count', 'fit-lock', true, 'without the block lock of BP409'],
      ];
      for (const [name, mutant, shouldBite, text] of matrix) {
        const spec = RACES[name]!;
        await check(`bites: ${spec.label}, ${text} (${mutant})`, async () => {
          await install(owner, mutate(originals!, mutant));
          let t: Tally;
          try {
            t = await race(owner, ctx, ca, cb, spec, RACES_N);
          } finally {
            await restore(owner, originals!, expected!);
          }
          if (shouldBite) must(t.bad >= 1, `no run of ${t.iterations} ended wrong: the race does not bite this mutant (${tallyText(t)})`);
          else must(t.bad === 0 && t.deadlocks === 0, `a run ended wrong although another lock orders the writers (${tallyText(t)})`);
          return `${shouldBite ? 'bites: ' : 'does not bite, as it should not: '}${tallyText(t)}`;
        });
      }
    } else {
      for (const [name, spec] of Object.entries(RACES)) {
        await check(`${spec.label}: no deadlock and the block never ends wrong`, async () => {
          const t = await race(owner, ctx, ca, cb, spec, RACES_N);
          must(t.deadlocks === 0, `a deadlock: ${tallyText(t)}`);
          must(t.otherErrors.length === 0, `an error that is no refusal: ${t.otherErrors.join(' | ')}`);
          must(t.bad === 0, `the block ended in a state the rules refuse: ${tallyText(t)}`);
          if (spec.mustRefuseOne) {
            must(t.oneRefusal === t.iterations, `exactly one writer should be refused in every run: ${tallyText(t)}`);
            must([...t.refusals.keys()].every((k) => k === spec.refusalReason), `the refusal should be ${spec.refusalReason}: ${tallyText(t)}`);
          } else {
            // The room row's writer is refused (MEMBER) when the post has already left, and the post's own move is never refused.
            must([...t.refusals.keys()].every((k) => k === 'BP409 MEMBER'), `only MEMBER may be refused: ${tallyText(t)}`);
          }
          return tallyText(t);
        });
      }
      // The hunts. Sessions of the owner with a short deadlock_timeout: the order the rows are locked in is the same whoever asks.
      const h1 = new Client(pgConfig(process.env['PROBE_OWNER_URL'], 'PROBE_OWNER_URL'));
      const h2 = new Client(pgConfig(process.env['PROBE_OWNER_URL'], 'PROBE_OWNER_URL'));
      await Promise.all([h1.connect(), h2.connect()]);
      try {
        for (const h of [h1, h2]) await h.query(`SET deadlock_timeout = '20ms'`);
        await check(`hunt 1: a member's lessons change while a share is written for the same member, ${HUNT_N} attempts, no deadlock`, async () => {
          const w = await plantBlock(owner, ctx, 'hs', { members: 2, lessons: 3 });
          const t = await hunt(
            h1,
            h2,
            HUNT_N,
            (i) => [`UPDATE "TeachingRequirements" SET "lessonsPerWeek" = $1 WHERE "blockId" = $2`, [i % 2 === 0 ? 4 : 3, w.block]],
            () => [`INSERT INTO "TeachingRequirementShares" ("schoolId", "requirementId", "teacherId", lessons, minutes, "updatedAt") VALUES ($1, $2, $3, 1, 60, now())`, [ctx.school, w.posts[0], ctx.teacher]],
            async () => void (await owner.query(`DELETE FROM "TeachingRequirementShares" WHERE "requirementId" = ANY ($1::uuid[])`, [w.posts])),
          );
          must(t.deadlocks === 0, `${t.deadlocks} of ${t.iterations} attempts ended in a deadlock (40P01): the two paths take the post's row and the block's row in opposite orders`);
          must(t.otherErrors.length === 0, `an error that is no deadlock: ${t.otherErrors.join(' | ')}`);
          return `${t.iterations} attempts, no deadlock`;
        });
        await check(`hunt 2: two posts swap blocks at once, ${HUNT_N} attempts, no deadlock`, async () => {
          const x = await plantBlock(owner, ctx, 'sx', { members: 1, lessons: 2 });
          const y = await plantBlock(owner, ctx, 'sy', { members: 1, lessons: 2 });
          const move = `UPDATE "TeachingRequirements" SET "blockId" = $1 WHERE id = $2`;
          const t = await hunt(
            h1,
            h2,
            HUNT_N,
            () => [move, [y.block, x.posts[0]]],
            () => [move, [x.block, y.posts[0]]],
            async () => {
              await owner.query(move, [x.block, x.posts[0]]);
              await owner.query(move, [y.block, y.posts[0]]);
            },
          );
          must(t.deadlocks === 0, `${t.deadlocks} of ${t.iterations} attempts ended in a deadlock (40P01): each takes the block it comes to and then the block it leaves, so the two take the two blocks in opposite orders`);
          must(t.otherErrors.length === 0, `an error that is no deadlock: ${t.otherErrors.join(' | ')}`);
          return `${t.iterations} attempts, no deadlock`;
        });
      } finally {
        await Promise.all([h1.end(), h2.end()]);
      }
    }
  } finally {
    await putBack().catch((error: unknown) => {
      failures += 1;
      console.error(`FAIL the functions were not put back: ${summarise(error)}`);
    });
    await owner.query(`DELETE FROM "Schools" WHERE slug = $1`, [SLUG]).catch((error: unknown) => console.error(`the probe's school was not dropped: ${summarise(error)}`));
    await Promise.all([owner.end(), ca.end(), cb.end()]);
  }
  const seconds = Math.round((Date.now() - started) / 100) / 10;
  if (failures > 0) {
    console.error(`==> Block-lås probe FAILED: ${failures} check(s) in ${seconds} s`);
    process.exitCode = 1;
  } else {
    console.log(`==> Block-lås probe passed in ${seconds} s`);
  }
}

main().catch((error: unknown) => {
  console.error(summarise(error));
  process.exit(1);
});
