/**
 * Schemaförslag (20261125090000) through the real services, against Postgres,
 * with the engine stubbed at HttpService (the proxy's only way out):
 *
 *   sc-a  Generera writes the first draft (the shared write, createMany, the
 *         year lock); a run of three candidates goes end to end under
 *         app_authenticated: the fetch once, the three engine calls with their
 *         own search and timeout, the progress counted as each is stored, the
 *         metrics, the basis and its parts, SUCCEEDED; the overview and a
 *         candidate's lessons read back;
 *   sc-b  the expedition's start is refused by the insert arm (AREA_NOT_YOURS)
 *         and writes nothing, its DELETE removes nothing, and a teacher sees
 *         no run;
 *   sc-c  a run that fails — the engine gone at the second candidate, an
 *         engine older than `search`, the first candidate INFEASIBLE — keeps
 *         the batch before it; the next success deletes them all;
 *   sc-d  the apply: refused in another mode first; then the masters are the
 *         candidate's, the safety version and the REGENERATE entry are
 *         written, appliedCandidateId is set, the locked, handmade and
 *         participant lessons stand, and in DIRECT exactly the dated lessons
 *         the check counted leave the calendar;
 *   sc-e  a hand edit after the run is 409 SCHEDULE_CANDIDATE_STALE naming the
 *         part it changed (draft, requirements, preserved), with nothing
 *         written; put back by content, the batch is applicable again;
 *   sc-f  a hand UPDATE of a generated lesson held open while an apply runs:
 *         the apply waits on the year's regeneration lock the edit holds a
 *         share of (before any row), then refuses; the other way round, the
 *         edit waits in its share of the lock for the apply and fails (P2025,
 *         a 404 over HTTP: its lesson was replaced); behind an apply held past
 *         5 s it answers 409 SCHEDULE_BUSY with nothing written; no edit is
 *         lost without an error;
 *   sc-g  a version restore and an apply queue on the year lock, both ways
 *         round, and a restore that waits past 5 s answers SCHEDULE_BUSY;
 *   sc-h  a generate whose fetch predates an apply is GENERATE_STALE; a job's
 *         solve refuses an apply and a start (GENERATE_RUNNING), and a hand
 *         delete during it ends the job GENERATE_STALE;
 *   sc-i  DELETE of a running run sets CANCELLING, Generera and a second start
 *         are refused beside it, and its task stops without writing;
 *   sc-j  the sweep abandons a run past its lease and frees the year, while
 *         its task can no longer write; the partial index answers a second
 *         start that passed every check (23505 → CANDIDATES_RUNNING); the cap
 *         on live runs, whatever their school or year (CANDIDATES_BUSY);
 *   sc-k  no stored row, change-log entry, response or engine request names a
 *         pupil;
 *   sc-l  a run interrupted by a restart while its call is out frees its year
 *         at once but keeps its place under CANDIDATE_RUNS_MAX until that
 *         call could have ended (engineBusyUntil), and its task writes
 *         nothing more.
 *
 * Interleavings are made the way the rest of the probe makes them: a holder
 * parked on a promise inside its transaction, the other side started, its wait
 * read from pg_stat_activity, then the holder released. The task of a run is
 * the service's own fire-and-forget; it is awaited by the service's registry
 * of runs in flight, not by a clock. Two checks wait a clock on purpose: the
 * 5 s lock_timeouts of sc-f (a hand edit) and sc-g (a restore).
 *
 * Imported by prisma-adapter-probe.ts, which hands in its `check`, its pool
 * opener and the API's URL (a second pool, so a held transaction and the call
 * it holds up never share connections). Its school is its own
 * (`<marker>-schemaforslag`), created and removed as the owner.
 */
import { strict as assert } from 'node:assert';
import { randomUUID } from 'node:crypto';
import { HttpException } from '@nestjs/common';
import { Prisma, type PrismaClient } from '@prisma/client';
import { AxiosError } from 'axios';
import type { Client } from 'pg';
import { from } from 'rxjs';
import { Role } from '../../src/auth/enums/role.enum';
import type { AuthenticatedUser } from '../../src/auth/interfaces/authenticated-user.interface';
import { MasterLessonsService } from '../../src/calendar/master-lessons.service';
import { ScheduleVersionsService } from '../../src/calendar/schedule-versions.service';
import { areaRefusal } from '../../src/common/utils/prisma-errors';
import type { PrismaService } from '../../src/database/prisma.service';
import type { NotificationsService } from '../../src/notifications/notifications.service';
import { BASIS_PARTS } from '../../src/optimization/candidate-basis';
import { OptimizationJobsService } from '../../src/optimization/optimization-jobs.service';
import { OptimizationProxyService } from '../../src/optimization/optimization-proxy.service';
import { ScheduleCandidatesService, yearHasActiveCandidateRun } from '../../src/optimization/schedule-candidates.service';
import type { RealtimeService } from '../../src/realtime/realtime.service';

type Check = (label: string, body: () => Promise<void>) => Promise<void>;

export function scheduleCandidatesSlug(marker: string): string {
  return `${marker}-schemaforslag`;
}

export async function sweepScheduleCandidatesSchool(owner: Client, marker: string): Promise<void> {
  await owner.query(`DELETE FROM "Schools" WHERE slug = $1`, [scheduleCandidatesSlug(marker)]);
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

/** A promise's outcome as a value: what a racing call ended with, without an unhandled rejection. */
function settled<T>(work: Promise<T>): Promise<{ ok: true; value: T } | { ok: false; error: unknown }> {
  return work.then(
    (value) => ({ ok: true as const, value }),
    (error: unknown) => ({ ok: false as const, error }),
  );
}

/** A refusal's code and body, from a Nest HttpException. */
function bodyOf(error: unknown): { status: number; code?: string; changed?: string[]; params?: Record<string, unknown>; message?: string } {
  assert.ok(error instanceof HttpException, `expected an HttpException, got ${describe(error)}`);
  const body = error.getResponse();
  return { status: error.getStatus(), ...(typeof body === 'object' && body !== null ? (body as object) : { message: String(body) }) };
}

function describe(error: unknown): string {
  if (error instanceof HttpException) return `${error.name} ${error.getStatus()} ${JSON.stringify(error.getResponse())}`;
  if (error instanceof Prisma.PrismaClientKnownRequestError) return `${error.name} ${error.code}: ${error.message.split('\n').slice(-2).join(' ')}`;
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  return String(error);
}

async function refusal(work: Promise<unknown>): Promise<unknown> {
  const outcome = await settled(work);
  assert.ok(!outcome.ok, 'the call was not refused');
  return outcome.error;
}

async function refusedWith(work: Promise<unknown>, status: number, code: string): Promise<ReturnType<typeof bodyOf>> {
  const body = bodyOf(await refusal(work));
  assert.equal(body.status, status, `expected ${status} ${code}, got ${JSON.stringify(body)}`);
  assert.equal(body.code, code, `expected ${status} ${code}, got ${JSON.stringify(body)}`);
  return body;
}

// ---------------------------------------------------------------------------
// The engine, at HttpService
// ---------------------------------------------------------------------------

interface EngineRequirement {
  id: string;
  studentGroupId: string;
  lessonsPerWeek: number;
  minutesPerLesson: number;
}

interface EngineBody {
  requestId: string;
  requirements: EngineRequirement[];
  rooms: Array<{ id: string; capacity: number | null }>;
  fixedLessons: unknown[];
  previousLessons: Array<{ requirementId: string; dayOfWeek: number; startTime: string }>;
  weights?: Record<string, number>;
  search?: { seed?: number; maxSeconds?: number; probes?: boolean; workers?: number };
}

interface EngineAnswer {
  requestId: string;
  status: 'OPTIMAL' | 'FEASIBLE' | 'INFEASIBLE' | 'TIMEOUT';
  lessons: Array<{ requirementId: string; roomId: string | null; dayOfWeek: number; startTime: string; endTime: string }>;
  lunches?: Array<{ studentGroupId: string; dayOfWeek: number; startTime: string; endTime: string }>;
  conflicts?: unknown;
}

/**
 * Every requirement has a row of its own by its length — 60 min at 08:00,
 * 50 at 09:10, 45 at 10:20, 40 at 13:00 — and a room by its length (the
 * 30-seat room for 60 and 45, the 32-seat one for 50 and 40), so a placement
 * reads the same through every fetch although each fetch's anonymous ids are
 * new. A lesson keeps its previous day and time when the request hints one
 * (the warm start every candidate gets); seed 1 (TEACHER_GAPS) moves every
 * lesson two days on — past every day the requirement already has, so no
 * lesson of it is kept — and every other request places exactly like Generera's —
 * so SPREAD comes back as KEEP's twin (sameAs).
 */
const ROW_OF: Record<number, string> = { 60: '08:00:00', 50: '09:10:00', 45: '10:20:00', 40: '13:00:00' };

function clockPlus(clock: string, minutes: number): string {
  const [h, m] = clock.split(':').map(Number);
  const total = h! * 60 + m! + minutes;
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}:00`;
}

function placed(body: EngineBody): EngineAnswer {
  const byCapacity = [...body.rooms].sort((a, b) => (a.capacity ?? 0) - (b.capacity ?? 0));
  const shift = body.search?.seed === 1 ? 2 : 0;
  const lessons: EngineAnswer['lessons'] = [];
  for (const requirement of body.requirements) {
    const minutes = requirement.minutesPerLesson;
    const previous = body.previousLessons
      .filter((lesson) => lesson.requirementId === requirement.id)
      .sort((a, b) => a.dayOfWeek - b.dayOfWeek || a.startTime.localeCompare(b.startTime));
    const room = (minutes === 60 || minutes === 45 ? byCapacity[0] : byCapacity[1] ?? byCapacity[0])?.id ?? null;
    for (let k = 0; k < requirement.lessonsPerWeek; k++) {
      const day = previous[k]?.dayOfWeek ?? k + 1;
      const start = previous[k]?.startTime ?? ROW_OF[minutes] ?? '14:00:00';
      lessons.push({
        requirementId: requirement.id,
        roomId: room,
        dayOfWeek: ((day - 1 + shift) % 5) + 1,
        startTime: start,
        endTime: clockPlus(start, minutes),
      });
    }
  }
  const groups = [...new Set(body.requirements.map((requirement) => requirement.studentGroupId))];
  return {
    requestId: body.requestId,
    status: 'OPTIMAL',
    lessons,
    lunches: groups.map((studentGroupId) => ({ studentGroupId, dayOfWeek: 1, startTime: '11:30:00', endTime: '12:00:00' })),
    conflicts: null,
  };
}

const isCandidateCall = (body: EngineBody) => body.search !== undefined;
const isGenerateCall = (body: EngineBody) => body.search === undefined;

class EngineStub {
  readonly calls: Array<{ body: EngineBody; timeoutMs: number | undefined }> = [];
  private readonly script: Array<{ match: (body: EngineBody) => boolean; answer: (body: EngineBody) => Promise<EngineAnswer> }> = [];

  /** The next call `match` accepts is answered by `answer`, once. */
  once(match: (body: EngineBody) => boolean, answer: (body: EngineBody) => Promise<EngineAnswer>): void {
    this.script.push({ match, answer });
  }

  /** The next matching call waits for `release`; `arrived` is its body. */
  park(match: (body: EngineBody) => boolean): { arrived: Promise<EngineBody>; release: () => void } {
    const arrived = deferred<EngineBody>();
    const gate = deferred<void>();
    this.once(match, async (body) => {
      arrived.resolve(body);
      await gate.promise;
      return placed(body);
    });
    return { arrived: arrived.promise, release: () => gate.resolve() };
  }

  readonly http = {
    post: (_url: string, body: EngineBody, config?: { timeout?: number }) => {
      this.calls.push({ body, timeoutMs: config?.timeout });
      const index = this.script.findIndex((entry) => entry.match(body));
      const entry = index >= 0 ? this.script.splice(index, 1)[0] : undefined;
      return from(
        Promise.resolve()
          .then(() => (entry ? entry.answer(body) : placed(body)))
          .then((data) => ({ data })),
      );
    },
  };
}

/** The engine unreachable: what axios throws for a refused connection. */
function unreachable(): never {
  throw new AxiosError('connect ECONNREFUSED', 'ECONNREFUSED');
}

/** An engine older than `search`: its models forbid the field, and it says so in a 422. */
function olderEngine(): never {
  throw new AxiosError('Request failed with status code 422', 'ERR_BAD_REQUEST', undefined, undefined, {
    status: 422,
    statusText: 'Unprocessable Entity',
    headers: {},
    config: {} as never,
    data: {
      code: 'VALIDATION_ERROR',
      message: 'Request validation failed',
      details: { errors: [{ type: 'extra_forbidden', loc: ['body', 'search'], msg: 'Extra inputs are not permitted' }] },
    },
  });
}

// ---------------------------------------------------------------------------
// Holding a transaction open
// ---------------------------------------------------------------------------

/**
 * A PrismaService whose withRls parks at the end of its transaction — after
 * every write, before COMMIT — until released, so the locks it took are held
 * while the probe starts the other side. Every service raced here only calls
 * withRls (and ScheduleVersionsService.list's queryWithRls, passed through).
 */
function parkedAtCommit(base: PrismaService): { prisma: PrismaService; reached: Promise<number>; release: () => void } {
  const reached = deferred<number>();
  const gate = deferred<void>();
  const prisma = {
    withRls: <T>(user: AuthenticatedUser, fn: (tx: PrismaClient) => Promise<T>) =>
      base.withRls(
        user,
        async (tx) => {
          const result = await fn(tx);
          const [{ pid }] = await tx.$queryRaw<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`;
          reached.resolve(pid);
          await gate.promise;
          return result;
        },
        { timeoutMs: 60_000 },
      ),
    queryWithRls: base.queryWithRls.bind(base),
  } as unknown as PrismaService;
  return { prisma, reached: reached.promise, release: () => gate.resolve() };
}

/**
 * Versions for an apply that parks inside its transaction at the safety
 * snapshot (design §4 step 7): by then it holds the publication lock, the
 * year's three rewrite locks, the run's row and every master FOR UPDATE, and
 * has found the basis equal.
 */
function snapshotParked(real: ScheduleVersionsService): { versions: ScheduleVersionsService; reached: Promise<number>; release: () => void } {
  const reached = deferred<number>();
  const gate = deferred<void>();
  const versions = {
    snapshotInTransaction: async (tx: PrismaClient, academicYearId: string, name: string, user: AuthenticatedUser) => {
      const [{ pid }] = await tx.$queryRaw<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`;
      reached.resolve(pid);
      await gate.promise;
      return real.snapshotInTransaction(tx, academicYearId, name, user);
    },
  } as unknown as ScheduleVersionsService;
  return { versions, reached: reached.promise, release: () => gate.resolve() };
}

/** Resolves with the holder's pid, or fails with what the holder settled with if it never parked. */
async function parked(reached: Promise<number>, work: Promise<{ ok: boolean; error?: unknown }>, what: string): Promise<number> {
  return Promise.race([
    reached,
    work.then((outcome) => {
      throw new Error(`${what} settled before it parked: ${outcome.ok ? 'it passed' : describe(outcome.error)}`);
    }),
  ]);
}

interface Wait {
  pid: number;
  waitEvent: string;
  /** The waiting statement, whitespace folded. */
  statement: string;
  /** Its first 90 characters, for the log. */
  query: string;
}

/**
 * A backend waiting on `holderPid` whose statement matches `pattern`, read
 * from pg_stat_activity; fails with the waiter's own outcome if it settles
 * first (it never waited).
 */
async function waitingOn(
  owner: Client,
  holderPid: number,
  pattern: RegExp,
  waiter: Promise<{ ok: boolean; error?: unknown }>,
  what: string,
): Promise<Wait> {
  let done: string | null = null;
  void waiter.then((outcome) => {
    done = outcome.ok ? 'it passed' : describe(outcome.error);
  });
  for (let tries = 0; ; tries++) {
    const { rows } = await owner.query<{ pid: number; wait_event_type: string; wait_event: string; query: string }>(
      `SELECT pid, wait_event_type, wait_event, query FROM pg_stat_activity WHERE $1::int = ANY(pg_blocking_pids(pid))`,
      [holderPid],
    );
    const row = rows.find((candidate) => pattern.test(candidate.query));
    if (row) {
      const statement = row.query.replace(/\s+/g, ' ').trim();
      return { pid: row.pid, waitEvent: `${row.wait_event_type}/${row.wait_event}`, statement, query: statement.slice(0, 90) };
    }
    if (done !== null) throw new Error(`${what} settled without waiting on ${holderPid}: ${done}`);
    if (tries > 3000) throw new Error(`${what} never waited on ${holderPid}`);
    await sleep(10);
  }
}

// ---------------------------------------------------------------------------
// The checks
// ---------------------------------------------------------------------------

export async function scheduleCandidateChecks(
  owner: Client,
  api: PrismaService,
  marker: string,
  check: Check,
  open: (url: string) => PrismaService,
  appUrl: string,
): Promise<void> {
  await sweepScheduleCandidatesSchool(owner, marker);
  const one = async <T extends object>(sql: string, params: unknown[] = []): Promise<T> => (await owner.query<T>(sql, params)).rows[0]!;
  const all = async <T extends object>(sql: string, params: unknown[] = []): Promise<T[]> => (await owner.query<T>(sql, params)).rows;

  // A second pool for the side a held transaction holds up.
  const second = open(appUrl);
  await second.onModuleInit();

  const s = (
    await one<{ id: string }>(
      `INSERT INTO "Schools" (name, slug, timezone, "updatedAt") VALUES ($1, $2, 'Europe/Stockholm', now()) RETURNING id`,
      [`${marker} schemaförslag`, scheduleCandidatesSlug(marker)],
    )
  ).id;
  // 2095/96, so every dated lesson lies ahead and the DIRECT sweep sees it.
  const year = (
    await one<{ id: string }>(
      `INSERT INTO "AcademicYears" ("schoolId", name, "startDate", "endDate", "isActive", "updatedAt")
       VALUES ($1, 'Probe 2095/96', '2095-08-15', '2096-06-10', true, now()) RETURNING id`,
      [s],
    )
  ).id;
  // A second year, only for a run row of another year (the cap across runs).
  const otherYear = (
    await one<{ id: string }>(
      `INSERT INTO "AcademicYears" ("schoolId", name, "startDate", "endDate", "isActive", "updatedAt")
       VALUES ($1, 'Probe 2096/97', '2096-08-15', '2097-06-10', false, now()) RETURNING id`,
      [s],
    )
  ).id;
  const group = async (name: string) =>
    (
      await one<{ id: string }>(
        `INSERT INTO "StudentGroups" ("schoolId", "academicYearId", name, kind, "gradeLevel", "updatedAt") VALUES ($1, $2, $3, 'CLASS', 7, now()) RETURNING id`,
        [s, year, name],
      )
    ).id;
  const g7a = await group('SF 7A');
  const g7b = await group('SF 7B');
  const person = async (label: string, role: string, extra: { groupId?: string; adminProfile?: string } = {}) => {
    const authId = randomUUID();
    const row = await one<{ id: string }>(
      `INSERT INTO "Users" ("schoolId", email, "firstName", "lastName", role, "adminProfile", "authId", "isActive", "studentGroupId", "updatedAt")
       VALUES ($1, $2, $3, 'Förslag', $4, $5, $6, true, $7, now()) RETURNING id`,
      [s, `${marker}-schemaforslag-${label}@example.invalid`, label, role, extra.adminProfile ?? null, authId, extra.groupId ?? null],
    );
    return { id: row.id, authId };
  };
  const adminRow = await person('admin', 'SCHOOL_ADMIN', { adminProfile: 'FULL' });
  const expeditionRow = await person('expedition', 'SCHOOL_ADMIN', { adminProfile: 'EXPEDITION' });
  const t1 = await person('t1', 'TEACHER');
  const t2 = await person('t2', 'TEACHER');
  const pupils = [
    await person('p1', 'STUDENT', { groupId: g7a }),
    await person('p2', 'STUDENT', { groupId: g7a }),
    await person('p3', 'STUDENT', { groupId: g7b }),
  ];
  const pupilIds = pupils.map((pupil) => pupil.id);
  const admin: AuthenticatedUser = { authId: adminRow.authId, userId: adminRow.id, schoolId: s, role: Role.SCHOOL_ADMIN, adminProfile: 'FULL' } as AuthenticatedUser;
  const expedition: AuthenticatedUser = {
    authId: expeditionRow.authId,
    userId: expeditionRow.id,
    schoolId: s,
    role: Role.SCHOOL_ADMIN,
    adminProfile: 'EXPEDITION',
  } as AuthenticatedUser;
  const teacher: AuthenticatedUser = { authId: t1.authId, userId: t1.id, schoolId: s, role: Role.TEACHER };
  const subject = async (name: string) =>
    (await one<{ id: string }>(`INSERT INTO "Subjects" ("schoolId", name, "updatedAt") VALUES ($1, $2, now()) RETURNING id`, [s, name])).id;
  const ma = await subject('SF Matematik');
  const sv = await subject('SF Svenska');
  const en = await subject('SF Engelska');
  const klassrad = await subject('SF Klassråd');
  const stod = await subject('SF Stöd');
  const room = async (name: string, capacity: number) =>
    (await one<{ id: string }>(`INSERT INTO "Rooms" ("schoolId", name, capacity, "updatedAt") VALUES ($1, $2, $3, now()) RETURNING id`, [s, name, capacity])).id;
  await room('SF sal 30', 30);
  await room('SF sal 32', 32);
  const requirement = async (groupId: string, subjectId: string, teacherId: string, lessons: number, minutes: number) =>
    (
      await one<{ id: string }>(
        `INSERT INTO "TeachingRequirements" ("schoolId", "academicYearId", "subjectId", "studentGroupId", "teacherId", "lessonsPerWeek", "minutesPerLesson", "updatedAt")
         VALUES ($1, $2, $3, $4, $5, $6, $7, now()) RETURNING id`,
        [s, year, subjectId, groupId, teacherId, lessons, minutes],
      )
    ).id;
  // Nine lessons a week; each requirement on a row of its own (ROW_OF).
  const maA = await requirement(g7a, ma, t1.id, 3, 60);
  await requirement(g7a, sv, t2.id, 2, 50);
  await requirement(g7b, ma, t1.id, 2, 45);
  const enB = await requirement(g7b, en, t2.id, 2, 40);

  const engine = new EngineStub();
  const proxy = new OptimizationProxyService(
    api,
    engine.http as never,
    { getOrThrow: () => ({ baseUrl: 'http://engine.invalid', apiKey: 'k'.repeat(32), timeoutMs: 120_000 }) } as never,
  );
  const notices: Array<{ schoolId: string; draft: boolean }> = [];
  const realtime = {
    notifyMasterTimetableChanged: (schoolId: string, options?: { draft?: boolean }) => notices.push({ schoolId, draft: options?.draft === true }),
    notifyLessonChanged: async () => undefined,
  } as unknown as RealtimeService;
  const silent = { recipientsForLessons: async () => [], notifyUsers: async () => undefined } as unknown as NotificationsService;
  const configOf = (runsMax: number) =>
    ({ get: (key: string) => (key === 'candidates' ? { maxSeconds: 30, runsMax, solverWorkers: 4, background: false } : undefined) }) as never;
  const versions = new ScheduleVersionsService(api);
  const candidates = new ScheduleCandidatesService(api, proxy, versions, realtime, configOf(2));
  const lessons = new MasterLessonsService(api, realtime, silent);
  const lessonsOnSecond = new MasterLessonsService(second, realtime, silent);
  const jobs = new OptimizationJobsService(proxy, api);

  /** Every candidate and run row the probe read, for sc-k: rows a success deletes later are scanned too. */
  const seenRows: unknown[] = [];
  const responses: unknown[] = [];

  const runRow = async (runId: string) => {
    const row = await one<{
      id: string;
      status: string;
      requested: number;
      progress: number;
      basis: string | null;
      basisParts: Record<string, string> | null;
      weights: unknown;
      unplaced: Record<string, number> | null;
      error: string | null;
      errorCode: string | null;
      errorParams: unknown;
      appliedCandidateId: string | null;
      appliedAt: Date | null;
      leaseSeconds: number;
      createdById: string | null;
      startedAt: Date | null;
      finishedAt: Date | null;
    }>(
      `SELECT id, status::text AS status, requested, progress, basis, "basisParts", weights, unplaced, error, "errorCode", "errorParams",
              "appliedCandidateId", "appliedAt", "leaseSeconds", "createdById", "startedAt", "finishedAt"
         FROM "ScheduleCandidateRuns" WHERE id = $1`,
      [runId],
    );
    if (row) seenRows.push(row);
    return row;
  };
  const candidateRows = async (runId: string) => {
    const rows = await all<{
      id: string;
      ordinal: number;
      variant: string;
      weights: Record<string, number> | null;
      seed: number | null;
      solverStatus: string;
      lessons: Array<{ requirementId: string; roomId: string | null; dayOfWeek: number; startTime: string; endTime: string }>;
      lunches: unknown;
      metrics: Record<string, number | null | object> | null;
      conflicts: Array<{ code?: string; resourceNames?: string[] }>;
      errorCode: string | null;
    }>(
      `SELECT id, ordinal, variant, weights, seed, "solverStatus", lessons, lunches, metrics, conflicts, "errorCode"
         FROM "ScheduleCandidates" WHERE "runId" = $1 ORDER BY ordinal`,
      [runId],
    );
    seenRows.push(...rows);
    return rows;
  };
  /** The run's task, awaited by the service's own registry of runs in flight. */
  const settle = async (runId: string, service: ScheduleCandidatesService = candidates) => {
    for (let tries = 0; service.running.includes(runId); tries++) {
      if (tries > 6000) throw new Error(`run ${runId} never finished`);
      await sleep(20);
    }
    return runRow(runId);
  };
  const runOf = async (count: number, service: ScheduleCandidatesService = candidates) => {
    const { runId } = await service.start({ academicYearId: year, count }, admin);
    const row = await settle(runId, service);
    return { runId, row, rows: await candidateRows(runId) };
  };
  const masters = () =>
    all<{
      id: string;
      subjectId: string;
      studentGroupId: string;
      roomId: string | null;
      dayOfWeek: number;
      start: string;
      end: string;
      isGenerated: boolean;
      isLocked: boolean;
      pupils: number;
      groups: number;
    }>(
      `SELECT m.id, m."subjectId", m."studentGroupId", m."roomId", m."dayOfWeek", to_char(m."startTime", 'HH24:MI') AS start,
              to_char(m."endTime", 'HH24:MI') AS "end", m."isGenerated", m."isLocked",
              (SELECT count(*)::int FROM "MasterLessonStudents" p WHERE p."masterLessonId" = m.id) AS pupils,
              (SELECT count(*)::int FROM "MasterLessonGroups" g WHERE g."masterLessonId" = m.id) AS groups
         FROM "MasterLessons" m WHERE m."academicYearId" = $1 ORDER BY m.id`,
      [year],
    );
  const contentOf = (row: { subjectId: string; studentGroupId: string; roomId: string | null; dayOfWeek: number; start: string; end: string }) =>
    `${row.studentGroupId}|${row.subjectId}|${row.dayOfWeek}|${row.start}|${row.end}|${row.roomId}`;
  const sortedContent = (rows: Parameters<typeof contentOf>[0][]) => rows.map(contentOf).sort();
  const versionRows = () =>
    all<{ id: string; name: string; lessonCount: number; lessons: Array<Record<string, unknown>> }>(
      `SELECT id, name, "lessonCount", lessons FROM "ScheduleVersions" WHERE "academicYearId" = $1 ORDER BY "createdAt", id`,
      [year],
    );
  const regenerations = () =>
    all<{ after: Record<string, unknown>; actorId: string | null }>(
      `SELECT after, "actorId" FROM "ScheduleChangeLogs" WHERE "academicYearId" = $1 AND action = 'REGENERATE' ORDER BY "createdAt", id`,
      [year],
    );
  /** The requirement rows by id, to read a stored lesson as (group, subject). */
  const requirementsById = new Map(
    (
      await all<{ id: string; subjectId: string; studentGroupId: string }>(
        `SELECT id, "subjectId", "studentGroupId" FROM "TeachingRequirements" WHERE "academicYearId" = $1`,
        [year],
      )
    ).map((row) => [row.id, row]),
  );
  const asMasterContent = (lesson: { requirementId: string; roomId: string | null; dayOfWeek: number; startTime: string; endTime: string }) => {
    const row = requirementsById.get(lesson.requirementId)!;
    return contentOf({ studentGroupId: row.studentGroupId, subjectId: row.subjectId, roomId: lesson.roomId, dayOfWeek: lesson.dayOfWeek, start: lesson.startTime, end: lesson.endTime });
  };
  /** A weekday on which `lesson`'s class, teacher and room are all free for its clock: a move the service accepts. */
  const freeDayFor = async (lessonId: string): Promise<number> => {
    const [lesson] = await all<{ dayOfWeek: number; studentGroupId: string; teacherId: string | null; roomId: string | null; startTime: string; endTime: string }>(
      `SELECT "dayOfWeek", "studentGroupId", "teacherId", "roomId", "startTime"::text, "endTime"::text FROM "MasterLessons" WHERE id = $1`,
      [lessonId],
    );
    const busy = await all<{ dayOfWeek: number }>(
      `SELECT DISTINCT "dayOfWeek" FROM "MasterLessons"
        WHERE "academicYearId" = $1 AND id <> $2 AND "startTime" < $6::time AND "endTime" > $5::time
          AND ("studentGroupId" = $3 OR "teacherId" = $4 OR "roomId" = $7)`,
      [year, lessonId, lesson!.studentGroupId, lesson!.teacherId, lesson!.startTime, lesson!.endTime, lesson!.roomId],
    );
    const taken = new Set(busy.map((row) => row.dayOfWeek));
    const day = [1, 2, 3, 4, 5].find((candidate) => candidate !== lesson!.dayOfWeek && !taken.has(candidate));
    assert.ok(day, 'no free weekday to move the lesson to');
    return day;
  };
  /** The first generated, unlocked, pupil-less lesson of a class and subject: one a regeneration replaces. */
  const generatedMaster = async (subjectId: string, groupId: string) =>
    (
      await one<{ id: string; dayOfWeek: number }>(
        `SELECT id, "dayOfWeek" FROM "MasterLessons" WHERE "academicYearId" = $1 AND "subjectId" = $2 AND "studentGroupId" = $3
            AND "isGenerated" AND NOT "isLocked" AND NOT EXISTS (SELECT 1 FROM "MasterLessonStudents" p WHERE p."masterLessonId" = "MasterLessons".id)
          ORDER BY "dayOfWeek", id LIMIT 1`,
        [year, subjectId, groupId],
      )
    );

  // Ids the checks hand on to each other.
  let lockedId = '';
  let handmadeId = '';
  let participantId = '';
  let lockedCalendarLesson = '';
  const pendingReleases: Array<() => void> = [];

  try {
    await check('(sc-a) Generera writes the first draft, and a run of three candidates goes end to end under app_authenticated', async () => {
      const [who] = await api.$queryRaw<{ name: string }[]>`SELECT current_user::text AS name`;
      assert.equal(who?.name, 'app_authenticated');
      // Before any draft there is nothing to compare against.
      await refusedWith(candidates.start({ academicYearId: year, count: 3 }, admin), 409, 'CANDIDATES_NEED_A_DRAFT');
      assert.equal(engine.calls.length, 0);

      // Generera's persist: the year lock, the shared write, one createMany.
      const generated = await proxy.triggerScheduling(year, admin);
      assert.equal(generated.status, 'OPTIMAL');
      const first = await masters();
      assert.equal(first.length, 9, `Generera wrote ${first.length} lessons`);
      assert.ok(first.every((row) => row.isGenerated && !row.isLocked));
      assert.equal(engine.calls.length, 1);
      assert.equal(engine.calls[0]!.body.search, undefined, 'Generera sent search');

      // What every candidate must keep: a locked generated lesson (one of 7A
      // matematik's three), a handmade one, and a generated one that names a
      // pupil (participants), each preserved by its own arm.
      lockedId = (await generatedMaster(ma, g7a)).id;
      await owner.query(`UPDATE "MasterLessons" SET "isLocked" = true WHERE id = $1`, [lockedId]);
      handmadeId = (
        await one<{ id: string }>(
          `INSERT INTO "MasterLessons" ("schoolId", "academicYearId", "subjectId", "studentGroupId", "dayOfWeek", "startTime", "endTime", "isGenerated", "updatedAt")
           VALUES ($1, $2, $3, $4, 5, '15:00', '15:30', false, now()) RETURNING id`,
          [s, year, klassrad, g7b],
        )
      ).id;
      participantId = (
        await one<{ id: string }>(
          `INSERT INTO "MasterLessons" ("schoolId", "academicYearId", "subjectId", "studentGroupId", "teacherId", "dayOfWeek", "startTime", "endTime", "isGenerated", "updatedAt")
           VALUES ($1, $2, $3, $4, $5, 4, '14:00', '14:40', true, now()) RETURNING id`,
          [s, year, stod, g7a, t1.id],
        )
      ).id;
      await owner.query(`INSERT INTO "MasterLessonStudents" ("schoolId", "masterLessonId", "studentId") VALUES ($1, $2, $3)`, [s, participantId, pupils[0]!.id]);

      // The run, its progress read as each engine call arrives.
      engine.calls.length = 0;
      const progressAtCall: number[] = [];
      for (let i = 0; i < 3; i++) {
        engine.once(isCandidateCall, async (body) => {
          const { rows } = await owner.query<{ progress: number }>(
            `SELECT progress FROM "ScheduleCandidateRuns" WHERE "academicYearId" = $1 AND status = 'RUNNING'`,
            [year],
          );
          progressAtCall.push(rows[0]?.progress ?? -1);
          return placed(body);
        });
      }
      const { runId, row: run, rows } = await runOf(3);
      assert.deepEqual(progressAtCall, [0, 1, 2], 'a candidate was not counted as it was stored');
      assert.equal(run.status, 'SUCCEEDED', `the run ended ${run.status} ${run.errorCode} ${run.error}`);
      assert.deepEqual([run.requested, run.progress, run.createdById, run.errorCode], [3, 3, adminRow.id, null]);
      assert.match(run.basis ?? '', /^[0-9a-f]{64}$/);
      assert.deepEqual(Object.keys(run.basisParts ?? {}).sort(), [...BASIS_PARTS].sort());
      // The lead waits 30 + 45 + 20 s (every candidate has the same budget), twice that is the lease.
      assert.equal(run.leaseSeconds, 190);
      assert.ok(run.startedAt && run.finishedAt);
      assert.deepEqual(
        Object.keys(run.unplaced ?? {}).sort(),
        ['draftLines', 'draftMinutes', 'lines', 'minutes'],
        `unplaced is ${JSON.stringify(run.unplaced)}`,
      );

      assert.deepEqual(
        rows.map((row) => [row.ordinal, row.variant, row.seed, row.solverStatus, row.lessons.length]),
        [
          [1, 'KEEP', null, 'OPTIMAL', 8],
          [2, 'TEACHER_GAPS', 1, 'OPTIMAL', 8],
          [3, 'SPREAD', 2, 'OPTIMAL', 8],
        ],
      );
      assert.equal(rows[0]!.weights, null);
      assert.deepEqual(rows[1]!.weights, { disruption: 2, teacherGap: 8 });
      assert.deepEqual(rows[2]!.weights, { disruption: 2, spread: 9 });
      const metric = (index: number) => {
        const metrics = rows[index]!.metrics!;
        return [metrics.moved, metrics.movedOf, metrics.kept, metrics.roomChanges, metrics.sameAs, metrics.lessonCount];
      };
      assert.deepEqual(metric(0), [0, 8, 8, 0, null, 8], 'KEEP is not the draft');
      assert.deepEqual(metric(1), [8, 8, 0, 0, null, 8], 'TEACHER_GAPS did not move every lesson');
      assert.deepEqual(metric(2), [0, 8, 8, 0, 1, 8], 'SPREAD is not shown as KEEP’s twin');
      for (const row of rows) {
        assert.ok(row.lessons.every((lesson) => requirementsById.has(lesson.requirementId) && /^\d\d:\d\d$/.test(lesson.startTime)), 'a stored lesson is not in real ids');
        // The lock covers one of 7A matematik's three: two are left to place.
        assert.equal(row.lessons.filter((lesson) => lesson.requirementId === maA).length, 2);
      }

      // The three calls: one fetch, each its own search, hints and timeout.
      assert.equal(engine.calls.length, 3);
      assert.deepEqual(
        engine.calls.map((call) => [call.body.search, call.timeoutMs, call.body.previousLessons.length, call.body.fixedLessons.length, call.body.weights ?? null]),
        [
          [{ workers: 4, probes: true, maxSeconds: 30 }, 95_000, 8, 3, null],
          [{ workers: 4, probes: false, maxSeconds: 30, seed: 1 }, 75_000, 8, 3, { disruption: 2, teacherGap: 8 }],
          [{ workers: 4, probes: false, maxSeconds: 30, seed: 2 }, 75_000, 8, 3, { disruption: 2, spread: 9 }],
        ],
      );
      assert.equal(new Set(engine.calls.map((call) => call.body.requestId)).size, 3, 'two calls shared a requestId');

      const overview = await candidates.overview(year, admin);
      responses.push(overview);
      assert.equal(overview.latest?.run.id, runId);
      assert.equal(overview.batch?.run.id, runId);
      assert.deepEqual(overview.batch?.candidates.map((candidate) => [candidate.ordinal, candidate.lessonCount, candidate.metrics?.moved]), [
        [1, 8, 0],
        [2, 8, 8],
        [3, 8, 0],
      ]);
      assert.ok(overview.unplaced);
      const read = await candidates.lessons(rows[1]!.id, admin);
      responses.push(read);
      assert.equal(read.length, 8);
      for (const lesson of read) {
        const source = requirementsById.get(lesson.requirementId)!;
        assert.deepEqual([lesson.subjectId, lesson.studentGroupId], [source.subjectId, source.studentGroupId]);
        assert.ok(!('studentIds' in lesson) && !('participants' in lesson));
      }
    });

    await check('(sc-b) the expedition’s start is refused by the insert arm and writes nothing; its DELETE removes nothing; a teacher sees no run', async () => {
      const before = await one<{ n: number }>(`SELECT count(*)::int AS n FROM "ScheduleCandidateRuns" WHERE "schoolId" = $1`, [s]);
      const calls = engine.calls.length;
      const error = await refusal(candidates.start({ academicYearId: year, count: 2 }, expedition));
      assert.equal(areaRefusal(error)?.code, 'AREA_NOT_YOURS', `not read as an area refusal: ${describe(error)}`);
      const after = await one<{ n: number }>(`SELECT count(*)::int AS n FROM "ScheduleCandidateRuns" WHERE "schoolId" = $1`, [s]);
      assert.equal(after.n, before.n, 'the refused start left a run');
      assert.equal(engine.calls.length, calls, 'the refused start reached the engine');
      // Every administrator reads the batch (the select arm asks no area) ...
      const seen = await candidates.overview(year, expedition);
      assert.ok(seen.batch, 'the expedition does not see the batch');
      // ... and only schemaläggning removes it: the delete arm filters, silently.
      await candidates.discard(year, expedition);
      const kept = await one<{ n: number }>(`SELECT count(*)::int AS n FROM "ScheduleCandidateRuns" WHERE "schoolId" = $1`, [s]);
      assert.equal(kept.n, before.n, 'the expedition deleted a batch');
      const teacherSees = await api.withRls(teacher, (tx) => tx.scheduleCandidateRun.count());
      assert.equal(teacherSees, 0, 'a teacher reads a run');
    });

    let batchId = '';
    await check('(sc-c) a run that fails keeps the batch before it, and only the next success deletes the old runs', async () => {
      const batch = (await candidates.overview(year, admin)).batch!.run.id;
      const failedRuns: string[] = [];

      // The engine gone at the second call: the run fails at once, never the third.
      engine.once(isCandidateCall, async (body) => placed(body));
      engine.once(isCandidateCall, async () => unreachable());
      let calls = engine.calls.length;
      const gone = await runOf(3);
      assert.deepEqual([gone.row.status, gone.row.errorCode, gone.row.progress], ['FAILED', 'CANDIDATE_ENGINE_TIMEOUT', 1]);
      assert.equal(engine.calls.length - calls, 2, 'the run asked again after the engine failed');
      assert.equal(gone.rows.length, 1);
      failedRuns.push(gone.runId);
      let overview = await candidates.overview(year, admin);
      assert.deepEqual([overview.latest?.run.id, overview.batch?.run.id], [gone.runId, batch]);

      // An engine older than `search`.
      engine.once(isCandidateCall, async () => olderEngine());
      calls = engine.calls.length;
      const older = await runOf(2);
      assert.deepEqual([older.row.status, older.row.errorCode, older.row.progress], ['FAILED', 'ENGINE_LACKS_CANDIDATES', 0]);
      assert.equal(engine.calls.length - calls, 1);
      failedRuns.push(older.runId);

      // The first candidate INFEASIBLE: stored, with its conflicts named, and the run ends.
      engine.once(isCandidateCall, async (body) => ({
        requestId: body.requestId,
        status: 'INFEASIBLE',
        lessons: [],
        conflicts: {
          summary: 'No timetable exists.',
          summaryCode: 'GROUP_OVERLOADED',
          summaryParams: {},
          conflicts: [
            {
              category: 'GROUP',
              code: 'GROUP_OVERLOADED',
              params: {},
              message: `Group ${body.requirements[0]!.studentGroupId} has more lessons than slots.`,
              resourceIds: [body.requirements[0]!.studentGroupId],
            },
          ],
        },
      }));
      calls = engine.calls.length;
      const infeasible = await runOf(3);
      assert.deepEqual([infeasible.row.status, infeasible.row.errorCode, infeasible.row.progress], ['FAILED', 'CANDIDATES_FIRST_FAILED', 1]);
      assert.equal(engine.calls.length - calls, 1, 'the run went on after its first candidate found nothing');
      assert.deepEqual(
        infeasible.rows.map((row) => [row.ordinal, row.solverStatus, row.errorCode, row.lessons.length, row.metrics]),
        [[1, 'INFEASIBLE', 'GROUP_OVERLOADED', 0, null]],
      );
      const names = infeasible.rows[0]!.conflicts[0]?.resourceNames ?? [];
      assert.ok(names.some((name) => name.startsWith('SF 7')), `the conflict names ${JSON.stringify(names)}`);
      failedRuns.push(infeasible.runId);

      overview = await candidates.overview(year, admin);
      assert.deepEqual([overview.latest?.run.id, overview.batch?.run.id], [infeasible.runId, batch], 'a failed run replaced the batch');
      const standing = await all<{ id: string }>(`SELECT id FROM "ScheduleCandidateRuns" WHERE "academicYearId" = $1`, [year]);
      assert.equal(standing.length, 4);

      // A success replaces them all.
      const next = await runOf(2);
      assert.equal(next.row.status, 'SUCCEEDED');
      const left = await all<{ id: string }>(`SELECT id FROM "ScheduleCandidateRuns" WHERE "academicYearId" = $1`, [year]);
      assert.deepEqual(left.map((row) => row.id), [next.runId], 'the success left older runs');
      const orphans = await one<{ n: number }>(`SELECT count(*)::int AS n FROM "ScheduleCandidates" WHERE "runId" = ANY($1::uuid[])`, [[batch, ...failedRuns]]);
      assert.equal(orphans.n, 0);
      batchId = next.runId;
    });

    await check('(sc-d) an apply writes the candidate’s masters, the safety version, the REGENERATE entry and appliedCandidateId, keeps the preserved lessons, and sweeps exactly what the check counted', async () => {
      // Dated lessons ahead in DIRECT: two of a replaced master (one with a
      // vikarie booked) and one of the locked master, which stays.
      const replaced = await generatedMaster(en, g7b);
      const calendarLesson = async (masterId: string, date: string) =>
        (
          await one<{ id: string }>(
            `INSERT INTO "CalendarLessons" ("schoolId", "masterLessonId", "subjectId", "studentGroupId", date, "startsAt", "endsAt", "updatedAt")
             SELECT m."schoolId", m.id, m."subjectId", m."studentGroupId", $2::date,
                    ($2::date + m."startTime") AT TIME ZONE 'Europe/Stockholm', ($2::date + m."endTime") AT TIME ZONE 'Europe/Stockholm', now()
               FROM "MasterLessons" m WHERE m.id = $1 RETURNING id`,
            [masterId, date],
          )
        ).id;
      const swept = [await calendarLesson(replaced.id, '2095-09-05'), await calendarLesson(replaced.id, '2095-09-12')];
      await owner.query(`INSERT INTO "CalendarLessonTeachers" ("schoolId", "calendarLessonId", "teacherId", role) VALUES ($1, $2, $3, 'SUBSTITUTE')`, [s, swept[0], t1.id]);
      lockedCalendarLesson = await calendarLesson(lockedId, '2095-09-05');

      const checked = await candidates.check(batchId, admin);
      responses.push(checked);
      assert.deepEqual(checked, { stale: false, changed: [], refusalCode: null, mode: 'DIRECT', futureCalendarLessons: 2, coverAssignments: 1 });

      const rows = await candidateRows(batchId);
      const chosen = rows.find((row) => row.variant === 'TEACHER_GAPS')!;
      const before = await masters();
      const versionsBefore = await versionRows();
      const logsBefore = await regenerations();

      // The dialog confirmed DRAFT; the school is DIRECT: refused before anything.
      const changedMode = await refusedWith(candidates.apply(chosen.id, 'DRAFT', admin), 409, 'PUBLISH_MODE_CHANGED');
      assert.deepEqual(changedMode.params, { mode: 'DIRECT' });
      assert.deepEqual(await masters(), before);
      assert.equal((await versionRows()).length, versionsBefore.length);

      notices.length = 0;
      const outcome = await candidates.apply(chosen.id, 'DIRECT', admin);
      responses.push(outcome);
      assert.equal(outcome.lessonsCreated, 8);

      const after = await masters();
      const preserved = (list: typeof after) => list.filter((row) => !row.isGenerated || row.isLocked || row.pupils > 0 || row.groups > 0);
      assert.deepEqual(preserved(after), preserved(before), 'a preserved lesson changed');
      assert.deepEqual(preserved(after).map((row) => row.id).sort(), [lockedId, handmadeId, participantId].sort());
      const draft = after.filter((row) => !preserved(after).includes(row));
      assert.deepEqual(sortedContent(draft), chosen.lessons.map(asMasterContent).sort(), 'the masters are not the candidate');
      assert.ok(draft.every((row) => row.isGenerated && !before.some((old) => old.id === row.id)));

      const versionsAfter = await versionRows();
      assert.equal(versionsAfter.length, versionsBefore.length + 1);
      const safety = versionsAfter.at(-1)!;
      assert.deepEqual([safety.id, safety.name, safety.lessonCount], [outcome.versionId, 'Före schemaförslag 2 – Färre håltimmar för lärarna', before.length]);

      const logsAfter = await regenerations();
      assert.equal(logsAfter.length, logsBefore.length + 1);
      const entry = logsAfter.at(-1)!;
      assert.equal(entry.actorId, adminRow.id);
      assert.deepEqual(
        [entry.after.source, entry.after.runId, entry.after.ordinal, entry.after.variant, entry.after.solverStatus],
        ['CANDIDATE', batchId, 2, 'TEACHER_GAPS', 'OPTIMAL'],
      );
      assert.deepEqual(
        [entry.after.lessonsCreated, entry.after.unlockedReplaced, entry.after.lockedPreserved, entry.after.calendarLessonsRemoved],
        [8, 8, 3, 2],
      );
      assert.equal((entry.after.metrics as { moved?: number } | null)?.moved, 8);

      const run = await runRow(batchId);
      assert.deepEqual([run.status, run.appliedCandidateId], ['SUCCEEDED', chosen.id]);
      assert.ok(run.appliedAt);
      assert.equal((await candidateRows(batchId)).length, 2, 'the applied batch was not kept');

      const left = await all<{ id: string }>(`SELECT id FROM "CalendarLessons" WHERE id = ANY($1::uuid[])`, [[...swept, lockedCalendarLesson]]);
      assert.deepEqual(left.map((row) => row.id), [lockedCalendarLesson], 'the sweep took other rows than the check counted');
      const sittings = await all<{ n: number }>(`SELECT count(*)::int AS n FROM "LunchSittings" WHERE "academicYearId" = $1 AND "isGenerated"`, [year]);
      assert.equal(sittings[0]!.n, 2, 'the candidate’s sittings were not written');
      assert.deepEqual(notices, [{ schoolId: s, draft: false }]);

      // The batch is stale now: the draft it was solved from is gone.
      const stale = await candidates.check(batchId, admin);
      assert.equal(stale.stale, true);
      assert.ok(stale.changed.includes('draft'), `changed: ${JSON.stringify(stale.changed)}`);
      const again = await refusedWith(candidates.apply(rows[0]!.id, 'DIRECT', admin), 409, 'SCHEDULE_CANDIDATE_STALE');
      assert.ok(again.changed?.includes('draft'));
      console.log(`     sc-d: after its own apply the batch names ${JSON.stringify(stale.changed)}`);
    });

    let staleBatch = '';
    await check('(sc-e) a hand edit after the run is 409 SCHEDULE_CANDIDATE_STALE naming the part, writes nothing, and the content put back makes the batch applicable again', async () => {
      const fresh = await runOf(2);
      assert.equal(fresh.row.status, 'SUCCEEDED');
      staleBatch = fresh.runId;
      const keep = fresh.rows[0]!;
      const writes = async () => ({
        masters: await masters(),
        versions: (await versionRows()).length,
        logs: (await regenerations()).length,
        applied: (await runRow(fresh.runId)).appliedCandidateId,
      });

      const staleWith = async (changed: string[]) => {
        const checked = await candidates.check(fresh.runId, admin);
        assert.deepEqual([checked.stale, checked.changed], [true, changed], `the check said ${JSON.stringify(checked)}`);
        const state = await writes();
        const body = await refusedWith(candidates.apply(keep.id, 'DIRECT', admin), 409, 'SCHEDULE_CANDIDATE_STALE');
        assert.deepEqual(body.changed, changed);
        assert.deepEqual(body.params, { changed: changed.join(',') }, 'the problem filter would drop what changed');
        assert.deepEqual(await writes(), state, 'the refused apply wrote');
      };
      const applicable = async () => {
        const checked = await candidates.check(fresh.runId, admin);
        assert.deepEqual([checked.stale, checked.changed], [false, []], `the check said ${JSON.stringify(checked)}`);
      };

      // A generated lesson moved by hand: the draft.
      const moved = await generatedMaster(sv, g7a);
      await lessons.update(moved.id, { dayOfWeek: await freeDayFor(moved.id) }, admin);
      await staleWith(['draft']);
      await lessons.update(moved.id, { dayOfWeek: moved.dayOfWeek }, admin);
      await applicable();

      // A timplanspost's pupil buffer: the requirements.
      await api.withRls(admin, (tx) => tx.teachingRequirement.update({ where: { id: enB }, data: { minutesBefore: 5 } }));
      await staleWith(['requirements']);
      await api.withRls(admin, (tx) => tx.teachingRequirement.update({ where: { id: enB }, data: { minutesBefore: 0 } }));
      await applicable();

      // A generated lesson locked: it is preserved now, and the demand and the draft shrink by it.
      const locking = await generatedMaster(ma, g7b);
      await lessons.update(locking.id, { isLocked: true }, admin);
      const lockedParts = (await candidates.check(fresh.runId, admin)).changed;
      assert.ok(lockedParts.includes('preserved'), `a lock did not change the preserved part: ${JSON.stringify(lockedParts)}`);
      await staleWith(lockedParts);
      await lessons.update(locking.id, { isLocked: false }, admin);
      await applicable();
      console.log(`     sc-e: a lock changes ${JSON.stringify(lockedParts)}`);
    });

    await check('(sc-f) a hand UPDATE held open makes the apply wait on the year lock and refuse; an apply held open makes the edit wait in its share of it and fail, or answer 409 past 5 s; no edit is lost without an error', async () => {
      const keep = (await candidateRows(staleBatch))[0]!;

      // 1. The edit first, parked before its COMMIT.
      const moved = await generatedMaster(sv, g7a);
      const target = await freeDayFor(moved.id);
      const held = parkedAtCommit(second);
      const editing = settled(new MasterLessonsService(held.prisma, realtime, silent).update(moved.id, { dayOfWeek: target }, admin));
      pendingReleases.push(held.release);
      const holderPid = await parked(held.reached, editing, 'the hand edit');
      const before = { versions: (await versionRows()).length, logs: (await regenerations()).length };
      const applying = settled(candidates.apply(keep.id, 'DIRECT', admin));
      const wait = await waitingOn(owner, holderPid, /pg_advisory_xact_lock|"MasterLessons"/, applying, 'the apply');
      held.release();
      const [edited, applied] = await Promise.all([editing, applying]);
      assert.ok(edited.ok, `the held edit failed: ${edited.ok ? '' : describe(edited.error)}`);
      assert.ok(!applied.ok, 'the apply wrote over a hand edit it waited for');
      const body = bodyOf(applied.error);
      assert.deepEqual([body.status, body.code, body.changed], [409, 'SCHEDULE_CANDIDATE_STALE', ['draft']]);
      const row = await one<{ dayOfWeek: number }>(`SELECT "dayOfWeek" FROM "MasterLessons" WHERE id = $1`, [moved.id]);
      assert.equal(row.dayOfWeek, target, 'the hand edit is lost');
      assert.deepEqual({ versions: (await versionRows()).length, logs: (await regenerations()).length }, before, 'the refused apply wrote');
      // Where it waited: the year's regeneration lock, which the edit holds a
      // share of — before the apply has locked a single row, so the two
      // cannot deadlock.
      assert.match(wait.statement, /grundschema-regenerate/, `the apply waited elsewhere: ${wait.statement}`);
      assert.equal(wait.waitEvent, 'Lock/advisory', `the apply waited ${wait.waitEvent}`);
      console.log(`     sc-f: the apply waited ${wait.waitEvent} in: ${wait.query}`);
      await lessons.update(moved.id, { dayOfWeek: moved.dayOfWeek }, admin);
      assert.equal((await candidates.check(staleBatch, admin)).stale, false);

      // 2. The apply first, parked at its safety snapshot with every master locked.
      const snap = snapshotParked(versions);
      const heldCandidates = new ScheduleCandidatesService(api, proxy, snap.versions, realtime, configOf(2));
      const holding = settled(heldCandidates.apply(keep.id, 'DIRECT', admin));
      pendingReleases.push(snap.release);
      const applyPid = await parked(snap.reached, holding, 'the apply');
      const victim = await generatedMaster(sv, g7a);
      const late = settled(lessonsOnSecond.update(victim.id, { dayOfWeek: await freeDayFor(victim.id) }, admin));
      const editWait = await waitingOn(owner, applyPid, /lock_years_for_grundschema_edit|"MasterLessons"/, late, 'the hand edit');
      snap.release();
      const [applyOutcome, editOutcome] = await Promise.all([holding, late]);
      assert.ok(applyOutcome.ok, `the held apply failed: ${applyOutcome.ok ? '' : describe(applyOutcome.error)}`);
      assert.ok(!editOutcome.ok, 'the edit that waited for the apply passed: it was written to a lesson the apply deleted');
      const after = await masters();
      assert.ok(!after.some((lesson) => lesson.id === victim.id), 'the edited lesson outlived the apply');
      const draft = after.filter((lesson) => lesson.isGenerated && !lesson.isLocked && lesson.pupils === 0);
      assert.deepEqual(sortedContent(draft), keep.lessons.map(asMasterContent).sort(), 'the applied draft is not the candidate');
      // In its share of the year lock, before it locked a row.
      assert.match(editWait.statement, /lock_years_for_grundschema_edit/, `the edit waited elsewhere: ${editWait.statement}`);
      console.log(`     sc-f: the edit waited ${editWait.waitEvent} in: ${editWait.query}; it then failed with ${describe(editOutcome.error).slice(0, 120)}`);

      // 3. An apply held past 5 s: the edit answers 409 SCHEDULE_BUSY in about
      //    5 s, having written nothing, and the apply then commits whole.
      const third = await runOf(2);
      const long = snapshotParked(versions);
      const longCandidates = new ScheduleCandidatesService(api, proxy, long.versions, realtime, configOf(2));
      const longApply = settled(longCandidates.apply(third.rows[1]!.id, 'DIRECT', admin));
      pendingReleases.push(long.release);
      await parked(long.reached, longApply, 'the apply');
      const target3 = await generatedMaster(sv, g7a);
      const before3 = await one<{ dayOfWeek: number }>(`SELECT "dayOfWeek" FROM "MasterLessons" WHERE id = $1`, [target3.id]);
      const startedAt = Date.now();
      const busy = await refusedWith(lessonsOnSecond.update(target3.id, { dayOfWeek: await freeDayFor(target3.id) }, admin), 409, 'SCHEDULE_BUSY');
      const waited = Date.now() - startedAt;
      assert.ok(waited >= 4_900 && waited < 14_000, `the edit gave up after ${waited} ms`);
      assert.match(String(busy.message ?? ''), /schemaförslag/, `the 409 does not say why: ${JSON.stringify(busy)}`);
      const unchanged = await one<{ dayOfWeek: number }>(`SELECT "dayOfWeek" FROM "MasterLessons" WHERE id = $1`, [target3.id]);
      assert.equal(unchanged.dayOfWeek, before3.dayOfWeek, 'the refused edit wrote');
      long.release();
      const longOutcome = await longApply;
      assert.ok(longOutcome.ok, `the apply failed: ${longOutcome.ok ? '' : describe(longOutcome.error)}`);
      console.log(`     sc-f: the edit behind a held apply answered ${busy.code} after ${waited} ms`);
    });

    await check('(sc-g) a version restore and an apply queue on the year lock both ways round, and a restore that waits past 5 s answers SCHEDULE_BUSY', async () => {
      const safetyOf = async (name: string) => (await versionRows()).find((version) => version.name === name)!;
      const restoreTarget = await safetyOf('Före schemaförslag 2 – Färre håltimmar för lärarna');
      const masterCount = async () => (await masters()).length;
      const versionContent = (version: { lessons: Array<Record<string, unknown>> }) =>
        version.lessons
          .map((lesson) =>
            contentOf({
              studentGroupId: String(lesson.studentGroupId),
              subjectId: String(lesson.subjectId),
              roomId: (lesson.roomId as string | null) ?? null,
              dayOfWeek: Number(lesson.dayOfWeek),
              start: String(lesson.startTime),
              end: String(lesson.endTime),
            }),
          )
          .sort();

      // 1. An apply holds the year lock; a restore waits for it, then replaces it whole.
      const first = await runOf(2);
      const snap = snapshotParked(versions);
      const heldCandidates = new ScheduleCandidatesService(api, proxy, snap.versions, realtime, configOf(2));
      const applying = settled(heldCandidates.apply(first.rows[1]!.id, 'DIRECT', admin));
      pendingReleases.push(snap.release);
      const applyPid = await parked(snap.reached, applying, 'the apply');
      const restoring = settled(new ScheduleVersionsService(second).restore(restoreTarget.id, admin));
      const wait = await waitingOn(owner, applyPid, /pg_advisory_xact_lock|"MasterLessons"/, restoring, 'the restore');
      snap.release();
      const [applied, restored] = await Promise.all([applying, restoring]);
      assert.ok(applied.ok && restored.ok, `apply ${applied.ok ? 'ok' : describe(applied.error)}, restore ${restored.ok ? 'ok' : describe(restored.error)}`);
      const now = await masters();
      assert.equal(now.length, restoreTarget.lessonCount, 'the restore left the apply’s lessons beside its own');
      assert.deepEqual(sortedContent(now), versionContent(restoreTarget));
      // The restore's own safety version holds the applied candidate: it ran after the apply.
      const restoredSafety = (await versionRows()).at(-1)!;
      assert.match(restoredSafety.name, /^Before restore of/);
      assert.equal(restoredSafety.lessonCount, 8 + 3);
      // Where it waited: the year lock, before it read anything it replaces.
      assert.equal(wait.waitEvent, 'Lock/advisory', `the restore waited in: ${wait.query}`);
      console.log(`     sc-g: the restore waited ${wait.waitEvent} in: ${wait.query}`);

      // 2. A restore holds it; the apply waits, then finds the draft changed.
      const second_ = await runOf(2);
      const back = parkedAtCommit(second);
      const restoringHeld = settled(new ScheduleVersionsService(back.prisma).restore(restoredSafety.id, admin));
      pendingReleases.push(back.release);
      const restorePid = await parked(back.reached, restoringHeld, 'the restore');
      const before = (await versionRows()).length;
      const applyingLate = settled(candidates.apply(second_.rows[0]!.id, 'DIRECT', admin));
      const applyWait = await waitingOn(owner, restorePid, /pg_advisory_xact_lock|"MasterLessons"/, applyingLate, 'the apply');
      back.release();
      const [restoredHeld, appliedLate] = await Promise.all([restoringHeld, applyingLate]);
      assert.ok(restoredHeld.ok, `the held restore failed: ${restoredHeld.ok ? '' : describe(restoredHeld.error)}`);
      assert.ok(!appliedLate.ok, 'the apply wrote over the restore it waited for');
      const lateBody = bodyOf(appliedLate.error);
      assert.deepEqual([lateBody.status, lateBody.code], [409, 'SCHEDULE_CANDIDATE_STALE']);
      assert.ok(lateBody.changed?.includes('draft'), JSON.stringify(lateBody));
      assert.deepEqual(sortedContent(await masters()), versionContent(restoredSafety), 'the restore did not stand');
      assert.equal((await versionRows()).length, before + 1, 'the apply left a safety version');
      assert.equal(applyWait.waitEvent, 'Lock/advisory', `the apply waited in: ${applyWait.query}`);
      console.log(`     sc-g: the apply waited ${applyWait.waitEvent}, then answered ${lateBody.code} ${JSON.stringify(lateBody.changed)}`);

      // 3. A restore behind an apply held past its 5 s: 409 SCHEDULE_BUSY, nothing written.
      const third = await runOf(2);
      const long = snapshotParked(versions);
      const longCandidates = new ScheduleCandidatesService(api, proxy, long.versions, realtime, configOf(2));
      const longApply = settled(longCandidates.apply(third.rows[1]!.id, 'DIRECT', admin));
      pendingReleases.push(long.release);
      await parked(long.reached, longApply, 'the apply');
      const content = sortedContent(await masters());
      const versionsBefore = (await versionRows()).length;
      const startedAt = Date.now();
      const busy = await refusedWith(new ScheduleVersionsService(second).restore(restoreTarget.id, admin), 409, 'SCHEDULE_BUSY');
      const waited = Date.now() - startedAt;
      assert.ok(waited >= 4_900, `the restore gave up after ${waited} ms`);
      long.release();
      const longOutcome = await longApply;
      assert.ok(longOutcome.ok, `the apply failed: ${longOutcome.ok ? '' : describe(longOutcome.error)}`);
      assert.equal((await versionRows()).length, versionsBefore + 1, 'the refused restore wrote its safety version');
      const applied3 = (await masters()).filter((lesson) => lesson.isGenerated && !lesson.isLocked && lesson.pupils === 0);
      assert.deepEqual(sortedContent(applied3), third.rows[1]!.lessons.map(asMasterContent).sort(), 'the draft is not the apply’s');
      assert.notDeepEqual(sortedContent(await masters()), content);
      console.log(`     sc-g: the restore behind a held apply answered ${busy.code} after ${waited} ms; ${await masterCount()} masters`);
    });

    await check('(sc-h) a generate whose fetch predates an apply is GENERATE_STALE; a job’s solve refuses an apply and a start, and a hand delete during it ends the job GENERATE_STALE', async () => {
      // Direct: the fetch, the apply, then the persist.
      const batch = await runOf(2);
      const solving = engine.park(isGenerateCall);
      pendingReleases.push(solving.release);
      const generating = settled(proxy.triggerScheduling(year, admin));
      await solving.arrived;
      const applied = await candidates.apply(batch.rows[1]!.id, 'DIRECT', admin);
      const afterApply = await masters();
      solving.release();
      const outcome = await generating;
      assert.ok(!outcome.ok, 'the generate wrote over the apply');
      const body = bodyOf(outcome.error);
      assert.deepEqual([body.status, body.code], [409, 'GENERATE_STALE']);
      assert.deepEqual(await masters(), afterApply, 'the refused generate wrote');
      assert.equal(applied.lessonsCreated, 8);

      // Through the job: the solve holds the year off, and a hand delete during it is the lost update.
      const next = await runOf(2);
      const jobSolve = engine.park(isGenerateCall);
      pendingReleases.push(jobSolve.release);
      const { jobId } = await jobs.start(year, admin);
      await jobSolve.arrived;
      await refusedWith(candidates.apply(next.rows[0]!.id, 'DIRECT', admin), 409, 'GENERATE_RUNNING');
      await refusedWith(candidates.start({ academicYearId: year, count: 2 }, admin), 409, 'GENERATE_RUNNING');
      const deleted = await generatedMaster(sv, g7a);
      await lessons.remove(deleted.id, admin);
      const withoutIt = await masters();
      jobSolve.release();
      let job = await jobs.get(jobId, admin);
      for (let tries = 0; job.status === 'PENDING' || job.status === 'RUNNING'; tries++) {
        if (tries > 3000) throw new Error('the job never finished');
        await sleep(20);
        job = await jobs.get(jobId, admin);
      }
      assert.deepEqual([job.status, job.errorCode], ['FAILED', 'GENERATE_STALE'], JSON.stringify(job));
      assert.deepEqual(await masters(), withoutIt, 'the stale job wrote');
    });

    await check('(sc-i) DELETE of a running run sets CANCELLING, Generera and a second start are refused beside it, and its task stops without writing', async () => {
      const solving = engine.park(isCandidateCall);
      pendingReleases.push(solving.release);
      const calls = engine.calls.length;
      const { runId } = await candidates.start({ academicYearId: year, count: 3 }, admin);
      await solving.arrived;
      assert.equal((await runRow(runId)).status, 'RUNNING');
      assert.equal(await api.withRls(admin, (tx) => yearHasActiveCandidateRun(tx, year)), true);
      await refusedWith(jobs.start(year, admin), 409, 'CANDIDATES_RUNNING');
      await refusedWith(candidates.start({ academicYearId: year, count: 2 }, admin), 409, 'CANDIDATES_RUNNING');

      const finishedBefore = await one<{ n: number }>(
        `SELECT count(*)::int AS n FROM "ScheduleCandidateRuns" WHERE "academicYearId" = $1 AND status IN ('SUCCEEDED', 'FAILED')`,
        [year],
      );
      assert.ok(finishedBefore.n > 0);
      await candidates.discard(year, admin);
      const cancelling = await runRow(runId);
      assert.equal(cancelling.status, 'CANCELLING');
      const finishedAfter = await one<{ n: number }>(`SELECT count(*)::int AS n FROM "ScheduleCandidateRuns" WHERE "academicYearId" = $1 AND id <> $2`, [year, runId]);
      assert.equal(finishedAfter.n, 0, 'the DELETE left finished runs');

      solving.release();
      const ended = await settle(runId);
      assert.deepEqual([ended.status, ended.errorCode, ended.progress], ['FAILED', 'CANDIDATE_RUN_CANCELLED', 0]);
      assert.ok(ended.finishedAt);
      assert.equal((await candidateRows(runId)).length, 0, 'the cancelled task stored a candidate');
      assert.equal(engine.calls.length - calls, 1, 'the cancelled task asked the engine again');
      // The year is free again.
      const free = await api.withRls(admin, (tx) =>
        tx.scheduleCandidateRun.count({ where: { academicYearId: year, status: { in: ['PENDING', 'RUNNING', 'CANCELLING'] } } }),
      );
      assert.equal(free, 0);
    });

    await check('(sc-j) the sweep abandons a run past its lease and frees the year; the partial index answers a start that passed every check; the cap across runs', async () => {
      // A run whose instance "died": its task parked in the engine, its heartbeat an hour old —
      // and with it the deadline of the call it had out, which the task sets in the same
      // statement (the heartbeat plus the call's timeout, well inside the lease).
      const solving = engine.park(isCandidateCall);
      pendingReleases.push(solving.release);
      const { runId } = await candidates.start({ academicYearId: year, count: 2 }, admin);
      await solving.arrived;
      await owner.query(
        `UPDATE "ScheduleCandidateRuns"
            SET "engineBusyUntil" = "engineBusyUntil" - ("heartbeatAt" - (now() - interval '1 hour')),
                "heartbeatAt" = now() - interval '1 hour'
          WHERE id = $1`,
        [runId],
      );

      // Shown as what the sweep will make it, and no longer counted as alive ...
      const shown = await candidates.overview(year, admin);
      assert.deepEqual([shown.latest?.run.id, shown.latest?.run.status, shown.latest?.run.errorCode], [runId, 'FAILED', 'CANDIDATE_RUN_ABANDONED']);
      const [alive] = await api.withRls(admin, (tx) => tx.$queryRaw<{ n: number }[]>`SELECT app.schedule_candidate_runs_active() AS n`);
      assert.equal(Number(alive?.n), 0);
      // Generera's own question (POST jobs) agrees: a run past its lease holds nobody off.
      assert.equal(await api.withRls(admin, (tx) => yearHasActiveCandidateRun(tx, year)), false);
      // ... but it still holds the year's one active place until it is marked.
      await owner.query('BEGIN');
      try {
        await assert.rejects(
          owner.query(
            `INSERT INTO "ScheduleCandidateRuns" ("schoolId", "academicYearId", status, requested) VALUES ($1, $2, 'PENDING', 2)`,
            [s, year],
          ),
          (error: { code?: string }) => error.code === '23505',
        );
      } finally {
        await owner.query('ROLLBACK');
      }

      const changed = await candidates.sweep();
      assert.ok(changed >= 1, `the sweep changed ${changed}`);
      const swept = await runRow(runId);
      assert.deepEqual([swept.status, swept.errorCode, swept.error], ['FAILED', 'CANDIDATE_RUN_ABANDONED', 'The run stopped before it finished.']);
      assert.ok(swept.finishedAt);

      // The task outlived its lease: it can no longer write.
      solving.release();
      const after = await settle(runId);
      assert.deepEqual([after.status, after.errorCode, after.progress], ['FAILED', 'CANDIDATE_RUN_ABANDONED', 0]);
      assert.equal((await candidateRows(runId)).length, 0, 'the abandoned task stored a candidate');

      // The year is free: the next start runs.
      const freed = await runOf(2);
      assert.equal(freed.row.status, 'SUCCEEDED');

      // Two starts that both pass the check: the second meets the partial
      // unique index, waits for the first's commit, and answers 409.
      const rival = deferred<number>();
      const gate = deferred<void>();
      pendingReleases.push(() => gate.resolve());
      const rivalRun = settled(
        second.withRls(admin, async (tx) => {
          await tx.scheduleCandidateRun.create({ data: { schoolId: s, academicYearId: year, status: 'PENDING', requested: 2, createdById: adminRow.id } });
          const [{ pid }] = await tx.$queryRaw<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`;
          rival.resolve(pid);
          await gate.promise;
        }),
      );
      const rivalPid = await parked(rival.promise, rivalRun, 'the rival start');
      const starting = settled(candidates.start({ academicYearId: year, count: 2 }, admin));
      const wait = await waitingOn(owner, rivalPid, /INSERT INTO "public"\."ScheduleCandidateRuns"/, starting, 'the second start');
      gate.resolve();
      const [rivalOutcome, startOutcome] = await Promise.all([rivalRun, starting]);
      assert.ok(rivalOutcome.ok);
      assert.ok(!startOutcome.ok, 'two runs are active for one year');
      assert.deepEqual([bodyOf(startOutcome.error).status, bodyOf(startOutcome.error).code], [409, 'CANDIDATES_RUNNING']);
      console.log(`     sc-j: the second start waited ${wait.waitEvent} in: ${wait.query}`);
      await owner.query(`DELETE FROM "ScheduleCandidateRuns" WHERE "academicYearId" = $1 AND status = 'PENDING'`, [year]);

      // CANDIDATE_RUNS_MAX across runs: one alive elsewhere fills a cap of one.
      await owner.query(
        `INSERT INTO "ScheduleCandidateRuns" ("schoolId", "academicYearId", status, requested, "leaseSeconds") VALUES ($1, $2, 'RUNNING', 2, 600)`,
        [s, otherYear],
      );
      try {
        const capped = new ScheduleCandidatesService(api, proxy, versions, realtime, configOf(1));
        await refusedWith(capped.start({ academicYearId: year, count: 2 }, admin), 409, 'CANDIDATES_BUSY');
      } finally {
        await owner.query(`DELETE FROM "ScheduleCandidateRuns" WHERE "academicYearId" = $1`, [otherYear]);
      }
    });

    await check('(sc-l) a run interrupted while its call is out frees its year at once, keeps its place under CANDIDATE_RUNS_MAX until that call could have ended, and writes nothing more', async () => {
      const activeNow = async () => {
        const [row] = await api.withRls(admin, (tx) => tx.$queryRaw<{ n: number }[]>`SELECT app.schedule_candidate_runs_active() AS n`);
        return Number(row?.n);
      };
      const idle = await activeNow();
      // An instance of its own, so the shutdown hook ends only this run.
      const restarting = new ScheduleCandidatesService(api, proxy, versions, realtime, configOf(idle + 2));
      const solving = engine.park(isCandidateCall);
      pendingReleases.push(solving.release);
      const { runId } = await restarting.start({ academicYearId: year, count: 2 }, admin);
      await solving.arrived;
      const out = await runRow(runId);
      assert.equal(out.status, 'RUNNING');
      const busy = await one<{ until: Date | null; heartbeat: Date }>(
        `SELECT "engineBusyUntil" AS until, "heartbeatAt" AS heartbeat FROM "ScheduleCandidateRuns" WHERE id = $1`,
        [runId],
      );
      assert.ok(busy.until, 'the call out on the engine has no deadline');
      // The lead's call: CANDIDATE_MAX_SECONDS 30 + 45 + the probe's 20.
      assert.equal(Math.round((busy.until!.getTime() - busy.heartbeat.getTime()) / 1000), 95);

      // The redeploy: SIGTERM runs the shutdown hook while the engine solves on.
      await restarting.onModuleDestroy();
      const interrupted = await runRow(runId);
      assert.deepEqual([interrupted.status, interrupted.errorCode], ['FAILED', 'CANDIDATE_RUN_INTERRUPTED']);
      // The year is free at once: Generera's question and the year's one active place.
      assert.equal(await api.withRls(admin, (tx) => yearHasActiveCandidateRun(tx, year)), false);
      // But the orphaned solve still counts under the cap: a cap with no room
      // left beside it refuses a start anywhere.
      assert.equal(await activeNow(), idle + 1, 'the interrupted run left the count while its call is out');
      const capped = new ScheduleCandidatesService(api, proxy, versions, realtime, configOf(idle + 1));
      await refusedWith(capped.start({ academicYearId: year, count: 2 }, admin), 409, 'CANDIDATES_BUSY');

      // The engine answers; the orphaned task wakes to a run that is not its own.
      solving.release();
      for (let tries = 0; tries < 50; tries++) await sleep(20);
      const after = await runRow(runId);
      assert.deepEqual([after.status, after.errorCode, after.progress], ['FAILED', 'CANDIDATE_RUN_INTERRUPTED', 0]);
      assert.equal((await candidateRows(runId)).length, 0, 'the interrupted task stored a candidate');

      // Once the call could have ended, the place is free again.
      await owner.query(`UPDATE "ScheduleCandidateRuns" SET "engineBusyUntil" = now() - interval '1 second' WHERE id = $1`, [runId]);
      assert.equal(await activeNow(), idle);
      const next = await runOf(2, capped);
      assert.equal(next.row.status, 'SUCCEEDED');
      console.log(`     sc-l: interrupted run counted until its call's deadline (95 s after the heartbeat); then a run of a cap of ${idle + 1} went through`);
    });

    await check('(sc-k) no stored candidate, run, REGENERATE entry, response or engine request names a pupil', async () => {
      const standing = await all<{ doc: string }>(
        `SELECT to_jsonb(c)::text AS doc FROM "ScheduleCandidates" c WHERE c."schoolId" = $1
         UNION ALL SELECT to_jsonb(r)::text FROM "ScheduleCandidateRuns" r WHERE r."schoolId" = $1`,
        [s],
      );
      assert.ok(standing.length >= 3, 'nothing left to scan');
      const logs = await all<{ doc: string }>(
        `SELECT after::text AS doc FROM "ScheduleChangeLogs" WHERE "academicYearId" = $1 AND action = 'REGENERATE' AND after ->> 'source' = 'CANDIDATE'`,
        [year],
      );
      assert.ok(logs.length >= 4);
      const documents: Array<[string, string]> = [
        ...standing.map((row): [string, string] => ['a stored row', row.doc]),
        ...seenRows.map((row): [string, string] => ['a row read during the probe', JSON.stringify(row)]),
        ...logs.map((row): [string, string] => ['a REGENERATE entry', row.doc]),
        ...responses.map((row): [string, string] => ['a response', JSON.stringify(row)]),
        ...engine.calls.map((call): [string, string] => ['an engine request', JSON.stringify(call.body)]),
      ];
      // The scan would find one: the participant lesson's pupil is in the version snapshots, by design.
      const snapshot = await one<{ n: number }>(
        `SELECT count(*)::int AS n FROM "ScheduleVersions" WHERE "academicYearId" = $1 AND lessons::text LIKE '%' || $2 || '%'`,
        [year, pupils[0]!.id],
      );
      assert.ok(snapshot.n > 0, 'the control found no pupil where one is: the scan proves nothing');
      for (const [what, doc] of documents) {
        for (const id of pupilIds) assert.ok(!doc.includes(id), `${what} names a pupil: ${doc.slice(0, 200)}`);
        assert.ok(!/studentIds|participants/.test(doc), `${what} carries a pupil list: ${doc.slice(0, 200)}`);
      }
      console.log(`     sc-k: scanned ${documents.length} documents for ${pupilIds.length} pupils`);
    });
  } finally {
    for (const release of pendingReleases) release();
    for (let tries = 0; candidates.running.length > 0 && tries < 3000; tries++) await sleep(20);
    await sweepScheduleCandidatesSchool(owner, marker);
  }
}
