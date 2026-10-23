import {
  ConflictException,
  HttpException,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleDestroy,
  OnModuleInit,
  Optional,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma, type PrismaClient, type ScheduleCandidateRunStatus } from '@prisma/client';
import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';
import { ScheduleVersionsService } from '../calendar/schedule-versions.service';
import { DEFAULT_CANDIDATES_CONFIG, type CandidatesConfig } from '../config/configuration';
import { PrismaService } from '../database/prisma.service';
import { isWriteConflict } from '../common/utils/prisma-errors';
import { requireSchoolId } from '../common/utils/request-context';
import { errorName, JobRunner } from '../jobs/job-runner';
import { enterGrundschemaWrite, isLockTimeout, publishModeOf, type PublishMode } from '../publication/publish-mode';
import { RealtimeService } from '../realtime/realtime.service';
import { rostersOfYear } from '../year-rollover/projected-rosters';
import { changedParts, type BasisParts } from './candidate-basis';
import { TEACHER_WORK_DAYS_HIDDEN, WORK_DAYS_HIDDEN_MESSAGE, isDaysBearing } from './work-days';
import { timetableWith, unkeptFreeDayWishes } from './free-day-wishes';
import { candidateMetricsOf, lessonCountOf, metricsViewOf, runUnplacedOf, type CandidateMetrics, type CandidateMetricsView, type RunUnplaced } from './candidate-metrics';
import {
  callTimeoutMs,
  DEFAULT_CANDIDATE_COUNT,
  leaseSecondsFor,
  refreshWeights,
  searchFor,
  snapshotNameOf,
  variantsFor,
  weightsFor,
  type CallShape,
  type SearchSettings,
} from './candidate-variants';
import type { StartCandidatesDto } from './dto/schedule-candidates.dto';
import type {
  AiEngineConflictAnalysis,
  AiEngineConflictDetail,
  AiEngineLunch,
  DayOfWeek,
  ObjectiveWeights,
} from './interfaces/ai-engine-payload.interface';
import {
  namesOf,
  notedTeachersOf,
  notesViewOf,
  storedOf,
  type ConflictView,
  type StoredConflict,
} from './stored-conflicts';
import {
  calendarSweepWhere,
  draftMastersWhere,
  engineMayStillBeSolving,
  OptimizationProxyService,
  previousLessonsFrom,
  type CandidateLesson,
  type CandidateSolution,
} from './optimization-proxy.service';
import {
  lockYearForCandidateApply,
  lockYearForRegeneration,
  lockYearForSolveStart,
  lockYearMasters,
  scheduleBusy,
  scheduleCandidateStale,
  SCHEDULE_BUSY,
  SCHEDULE_CANDIDATE_BUSY,
  SCHEDULE_CANDIDATE_STALE,
} from './regeneration-lock';

/*
 * SCHEMAFÖRSLAG (design §3–§5): two to four private candidates of a year's
 * grundschema, solved one after another in the background, compared on a
 * page of their own, and one of them applied the way Generera writes.
 *
 * THE RUN. POST answers 202 with the run's id once the row is inserted, and
 * the work goes on in this process, as an OptimizationJob's does. Unlike a
 * job's, every write the task makes is conditional on the run still being its
 * own: before each engine call a compare-and-set bumps the heartbeat WHERE the
 * run is still PENDING or RUNNING, and a 0 means somebody else decided — a
 * DELETE asked it to stop (CANCELLING), an apply superseded it, the sweep gave
 * it up — and the task stops without writing again. A candidate is stored, and
 * the run finished, under the run row's lock and only while it is RUNNING. So
 * a task that outlived its lease can never write SUCCEEDED over the sweep's
 * FAILED, nor a second batch beside the next run's.
 *
 * THE LEASE. Twice the longest call the run makes (candidate-variants.ts).
 * The task bumps heartbeatAt before every call and after every stored
 * candidate; app.schedule_candidates_sweep() fails a run whose heartbeat is
 * older than its lease, or that began more than half an hour ago, and frees
 * the year. The sweep runs in a short transaction of its own before every
 * start, and every quarter hour as a JobRunner job.
 *
 * ONE FETCH PER RUN. prepareSchedule (the proxy's, the fetch Generera makes)
 * is read once, and every candidate is solved from it: one basis for the
 * batch, and one draft for "moved" and "unplaced". An apply rebuilds the same
 * fetch in its own transaction under the locks and refuses a different basis.
 *
 * NOTHING HERE PUBLISHES, and nothing names a pupil. A candidate's lessons
 * are {requirementId, roomId, dayOfWeek, startTime, endTime}; its lunches
 * {studentGroupId, dayOfWeek, startTime, endTime}; its conflicts the job
 * row's StoredConflict. Applying one replaces the draft exactly as Generera's
 * persist does — in DIRECT that takes the replaced lessons off the calendar
 * until the next publish, which the apply dialog says.
 */

/** A run that holds the year's one active place. */
const ACTIVE: ScheduleCandidateRunStatus[] = ['PENDING', 'RUNNING', 'CANCELLING'];
/** A run whose task has nothing more to do with it. */
const FINISHED: ScheduleCandidateRunStatus[] = ['SUCCEEDED', 'FAILED'];
/** The solver statuses a candidate can be applied from. */
const APPLICABLE = new Set(['OPTIMAL', 'FEASIBLE']);

// Refusals, each a 409 (or 404) whose code the web says in Swedish.
export const CANDIDATES_RUNNING = 'CANDIDATES_RUNNING';
export const GENERATE_RUNNING = 'GENERATE_RUNNING';
export const CANDIDATES_BUSY = 'CANDIDATES_BUSY';
export const CANDIDATES_NEED_A_DRAFT = 'CANDIDATES_NEED_A_DRAFT';
export const REFRESH_GONE = 'REFRESH_GONE';
export const CANDIDATE_GONE = 'CANDIDATE_GONE';
export const PUBLISH_MODE_CHANGED = 'PUBLISH_MODE_CHANGED';
export const SCHEDULE_CANDIDATE_NOT_APPLICABLE = 'SCHEDULE_CANDIDATE_NOT_APPLICABLE';

// How a run ends when it does not succeed (ScheduleCandidateRuns.errorCode).
export const CANDIDATE_RUN_CANCELLED = 'CANDIDATE_RUN_CANCELLED';
export const CANDIDATE_RUN_INTERRUPTED = 'CANDIDATE_RUN_INTERRUPTED';
export const CANDIDATE_RUN_ABANDONED = 'CANDIDATE_RUN_ABANDONED';
export const CANDIDATE_ENGINE_TIMEOUT = 'CANDIDATE_ENGINE_TIMEOUT';
export const CANDIDATE_ENGINE_FAILED = 'CANDIDATE_ENGINE_FAILED';
export const CANDIDATES_FIRST_FAILED = 'CANDIDATES_FIRST_FAILED';
export const CANDIDATES_NONE_APPLICABLE = 'CANDIDATES_NONE_APPLICABLE';

/** The sweep's name in the runner and in JobRuns. */
export const SWEEP_JOB = 'schedule-candidates-sweep';
/** Every quarter hour: a lost run already frees its year at the next start, so this is for the ones nobody starts after. */
export const SWEEP_INTERVAL_MS = 15 * 60 * 1000;
/** A Generera job of the year PENDING or RUNNING and younger than this holds candidate runs off, and an apply. */
export const GENERATE_JOB_WINDOW_MS = 15 * 60 * 1000;
/** The sweep's other limit: a run older than this has lost its task whatever its heartbeat says. */
export const RUN_MAX_AGE_MS = 30 * 60 * 1000;
/** The fetch of a run and of a check: Generera's fetch plus the timplan rows "unplaced" needs. */
export const PREPARE_TIMEOUT_MS = 30_000;
/** The apply's whole transaction: the fetch again, a snapshot, and the write (design §4). */
export const APPLY_TIMEOUT_MS = 60_000;

/** The stored errorCode's shape (ScheduleCandidateRuns_errorCode_is_a_name). */
const CODE_SHAPE = /^[A-Z][A-Z0-9_]{0,63}$/;
/** ScheduleCandidateRuns_error_is_short. */
const ERROR_MAX = 2000;

export interface CandidateRunView {
  id: string;
  status: ScheduleCandidateRunStatus;
  requested: number;
  progress: number;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  error: string | null;
  errorCode: string | null;
  errorParams: Record<string, string | number> | null;
  createdById: string | null;
  /**
   * Always null. The safety versions this feature leans on name nobody
   * either (ScheduleVersionsService.list), and a name here would be a
   * person read out of Users for every poll of the page.
   */
  createdByName: string | null;
  appliedCandidateId: string | null;
  appliedAt: string | null;
  refreshOfId: string | null;
}

export interface CandidateView {
  id: string;
  ordinal: number;
  variant: string;
  weights: ObjectiveWeights | null;
  solverStatus: string;
  lessonCount: number;
  errorCode: string | null;
  /** errorCode's values (scalars), for its sentence; null when there are none. */
  errorParams: Record<string, string | number> | null;
  /** Null unless OPTIMAL or FEASIBLE. */
  metrics: CandidateMetricsView | null;
  conflicts: StoredConflict[];
  /**
   * The free-day wishes the candidate's timetable breaks (free-day-wishes.ts),
   * as Generera's notes: the teacher named beside each for every reader. Null
   * when it was not measured — a candidate with no timetable, or one stored
   * before 20261127090000; empty when every wish is kept.
   */
  notes: ConflictView[] | null;
}

export interface CandidateBatchView {
  run: CandidateRunView;
  candidates: CandidateView[];
}

export interface CandidatesOverview {
  /** The newest run of the year that no discard removed, any status, with what it has stored so far. */
  latest: CandidateBatchView | null;
  /** The newest SUCCEEDED run: the batch a comparison is made of. */
  batch: CandidateBatchView | null;
  /** The batch's unplaced figure beside the draft's, as measured when it was stored. */
  unplaced: RunUnplaced | null;
  /**
   * The free-day wishes the draft the batch was solved from breaks, measured
   * when it was stored, as each candidate's notes are: the comparison's first
   * column. Null when there is no batch or it was stored before 20261127090000.
   */
  draftNotes: ConflictView[] | null;
}

export interface CandidateCheck {
  stale: boolean;
  changed: string[];
  refusalCode: string | null;
  mode: PublishMode;
  futureCalendarLessons: number;
  coverAssignments: number;
}

/** One stored lesson as the compare page reads it: the MasterLesson shape, resolved from the requirement now. */
export interface CandidateLessonView {
  requirementId: string;
  subjectId: string;
  studentGroupId: string;
  teacherId: string | null;
  coTeacherId: string | null;
  roomId: string | null;
  dayOfWeek: number;
  startTime: string;
  endTime: string;
  recurrence: string;
  startDate: string | null;
  endDate: string | null;
}

export interface CandidateApplyOutcome {
  lessonsCreated: number;
  versionId: string;
}

/** One candidate the task will solve. */
export interface PlannedCandidate {
  ordinal: number;
  variant: string;
  weights: ObjectiveWeights | null;
  seed: number | null;
  /** A refresh's hints, the old candidate's lessons. Null: the draft's own, as Generera's. */
  previous: CandidateLesson[] | null;
}

/** What the task was started with. */
interface RunPlan {
  runId: string;
  schoolId: string;
  academicYearId: string;
  candidates: PlannedCandidate[];
  settings: SearchSettings;
}

/** How a run failed, as it is stored. */
interface RunFailure {
  code: string | null;
  message: string;
  params: Record<string, string | number> | null;
}

/**
 * Whether the year has a candidate run that is active AND alive — inside its
 * lease and its half hour, the runs app.schedule_candidate_runs_active()
 * counts — for Generera's POST jobs, which refuses to start beside one. A run
 * past its lease no longer holds anybody off: the sweep is about to fail it,
 * and its task is gone. Under the caller's RLS.
 */
export async function yearHasActiveCandidateRun(tx: PrismaClient, academicYearId: string): Promise<boolean> {
  const rows = await tx.$queryRaw<{ active: number }[]>(
    Prisma.sql`SELECT count(*)::integer AS "active" FROM "ScheduleCandidateRuns"
                WHERE "academicYearId" = ${academicYearId}::uuid
                  AND "status" IN ('PENDING', 'RUNNING', 'CANCELLING')
                  AND "heartbeatAt" + make_interval(secs => "leaseSeconds") >= now()
                  AND "createdAt" >= now() - interval '30 minutes'`,
  );
  return Number(rows?.[0]?.active ?? 0) > 0;
}

/** Generera's own refusal while a candidate run holds the year. */
export function candidatesRunning(): ConflictException {
  return new ConflictException({
    message: 'Schemaförslag tas fram för läsåret just nu. Försök igen när de är klara.',
    code: CANDIDATES_RUNNING,
  });
}

/**
 * The draft's own masters, by the proxy's one rule: everything that is not
 * PRESERVED_FROM_REGENERATION (optimization-proxy.service.ts), never a copy of
 * it, since a lesson in one list and not the other is either counted as a
 * draft that the write would keep or the other way round.
 */
export { draftMastersWhere };

const iso = (value: Date | null | undefined): string | null => (value ? value.toISOString() : null);
const dayString = (value: Date | null | undefined): string | null => (value ? value.toISOString().slice(0, 10) : null);
const truncate = (text: string): string => (text.length > ERROR_MAX ? text.slice(0, ERROR_MAX) : text);
const codeOrNull = (code: unknown): string | null => (typeof code === 'string' && CODE_SHAPE.test(code) ? code : null);

/** Scalars only, as the job row keeps its params (optimization-jobs.service.ts asParams). */
function scalarParams(value: unknown): Record<string, string | number> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const params: Record<string, string | number> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (typeof entry === 'string' || typeof entry === 'number') params[key] = entry;
  }
  return Object.keys(params).length > 0 ? params : null;
}

const WEIGHT_KEYS = ['preferredFree', 'preferredBusy', 'disruption', 'spread', 'teacherGap'] as const;

/** The five integer weights and nothing else, from a DTO or a stored blob; null when none is set. */
export function plainWeights(value: unknown): ObjectiveWeights | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const weights: ObjectiveWeights = {};
  for (const key of WEIGHT_KEYS) {
    const entry = (value as Record<string, unknown>)[key];
    if (typeof entry === 'number' && Number.isInteger(entry) && entry >= 0 && entry <= 1000) weights[key] = entry;
  }
  return Object.keys(weights).length > 0 ? weights : null;
}

const CLOCK = /^\d{2}:\d{2}$/;

/** A stored lesson list, read back; null when any entry is not the shape the run wrote. */
export function storedLessonsOf(value: unknown): CandidateLesson[] | null {
  if (!Array.isArray(value)) return null;
  const lessons: CandidateLesson[] = [];
  for (const entry of value as unknown[]) {
    const lesson = (entry ?? {}) as Record<string, unknown>;
    const day = lesson['dayOfWeek'];
    const room = lesson['roomId'];
    if (
      typeof lesson['requirementId'] !== 'string' ||
      !(room === null || typeof room === 'string') ||
      typeof day !== 'number' ||
      !Number.isInteger(day) ||
      day < 1 ||
      day > 7 ||
      typeof lesson['startTime'] !== 'string' ||
      !CLOCK.test(lesson['startTime']) ||
      typeof lesson['endTime'] !== 'string' ||
      !CLOCK.test(lesson['endTime'])
    ) {
      return null;
    }
    lessons.push({
      requirementId: lesson['requirementId'],
      roomId: room,
      dayOfWeek: day as DayOfWeek,
      startTime: lesson['startTime'],
      endTime: lesson['endTime'],
    });
  }
  return lessons;
}

/** Stored sittings, read back; null (the stored sittings stand) when none were stored or the shape is not the run's. */
export function storedLunchesOf(value: unknown): AiEngineLunch[] | null {
  if (!Array.isArray(value)) return null;
  const lunches: AiEngineLunch[] = [];
  for (const entry of value as unknown[]) {
    const lunch = (entry ?? {}) as Record<string, unknown>;
    const day = lunch['dayOfWeek'];
    if (
      typeof lunch['studentGroupId'] !== 'string' ||
      typeof day !== 'number' ||
      typeof lunch['startTime'] !== 'string' ||
      typeof lunch['endTime'] !== 'string'
    ) {
      return null;
    }
    lunches.push({
      studentGroupId: lunch['studentGroupId'],
      dayOfWeek: day as DayOfWeek,
      startTime: lunch['startTime'],
      endTime: lunch['endTime'],
    });
  }
  return lunches;
}

/** The lessons as they are stored: the five fields, built field by field so nothing else rides along. */
function lessonsForStorage(lessons: readonly CandidateLesson[]): CandidateLesson[] {
  return lessons.map((lesson) => ({
    requirementId: lesson.requirementId,
    roomId: lesson.roomId,
    dayOfWeek: lesson.dayOfWeek,
    startTime: lesson.startTime,
    endTime: lesson.endTime,
  }));
}

/** The sittings as they are stored: a class, a day, a clock. */
function lunchesForStorage(lunches: readonly AiEngineLunch[]): AiEngineLunch[] {
  return lunches.map((lunch) => ({
    studentGroupId: lunch.studentGroupId,
    dayOfWeek: lunch.dayOfWeek,
    startTime: lunch.startTime,
    endTime: lunch.endTime,
  }));
}

/**
 * A sentence about a post's days (Lärarens dag), as a candidate keeps it: the
 * hidden one, for every reader. The figure is HR data, and the job row keeps
 * its sentence without it and decides per reader what is shown (work-days.ts,
 * forReader); a candidate is read on a page that has no HR-läs path and
 * writes no Läslogg row, so it keeps what a reader without HR-läs is shown —
 * no figure, no post, no teacher — rektor included. Generera's page names
 * them to whoever may read them.
 */
function hiddenDaysSentence(conflict: Pick<StoredConflict, 'category'>): StoredConflict {
  return { category: conflict.category, code: TEACHER_WORK_DAYS_HIDDEN, params: {}, message: WORK_DAYS_HIDDEN_MESSAGE, resourceNames: [] };
}

/**
 * What of a refusal a candidate keeps: what the job row keeps (StoredConflict),
 * never the id arrays, and a days-bearing sentence hidden, once: two of them
 * say nothing the first did not (forReader's rule).
 */
export function storedConflictsOf(analysis: AiEngineConflictAnalysis | null): StoredConflict[] {
  let hidden = false;
  return (analysis?.conflicts ?? []).flatMap((conflict): StoredConflict[] => {
    if (isDaysBearing(conflict.code)) {
      if (hidden) return [];
      hidden = true;
      return [hiddenDaysSentence(conflict)];
    }
    return [
      {
        category: conflict.category,
        code: conflict.code,
        params: conflict.params ?? {},
        message: conflict.message,
        resourceNames: conflict.resourceNames ?? [],
      },
    ];
  });
}

/** A candidate's or a run's own code and values, a days-bearing one hidden as storedConflictsOf hides it. */
function sentenceCodeOf(
  code: unknown,
  params: unknown,
): { code: string | null; params: Record<string, string | number> | null } {
  if (typeof code === 'string' && isDaysBearing(code)) return { code: TEACHER_WORK_DAYS_HIDDEN, params: null };
  return { code: codeOrNull(code), params: scalarParams(params) };
}

/** The stored sentences as a view, field by field: nothing a row might carry beyond them goes out. */
function conflictsViewOf(value: unknown): StoredConflict[] {
  if (!Array.isArray(value)) return [];
  return (value as Array<Partial<StoredConflict> & Pick<StoredConflict, 'category' | 'message'>>).map((conflict) => ({
    category: conflict.category,
    ...(conflict.code !== undefined ? { code: conflict.code } : {}),
    ...(conflict.params !== undefined ? { params: conflict.params } : {}),
    message: conflict.message,
    resourceNames: conflict.resourceNames ?? [],
  }));
}

function unplacedViewOf(value: unknown): RunUnplaced | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const blob = value as Record<string, unknown>;
  const n = (key: string): number | null =>
    typeof blob[key] === 'number' && Number.isFinite(blob[key] as number) ? (blob[key] as number) : null;
  const [lines, minutes, draftLines, draftMinutes] = [n('lines'), n('minutes'), n('draftLines'), n('draftMinutes')];
  if (lines === null || minutes === null || draftLines === null || draftMinutes === null) return null;
  return { lines, minutes, draftLines, draftMinutes };
}

/**
 * How a failed engine call reads on the run. A call that ran out of time or
 * never reached the engine (the proxy's 503s) is CANDIDATE_ENGINE_TIMEOUT; an
 * engine that broke (another 5xx) CANDIDATE_ENGINE_FAILED; anything the engine
 * or the proxy NAMED keeps its name — ENGINE_LACKS_CANDIDATES, and the
 * engine's own 4xx refusals — with its values.
 */
export function engineFailureOf(error: unknown): RunFailure {
  const failure = failureOf(error);
  if (failure.code !== null || !(error instanceof HttpException)) return failure;
  const status = error.getStatus();
  if (status === 503 || status === 504) return { ...failure, code: CANDIDATE_ENGINE_TIMEOUT };
  if (status >= 500) return { ...failure, code: CANDIDATE_ENGINE_FAILED };
  return failure;
}

/**
 * An HttpException's own message, code and values; anything else its message
 * and no code. The engine's refusal about a post's days (a WorkDaysRefusal)
 * is kept as the hidden sentence: see hiddenDaysSentence.
 */
function failureOf(error: unknown): RunFailure {
  if (error instanceof HttpException) {
    const body = error.getResponse();
    if (typeof body === 'object' && body !== null) {
      const shape = body as { message?: unknown; code?: unknown; params?: unknown };
      if (typeof shape.code === 'string' && isDaysBearing(shape.code)) {
        return { message: WORK_DAYS_HIDDEN_MESSAGE, code: TEACHER_WORK_DAYS_HIDDEN, params: null };
      }
      return {
        message: typeof shape.message === 'string' ? shape.message : error.message,
        code: codeOrNull(shape.code),
        params: scalarParams(shape.params),
      };
    }
    return { message: typeof body === 'string' ? body : error.message, code: null, params: null };
  }
  return { message: error instanceof Error ? error.message : 'The candidate run failed.', code: null, params: null };
}

const RUN_SELECT = {
  id: true,
  status: true,
  requested: true,
  progress: true,
  createdAt: true,
  startedAt: true,
  finishedAt: true,
  error: true,
  errorCode: true,
  errorParams: true,
  createdById: true,
  appliedCandidateId: true,
  appliedAt: true,
  refreshOfId: true,
  heartbeatAt: true,
  leaseSeconds: true,
  unplaced: true,
  draftNotes: true,
  // Never the lessons: a page that polls every two seconds while a run is
  // going needs the figures, and a candidate's lessons are read once each.
  candidates: {
    orderBy: { ordinal: 'asc' },
    select: {
      id: true,
      ordinal: true,
      variant: true,
      weights: true,
      solverStatus: true,
      errorCode: true,
      errorParams: true,
      metrics: true,
      conflicts: true,
      notes: true,
    },
  },
} satisfies Prisma.ScheduleCandidateRunSelect;

type RunRow = Prisma.ScheduleCandidateRunGetPayload<{ select: typeof RUN_SELECT }>;

@Injectable()
export class ScheduleCandidatesService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ScheduleCandidatesService.name);
  /** This instance's runs in flight, run id → the admin who started it: what OnModuleDestroy fails. */
  private readonly inFlight = new Map<string, AuthenticatedUser>();
  private sweeping: Promise<void> | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly proxy: OptimizationProxyService,
    private readonly versions: ScheduleVersionsService,
    private readonly realtime: RealtimeService,
    @Optional() private readonly config?: ConfigService,
    @Optional() private readonly jobs?: JobRunner,
  ) {}

  onModuleInit(): void {
    if (!this.settings().background || !this.jobs) return;
    this.jobs.register({ name: SWEEP_JOB, intervalMs: SWEEP_INTERVAL_MS, tick: () => this.tick() });
  }

  /**
   * Leaves the runner, and fails this instance's runs in flight with
   * CANDIDATE_RUN_INTERRUPTED, best effort: the year is free at once instead
   * of after the lease, and the page says the service restarted rather than
   * that the run stopped answering. Each under the admin who started it, as
   * every write of the run is.
   *
   * engineBusyUntil is left as the last call set it: the engine solves on
   * after its caller is gone, so the run keeps its place under
   * CANDIDATE_RUNS_MAX until that call could have ended
   * (app.schedule_candidate_runs_active), while the year itself is free.
   */
  async onModuleDestroy(): Promise<void> {
    this.jobs?.unregister(SWEEP_JOB);
    const runs = [...this.inFlight];
    this.inFlight.clear();
    await Promise.allSettled(
      runs.map(([runId, user]) =>
        this.prisma.withRls(user, (tx) =>
          tx.scheduleCandidateRun.updateMany({
            where: { id: runId, status: { in: ACTIVE } },
            data: {
              status: 'FAILED',
              error: 'The service restarted while the candidates were being made.',
              errorCode: CANDIDATE_RUN_INTERRUPTED,
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
    return this.jobs?.isScheduled(SWEEP_JOB) ?? false;
  }

  /** The runs this instance is working on, by id. */
  get running(): string[] {
    return [...this.inFlight.keys()];
  }

  private settings(): CandidatesConfig {
    return this.config?.get<CandidatesConfig>('candidates') ?? DEFAULT_CANDIDATES_CONFIG;
  }

  private searchSettings(): SearchSettings {
    const settings = this.settings();
    return { maxSeconds: settings.maxSeconds, workers: settings.solverWorkers };
  }

  // ---------------------------------------------------------------------------
  // The sweep
  // ---------------------------------------------------------------------------

  /**
   * app.schedule_candidates_sweep() in a short transaction of its own, with no
   * principal: the function is the owner's and takes no argument. Returns how
   * many runs it failed or deleted.
   */
  async sweep(): Promise<number> {
    const rows = await this.prisma.withDeliveryService((tx) =>
      tx.$queryRaw<{ changed: number }[]>(Prisma.sql`SELECT app.schedule_candidates_sweep() AS "changed"`),
    );
    return Number(rows?.[0]?.changed ?? 0);
  }

  /** One pass of the job; a tick while the last one runs waits for it. Never throws. */
  async tick(): Promise<void> {
    if (this.sweeping) return this.sweeping;
    const started = new Date();
    this.sweeping = this.sweep()
      .then((changed) => this.jobs?.settled(SWEEP_JOB, started, { ok: true, counts: { changed } }))
      .catch((error: unknown) => {
        this.logger.warn(`Candidate sweep failed [${errorName(error)}]`);
        this.jobs?.settled(SWEEP_JOB, started, { ok: false, error: errorName(error) });
      })
      .finally(() => {
        this.sweeping = null;
      });
    return this.sweeping;
  }

  // ---------------------------------------------------------------------------
  // POST candidates
  // ---------------------------------------------------------------------------

  /**
   * A run, inserted PENDING, and its task started. Every refusal is answered
   * here, before the 202:
   *
   *   - a year two steps ahead of the active one (rostersOfYear, R6);
   *   - 404 REFRESH_GONE for a refresh of a run that is gone or not SUCCEEDED;
   *   - 409 CANDIDATES_NEED_A_DRAFT when the year has no lesson a
   *     regeneration would replace — "moved" would have nothing to count
   *     against, and Generera is the first step;
   *   - 409 GENERATE_RUNNING beside a Generera job of the year;
   *   - 409 CANDIDATES_RUNNING beside an active run of the year (and on the
   *     partial unique index, for two starts that pass the check at once);
   *   - 409 CANDIDATES_BUSY when CANDIDATE_RUNS_MAX runs are active across
   *     schools — asked under one advisory lock, so two starts cannot both
   *     see the last place free.
   *
   * The sweep runs first, in its own transaction, so a run whose instance
   * died does not hold the year until the quarter-hour job comes round.
   */
  async start(dto: StartCandidatesDto, user: AuthenticatedUser): Promise<{ runId: string }> {
    const schoolId = requireSchoolId(user);
    const { academicYearId } = dto;
    await this.sweepBeforeStart();
    const settings = this.searchSettings();
    const runsMax = this.settings().runsMax;

    const { runId, candidates } = await this.prisma.withRls(user, async (tx) => {
      await rostersOfYear(tx, user, academicYearId);
      const planned = dto.refreshOf
        ? await this.refreshPlan(tx, dto.refreshOf, academicYearId)
        : { weights: plainWeights(dto.weights), candidates: this.freshPlan(dto.count, plainWeights(dto.weights)) };

      const drafts = await tx.masterLesson.count({ where: draftMastersWhere(academicYearId) });
      if (drafts === 0) {
        throw new ConflictException({
          message: 'Generera ett första schema, sedan kan du ta fram förslag utifrån det.',
          code: CANDIDATES_NEED_A_DRAFT,
        });
      }
      // Before the cross-check with Generera, so a POST jobs at the same
      // moment either sees this run or is seen (regeneration-lock.ts).
      await lockYearForSolveStart(tx, academicYearId, CANDIDATES_RUNNING);
      // And past any rewrite of the year in progress (an apply, a restore,
      // Generera's write): held until this start commits, so the run's task,
      // whose fetch begins once it has, reads the rewrite's result and not
      // the draft it replaced — and an apply's CANCELLING of newer runs
      // cannot miss a run inserted beside it. At most 5 s, then 409
      // SCHEDULE_BUSY. Order: start lock, then this, then the global one.
      await lockYearForRegeneration(tx, academicYearId, SCHEDULE_BUSY);
      if (await this.generateRunning(tx, academicYearId)) throw generateRunning();
      const active = await tx.scheduleCandidateRun.findFirst({
        where: { academicYearId, status: { in: ACTIVE } },
        select: { id: true },
      });
      if (active) throw candidatesRunning();

      try {
        await tx.$executeRaw`SET LOCAL lock_timeout = '5s'`;
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('schedule-candidates-start'))`;
      } catch (error) {
        if (isLockTimeout(error)) throw candidatesBusy();
        throw error;
      }
      const [counted] = await tx.$queryRaw<{ active: number }[]>(
        Prisma.sql`SELECT app.schedule_candidate_runs_active() AS "active"`,
      );
      if (Number(counted?.active ?? 0) >= runsMax) throw candidatesBusy();

      const calls = planned.candidates.map((candidate, index) => callOf(candidate, index));
      try {
        const run = await tx.scheduleCandidateRun.create({
          data: {
            schoolId,
            academicYearId,
            createdById: user.userId ?? null,
            status: 'PENDING',
            requested: planned.candidates.length,
            leaseSeconds: leaseSecondsFor(calls, settings),
            weights: jsonOrDbNull(planned.weights),
            refreshOfId: dto.refreshOf ?? null,
          },
          select: { id: true },
        });
        return { runId: run.id, candidates: planned.candidates };
      } catch (error) {
        if (isUniqueViolation(error)) throw candidatesRunning();
        throw error;
      }
    });

    this.launch({ runId, schoolId, academicYearId, candidates, settings }, user);
    this.logger.log(`Candidate run started [runId=${runId}, candidates=${candidates.length}, refresh=${dto.refreshOf ? 'yes' : 'no'}]`);
    return { runId };
  }

  private async sweepBeforeStart(): Promise<void> {
    try {
      await this.sweep();
    } catch (error) {
      // Its own transaction, so a failure here costs only what it would have
      // freed; the partial index still refuses a second active run.
      this.logger.warn(`Candidate sweep before a start failed [${errorName(error)}]`);
    }
  }

  /** A new run: the first `count` variants, each over the run's own weights. */
  private freshPlan(count: number | undefined, base: ObjectiveWeights | null): PlannedCandidate[] {
    return variantsFor(count ?? DEFAULT_CANDIDATE_COUNT).map((variant) => ({
      ordinal: variant.ordinal,
      variant: variant.code,
      weights: weightsFor(base, variant),
      seed: variant.seed,
      previous: null,
    }));
  }

  /**
   * "Uppdatera förslagen": the old batch's applicable candidates again, under
   * their own ordinals, variants and seeds, each hinted by its own old lessons
   * and with keeping them weighted at least REFRESH_DISRUPTION_FLOOR — so a
   * candidate the school liked comes back close to what it was, but solved
   * against the draft as it is now. Nothing the engine does not already do.
   */
  private async refreshPlan(
    tx: PrismaClient,
    refreshOf: string,
    academicYearId: string,
  ): Promise<{ weights: ObjectiveWeights | null; candidates: PlannedCandidate[] }> {
    const old = await tx.scheduleCandidateRun.findUnique({
      where: { id: refreshOf },
      select: {
        academicYearId: true,
        status: true,
        weights: true,
        candidates: {
          orderBy: { ordinal: 'asc' },
          select: { ordinal: true, variant: true, weights: true, seed: true, solverStatus: true, lessons: true },
        },
      },
    });
    const candidates = (old?.candidates ?? []).flatMap((candidate): PlannedCandidate[] => {
      const lessons = storedLessonsOf(candidate.lessons);
      if (!APPLICABLE.has(candidate.solverStatus) || lessons === null) return [];
      return [
        {
          ordinal: candidate.ordinal,
          variant: candidate.variant,
          weights: refreshWeights(plainWeights(candidate.weights)),
          seed: candidate.seed ?? null,
          previous: lessons,
        },
      ];
    });
    if (!old || old.academicYearId !== academicYearId || old.status !== 'SUCCEEDED' || candidates.length === 0) {
      throw new NotFoundException({
        message: 'Förslagen som skulle uppdateras finns inte längre.',
        code: REFRESH_GONE,
      });
    }
    return { weights: plainWeights(old.weights), candidates };
  }

  private async generateRunning(tx: PrismaClient, academicYearId: string): Promise<boolean> {
    const jobs = await tx.optimizationJob.count({
      where: {
        academicYearId,
        status: { in: ['PENDING', 'RUNNING'] },
        createdAt: { gte: new Date(Date.now() - GENERATE_JOB_WINDOW_MS) },
      },
    });
    return jobs > 0;
  }

  /**
   * Fire and forget, as OptimizationJobsService.start does: run() records its
   * own outcome and is written never to throw, and the catch stays because an
   * unhandled rejection of this unawaited promise would end the process for
   * every school on the instance.
   */
  private launch(plan: RunPlan, user: AuthenticatedUser): void {
    this.inFlight.set(plan.runId, user);
    void this.run(plan, user)
      .catch((error: unknown) => {
        this.logger.error(
          `Candidate run ${plan.runId} crashed outside its own error handling.`,
          error instanceof Error ? error.stack : String(error),
        );
      })
      .finally(() => {
        this.inFlight.delete(plan.runId);
      });
  }

  // ---------------------------------------------------------------------------
  // The task
  // ---------------------------------------------------------------------------

  /**
   * The run, one candidate after another (never two engine calls at once for
   * one run).
   *
   *  1. CAS, then the one fetch (prepareSchedule with the coverage rows); a
   *     refusal — posts without a teacher under a REFUSE policy, a block
   *     partly locked — fails the run with the refusal's code.
   *  2. The basis and its parts, under a CAS of their own.
   *  3. Per candidate: CAS; the engine call with its own timeout; any failure
   *     of the call fails the run at once — the next candidate would meet the
   *     same engine. Candidate 1 INFEASIBLE or TIMEOUT is stored, with its
   *     conflicts, and ends the run CANDIDATES_FIRST_FAILED: every variant
   *     has the same hard constraints, so the others would find nothing
   *     either. An answer the demand guard refuses is stored REJECTED. An
   *     applicable candidate is stored with its metrics and the free-day
   *     wishes its timetable breaks (free-day-wishes.ts), both read off the
   *     run's one fetch.
   *  4. Finished under the row lock: SUCCEEDED with at least one applicable
   *     candidate (and the year's other finished runs removed: one batch is
   *     kept, and only a success replaces it) and the draft's broken wishes
   *     beside its unplaced figure, else CANDIDATES_NONE_APPLICABLE.
   */
  private async run(plan: RunPlan, user: AuthenticatedUser): Promise<void> {
    const { runId, academicYearId } = plan;
    try {
      if (!(await this.heartbeat(runId, user))) return await this.stopped(runId, user);

      const prepared = await this.prisma.withRls(
        user,
        (tx) => this.proxy.prepareSchedule(tx, academicYearId, user, { coverage: true }),
        { timeoutMs: PREPARE_TIMEOUT_MS },
      );
      if (!prepared.ready) {
        await this.fail(runId, user, {
          code: codeOrNull(prepared.refusalCode),
          message: truncate(prepared.refusal.conflicts?.summary ?? 'The draft cannot be generated as it stands.'),
          params: scalarParams(prepared.refusal.conflicts?.summaryParams),
        });
        return;
      }
      if (!(await this.heartbeat(runId, user, { basis: prepared.basis, parts: prepared.basisParts }))) {
        return await this.stopped(runId, user);
      }
      // The comparison's first column: the draft the run is solved from, its
      // kept lessons and its own, a parked lesson occupying no day — the
      // timetable Generera's notes would describe had it written this draft.
      const draftNotes = unkeptFreeDayWishes(prepared.freeDayWishes, [
        ...prepared.keptTimetable,
        ...prepared.draftLessons.filter((lesson) => !lesson.isParked),
      ]);

      const applicable: Array<{ ordinal: number; lessons: CandidateLesson[]; metrics: CandidateMetrics }> = [];
      for (const [index, candidate] of plan.candidates.entries()) {
        const call = callOf(candidate, index);
        // The call's own deadline goes on the run with the heartbeat: until
        // then the engine may be solving for it, whatever becomes of the run.
        const timeoutMs = callTimeoutMs(call, plan.settings);
        if (!(await this.heartbeat(runId, user, undefined, Math.ceil(timeoutMs / 1000)))) {
          return await this.stopped(runId, user);
        }

        let solution: CandidateSolution;
        try {
          solution = await this.proxy.solveCandidate(prepared, {
            weights: candidate.weights,
            search: searchFor(call, plan.settings),
            ...(candidate.previous ? { previousLessons: previousLessonsFrom(prepared, candidate.previous) } : {}),
            timeoutMs,
          });
        } catch (error) {
          const failure = engineFailureOf(error);
          this.logger.warn(`Candidate engine call failed [runId=${runId}, ordinal=${candidate.ordinal}, code=${failure.code ?? 'none'}]`);
          // A call that reached the engine and timed out — the gateway's
          // timeout, or the engine's own 503, whose wait does not stop its
          // solve thread — leaves the solve running: the run keeps the call's
          // deadline. An engine never reached, or one that answered, clears it.
          await this.fail(runId, user, failure, { keepEngineBusy: engineMayStillBeSolving(error) });
          return;
        }

        const status = solution.rejected ? 'REJECTED' : solution.status;
        const metrics = APPLICABLE.has(status)
          ? candidateMetricsOf({
              requirementRows: prepared.requirementRows,
              draftLessons: prepared.draftLessons,
              coverage: prepared.coverage,
              lessons: solution.lessons,
              earlier: applicable,
            })
          : null;
        // What applying it would leave, read as Generera reads what it wrote.
        const notes = APPLICABLE.has(status)
          ? unkeptFreeDayWishes(
              prepared.freeDayWishes,
              timetableWith(prepared.keptTimetable, prepared.requirementRows, solution.lessons),
            )
          : null;
        const firstFailed = index === 0 && (status === 'INFEASIBLE' || status === 'TIMEOUT');
        const outcome = await this.store(plan, user, candidate, solution, status, { metrics, notes }, firstFailed);
        if (outcome !== 'stored') return;
        if (metrics) applicable.push({ ordinal: candidate.ordinal, lessons: solution.lessons, metrics });
      }

      await this.finish(
        plan,
        user,
        { unplaced: runUnplacedOf(prepared.coverage, applicable[0]?.metrics.unplaced ?? null), draftNotes },
        applicable.length > 0,
      );
    } catch (error) {
      this.logger.warn(`Candidate run failed [runId=${runId}, ${errorName(error)}]`);
      await this.fail(runId, user, failureOf(error)).catch(() => undefined);
    }
  }

  /**
   * The compare-and-set every step of the task begins with: RUNNING, the
   * heartbeat now (the database's clock, the one the sweep reads), startedAt
   * once, the basis when it is known, and before an engine call the latest
   * that call can still be solving (engineBusyUntil) — WHERE the run is still
   * PENDING or RUNNING. False when nothing was updated: the run is no longer
   * the task's, and the task writes nothing more.
   */
  private async heartbeat(
    runId: string,
    user: AuthenticatedUser,
    basis?: { basis: string; parts: BasisParts },
    engineSeconds?: number,
  ): Promise<boolean> {
    const updated = await this.prisma.withRls(user, (tx) =>
      basis
        ? tx.$executeRaw(
            Prisma.sql`UPDATE "ScheduleCandidateRuns"
                          SET "status" = 'RUNNING', "heartbeatAt" = now(), "startedAt" = coalesce("startedAt", now()),
                              "basis" = ${basis.basis}, "basisParts" = ${JSON.stringify(basis.parts)}::jsonb
                        WHERE "id" = ${runId}::uuid AND "status" IN ('PENDING', 'RUNNING')`,
          )
        : engineSeconds !== undefined
          ? tx.$executeRaw(
              Prisma.sql`UPDATE "ScheduleCandidateRuns"
                            SET "status" = 'RUNNING', "heartbeatAt" = now(), "startedAt" = coalesce("startedAt", now()),
                                "engineBusyUntil" = now() + make_interval(secs => ${engineSeconds})
                          WHERE "id" = ${runId}::uuid AND "status" IN ('PENDING', 'RUNNING')`,
            )
          : tx.$executeRaw(
              Prisma.sql`UPDATE "ScheduleCandidateRuns"
                            SET "status" = 'RUNNING', "heartbeatAt" = now(), "startedAt" = coalesce("startedAt", now())
                          WHERE "id" = ${runId}::uuid AND "status" IN ('PENDING', 'RUNNING')`,
            ),
    );
    return Number(updated) > 0;
  }

  /**
   * The run is no longer the task's. The one write left is a DELETE's: a run
   * it set CANCELLING is the task's to end, now that the task has stopped,
   * and it ends FAILED CANDIDATE_RUN_CANCELLED, which frees the year. A run
   * the sweep or an interruption already failed is left exactly as it is.
   */
  private async stopped(runId: string, user: AuthenticatedUser): Promise<void> {
    this.logger.log(`Candidate run stopped: it is no longer running [runId=${runId}]`);
    await this.prisma.withRls(user, (tx) => markCancelled(tx, runId));
  }

  /** The run's lock, and its status under it. */
  private async lockedStatus(tx: PrismaClient, runId: string): Promise<string | null> {
    const rows = await tx.$queryRaw<{ status: string }[]>(
      Prisma.sql`SELECT "status"::text AS "status" FROM "ScheduleCandidateRuns" WHERE "id" = ${runId}::uuid FOR UPDATE`,
    );
    return rows?.[0]?.status ?? null;
  }

  /**
   * One candidate, in one transaction under the run row's lock: inserted
   * only while the run is RUNNING, with the progress and the heartbeat. The
   * first candidate's INFEASIBLE or TIMEOUT also ends the run, in the same
   * transaction, so the page never shows a stored refusal under a run that
   * still claims to be working. What was `measured` is null for a candidate
   * with no timetable: no lesson to count a move in, and no wish to break.
   */
  private async store(
    plan: RunPlan,
    user: AuthenticatedUser,
    candidate: PlannedCandidate,
    solution: CandidateSolution,
    status: string,
    measured: { metrics: CandidateMetrics | null; notes: AiEngineConflictDetail[] | null },
    firstFailed: boolean,
  ): Promise<'stored' | 'finished' | 'stopped'> {
    const applicable = APPLICABLE.has(status);
    const summary = sentenceCodeOf(solution.conflicts?.summaryCode, solution.conflicts?.summaryParams);
    return this.prisma.withRls(user, async (tx) => {
      const current = await this.lockedStatus(tx, plan.runId);
      if (current !== 'RUNNING') {
        await markCancelled(tx, plan.runId);
        return 'stopped';
      }
      await tx.scheduleCandidate.create({
        data: {
          runId: plan.runId,
          schoolId: plan.schoolId,
          ordinal: candidate.ordinal,
          variant: candidate.variant,
          weights: jsonOrDbNull(candidate.weights),
          seed: candidate.seed,
          solverStatus: status,
          lessons: (applicable ? lessonsForStorage(solution.lessons) : []) as unknown as Prisma.InputJsonValue,
          lunches: jsonOrDbNull(applicable && solution.lunches !== null ? lunchesForStorage(solution.lunches) : null),
          metrics: jsonOrDbNull(measured.metrics),
          conflicts: storedConflictsOf(solution.conflicts) as unknown as Prisma.InputJsonValue,
          // As the job row keeps its notes: the teacher's Users id beside each,
          // for the read that names them, and never a name.
          notes: jsonOrDbNull(measured.notes?.map(storedOf) ?? null),
          errorCode: applicable || status === 'REJECTED' ? null : summary.code,
          // The summary's values, without which its sentence cannot be said
          // (a first candidate that ran out of time has a summary and no list).
          errorParams: jsonOrDbNull(applicable || status === 'REJECTED' ? null : summary.params),
        },
        select: { id: true },
      });
      await tx.$executeRaw(
        Prisma.sql`UPDATE "ScheduleCandidateRuns" SET "progress" = "progress" + 1, "heartbeatAt" = now(), "engineBusyUntil" = NULL WHERE "id" = ${plan.runId}::uuid`,
      );
      if (!firstFailed) return 'stored';
      await tx.scheduleCandidateRun.update({
        where: { id: plan.runId },
        data: {
          status: 'FAILED',
          error: 'The first candidate found no timetable, and the others share its hard constraints.',
          errorCode: CANDIDATES_FIRST_FAILED,
          errorParams: Prisma.DbNull,
          finishedAt: new Date(),
        },
      });
      this.logger.log(`Candidate run stopped at its first candidate [runId=${plan.runId}, status=${status}]`);
      return 'finished';
    });
  }

  /**
   * The end of a run whose every candidate was asked, under the row lock and
   * only while it is RUNNING. A success removes the year's other finished
   * runs (removeFinished) — one batch is kept, and a failed run never
   * replaces it. The draft's figures are kept on a success only, beside the
   * candidates they are read against.
   */
  private async finish(
    plan: RunPlan,
    user: AuthenticatedUser,
    draft: { unplaced: RunUnplaced | null; draftNotes: AiEngineConflictDetail[] },
    succeeded: boolean,
  ): Promise<void> {
    await this.prisma.withRls(user, async (tx) => {
      const current = await this.lockedStatus(tx, plan.runId);
      if (current !== 'RUNNING') {
        await markCancelled(tx, plan.runId);
        return;
      }
      if (!succeeded) {
        await tx.scheduleCandidateRun.update({
          where: { id: plan.runId },
          data: {
            status: 'FAILED',
            error: 'No candidate found a timetable that can be applied.',
            errorCode: CANDIDATES_NONE_APPLICABLE,
            errorParams: Prisma.DbNull,
            engineBusyUntil: null,
            finishedAt: new Date(),
          },
        });
        return;
      }
      await tx.scheduleCandidateRun.update({
        where: { id: plan.runId },
        data: {
          status: 'SUCCEEDED',
          unplaced: jsonOrDbNull(draft.unplaced),
          draftNotes: draft.draftNotes.map(storedOf) as unknown as Prisma.InputJsonValue,
          engineBusyUntil: null,
          finishedAt: new Date(),
        },
      });
      const count = await removeFinished(tx, { academicYearId: plan.academicYearId, id: { not: plan.runId } });
      this.logger.log(`Candidate run succeeded [runId=${plan.runId}, superseded=${count}]`);
    });
  }

  /**
   * Fails the run, only while it is still the task's (PENDING or RUNNING); a
   * run a DELETE or an apply set CANCELLING ends CANCELLED instead, and one
   * already finished is left alone. keepEngineBusy holds in both: a call
   * that timed out may still be solving, whoever cancelled the run.
   */
  private async fail(
    runId: string,
    user: AuthenticatedUser,
    failure: RunFailure,
    options: { keepEngineBusy?: boolean } = {},
  ): Promise<void> {
    await this.prisma.withRls(user, async (tx) => {
      const { count } = await tx.scheduleCandidateRun.updateMany({
        where: { id: runId, status: { in: ['PENDING', 'RUNNING'] } },
        data: {
          status: 'FAILED',
          error: truncate(failure.message),
          errorCode: codeOrNull(failure.code),
          errorParams: jsonOrDbNull(failure.params),
          // Cleared when the engine answered (nothing of the run is solving);
          // kept after a timeout, when its solve thread may run on.
          ...(options.keepEngineBusy ? {} : { engineBusyUntil: null }),
          finishedAt: new Date(),
        },
      });
      if (count === 0) await markCancelled(tx, runId, options);
    });
  }

  // ---------------------------------------------------------------------------
  // GET candidates, GET candidates/:id/lessons, GET candidates/runs/:runId/check
  // ---------------------------------------------------------------------------

  /**
   * The year's newest run and newest batch, with no basis rebuilt: a page
   * polls this every two seconds while a run is going. A run whose heartbeat
   * is past its lease is shown as what the sweep will make it, FAILED
   * CANDIDATE_RUN_ABANDONED, so a page never polls a dead run for ever.
   *
   * The teachers whose free-day wish a candidate or the draft breaks are
   * named here, for every reader, as Generera's run names them
   * (OptimizationJobsService): one more read, of Users by id, only when a
   * stored note is about somebody, and no Läslogg row — a name beside the
   * work rule's wish, which every member of staff reads, not the post's
   * days (access-log.ts, NOT RECORDED).
   */
  async overview(academicYearId: string, user: AuthenticatedUser, now: Date = new Date()): Promise<CandidatesOverview> {
    const { latest, batch, names } = await this.prisma.withRls(user, async (tx) => {
      const order = [{ createdAt: 'desc' as const }, { id: 'desc' as const }];
      // A run a discard removed is not shown, whatever is left of its row.
      const newest = await tx.scheduleCandidateRun.findFirst({
        where: { academicYearId, discardedAt: null },
        orderBy: order,
        select: RUN_SELECT,
      });
      const succeeded =
        newest?.status === 'SUCCEEDED'
          ? newest
          : await tx.scheduleCandidateRun.findFirst({
              where: { academicYearId, status: 'SUCCEEDED', discardedAt: null },
              orderBy: order,
              select: RUN_SELECT,
            });
      const noted = new Set<string>();
      for (const run of [newest, succeeded]) {
        if (!run) continue;
        for (const id of notedTeachersOf(run.draftNotes)) noted.add(id);
        for (const candidate of run.candidates) for (const id of notedTeachersOf(candidate.notes)) noted.add(id);
      }
      const people =
        noted.size === 0
          ? []
          : await tx.user.findMany({ where: { id: { in: [...noted] } }, select: { id: true, firstName: true, lastName: true } });
      return { latest: newest, batch: succeeded, names: namesOf(people) };
    });
    return {
      latest: latest ? batchViewOf(latest, now, names) : null,
      batch: batch ? batchViewOf(batch, now, names) : null,
      unplaced: batch ? unplacedViewOf(batch.unplaced) : null,
      draftNotes: batch ? measuredNotesOf(batch.draftNotes, names) : null,
    };
  }

  /**
   * One candidate's lessons, each resolved from its timplanspost as it reads
   * now — subject, class, teachers, weeks — the MasterLesson shape the
   * compare page feeds to its week sheet and gaps.ts. A lesson whose post was
   * deleted since is left out; the batch is stale then anyway. Teachers by
   * id, as MasterLessons have them; never a pupil.
   */
  async lessons(candidateId: string, user: AuthenticatedUser): Promise<CandidateLessonView[]> {
    return this.prisma.withRls(user, async (tx) => {
      const candidate = await tx.scheduleCandidate.findUnique({ where: { id: candidateId }, select: { lessons: true } });
      if (!candidate) throw candidateGone();
      const lessons = storedLessonsOf(candidate.lessons) ?? [];
      const ids = [...new Set(lessons.map((lesson) => lesson.requirementId))];
      const rows =
        ids.length === 0
          ? []
          : await tx.teachingRequirement.findMany({
              where: { id: { in: ids } },
              select: {
                id: true,
                subjectId: true,
                studentGroupId: true,
                teacherId: true,
                coTeacherId: true,
                recurrence: true,
                startDate: true,
                endDate: true,
              },
            });
      const byId = new Map(rows.map((row) => [row.id, row]));
      return lessons.flatMap((lesson): CandidateLessonView[] => {
        const row = byId.get(lesson.requirementId);
        if (!row) return [];
        return [
          {
            requirementId: lesson.requirementId,
            subjectId: row.subjectId,
            studentGroupId: row.studentGroupId,
            teacherId: row.teacherId ?? null,
            coTeacherId: row.coTeacherId ?? null,
            roomId: lesson.roomId,
            dayOfWeek: lesson.dayOfWeek,
            startTime: lesson.startTime,
            endTime: lesson.endTime,
            recurrence: row.recurrence,
            startDate: dayString(row.startDate),
            endDate: dayString(row.endDate),
          },
        ];
      });
    });
  }

  /**
   * The batch against today's draft, before an apply: one rebuild of the
   * fetch, and the parts that differ. It writes nothing of the timetable; the
   * one row the fetch may write is the Läslogg's, for the posts' day limits
   * it reads to send (Lärarens dag, in the proxy's fetchAndAnonymize), so the
   * transaction is not READ ONLY. The mode is the school's now, which the
   * apply must name back; in DIRECT the dated lessons the write would take
   * off the calendar are counted by the write's own where-clause, and the
   * vikarier booked on them.
   */
  async check(runId: string, user: AuthenticatedUser): Promise<CandidateCheck> {
    const schoolId = requireSchoolId(user);
    return this.prisma.withRls(
      user,
      async (tx) => {
        const run = await tx.scheduleCandidateRun.findUnique({
          where: { id: runId },
          select: { academicYearId: true, basis: true, basisParts: true, discardedAt: true },
        });
        if (!run || run.discardedAt) throw candidateGone();
        const mode = await publishModeOf(tx, schoolId);
        const prepared = await this.proxy.prepareSchedule(tx, run.academicYearId, user);
        if (!prepared.ready) {
          return { stale: true, changed: [], refusalCode: prepared.refusalCode, mode, futureCalendarLessons: 0, coverAssignments: 0 };
        }
        const stale = run.basis !== prepared.basis;
        const changed = stale ? changedParts(run.basisParts, prepared.basisParts) : [];
        if (mode === 'DRAFT') {
          return { stale, changed, refusalCode: null, mode, futureCalendarLessons: 0, coverAssignments: 0 };
        }
        const swept = calendarSweepWhere({ kind: 'IDS', ids: prepared.draftIds }, run.academicYearId);
        const futureCalendarLessons = await tx.calendarLesson.count({ where: swept });
        const coverAssignments =
          futureCalendarLessons === 0
            ? 0
            : await tx.calendarLessonTeacher.count({ where: { role: 'SUBSTITUTE', calendarLesson: { is: swept } } });
        return { stale, changed, refusalCode: null, mode, futureCalendarLessons, coverAssignments };
      },
      { timeoutMs: PREPARE_TIMEOUT_MS },
    );
  }

  // ---------------------------------------------------------------------------
  // POST candidates/:id/apply
  // ---------------------------------------------------------------------------

  /**
   * THE APPLY (design §4), one transaction of at most a minute:
   *
   *   1. the candidate and its run's year, without a lock (404 CANDIDATE_GONE);
   *   2. the publication lock and the mode (publish-mode.ts), which must be
   *      the one the dialog was confirmed in (409 PUBLISH_MODE_CHANGED);
   *   3. the year's three rewrite locks in their one order, each waited for
   *      5 s (409 SCHEDULE_CANDIDATE_BUSY);
   *   4. the run again, FOR UPDATE: SUCCEEDED and the candidate OPTIMAL or
   *      FEASIBLE (409 SCHEDULE_CANDIDATE_NOT_APPLICABLE), no Generera job of
   *      the year running (409 GENERATE_RUNNING), and a newer active run of
   *      the year asked to stop — it was solving from the draft this replaces;
   *   5. every master of the year FOR UPDATE, so no hand edit can make a
   *      lesson preserved, or stop it being, under the apply;
   *   6. the fetch rebuilt and its basis compared with the run's (409
   *      SCHEDULE_CANDIDATE_STALE naming the parts, or the refusal the draft
   *      now meets);
   *   7–10. the proxy's write: the safety version "Före schemaförslag N – …",
   *      the shared regeneration write scoped to exactly the ids just read,
   *      the asserts, the REGENERATE entry;
   *  11. the run marked applied. The batch is kept: its candidates are stale
   *      now, and "Uppdatera förslagen" solves them again on the new draft;
   *  12. after the commit, the timetable's realtime notice, as Generera's
   *      and the room apply's.
   *
   * A deadlock, a key the write met, or a lock wait past 5 s anywhere after
   * step 2 is 409 SCHEDULE_CANDIDATE_BUSY: nothing was written.
   */
  async apply(candidateId: string, expectedMode: PublishMode, user: AuthenticatedUser): Promise<CandidateApplyOutcome> {
    const schoolId = requireSchoolId(user);
    let outcome: { lessonsCreated: number; versionId: string; mode: PublishMode; runId: string };
    try {
      outcome = await this.prisma.withRls(
        user,
        async (tx) => {
          const candidate = await tx.scheduleCandidate.findUnique({
            where: { id: candidateId },
            select: {
              id: true,
              runId: true,
              ordinal: true,
              variant: true,
              solverStatus: true,
              lessons: true,
              lunches: true,
              metrics: true,
              run: { select: { academicYearId: true } },
            },
          });
          if (!candidate) throw candidateGone();
          const academicYearId = candidate.run.academicYearId;

          const mode = await enterGrundschemaWrite(tx, schoolId);
          if (mode !== expectedMode) {
            throw new ConflictException({
              message: 'Skolans publiceringsläge har ändrats sedan förslaget öppnades.',
              code: PUBLISH_MODE_CHANGED,
              params: { mode },
            });
          }
          await lockYearForCandidateApply(tx, academicYearId);

          await this.lockedStatus(tx, candidate.runId);
          const run = await tx.scheduleCandidateRun.findUnique({
            where: { id: candidate.runId },
            select: { id: true, status: true, basis: true, basisParts: true, createdAt: true },
          });
          const lessons = storedLessonsOf(candidate.lessons);
          if (!run || run.status !== 'SUCCEEDED' || !APPLICABLE.has(candidate.solverStatus) || lessons === null) {
            throw new ConflictException({
              message: 'Förslaget går inte att tillämpa: körningen är inte klar, eller förslaget fick inget schema.',
              code: SCHEDULE_CANDIDATE_NOT_APPLICABLE,
            });
          }
          if (await this.generateRunning(tx, academicYearId)) throw generateRunning();
          await tx.scheduleCandidateRun.updateMany({
            where: { academicYearId, status: { in: ['PENDING', 'RUNNING'] }, createdAt: { gt: run.createdAt } },
            data: { status: 'CANCELLING' },
          });

          await lockYearMasters(tx, academicYearId);
          const prepared = await this.proxy.prepareSchedule(tx, academicYearId, user);
          if (!prepared.ready) throw scheduleCandidateStale([], prepared.refusalCode);
          if (prepared.basis !== run.basis) {
            throw scheduleCandidateStale(changedParts(run.basisParts, prepared.basisParts));
          }

          const written = await this.proxy.applyCandidateWrite(tx, {
            user,
            prepared,
            mode,
            lessons,
            lunches: storedLunchesOf(candidate.lunches),
            solverStatus: candidate.solverStatus,
            snapshot: { versions: this.versions, name: snapshotNameOf(candidate.ordinal, candidate.variant) },
            after: {
              source: 'CANDIDATE',
              runId: run.id,
              ordinal: candidate.ordinal,
              variant: candidate.variant,
              metrics: (metricsBlobOf(candidate.metrics) ?? null) as Prisma.InputJsonValue | null,
            },
          });

          await tx.scheduleCandidateRun.update({
            where: { id: run.id },
            data: { appliedCandidateId: candidate.id, appliedAt: new Date() },
          });
          return { lessonsCreated: written.lessonsCreated, versionId: written.versionId, mode, runId: run.id };
        },
        { timeoutMs: APPLY_TIMEOUT_MS },
      );
    } catch (error) {
      if (error instanceof HttpException) throw withStaleParams(error);
      if (isLockTimeout(error) || isWriteConflict(error)) throw scheduleBusy(SCHEDULE_CANDIDATE_BUSY);
      throw error;
    }

    this.logger.log(
      `Candidate applied [runId=${outcome.runId}, candidateId=${candidateId}, lessons=${outcome.lessonsCreated}, version=${outcome.versionId}]`,
    );
    if (outcome.mode === 'DRAFT') this.realtime.notifyMasterTimetableChanged(schoolId, { draft: true });
    else this.realtime.notifyMasterTimetableChanged(schoolId);
    return { lessonsCreated: outcome.lessonsCreated, versionId: outcome.versionId };
  }

  // ---------------------------------------------------------------------------
  // DELETE candidates
  // ---------------------------------------------------------------------------

  /**
   * "Ta bort förslagen": the year's finished runs are removed with their
   * candidates (removeFinished: one whose engine call can still be solving
   * keeps an empty, hidden row until the sweep deletes it); an active run is
   * asked to stop (CANCELLING) and never deleted under its task, which stops
   * at its next step and ends it CANDIDATE_RUN_CANCELLED — or, if the task
   * is gone, the sweep does.
   */
  async discard(academicYearId: string, user: AuthenticatedUser): Promise<void> {
    requireSchoolId(user);
    await this.prisma.withRls(user, async (tx) => {
      await tx.scheduleCandidateRun.updateMany({
        where: { academicYearId, status: { in: ['PENDING', 'RUNNING'] } },
        data: { status: 'CANCELLING' },
      });
      await removeFinished(tx, { academicYearId });
    });
  }
}

/** The CallShape of a run's candidate at `index`: the first call is the lead, the one that probes. */
function callOf(candidate: PlannedCandidate, index: number): CallShape {
  return { variant: candidate.variant, seed: candidate.seed, lead: index === 0 };
}

/**
 * A run a DELETE or an apply set CANCELLING, ended now that its task has
 * stopped. Touches no other status. The engine deadline is cleared — the
 * task's last call returned, or it made none — unless that call timed out
 * (fail's keepEngineBusy): then the solve may run on, and the run keeps its
 * place under CANDIDATE_RUNS_MAX until it could have ended.
 */
async function markCancelled(tx: PrismaClient, runId: string, options: { keepEngineBusy?: boolean } = {}): Promise<void> {
  await tx.scheduleCandidateRun.updateMany({
    where: { id: runId, status: 'CANCELLING' },
    data: {
      status: 'FAILED',
      error: 'The run was cancelled before it finished.',
      errorCode: CANDIDATE_RUN_CANCELLED,
      errorParams: Prisma.DbNull,
      ...(options.keepEngineBusy ? {} : { engineBusyUntil: null }),
      finishedAt: new Date(),
    },
  });
}

/** Rows no engine call of theirs can still be solving for: no deadline, or one passed. */
function noCallOut(now: Date): Prisma.ScheduleCandidateRunWhereInput {
  return { OR: [{ engineBusyUntil: null }, { engineBusyUntil: { lte: now } }] };
}

/**
 * Removes the finished runs `where` names: deleted with their candidates,
 * except a run whose engine call can still be solving, whose row is its
 * place under CANDIDATE_RUNS_MAX (app.schedule_candidate_runs_active). That
 * one loses its candidates and is marked discardedAt: no overview shows it,
 * no check or apply finds it, and the sweep deletes it once its call could
 * have ended. One clock for both halves, so a row is in exactly one.
 */
async function removeFinished(tx: PrismaClient, where: Prisma.ScheduleCandidateRunWhereInput): Promise<number> {
  const now = new Date();
  const finished = { ...where, status: { in: FINISHED } };
  const { count } = await tx.scheduleCandidateRun.deleteMany({ where: { ...finished, ...noCallOut(now) } });
  const kept = await tx.scheduleCandidateRun.findMany({
    where: { ...finished, engineBusyUntil: { gt: now } },
    select: { id: true },
  });
  if (kept.length > 0) {
    const ids = kept.map((run) => run.id);
    await tx.scheduleCandidate.deleteMany({ where: { runId: { in: ids } } });
    await tx.scheduleCandidateRun.updateMany({ where: { id: { in: ids }, discardedAt: null }, data: { discardedAt: now } });
  }
  return count;
}

/** A nullable Json column's value: the blob, or SQL NULL (never the JSON literal null). */
function jsonOrDbNull(value: unknown): Prisma.InputJsonValue | typeof Prisma.DbNull {
  return value === null || value === undefined ? Prisma.DbNull : (value as Prisma.InputJsonValue);
}

/** The stored metrics blob as an object, for the change log; null when there is none. */
function metricsBlobOf(value: unknown): Prisma.InputJsonObject | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Prisma.InputJsonObject;
}

/**
 * A stale refusal with what it names as params too. The problem filter
 * (http-exception.filter.ts) forwards a refusal's code and its flat params
 * and nothing else of its body, so `changed` travels as "requirements,rosters"
 * and the refusal the draft now meets beside it — what the web's staleParts
 * reads. Every other refusal passes as it is.
 */
export function withStaleParams(error: HttpException): HttpException {
  const body = error.getResponse();
  if (typeof body !== 'object' || body === null) return error;
  const shape = body as { code?: unknown; changed?: unknown; refusalCode?: unknown; params?: unknown };
  if (shape.code !== SCHEDULE_CANDIDATE_STALE || shape.params !== undefined) return error;
  const changed = Array.isArray(shape.changed) ? shape.changed.filter((part): part is string => typeof part === 'string') : [];
  const params: Record<string, string> = {
    ...(changed.length > 0 ? { changed: changed.join(',') } : {}),
    ...(typeof shape.refusalCode === 'string' ? { refusalCode: shape.refusalCode } : {}),
  };
  return new ConflictException({ ...shape, params });
}

/** P2002, or 23505 under the adapter: here, the partial unique index on the year's active run. */
function isUniqueViolation(error: unknown): boolean {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError)) return false;
  if (error.code === 'P2002') return true;
  const cause = (error.meta as { driverAdapterError?: { cause?: { originalCode?: unknown } } } | undefined)
    ?.driverAdapterError?.cause;
  return cause?.originalCode === '23505';
}

function generateRunning(): ConflictException {
  return new ConflictException({
    message: 'Generera kör för läsåret just nu. Försök igen när körningen är klar.',
    code: GENERATE_RUNNING,
  });
}

function candidatesBusy(): ConflictException {
  return new ConflictException({
    message: 'Många skolor tar fram förslag just nu. Försök igen om några minuter.',
    code: CANDIDATES_BUSY,
  });
}

function candidateGone(): NotFoundException {
  return new NotFoundException({
    message: 'Förslaget finns inte längre.',
    code: CANDIDATE_GONE,
  });
}

/**
 * A run as the page reads it. An active run past its lease (or its half hour)
 * is shown FAILED CANDIDATE_RUN_ABANDONED, finished when its lease ran out —
 * what the sweep will write — so a dead task never keeps a page polling.
 */
export function runViewOf(row: Omit<RunRow, 'candidates' | 'unplaced' | 'draftNotes'>, now: Date): CandidateRunView {
  const leaseEnds = row.heartbeatAt.getTime() + row.leaseSeconds * 1000;
  const abandoned =
    ACTIVE.includes(row.status) && (leaseEnds < now.getTime() || row.createdAt.getTime() < now.getTime() - RUN_MAX_AGE_MS);
  return {
    id: row.id,
    status: abandoned ? 'FAILED' : row.status,
    requested: row.requested,
    progress: row.progress,
    createdAt: row.createdAt.toISOString(),
    startedAt: iso(row.startedAt),
    finishedAt: abandoned ? new Date(Math.min(leaseEnds, now.getTime())).toISOString() : iso(row.finishedAt),
    error: abandoned ? 'The run stopped before it finished.' : row.error,
    errorCode: abandoned ? CANDIDATE_RUN_ABANDONED : (row.errorCode ?? null),
    errorParams: abandoned ? null : scalarParams(row.errorParams),
    createdById: row.createdById ?? null,
    createdByName: null,
    appliedCandidateId: row.appliedCandidateId ?? null,
    appliedAt: iso(row.appliedAt),
    refreshOfId: row.refreshOfId ?? null,
  };
}

/**
 * Stored notes as their reader is shown them (stored-conflicts.ts), or null
 * when nothing was measured: the column is null on a candidate with no
 * timetable and on every row stored before it existed, and a hand-edited
 * value that is not a list says nothing either.
 */
function measuredNotesOf(stored: unknown, names: ReadonlyMap<string, string>): ConflictView[] | null {
  return Array.isArray(stored) ? notesViewOf(stored, names) : null;
}

function batchViewOf(row: RunRow, now: Date, names: ReadonlyMap<string, string>): CandidateBatchView {
  return {
    run: runViewOf(row, now),
    candidates: row.candidates.map((candidate) => {
      const applicable = APPLICABLE.has(candidate.solverStatus);
      return {
        id: candidate.id,
        ordinal: candidate.ordinal,
        variant: candidate.variant,
        weights: plainWeights(candidate.weights),
        solverStatus: candidate.solverStatus,
        lessonCount: applicable ? lessonCountOf(candidate.metrics) : 0,
        errorCode: candidate.errorCode ?? null,
        errorParams: scalarParams(candidate.errorParams),
        metrics: applicable ? metricsViewOf(candidate.metrics) : null,
        conflicts: conflictsViewOf(candidate.conflicts),
        notes: applicable ? measuredNotesOf(candidate.notes, names) : null,
      };
    }),
  };
}
