import { randomUUID } from 'node:crypto';
import {
  ConflictException,
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleDestroy,
  OnModuleInit,
  Optional,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma, type PrismaClient, type StaffingSearchRun } from '@prisma/client';
import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';
import { DEFAULT_STAFFING_SEARCH_CONFIG, type StaffingSearchConfig } from '../config/configuration';
import { fromNioarig, type GradeNumbering } from '../common/grade-numbering';
import { requireSchoolId } from '../common/utils/request-context';
import { PrismaService } from '../database/prisma.service';
import { errorName, JobRunner } from '../jobs/job-runner';
import type { StartStaffingSearchDto } from './dto/staffing-search.dto';
import { HEARTBEAT_INTERVAL_MS, INSTANCE_NAME, isUniqueViolation } from './generate-runs';
import type { AiEngineScheduleRequest } from './interfaces/ai-engine-payload.interface';
import {
  WEEK_BOUNDS_RESPONSE_KEYS,
  type AiEngineWeekBoundsExtra,
  type AiEngineWeekBoundsResponse,
  type StaffingSearchCheckpoint,
  type StaffingSearchFiguresDoc,
  type StaffingSearchLeftOut,
  type StaffingSearchStatus,
  type StaffingSearchStop,
  type StaffingSearchTally,
  type StaffingSearchView,
} from './interfaces/staffing-search.interface';
import { OptimizationProxyService, type AnonMaps } from './optimization-proxy.service';
import {
  leadRefusal,
  growthRefusal,
  stale,
  StaffingProposalService,
  type Plan,
  type StaffingProposal,
  type StaffingState,
} from './staffing-proposal.service';
import {
  cutoffsOf,
  judgedYearsOf,
  leftOutOf,
  readEvaluation,
  runSearch,
  searchModelOf,
  type Evaluation,
  type Figures,
  type SearchModel,
  type SearchOutcome,
  type SearchProgress,
  type WeekCell,
} from './staffing-search';
import { overlayLeads, weekBasisOf, withWeekBasis, type LeadChange, type PayloadIds } from './staffing-week';
import { spanOf } from './week-check-choice';
import { withPeriodDates, type PeriodStretch } from './year-periods';

/** The engine's exact count of a week (optimization-engine/app/api/v1/week_bounds.py). */
export const WEEK_BOUNDS_PATH = '/api/v1/week-bounds';

/** A second start of a year that has a search going (the partial unique index, or the start's own check). */
export const STAFFING_SEARCH_ALREADY_RUNNING = 'STAFFING_SEARCH_ALREADY_RUNNING';
/** The school has no behörigheter recorded: nobody is known to be allowed to take a post, so nothing can be searched. */
export const STAFFING_SEARCH_NO_QUALIFICATIONS = 'STAFFING_SEARCH_NO_QUALIFICATIONS';
/** Generera's own refusals of the week (two blocks on the same times that no longer fit, a block partly locked): the week is not one to count. */
export const STAFFING_SEARCH_NOT_READY = 'STAFFING_SEARCH_NOT_READY';
export const STAFFING_SEARCH_NO_POSTS = 'STAFFING_SEARCH_NO_POSTS';
export const STAFFING_SEARCH_GONE = 'STAFFING_SEARCH_GONE';

/** How a run ends when its process is gone (the sweep's, and a restart's own). Stored as errorCode. */
export const SEARCH_ABANDONED = 'SEARCH_ABANDONED';
export const SEARCH_INTERRUPTED = 'SEARCH_INTERRUPTED';
/** A quick count of the engine refuses the week as it stands: a choice of teachers is not what is wrong with it. */
export const SEARCH_START_REFUSED = 'SEARCH_START_REFUSED';
/** No year the search could judge was counted to the end in the engine's seconds. */
export const SEARCH_START_NOT_EXACT = 'SEARCH_START_NOT_EXACT';
export const SEARCH_ENGINE_OLDER = 'SEARCH_ENGINE_OLDER';
export const SEARCH_ENGINE_FAILING = 'SEARCH_ENGINE_FAILING';
/** The engine's gate (429) or the engine itself (503) did not take a count for as long as the search waits in all. */
export const SEARCH_ENGINE_BUSY = 'SEARCH_ENGINE_BUSY';
export const SEARCH_FAILED = 'SEARCH_FAILED';

/** The sweep's name in the runner and in JobRuns. */
export const STAFFING_SEARCH_SWEEP_JOB = 'staffing-search-sweep';
export const STAFFING_SEARCH_SWEEP_INTERVAL_MS = 5 * 60 * 1000;

/** The most years a search judges: the tightest of those a released post spans. */
export const MAX_JUDGED_YEARS = 4;
export const MAX_SEARCH_ROUNDS = 40;
export const MAX_SEARCH_EVALUATIONS = 800;
/** The engine's own seconds for one count, and what the gateway waits beyond them (the engine's headroom for what it cannot interrupt, the transfer). */
export const BOUNDS_SECONDS = 25;
export const BOUNDS_WAIT_MS = (BOUNDS_SECONDS + 15) * 1000;
/** What a run's lease is at each renewal: the longest engine call it has out (BOUNDS_WAIT_MS) and the API's own steps. */
export const SEARCH_LEASE_SECONDS = 90;
/** How often the task renews its lease and looks for a cancellation: much shorter than a Generera run's, so a cancel is answered at once. */
export const SEARCH_HEARTBEAT_MS = Math.min(HEARTBEAT_INTERVAL_MS, 5_000);
/**
 * THE ENGINE IS SHARED BY EVERY SCHOOL (one replica in production) and counts one search's candidate at a time (its own gate,
 * optimization-engine/app/api/v1/week_bounds.py), so a 429 is the ordinary answer when another school's search, or the same
 * school's, holds it. The search backs off and asks again (BUSY_WAIT_MS, growing to BUSY_WAIT_MAX_MS), in slices that a
 * cancellation interrupts, and THE WAIT IS NOT COUNTED IN THE SEARCH'S TIME (as the wait for a Generera run is not): a search
 * that was kept waiting has as much to count with as one that was not. A wait that lasts BUSY_GIVE_UP_MS in all ends the search
 * with what it has (ENGINE_BUSY): a job that waits for ever is a job stuck in RUNNING.
 *
 * A 503 is the engine unreachable or a count that did not finish; it is asked again a few times (BUSY_503_RETRIES) and then
 * given up as an engine failure, since the same candidate may be what the engine cannot finish.
 */
const BUSY_WAIT_MS = 2_000;
const BUSY_WAIT_MAX_MS = 10_000;
const BUSY_SLICE_MS = 1_000;
export const BUSY_GIVE_UP_MS = 45 * 60 * 1000;
const BUSY_503_RETRIES = 8;
/** How long the search waits, in all, for a Generera run of the year to end before it goes on beside it. */
export const YIELD_MAX_MS = 10 * 60 * 1000;
const YIELD_POLL_MS = 10_000;
/** The posts and the proposal a search reads are the plan's; a run keeps its figures a day (the sweep). */
const ACTIVE: StaffingSearchStatus[] = ['PENDING', 'RUNNING', 'CANCELLING'];

/** Whatever the task needs of the school as it was read at the start: nothing is read again until the proposal is. */
interface SearchContext {
  runId: string;
  academicYearId: string;
  user: AuthenticatedUser;
  plan: Plan;
  payload: AiEngineScheduleRequest;
  anonMaps: AnonMaps;
  ids: PayloadIds;
  stretches: PeriodStretch[][] | null;
}

/** What a task is told from outside: cancelled by the school, or interrupted by this process going away. */
interface SearchControl {
  user: AuthenticatedUser;
  cancel: boolean;
  interrupted: boolean;
  /** The last look for a Generera run of the year (pauseWhileGenerating), and what it found. */
  generatingCheckedAt?: number;
  generating?: boolean;
  /** The task's heartbeat, stopped by a restart so that nothing renews a lease the restart has just ended. */
  timer?: ReturnType<typeof setInterval>;
}

/** An answer of the engine, read: its shape checked before anything ranks by it. */
function boundsShapeOf(value: unknown): AiEngineWeekBoundsResponse | null {
  if (typeof value !== 'object' || value === null) return null;
  const record = value as Record<string, unknown>;
  if (!WEEK_BOUNDS_RESPONSE_KEYS.every((key) => key in record)) return null;
  if (!Array.isArray(record.rows) || typeof record.weeksTotal !== 'number' || typeof record.weeksCounted !== 'number') return null;
  if (typeof record.deadlineHit !== 'boolean') return null;
  for (const row of record.rows as unknown[]) {
    const r = row as Record<string, unknown> | null;
    if (!r || typeof r.demandMinutes !== 'number' || typeof r.capacityMinutes !== 'number' || typeof r.converged !== 'boolean' || typeof r.cutoff !== 'boolean') {
      return null;
    }
  }
  return value as AiEngineWeekBoundsResponse;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function tallyOf(progress: SearchProgress['tally']): StaffingSearchTally {
  const { better, notBetter, worse, refused } = progress;
  return {
    better,
    notBetter,
    worse,
    refused,
    unranked: Object.values(progress.unranked).reduce((sum, count) => sum + count, 0),
  };
}

/** The figures as the school reads them: every year in the school's own numbering (the doc keeps the payload's). */
export function inSchoolsNumbering(figures: StaffingSearchFiguresDoc, numbering: GradeNumbering): StaffingSearchFiguresDoc {
  const convert = (year: number): number => fromNioarig(year, numbering) ?? year;
  return {
    ...figures,
    years: figures.years.map((entry) => ({ ...entry, year: convert(entry.year) })),
    leftOut: { posts: figures.leftOut?.posts ?? [], years: (figures.leftOut?.years ?? []).map((entry) => ({ ...entry, year: convert(entry.year) })) },
  };
}

/**
 * The figures a run keeps: each judged year's weeks before the search and as far as it has come, with the week's dates when the
 * year has periods. Only minutes and week keys.
 */
export function figuresDocOf(
  start: Figures,
  now: Figures,
  stretches: readonly (readonly PeriodStretch[])[] | null,
  leftOut: StaffingSearchLeftOut,
): StaffingSearchFiguresDoc {
  return {
    years: [...start.keys()]
      .sort((a, b) => a - b)
      .map((year) => ({
        year,
        weeks: [...start.get(year)!.entries()].map(([key, before]) => {
          const [period, parity] = key.split(':');
          const periodIndex = period === 'x' ? null : Number(period);
          const parityName = parity === 'ODD_WEEKS' || parity === 'EVEN_WEEKS' ? parity : null;
          const named = (
            periodIndex !== null && stretches
              ? withPeriodDates({ period: periodIndex, ...(parityName ? { parity: parityName } : {}) }, stretches)
              : null
          ) as Record<string, string | number> | null;
          const from = typeof named?.periodFrom === 'string' ? named.periodFrom : null;
          const to = typeof named?.periodTo === 'string' ? named.periodTo : null;
          const after: WeekCell = now.get(year)?.get(key) ?? before;
          return {
            period: periodIndex,
            parity: parityName,
            from,
            to,
            before: { demandMinutes: before.demand, capacityMinutes: before.capacity },
            after: { demandMinutes: after.demand, capacityMinutes: after.capacity },
          };
        }),
      })),
    leftOut,
  };
}

/**
 * LÄRARVAL F3: THE JOB. A search for the choice of teachers that eases the week, run in the background by the API process that
 * took the request (staffing-search.ts says what is searched and what ranks); this is the part that is not pure: the row, the
 * lease, the engine, and the proposal it hands to Föreslå bemanning.
 *
 * A SEARCH IS A ROW. StaffingSearchRuns (20270227090000) holds it with what a Generera run's row holds (claimedBy, heartbeatAt,
 * leaseUntil, one active per year, a sweep): the row is durable, the process is not. The task renews the lease every few seconds,
 * which is also when it learns that the school cancelled (CANCELLING); a process that goes away fails its runs at once
 * (OnModuleDestroy: SEARCH_INTERRUPTED) and one that is lost is failed by the sweep (SEARCH_ABANDONED). Neither is resumed: another
 * process has not got the administrator's login, and the one thing it would need to carry on is a read of the school under it.
 * What a lost run keeps is its CHECKPOINT: the moves accepted so far, written after each. A search is an anytime search (every
 * state it accepts is a proven improvement on the one before), so what is stored is always a proposal that could be shown.
 *
 * NOTHING OF THE SCHOOL IS WRITTEN. The run writes its own row. A proposal it gives is read back through the plan as it is then
 * (proposal) and judged by the plan's own rules again (leadRefusal, growthRefusal); its basis is the tjänstefördelning's, the
 * releases' and the week's together (withWeekBasis), so an apply that finds any of them changed is stale (409), and applying is
 * Föreslå bemannings own apply, with its policy and its second confirmation of new teaching.
 */
@Injectable()
export class StaffingSearchService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(StaffingSearchService.name);
  /** This instance's runs in flight, run id → what the task is told from outside. */
  private readonly inFlight = new Map<string, SearchControl>();
  private sweeping: Promise<void> | null = null;
  /** The waits of the task (an engine that says it is busy, a Generera run to give way to): replaced by the spec. */
  private delay: (ms: number) => Promise<void> = sleep;

  constructor(
    private readonly prisma: PrismaService,
    private readonly proxy: OptimizationProxyService,
    private readonly staffing: StaffingProposalService,
    @Optional() private readonly config?: ConfigService,
    @Optional() private readonly jobs?: JobRunner,
  ) {}

  onModuleInit(): void {
    // The one switch of every sweep of a queue (CANDIDATES_BACKGROUND): a deployment that turns background jobs off turns this off too.
    if (this.config?.get<{ background?: boolean }>('candidates')?.background === false || !this.jobs) return;
    this.jobs.register({ name: STAFFING_SEARCH_SWEEP_JOB, intervalMs: STAFFING_SEARCH_SWEEP_INTERVAL_MS, tick: () => this.tick() });
  }

  /**
   * Leaves the runner and fails this instance's runs in flight with SEARCH_INTERRUPTED, best effort: the year is free at once
   * instead of after the lease, the page says the service restarted, and the checkpoint stays. Each under the administrator who
   * started it, as every write of the run is.
   */
  async onModuleDestroy(): Promise<void> {
    this.jobs?.unregister(STAFFING_SEARCH_SWEEP_JOB);
    const runs = [...this.inFlight];
    for (const [, control] of runs) {
      control.interrupted = true;
      if (control.timer) clearInterval(control.timer);
    }
    this.inFlight.clear();
    await Promise.allSettled(
      runs.map(([runId, control]) =>
        this.prisma.withRls(control.user, (tx) =>
          tx.staffingSearchRun.updateMany({
            where: { id: runId, status: { in: ACTIVE } },
            data: {
              status: 'FAILED',
              error: 'The service restarted while the search was running.',
              errorCode: SEARCH_INTERRUPTED,
              errorParams: Prisma.DbNull,
              finishedAt: new Date(),
            },
          }),
        ),
      ),
    );
  }

  /** Whether the sweep's interval is set. */
  get scheduled(): boolean {
    return this.jobs?.isScheduled(STAFFING_SEARCH_SWEEP_JOB) ?? false;
  }

  /** The runs this instance is working on, by id. */
  get running(): string[] {
    return [...this.inFlight.keys()];
  }

  private settings(): StaffingSearchConfig {
    return this.config?.get<StaffingSearchConfig>('staffingSearch') ?? DEFAULT_STAFFING_SEARCH_CONFIG;
  }

  // ---------------------------------------------------------------------------
  // The sweep

  /** app.staffing_search_sweep() in a short transaction of its own, with no principal. Returns how many rows it changed. */
  async sweep(): Promise<number> {
    const rows = await this.prisma.withDeliveryService((tx) =>
      tx.$queryRaw<{ changed: number }[]>(Prisma.sql`SELECT app.staffing_search_sweep() AS "changed"`),
    );
    return Number(rows?.[0]?.changed ?? 0);
  }

  /** One pass of the job; a tick while the last one runs waits for it. Never throws. */
  async tick(): Promise<void> {
    if (this.sweeping) return this.sweeping;
    const started = new Date();
    this.sweeping = this.sweep()
      .then((changed) => this.jobs?.settled(STAFFING_SEARCH_SWEEP_JOB, started, { ok: true, counts: { changed } }))
      .catch((error: unknown) => {
        this.logger.warn(`Staffing search sweep failed [${errorName(error)}]`);
        this.jobs?.settled(STAFFING_SEARCH_SWEEP_JOB, started, { ok: false, error: errorName(error) });
      })
      .finally(() => {
        this.sweeping = null;
      });
    return this.sweeping;
  }

  // ---------------------------------------------------------------------------
  // POST search

  /**
   * A run, inserted PENDING, and its task started. Every refusal is answered here, before the 202:
   *
   *   - 409 STAFFING_SEARCH_NO_QUALIFICATIONS when no behörighet is recorded;
   *   - 409 STAFFING_SEARCH_NOT_READY when Generera's own refusals of the week stand (a block partly locked);
   *   - 409 STAFFING_SEARCH_NO_POSTS when every post is hand-placed and nothing is sent to the engine;
   *   - 409 STAFFING_SEARCH_ALREADY_RUNNING beside an active search of the year (and on the partial unique index, for two starts
   *     that pass the check at once).
   *
   * The sweep runs first, in its own transaction, so a run whose instance died does not hold the year until the five-minute job.
   * The year's older finished runs are removed in the same transaction as the insert: one finished run is kept per year.
   */
  async start(dto: StartStaffingSearchDto, user: AuthenticatedUser): Promise<{ runId: string }> {
    const schoolId = requireSchoolId(user);
    const { academicYearId } = dto;
    await this.sweepBeforeStart();
    const requestId = randomUUID();

    const { runId, context } = await this.prisma
      .withRls(user, async (tx) => {
        const active = await tx.staffingSearchRun.count({ where: { academicYearId, status: { in: ACTIVE } } });
        if (active > 0) throw this.alreadyRunning();

        const { plan, basisSha256: staffingBasis } = await this.staffing.readPlan(tx, user, {
          academicYearId,
          pinnedRequirementIds: dto.pinnedRequirementIds,
        });
        if (!plan.recorded) {
          throw new ConflictException({
            message:
              'Det går inte att söka lärarval utan registrerade behörigheter: ingen vet då vem som får ta en post. Registrera behörigheterna och försök igen.',
            code: STAFFING_SEARCH_NO_QUALIFICATIONS,
          });
        }
        // The week as a Generera would be sent it, with the posts nobody teaches as they are (the question is about the posts that are led).
        const prepared = await this.proxy.prepareSchedule(tx, academicYearId, user, { requestId, skipUnstaffedRefusal: true });
        if (!prepared.ready) {
          throw new ConflictException({
            message: 'Veckan går inte att räkna som den står: Generera nekar den av ett skäl som inte handlar om lärarval.',
            code: STAFFING_SEARCH_NOT_READY,
          });
        }
        if (prepared.payload.requirements.length === 0) {
          throw new ConflictException({
            message: 'Alla poster är handplacerade: det finns ingen vecka att räkna.',
            code: STAFFING_SEARCH_NO_POSTS,
          });
        }
        const weekBasis = weekBasisOf(prepared.basisParts);

        // One finished run is kept per year: the new one replaces it (the active one, which the count above refused, never).
        await tx.staffingSearchRun.deleteMany({ where: { academicYearId, status: { notIn: ACTIVE } } });
        const row = await tx.staffingSearchRun.create({
          data: {
            schoolId,
            academicYearId,
            createdById: user.userId ?? null,
            options: { pinnedRequirementIds: plan.pinned } as Prisma.InputJsonValue,
            staffingBasis,
            weekBasis,
            claimedBy: INSTANCE_NAME,
          },
          select: { id: true },
        });
        return {
          runId: row.id,
          context: {
            runId: row.id,
            academicYearId,
            user,
            plan,
            payload: { ...prepared.payload, ...(prepared.storedRules ? { rules: prepared.storedRules } : {}) },
            anonMaps: prepared.anonMaps,
            ids: { requirementOf: prepared.anonMaps.requirementAnonMap, teacherOf: prepared.teacherAnonMap },
            stretches: prepared.periodStretches,
          } satisfies SearchContext,
        };
      })
      .catch((error: unknown) => {
        if (isUniqueViolation(error)) throw this.alreadyRunning();
        throw error;
      });

    this.logger.log(`Staffing search started [runId=${runId}, academicYearId=${academicYearId}]`);
    this.launch(context);
    return { runId };
  }

  private alreadyRunning(): ConflictException {
    return new ConflictException({
      message: 'En sökning efter lärarval pågår redan för läsåret. Vänta tills den är klar eller avbryt den.',
      code: STAFFING_SEARCH_ALREADY_RUNNING,
    });
  }

  private async sweepBeforeStart(): Promise<void> {
    try {
      await this.sweep();
    } catch (error) {
      this.logger.warn(`Staffing search sweep before a start failed [${errorName(error)}]`);
    }
  }

  /**
   * Fire and forget, as the other queues' starts: run() records its own outcome and is written never to throw, and the catch stays
   * because an unhandled rejection of this unawaited promise would end the process for every school on the instance.
   */
  private launch(context: SearchContext): void {
    const control: SearchControl = { user: context.user, cancel: false, interrupted: false };
    this.inFlight.set(context.runId, control);
    void this.run(context, control)
      .catch((error: unknown) => {
        this.logger.error(`Staffing search ${context.runId} crashed outside its own error handling.`, error instanceof Error ? error.stack : String(error));
      })
      .finally(() => {
        this.inFlight.delete(context.runId);
      });
  }

  // ---------------------------------------------------------------------------
  // The task

  /**
   * One search. First every year a released post spans is counted on its own (the baseline: an exact count, in the engine's
   * seconds), the tightest MAX_JUDGED_YEARS of them are the years the search judges, and the posts that span only those may
   * move; then the search (staffing-search.ts runSearch) with the engine as its oracle. The lease is renewed on a timer, which
   * is also where a cancellation is seen.
   */
  private async run(context: SearchContext, control: SearchControl): Promise<void> {
    const { runId } = context;
    const startedAt = Date.now();
    const settings = this.settings();
    const budgetMs = settings.budgetSeconds * 1000;
    let pausedMs = 0;
    let progress: SearchProgress | null = null;
    let doc: StaffingSearchFiguresDoc | null = null;
    // Every write of the run goes through one chain, so that a late progress write never lands after the finishing one.
    let writes: Promise<unknown> = Promise.resolve();
    const write = <T>(task: () => Promise<T>): Promise<T> => {
      const next = writes.then(task, task);
      writes = next.catch(() => undefined);
      return next;
    };

    const stop = (): StaffingSearchStop | null =>
      control.interrupted ? 'CANCELLED' : control.cancel ? 'CANCELLED' : Date.now() - startedAt - pausedMs > budgetMs ? 'BUDGET' : null;

    const beat = async (): Promise<boolean> => {
      const state = progress;
      const rows = await write(() =>
        this.prisma.withRls(context.user, (tx) =>
          tx.$queryRaw<{ status: string }[]>(Prisma.sql`
            UPDATE "StaffingSearchRuns"
               SET "status" = CASE WHEN "status" = 'CANCELLING' THEN 'CANCELLING' ELSE 'RUNNING' END::"StaffingSearchRunStatus",
                   "heartbeatAt" = now(),
                   "leaseUntil" = now() + make_interval(secs => ${SEARCH_LEASE_SECONDS}),
                   "startedAt" = coalesce("startedAt", now()),
                   "round" = ${state?.round ?? 0},
                   "evaluations" = ${state?.evaluations ?? 0},
                   "acceptedMoves" = ${state?.accepted ?? 0}
             WHERE "id" = ${runId}::uuid AND "status" IN ('PENDING', 'RUNNING', 'CANCELLING')
         RETURNING "status"::text AS "status"`),
        ),
      );
      const status = rows?.[0]?.status;
      if (status === 'CANCELLING') control.cancel = true;
      // The run is no longer the task's (the sweep failed it, a restart did): stop asking the engine for it.
      if (status === undefined) control.interrupted = true;
      return status !== undefined;
    };

    const timer = setInterval(() => {
      void beat().catch((error: unknown) => this.logger.warn(`Staffing search heartbeat failed [runId=${runId}, ${errorName(error)}]`));
    }, SEARCH_HEARTBEAT_MS);
    control.timer = timer;

    try {
      if (!(await beat())) return;

      // What a post spans, from the payload: the posts it does not carry are not in the week, and a post whose years are not known cannot be judged.
      const entries = new Map(context.payload.requirements.map((entry) => [entry.id, entry]));
      const yearsOf = (requirementId: string): number[] | null => {
        const entry = entries.get(context.ids.requirementOf.get(requirementId) ?? '');
        const span = entry ? spanOf(entry) : null;
        if (!span) return null;
        return Array.from({ length: span.max - span.min + 1 }, (_, index) => span.min + index);
      };
      const { model, excluded } = searchModelOf(context.plan, yearsOf);
      const spanned = [...new Set(model.rows.flatMap((row) => row.years))].sort((a, b) => a - b);

      if (model.rows.length === 0) {
        const nothing = leftOutOf(model, excluded, new Map(), []);
        await this.finish(runId, context.user, write, { status: 'SUCCEEDED', stop: 'NO_MOVES', doc: figuresDocOf(new Map(), new Map(), context.stretches, nothing), checkpoint: null, progress: null });
        return;
      }

      // The oracle: one candidate state (the leads it moves) counted for the years it touches.
      const rowOf = new Map(model.rows.map((row) => [row.requirementId, row]));
      let start: Figures = new Map();
      // The waits for the engine's gate: counted once however many callers wait together (the first in line is credited), and not counted in the search's time.
      const waiting = new Set<symbol>();
      let busyMs = 0;
      const backOff = async (ms: number): Promise<void> => {
        const me = Symbol('busy');
        waiting.add(me);
        try {
          for (let left = ms; left > 0 && stop() === null && !control.interrupted; left -= BUSY_SLICE_MS) {
            const slice = Math.min(left, BUSY_SLICE_MS);
            await this.delay(slice);
            if (waiting.values().next().value === me) {
              pausedMs += slice;
              busyMs += slice;
            }
          }
        } finally {
          waiting.delete(me);
        }
      };
      const askEngine = async (leads: ReadonlyMap<string, string>, years: readonly number[], guard: Figures | null): Promise<Evaluation> => {
        const changes: LeadChange[] = [...leads].map(([requirementId, toTeacherId]) => ({
          requirementId,
          fromTeacherId: rowOf.get(requirementId)!.leadId,
          toTeacherId,
        }));
        const laid = overlayLeads(context.payload, changes, context.ids);
        // A move whose post the week does not carry, or whose from-lead the payload does not show, changes nothing it can count.
        if (laid.overlay.laidOver !== changes.length) return { kind: 'UNRANKED', reason: 'INCONSISTENT' };
        const extra: AiEngineWeekBoundsExtra = {
          years: [...years],
          ...(guard ? { cutoffs: cutoffsOf(guard, years) } : {}),
          seconds: BOUNDS_SECONDS,
        };
        let unavailable = 0;
        for (let attempt = 0; ; attempt += 1) {
          await this.pauseWhileGenerating(context, control, () => stop(), (ms) => {
            pausedMs += ms;
          });
          // Stopped while it waited: nothing was asked, and nothing is said of the engine.
          if (stop() !== null || control.interrupted) return { kind: 'UNRANKED', reason: 'DEADLINE' };
          try {
            const answer = await this.proxy.callAiEngine<unknown>(
              WEEK_BOUNDS_PATH,
              { ...laid.payload, requestId: randomUUID(), ...extra },
              context.anonMaps,
              { timeoutMs: BOUNDS_WAIT_MS },
            );
            const shaped = boundsShapeOf(answer);
            if (!shaped) return { kind: 'UNRANKED', reason: 'ENGINE_ERROR' };
            return readEvaluation(shaped, years);
          } catch (error) {
            if (error instanceof HttpException) {
              const status = error.getStatus();
              if (status === HttpStatus.NOT_FOUND || status === HttpStatus.METHOD_NOT_ALLOWED) return { kind: 'UNRANKED', reason: 'ENGINE_OLDER' };
              // The engine's gate (it takes one count at a time, for every school) or the engine unable just now: back off and ask again.
              // The wait is not the search's time; it ends the search (ENGINE_BUSY) only when it has lasted BUSY_GIVE_UP_MS in all.
              if (status === HttpStatus.TOO_MANY_REQUESTS || (status === HttpStatus.SERVICE_UNAVAILABLE && (unavailable += 1) <= BUSY_503_RETRIES)) {
                if (busyMs >= BUSY_GIVE_UP_MS) return { kind: 'UNRANKED', reason: 'ENGINE_BUSY' };
                await backOff(Math.min(BUSY_WAIT_MS * (attempt + 1), BUSY_WAIT_MAX_MS));
                continue;
              }
            }
            return { kind: 'UNRANKED', reason: 'ENGINE_ERROR' };
          }
        }
      };

      // THE BASELINE: every year a post with a choice spans, counted on its own, to the end. A year whose count did not finish is not judged.
      const baseline = new Map<number, Map<string, WeekCell>>();
      let refusedAt: string | null = null;
      let older = false;
      let busy = false;
      let next = 0;
      const baselineWorker = async (): Promise<void> => {
        while (refusedAt === null && !older && !busy && stop() === null) {
          const index = next;
          next += 1;
          const year = spanned[index];
          if (year === undefined) return;
          const answer = await askEngine(new Map(), [year], null);
          if (answer.kind === 'REFUSED') refusedAt = answer.code;
          else if (answer.kind === 'UNRANKED' && answer.reason === 'ENGINE_OLDER') older = true;
          else if (answer.kind === 'UNRANKED' && answer.reason === 'ENGINE_BUSY') busy = true;
          else if (answer.kind === 'FIGURES') baseline.set(year, new Map(answer.figures.get(year)!));
        }
      };
      await Promise.all(Array.from({ length: Math.max(1, settings.concurrency) }, baselineWorker));

      if (older) {
        await this.fail(runId, context.user, write, SEARCH_ENGINE_OLDER, 'The engine cannot count the week for a search yet.', null, null, doc);
        return;
      }
      if (busy && stop() === null) {
        await this.fail(runId, context.user, write, SEARCH_ENGINE_BUSY, 'The engine was busy for too long to count the week as it stands.', null, null, doc);
        return;
      }
      const early = stop();
      if (early !== null) {
        await this.finish(runId, context.user, write, { status: early === 'CANCELLED' ? 'CANCELLED' : 'SUCCEEDED', stop: early, doc: null, checkpoint: null, progress: null });
        return;
      }
      if (refusedAt !== null) {
        await this.fail(runId, context.user, write, SEARCH_START_REFUSED, 'The week as it stands is refused by a quick count: a choice of teachers is not what is wrong with it.', { code: refusedAt }, null, doc);
        return;
      }
      const judgedYears = judgedYearsOf(model, baseline, MAX_JUDGED_YEARS);
      // WHAT THE SEARCH WILL NOT MOVE, said (every year not counted to the end as it stands, and every year past the limit, and their posts).
      const leftOut: StaffingSearchLeftOut = leftOutOf(model, excluded, baseline, judgedYears);
      if (judgedYears.length === 0) {
        await this.fail(runId, context.user, write, SEARCH_START_NOT_EXACT, 'No year could be counted to the end in the engine\'s seconds.', null, null, figuresDocOf(new Map(), new Map(), context.stretches, leftOut));
        return;
      }
      start = new Map(judgedYears.map((year) => [year, baseline.get(year)!]));
      doc = figuresDocOf(start, start, context.stretches, leftOut);

      const search = (limits: { concurrency: number; maxRounds: number; maxEvaluations: number; batch: number }, searched: SearchModel): Promise<SearchOutcome> =>
        runSearch(searched, start, limits, {
          evaluate: (leads, years) => askEngine(leads, years, start),
          stopped: () => stop(),
          progress: (state) => {
            progress = state;
          },
          accepted: async (state) => {
            progress = state;
            doc = figuresDocOf(start, state.figures, context.stretches, leftOut);
            await write(() => this.storeProgress(runId, context, rowOf, state, doc!));
          },
        });
      const outcome = await search(
        {
          concurrency: Math.max(1, settings.concurrency),
          maxRounds: MAX_SEARCH_ROUNDS,
          maxEvaluations: MAX_SEARCH_EVALUATIONS,
          // The best of 24 moves is taken (several rounds of the study's åk 9 measured: a batch of 9 spent 800 evaluations for 19 small steps).
          batch: Math.max(24, Math.max(1, settings.concurrency) * 3),
        },
        model,
      );
      progress = outcome;
      doc = figuresDocOf(start, outcome.figures, context.stretches, leftOut);
      const checkpoint = this.checkpointOf(rowOf, outcome);
      if (outcome.stop === 'ENGINE_OLDER' || outcome.stop === 'ENGINE_FAILING' || outcome.stop === 'ENGINE_BUSY') {
        const [code, message] =
          outcome.stop === 'ENGINE_OLDER'
            ? [SEARCH_ENGINE_OLDER, 'The engine cannot count the week for a search yet.']
            : outcome.stop === 'ENGINE_BUSY'
              ? [SEARCH_ENGINE_BUSY, 'The engine was busy for too long to count more candidates: the search stopped with what it had found.']
              : [SEARCH_ENGINE_FAILING, 'The engine failed to count several candidates in a row.'];
        await this.fail(runId, context.user, write, code, message, null, checkpoint, doc, outcome);
        return;
      }
      await this.finish(runId, context.user, write, {
        status: outcome.stop === 'CANCELLED' && control.cancel ? 'CANCELLED' : 'SUCCEEDED',
        stop: outcome.stop,
        doc,
        checkpoint,
        progress: outcome,
      });
      this.logger.log(
        `Staffing search finished [runId=${runId}, stop=${outcome.stop}, rounds=${outcome.round}, evaluations=${outcome.evaluations}, ` +
          `moves=${outcome.accepted}, ms=${Date.now() - startedAt}]`,
      );
    } catch (error) {
      this.logger.error(`Staffing search failed [runId=${runId}, ${errorName(error)}]`, error instanceof Error ? error.stack : undefined);
      if (!control.interrupted) {
        await this.fail(runId, context.user, write, SEARCH_FAILED, 'The search failed.', null, null, doc).catch(() => undefined);
      }
    } finally {
      clearInterval(timer);
    }
  }

  /** Waits while a Generera run of the year is going: its CP-SAT solve takes every core, and a search should not slow it. */
  private async pauseWhileGenerating(
    context: SearchContext,
    control: SearchControl,
    stopped: () => StaffingSearchStop | null,
    paused: (ms: number) => void,
  ): Promise<void> {
    const generating = async (): Promise<boolean> => {
      // Asked at most every YIELD_POLL_MS while nothing is going: a count is asked hundreds of times.
      if (control.generatingCheckedAt !== undefined && Date.now() - control.generatingCheckedAt < YIELD_POLL_MS && !control.generating) return false;
      control.generatingCheckedAt = Date.now();
      control.generating = await this.generatingNow(context);
      return control.generating;
    };
    let waited = 0;
    while (waited < YIELD_MAX_MS && stopped() === null && !control.interrupted && (await generating())) {
      await this.delay(YIELD_POLL_MS);
      waited += YIELD_POLL_MS;
      paused(YIELD_POLL_MS);
    }
  }

  /** Whether a Generera run of the year is going (alive: its lease has not run out). */
  private generatingNow(context: SearchContext): Promise<boolean> {
    return this.prisma
        .withRls(context.user, (tx) =>
          tx.optimizationJob.count({
            where: { academicYearId: context.academicYearId, status: { in: ['PENDING', 'RUNNING'] }, leaseUntil: { gte: new Date() } },
          }),
        )
      .then((count) => count > 0)
      .catch(() => false);
  }

  /** The moves a search has accepted, with the lead each started from, and what it tried: what a lost run keeps. */
  private checkpointOf(rowOf: ReadonlyMap<string, { leadId: string }>, state: SearchProgress): StaffingSearchCheckpoint {
    return {
      changes: [...state.leads]
        .map(([requirementId, toTeacherId]) => ({ requirementId, fromTeacherId: rowOf.get(requirementId)!.leadId, toTeacherId }))
        .sort((a, b) => (a.requirementId < b.requirementId ? -1 : 1)),
      tally: tallyOf(state.tally),
    };
  }

  /** After each accepted move: the counters, the checkpoint and the figures, only while the run is still the task's. */
  private async storeProgress(
    runId: string,
    context: SearchContext,
    rowOf: ReadonlyMap<string, { leadId: string }>,
    state: SearchProgress,
    doc: StaffingSearchFiguresDoc,
  ): Promise<void> {
    const checkpoint = this.checkpointOf(rowOf, state);
    await this.prisma.withRls(context.user, (tx) =>
      tx.$executeRaw(Prisma.sql`
        UPDATE "StaffingSearchRuns"
           SET "round" = ${state.round}, "evaluations" = ${state.evaluations}, "acceptedMoves" = ${state.accepted},
               "checkpoint" = ${JSON.stringify(checkpoint)}::jsonb, "figures" = ${JSON.stringify(doc)}::jsonb,
               "heartbeatAt" = now(), "leaseUntil" = now() + make_interval(secs => ${SEARCH_LEASE_SECONDS})
         WHERE "id" = ${runId}::uuid AND "status" IN ('RUNNING', 'CANCELLING')`),
    );
  }

  /** The run ended without a failure: SUCCEEDED (the search stopped for the reason it says) or CANCELLED. Only while the run is still the task's. */
  private async finish(
    runId: string,
    user: AuthenticatedUser,
    write: <T>(task: () => Promise<T>) => Promise<T>,
    done: {
      status: 'SUCCEEDED' | 'CANCELLED';
      stop: StaffingSearchStop;
      doc: StaffingSearchFiguresDoc | null;
      checkpoint: StaffingSearchCheckpoint | null;
      progress: SearchProgress | null;
    },
  ): Promise<void> {
    await write(() =>
      this.prisma.withRls(user, (tx) =>
        tx.$executeRaw(Prisma.sql`
          UPDATE "StaffingSearchRuns"
             SET "status" = ${done.status}::"StaffingSearchRunStatus", "stopReason" = ${done.stop}, "finishedAt" = now(),
                 "round" = ${done.progress?.round ?? 0}, "evaluations" = ${done.progress?.evaluations ?? 0}, "acceptedMoves" = ${done.progress?.accepted ?? 0},
                 "figures" = coalesce(${done.doc === null ? null : JSON.stringify(done.doc)}::jsonb, "figures"),
                 "checkpoint" = coalesce(${done.checkpoint === null ? null : JSON.stringify(done.checkpoint)}::jsonb, "checkpoint")
           WHERE "id" = ${runId}::uuid AND "status" IN ('PENDING', 'RUNNING', 'CANCELLING')`),
      ),
    );
  }

  /** The run failed, with a code the page can word; its checkpoint (the best so far) stays. */
  private async fail(
    runId: string,
    user: AuthenticatedUser,
    write: <T>(task: () => Promise<T>) => Promise<T>,
    code: string,
    message: string,
    params: Record<string, string | number> | null,
    checkpoint: StaffingSearchCheckpoint | null,
    doc: StaffingSearchFiguresDoc | null,
    progress: SearchProgress | null = null,
  ): Promise<void> {
    await write(() =>
      this.prisma.withRls(user, (tx) =>
        tx.$executeRaw(Prisma.sql`
          UPDATE "StaffingSearchRuns"
             SET "status" = 'FAILED', "error" = ${message}, "errorCode" = ${code},
                 "errorParams" = ${params === null ? null : JSON.stringify(params)}::jsonb, "finishedAt" = now(),
                 "round" = ${progress?.round ?? 0}, "evaluations" = ${progress?.evaluations ?? 0}, "acceptedMoves" = ${progress?.accepted ?? 0},
                 "figures" = coalesce(${doc === null ? null : JSON.stringify(doc)}::jsonb, "figures"),
                 "checkpoint" = coalesce(${checkpoint === null ? null : JSON.stringify(checkpoint)}::jsonb, "checkpoint")
           WHERE "id" = ${runId}::uuid AND "status" IN ('PENDING', 'RUNNING', 'CANCELLING')`),
      ),
    );
  }

  // ---------------------------------------------------------------------------
  // GET and cancel

  /**
   * Cancels a search: CANCELLING, which its task sees at its next heartbeat (a few seconds) and ends CANCELLED with the best so
   * far. On this instance the task is told at once. A run that is not active is left as it is. The run, as it stands.
   */
  async cancel(runId: string, user: AuthenticatedUser): Promise<StaffingSearchView> {
    await this.prisma.withRls(user, async (tx) => {
      const run = await tx.staffingSearchRun.findUnique({ where: { id: runId }, select: { id: true } });
      if (!run) throw this.gone();
      await tx.staffingSearchRun.updateMany({
        where: { id: runId, status: { in: ['PENDING', 'RUNNING'] } },
        data: { status: 'CANCELLING' },
      });
    });
    const control = this.inFlight.get(runId);
    if (control) control.cancel = true;
    return this.view(runId, user);
  }

  private gone(): NotFoundException {
    return new NotFoundException({ message: 'Sökningen finns inte längre.', code: STAFFING_SEARCH_GONE });
  }

  /** A run as a poll reads it. A lost run (lease out) is shown as what the sweep will make it, not as running for ever. */
  async view(runId: string, user: AuthenticatedUser, now: Date = new Date()): Promise<StaffingSearchView> {
    return this.prisma.withRls(user, async (tx) => {
      const row = await tx.staffingSearchRun.findUnique({ where: { id: runId } });
      if (!row) throw this.gone();
      return this.viewOf(tx, row, now);
    });
  }

  /** The year's latest run (or null): what the dialog opens on, so that a search begun before it was closed is found again. */
  async latest(academicYearId: string, user: AuthenticatedUser, now: Date = new Date()): Promise<StaffingSearchView | null> {
    return this.prisma.withRls(user, async (tx) => {
      const row = await tx.staffingSearchRun.findFirst({ where: { academicYearId }, orderBy: { createdAt: 'desc' } });
      return row ? this.viewOf(tx, row, now) : null;
    });
  }

  private async viewOf(
    tx: PrismaClient,
    row: StaffingSearchRun,
    now: Date,
  ): Promise<StaffingSearchView> {
    const year = await tx.academicYear.findUnique({ where: { id: row.academicYearId }, select: { gradeNumbering: true } });
    const numbering: GradeNumbering = year?.gradeNumbering === 'TIOARIG' ? 'TIOARIG' : 'NIOARIG';
    const lost = ACTIVE.includes(row.status) && (row.leaseUntil.getTime() < now.getTime() || row.createdAt.getTime() < now.getTime() - 60 * 60 * 1000);
    const figures = (row.figures ?? null) as StaffingSearchFiguresDoc | null;
    const checkpoint = (row.checkpoint ?? null) as StaffingSearchCheckpoint | null;
    const ended = !ACTIVE.includes(row.status) || lost;
    const end = row.finishedAt ?? (lost ? row.leaseUntil : now);
    return {
      id: row.id,
      academicYearId: row.academicYearId,
      status: lost ? 'FAILED' : row.status,
      stopReason: (row.stopReason ?? null) as StaffingSearchStop | null,
      budgetMs: this.settings().budgetSeconds * 1000,
      elapsedMs: row.startedAt ? Math.max(0, end.getTime() - row.startedAt.getTime()) : 0,
      round: row.round,
      evaluations: row.evaluations,
      acceptedMoves: row.acceptedMoves,
      figures: figures ? inSchoolsNumbering(figures, numbering) : null,
      tally: checkpoint?.tally ?? null,
      errorCode: lost ? SEARCH_ABANDONED : row.errorCode,
      errorParams: (row.errorParams ?? null) as Record<string, string | number> | null,
      error: lost ? 'The search stopped before it finished: the service that ran it was restarted or lost.' : row.error,
      hasProposal: ended && (checkpoint?.changes.length ?? 0) > 0,
      createdAt: row.createdAt.toISOString(),
      startedAt: row.startedAt?.toISOString() ?? null,
      finishedAt: (row.finishedAt ?? (lost ? row.leaseUntil : null))?.toISOString() ?? null,
    };
  }

  // ---------------------------------------------------------------------------
  // The proposal

  /**
   * The proposal a search gives: the school as it is now, read through the plan, with the moves the search accepted laid over it.
   * An ordinary proposal (StaffingProposal), whose basis is the tjänstefördelning's, the releases' and the week's together
   * (withWeekBasis) as they were when the search read them: the school, the releases or the week having changed since is the
   * proposal gone old (409 STAFF_PROPOSAL_STALE), as an apply's is, because what the search counted is no longer what the school
   * is. The moves are judged once more by the plan's own rules (leadRefusal, growthRefusal) before anything is shown, so a
   * proposal that broke one is never handed out.
   */
  async proposal(runId: string, user: AuthenticatedUser): Promise<{ proposal: StaffingProposal; figures: StaffingSearchFiguresDoc | null }> {
    const requestId = randomUUID();
    return this.prisma.withRls(user, async (tx) => {
      const row = await tx.staffingSearchRun.findUnique({ where: { id: runId } });
      if (!row) throw this.gone();
      if (ACTIVE.includes(row.status)) throw new ConflictException({ message: 'Sökningen pågår ännu.', code: 'STAFFING_SEARCH_NOT_DONE' });
      const checkpoint = (row.checkpoint ?? null) as StaffingSearchCheckpoint | null;
      if (!checkpoint || checkpoint.changes.length === 0) {
        throw new NotFoundException({ message: 'Sökningen hittade inget byte som underlättar veckan.', code: 'STAFFING_SEARCH_NO_PROPOSAL' });
      }
      const options = (row.options ?? {}) as { pinnedRequirementIds?: string[] };
      const { state, plan, basisSha256: staffingBasis } = await this.staffing.readPlan(tx, user, {
        academicYearId: row.academicYearId,
        pinnedRequirementIds: options.pinnedRequirementIds,
      });
      // The tjänstefördelning, the releases and the week as the search read them, or the proposal is old.
      if (staffingBasis !== row.staffingBasis) throw stale();
      const prepared = await this.proxy.prepareSchedule(tx, row.academicYearId, user, { requestId, skipUnstaffedRefusal: true });
      if (!prepared.ready || weekBasisOf(prepared.basisParts) !== row.weekBasis) throw stale();

      const leads = this.leadsOf(state, plan, checkpoint);
      // The figures come with the proposal (what the search left out is said beside it), in the school's own numbering like a poll's.
      const year = await tx.academicYear.findUnique({ where: { id: row.academicYearId }, select: { gradeNumbering: true } });
      const stored = (row.figures ?? null) as StaffingSearchFiguresDoc | null;
      const figures = stored ? inSchoolsNumbering(stored, year?.gradeNumbering === 'TIOARIG' ? 'TIOARIG' : 'NIOARIG') : null;
      const proposal = this.staffing.proposalFromLeads(state, plan, leads, withWeekBasis(row.staffingBasis, row.weekBasis), user);
      return { proposal, figures };
    });
  }

  /**
   * Every free staffed row's lead with the checkpoint's moves laid over it, judged by the plan: each moved row is one the plan
   * lets be led by the teacher it names, from the lead it has, and nobody ends over their limit. Anything else is a stale
   * proposal (the plan has moved in a way the basis did not hold still), never one that is shown.
   */
  private leadsOf(state: StaffingState, plan: Plan, checkpoint: StaffingSearchCheckpoint): Map<string, string> {
    const leads = new Map<string, string>();
    for (const row of plan.rows) if (row.kind === 'KEPT' && row.current !== null) leads.set(row.row.id, row.current);
    for (const change of checkpoint.changes) {
      const planned = plan.rowById.get(change.requirementId);
      if (!planned || planned.kind !== 'KEPT' || planned.current !== change.fromTeacherId || leadRefusal(plan, planned, change.toTeacherId) !== null) {
        throw stale();
      }
      leads.set(change.requirementId, change.toTeacherId);
    }
    if (growthRefusal(state, plan, leads) !== null) throw stale();
    return leads;
  }
}

