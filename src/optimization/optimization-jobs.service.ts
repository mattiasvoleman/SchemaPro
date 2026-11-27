import { HttpException, Injectable, Logger, NotFoundException, OnModuleDestroy, OnModuleInit, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '@prisma/client';
import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';
import { DEFAULT_CANDIDATES_CONFIG, type CandidatesConfig } from '../config/configuration';
import { DATABASE_BUSY, DATABASE_BUSY_DETAIL, isPoolBusy } from '../database/pool-wait';
import { PrismaService } from '../database/prisma.service';
import { errorName, JobRunner } from '../jobs/job-runner';
import { recordRead } from '../access-log/access-log';
import { readsHr } from '../staffing/hr-visibility';
import { OptimizationProxyService } from './optimization-proxy.service';
import type {
  AiEngineConflictAnalysis,
  ObjectiveWeights,
  ScheduleRules,
} from './interfaces/ai-engine-payload.interface';
import { rostersOfYear } from '../year-rollover/projected-rosters';
import {
  TEACHER_CONSECUTIVE_TEACHING_HIDDEN,
  TEACHER_WORK_DAYS_HIDDEN,
  WorkDaysRefusal,
  forReader,
  isDaysBearing,
  isStretchBearing,
  type PostShown,
  type SentenceShown,
  type StoredSentence,
} from './work-days';
import { candidatesRunning, yearHasActiveCandidateRun } from './schedule-candidates.service';
import { suggestionsRunning, yearHasRunningSuggestions } from './suggestions-running';
import {
  asParams,
  conflictView,
  entriesOf,
  namesOf,
  notedTeachersOf,
  notesViewOf,
  storedOf,
  subjectsOf,
  travelNamesOf,
  travelTeachersOf,
  type ConflictView,
} from './stored-conflicts';
import { lockYearForSolveStart, SCHEDULE_BUSY } from './regeneration-lock';
import {
  ABANDONED_MESSAGE,
  abandonedAt,
  ENGINE_RUN_ABANDONED,
  generateAlreadyRunning,
  GENERATE_SWEEP_INTERVAL_MS,
  GENERATE_SWEEP_JOB,
  HEARTBEAT_INTERVAL_MS,
  INSTANCE_NAME,
  INTERRUPTED_MESSAGE,
  isUniqueViolation,
  leaseSecondsFor,
} from './generate-runs';
import { timeoutReportOf, type TimeoutReportView } from './timeout-report';
import { startedFromOf, type StartedFrom, type StartRequest } from './start-schedule';
import { assertStartable } from './start-sources';
import {
  readAs,
  suggestionsMayBeAskedFor,
  suggestionsOf,
  teachersOfSuggestions,
  viewOf,
  type SuggestionsView,
} from './suggestions';

/**
 * What a failed run has to say for itself.
 *
 * The engine refuses a payload it cannot schedule — a lunch window a locked
 * lesson leaves nothing of, a sitting too small for a stage — and the proxy
 * throws that on as an HttpException whose body carries the refusal's own
 * name and values beside its English. Read them here so the screen can say it
 * in Swedish. Anything else that went wrong is a fault of ours, and gets its
 * message and no code: there is nothing to translate about a lost connection
 * to the engine, and pretending otherwise would put a Swedish sentence on an
 * error a school cannot act on anyway.
 */
function refusalOf(error: unknown): {
  message: string;
  code: string | null;
  params: Record<string, string | number> | null;
  /** Whose post a days refusal is about (work-days.ts); empty for every other. */
  subjectIds: readonly string[];
} {
  const fallback = 'The optimization run failed.';
  if (error instanceof HttpException) {
    const body = error.getResponse();
    const subjectIds = error instanceof WorkDaysRefusal ? error.subjectIds : [];
    if (typeof body === 'object' && body !== null) {
      const shape = body as {
        message?: unknown;
        code?: unknown;
        params?: unknown;
      };
      return {
        message: typeof shape.message === 'string' ? shape.message : error.message,
        code: typeof shape.code === 'string' ? shape.code : null,
        params: asParams(shape.params),
        subjectIds,
      };
    }
    return { message: typeof body === 'string' ? body : error.message, code: null, params: null, subjectIds };
  }
  // The pool had no connection for one of the run's own transactions, twice for the write after the engine (the retry in
  // triggerScheduling): a busy server, which the exception filter answers as 503 DATABASE_BUSY. A run has no response to
  // answer in; it stores what the filter would have said, and not the driver's "Transaction API error: Unable to start a
  // transaction in the given time." with no code for the page to name it by.
  if (isPoolBusy(error)) return { message: DATABASE_BUSY_DETAIL, code: DATABASE_BUSY, params: null, subjectIds: [] };
  return {
    message: error instanceof Error ? error.message : fallback,
    code: null,
    params: null,
    subjectIds: [],
  };
}

/**
 * The column a run's end writes: the engine's report, rebuilt from the closed set it may hold, for a TIMEOUT and for no other
 * answer (a run with a timetable or a refusal carries none, even from an engine that sent one), and a database null otherwise.
 */
function reportToStore(solverStatus: string, report: unknown): Prisma.InputJsonValue | typeof Prisma.DbNull {
  const view = solverStatus === 'TIMEOUT' ? timeoutReportOf(report) : null;
  return view === null ? Prisma.DbNull : (view as unknown as Prisma.InputJsonValue);
}

/** A params blob to store, with its teachers kept beside the figures when it has any. */
function storedParams(
  params: Record<string, string | number> | null | undefined,
  subjectIds: readonly string[] | undefined,
): Prisma.InputJsonValue | typeof Prisma.DbNull {
  if (!params) return Prisma.DbNull;
  return (
    subjectIds && subjectIds.length > 0 ? { ...params, subjectIds: [...subjectIds] } : params
  ) as Prisma.InputJsonValue;
}

export type { ConflictView, StoredConflict } from './stored-conflicts';

export type JobStatus = 'PENDING' | 'RUNNING' | 'SUCCEEDED' | 'FAILED';
export type SolverStatus = 'OPTIMAL' | 'FEASIBLE' | 'INFEASIBLE' | 'TIMEOUT';

export interface OptimizationJobView {
  id: string;
  status: JobStatus;
  solverStatus: SolverStatus | null;
  lessonsGenerated: number;
  conflictSummary: string | null;
  conflictSummaryCode: string | null;
  conflictSummaryParams: Record<string, string | number> | null;
  /**
   * The teachers a days-bearing summary is about, for a reader with HR-läs:
   * what a conflict carries in resourceNames, for a sentence that has none.
   * Its `limit` is a post's id, which no screen resolves, so without the name
   * the one reader entitled to the figure could not tell whose it is. Empty
   * for every other summary, and for every reader without HR-läs.
   */
  conflictSummaryNames: string[];
  conflicts: ConflictView[];
  /**
   * The soft wishes the finished run did not keep (free-day-wishes.ts), in a
   * conflict's shape, the teacher whose wish it was in resourceNames for
   * every reader. An empty list when there are none, and on every run
   * before 20261123090100, whose column is null.
   */
  notes: ConflictView[];
  error: string | null;
  errorCode: string | null;
  errorParams: Record<string, string | number> | null;
  /**
   * The teachers a days-bearing failure is about — the engine's pre-flight
   * TEACHER_WORK_DAYS_TOO_FEW_FOR_WEEK, the likeliest way a post's days stop
   * a run — on the same terms as conflictSummaryNames.
   */
  errorNames: string[];
  /**
   * Where a run that ran out of time spent it and how far its search got (timeout-report.ts), or null: every run
   * that did not end in TIMEOUT, a TIMEOUT from an engine older than the field, and every run before the column.
   * Measured, never a rule; the page says what a TIMEOUT has always said where there is none.
   */
  report: TimeoutReportView | null;
  /**
   * The changes that would let this run's week be laid (suggestions.ts, Åtgärdsförslag vid vägran), or null: nobody asked, or the
   * column holds nothing wholly well formed. RUNNING while the analysis runs; a RUNNING that outlived any analysis reads as FAILED.
   * A cap's teacher is named here for every reader, as a free-day note's is; a part-timer's days are in their hidden form for all.
   */
  suggestions: SuggestionsView | null;
  /** Whether the page may offer the button: the run ended with no timetable, and the end is one the five rules can have given. */
  suggestionsOffered: boolean;
  /**
   * Ett schema som start (M9): the schedule the run was asked to start from and what it did with it (held, moved, laid),
   * or null: the run started from nothing, as every run before the column did. Read through startedFromOf.
   */
  startedFrom: StartedFrom | null;
  /**
   * The schemaförslag applied over the year since this run — the newest —
   * whose timetable its notes no longer describe, as the apply's own
   * REGENERATE entry names it; null when none was. Read by GET jobs/:id for a
   * succeeded run with notes, the one card that shows them; null in the
   * history, which shows no notes.
   */
  supersededBy: SupersedingCandidate | null;
  /**
   * The longest a run can take, in seconds (OptimizationProxyService.waitSeconds):
   * what the Generera page quotes while a run is going, so that the sentence
   * follows the deployment's budget instead of the number somebody once wrote
   * into it. Set by the service on every view it returns; absent from a
   * gateway before this field.
   */
  waitSeconds?: number;
  createdAt: string;
  finishedAt: string | null;
}

/** A candidate applied over a run's timetable (ScheduleCandidatesService.apply's REGENERATE entry). */
export interface SupersedingCandidate {
  appliedAt: string;
  /** Null for an entry that does not say (written by hand): a candidate was applied, and which is unknown. */
  ordinal: number | null;
  variant: string | null;
  /**
   * The candidate's run, so the page links to the comparison only while that
   * run is still the year's batch: a newer batch, a discard or the sweep
   * deletes it, and the comparison then shows other candidates or none.
   */
  runId: string | null;
}

const JOB_SELECT = {
  id: true,
  // The year, for the posts a days sentence is read back from (work-days.ts).
  academicYearId: true,
  status: true,
  solverStatus: true,
  lessonsGenerated: true,
  conflictSummary: true,
  conflictSummaryCode: true,
  conflictSummaryParams: true,
  conflicts: true,
  notes: true,
  error: true,
  errorCode: true,
  errorParams: true,
  createdAt: true,
  finishedAt: true,
  // Where a run that ran out of time spent it (timeout-report.ts); null for every other run.
  report: true,
  // The changes that would let a refused or timed-out week be laid (suggestions.ts); null when nobody asked.
  suggestions: true,
  // The schedule a run started from, and what became of its lessons (start-schedule.ts); null when it started from nothing.
  startedFrom: true,
  // For a run whose lease has run out before the sweep has come round (abandonedAt).
  leaseUntil: true,
  // The last sign of life, for how long an abandoned run had gone on (lastSeenParams).
  heartbeatAt: true,
} as const;

/** A run's row as it is read. */
interface JobRow {
  id: string;
  academicYearId: string;
  status: string;
  solverStatus: string | null;
  lessonsGenerated: number;
  conflictSummary: string | null;
  conflictSummaryCode?: string | null;
  conflictSummaryParams?: unknown;
  conflicts: unknown;
  notes?: unknown;
  error: string | null;
  errorCode?: string | null;
  errorParams?: unknown;
  createdAt: Date;
  finishedAt: Date | null;
  /** Where a TIMEOUT's time went, as stored: read through timeoutReportOf, never as it stands. Absent before the column. */
  report?: unknown;
  /** The analysis of the run, as stored: read through suggestionsOf, never as it stands. Absent before the column. */
  suggestions?: unknown;
  /** The schedule the run started from, as stored: read through startedFromOf, never as it stands. Absent before the column. */
  startedFrom?: unknown;
  /** Absent from a row read before the column: such a run is never read as abandoned. */
  leaseUntil?: Date | null;
  /** The database's clock at the run's last sign of life; absent from a row read before the column. */
  heartbeatAt?: Date | null;
}

/**
 * Every sentence of a run that is HR data of a post — a days-bearing
 * refusal, and a note about a limit on teaching in a row (work-days.ts) —
 * with whom it is about: what a reader with HR-läs needs read back from the
 * posts before the run can be shown.
 */
function hrSentencesOf(job: JobRow): StoredSentence[] {
  return [
    ...entriesOf(job.conflicts).map((entry) => sentenceOf(entry.code, entry.params, entry.message, subjectsOf(entry))),
    ...entriesOf(job.notes).map((entry) => sentenceOf(entry.code, entry.params, entry.message, subjectsOf(entry))),
    summaryOf(job),
    failureOf(job),
  ].filter((sentence) => isDaysBearing(sentence.code) || isStretchBearing(sentence.code));
}

/**
 * A run's notes as one reader is shown them. A note about a limit on teaching
 * in a row goes through the rule of the days (forReader, work-days.ts): the
 * limit, the pause and the teacher's name only for a reader with HR-läs, from
 * the post as it stands, and otherwise the one hidden note. Every other note
 * names its teacher for every reader (notesViewOf).
 */
function notesShown(
  stored: unknown,
  names: ReadonlyMap<string, string>,
  say: (sentence: StoredSentence) => SentenceShown,
): ConflictView[] {
  const hiddenCategories = new Set<string>();
  const out: ConflictView[] = [];
  for (const entry of entriesOf(stored)) {
    if (!isStretchBearing(entry.code)) {
      out.push(...notesViewOf([entry], names));
      continue;
    }
    const note = conflictView(entry);
    const shown = say(sentenceOf(entry.code, entry.params, entry.message, subjectsOf(entry)));
    if (shown.code === TEACHER_CONSECUTIVE_TEACHING_HIDDEN) {
      if (hiddenCategories.has(note.category)) continue;
      hiddenCategories.add(note.category);
      out.push({
        category: note.category,
        code: TEACHER_CONSECUTIVE_TEACHING_HIDDEN,
        params: {},
        message: shown.message as string,
        resourceNames: [],
      });
      continue;
    }
    out.push({
      ...note,
      ...(shown.params !== null ? { params: shown.params } : {}),
      resourceNames: [...note.resourceNames, ...shown.names],
    });
  }
  return out;
}

/**
 * A run's analysis as one reader is shown it: through the whitelist (a value that is not wholly well formed is not shown in part), an
 * abandoned one read as the failure it is, each cap's teacher named by whom this reader may see (a protected identity is in nobody's map).
 */
function suggestionsShown(stored: unknown, names: ReadonlyMap<string, string>, now: Date): SuggestionsView | null {
  const held = suggestionsOf(stored);
  return held === null ? null : viewOf(readAs(held, now), names);
}

/** The run's summary as a sentence, its teachers from inside its params. */
function summaryOf(job: JobRow): StoredSentence {
  return sentenceOf(
    job.conflictSummaryCode,
    job.conflictSummaryParams,
    job.conflictSummary,
    subjectsOf(job.conflictSummaryParams),
  );
}

/** The run's failure as a sentence, its teachers from inside its params. */
function failureOf(job: JobRow): StoredSentence {
  return sentenceOf(job.errorCode, job.errorParams, job.error, subjectsOf(job.errorParams));
}

/**
 * How long an abandoned run had gone on when it was last heard from: the seconds from its start to its last
 * heartbeat. NOT to the end of its lease, which is the heartbeat and the lease (270 s at the production
 * settings) later and would overstate by that much what a school is told. Null where it says nothing a school
 * can use: a row from before the column, a run that was never heard from after it began (under five seconds),
 * or a clock that disagrees with itself.
 */
function lastSeenParams(job: JobRow): Record<string, number> | null {
  if (!job.heartbeatAt) return null;
  const seconds = Math.round((job.heartbeatAt.getTime() - job.createdAt.getTime()) / 1000);
  return seconds >= LAST_SEEN_MIN_SECONDS ? { lastSeenSeconds: seconds } : null;
}

/** Under this a run was abandoned as it began, and "after 0 seconds" would say nothing. */
const LAST_SEEN_MIN_SECONDS = 5;

/**
 * One part of a run as a sentence. `?? null` rather than the value: a row read
 * back from a database that predates these columns has undefined where the
 * view promises null, and undefined disappears from a JSON body instead of
 * arriving as "no code, show the English".
 */
function sentenceOf(
  code: string | null | undefined,
  params: unknown,
  message: string | null | undefined,
  subjectIds: readonly string[] | undefined,
): StoredSentence {
  return { code: code ?? null, params: asParams(params), message: message ?? null, subjectIds: subjectIds ?? [] };
}

/** The teachers the notes and the travel sentences of these runs are about: whom their view names. */
function notedOf(jobs: readonly JobRow[]): string[] {
  return [
    ...new Set(
      jobs.flatMap((job) => [
        ...notedTeachersOf(job.notes),
        ...travelTeachersOf(job.conflicts),
        // The teacher a cap in a suggestion is about: named when the run is read, never stored as a name.
        ...teachersOfSuggestions(suggestionsOf(job.suggestions)),
      ]),
    ),
  ];
}

const NO_NAMES: ReadonlyMap<string, string> = new Map();

/**
 * A run as one reader is shown it, and whose post's days that showed them.
 *
 * `posts` is what was read back for a reader with HR-läs (work-days.ts), or
 * null for a reader without. `names` are the teachers the notes are about,
 * read back for every reader (Users id → first and last name); a teacher not
 * in it — gone, or a row naming somebody else's — is named by nobody. Every
 * field is built from the whitelist: nothing of the stored JSON is spread
 * into the answer, so a field kept for the server (subjectIds) cannot leave
 * by being next to one that may.
 *
 * A run still active whose lease has run out is shown as what the sweep will
 * make it, FAILED ENGINE_RUN_ABANDONED, finished when its lease ran out
 * (abandonedAt), so that the page never polls a dead run for ever and says
 * what happened as soon as it is certain, not when the sweep comes round.
 */
export function jobView(
  job: JobRow,
  posts: ReadonlyMap<string, PostShown> | null,
  names: ReadonlyMap<string, string> = NO_NAMES,
  now: Date = new Date(),
): { view: OptimizationJobView; revealed: string[] } {
  const revealed: string[] = [];
  const say = (sentence: StoredSentence): SentenceShown => {
    const shown = forReader(sentence, posts);
    revealed.push(...shown.revealed);
    return shown;
  };

  // Two hidden sentences of one category say nothing the first did not.
  const hiddenCategories = new Set<string>();
  const conflicts: ConflictView[] = [];
  for (const entry of entriesOf(job.conflicts)) {
    const stored = conflictView(entry);
    const shown = say(sentenceOf(stored.code, stored.params, stored.message, subjectsOf(entry)));
    if (shown.code === TEACHER_WORK_DAYS_HIDDEN) {
      if (hiddenCategories.has(stored.category)) continue;
      hiddenCategories.add(stored.category);
      conflicts.push({
        category: stored.category,
        code: TEACHER_WORK_DAYS_HIDDEN,
        params: {},
        message: shown.message as string,
        resourceNames: [],
      });
      continue;
    }
    conflicts.push({
      ...stored,
      ...(shown.params !== null ? { params: shown.params } : {}),
      // A travel sentence's teachers, named now as a note's are.
      resourceNames: [...stored.resourceNames, ...shown.names, ...travelNamesOf(entry, names)],
    });
  }

  const abandoned = abandonedAt(job, now);
  const summary = say(summaryOf(job));
  // An abandoned run says how long it had gone on, whether this read gave it up (the lease has run out and the
  // sweep has not come round) or the sweep already had: the sweep writes the code and no figure.
  const stored = failureOf(job);
  const failure = say(
    abandoned || stored.code === ENGINE_RUN_ABANDONED
      ? sentenceOf(
          ENGINE_RUN_ABANDONED,
          lastSeenParams(job),
          abandoned ? ABANDONED_MESSAGE : stored.message,
          [],
        )
      : stored,
  );

  return {
    view: {
      id: job.id,
      status: abandoned ? 'FAILED' : (job.status as JobStatus),
      solverStatus: (job.solverStatus as SolverStatus | null) ?? null,
      lessonsGenerated: job.lessonsGenerated,
      conflictSummary: summary.message,
      conflictSummaryCode: summary.code,
      conflictSummaryParams: summary.params,
      // Beside the sentence, as a conflict's are in resourceNames: forReader
      // names the teachers only when it showed their post's days.
      conflictSummaryNames: summary.names,
      errorCode: failure.code,
      errorParams: failure.params,
      errorNames: failure.names,
      conflicts,
      // Whose wish it was, beside the sentence as a conflict's classes are:
      // the name the school gives the teacher now, never a stored copy. A
      // limit on teaching in a row is the exception: HR data, named only to a
      // reader with HR-läs (notesShown).
      notes: notesShown(job.notes, names, say),
      error: failure.message,
      report: timeoutReportOf(job.report),
      suggestions: suggestionsShown(job.suggestions, names, now),
      suggestionsOffered: suggestionsMayBeAskedFor({
        status: abandoned ? 'FAILED' : job.status,
        solverStatus: job.solverStatus,
        errorCode: failure.code,
      }),
      supersededBy: null,
      startedFrom: startedFromOf(job.startedFrom),
      createdAt: job.createdAt.toISOString(),
      finishedAt: abandoned ? abandoned.toISOString() : job.finishedAt ? job.finishedAt.toISOString() : null,
    },
    revealed,
  };
}

/**
 * DB-backed optimization job store (replaces the former in-memory queue). The
 * row is what the Generate page polls and what the per-year run history reads;
 * RLS scopes every row to the admin's school.
 *
 * THE RUN IS A QUEUE ENTRY (omgång 12, M4; generate-runs.ts). `run` executes
 * in whichever API process took the request, and a process can go at any
 * moment: every merge deploys the API, and a run takes up to about four
 * minutes. What lets the row outlive the process is on the row itself:
 *
 *   - a lease ("leaseUntil") the process renews every half minute while it
 *     works, each time to the longest the engine can still be solving for it;
 *   - a partial unique index, one active run per year, which a second start
 *     meets as 409 GENERATE_ALREADY_RUNNING;
 *   - a sweep (app.optimization_jobs_sweep) that fails a run whose lease has
 *     run out with ENGINE_RUN_ABANDONED. A start calls it first, the gateway's
 *     runner every five minutes, and a page reads an expired lease as the
 *     abandonment it will become (jobView).
 *
 * It is not a queue in the sense that a second process picks a lost run up:
 * the run is failed with a sentence that says so, and the administrator runs
 * Generera again. A restart that can say so itself (OnModuleDestroy) fails the
 * runs it has in flight at once, with the same code.
 *
 * SCHEDULE_BUSY is another thing. It is the year's regeneration lock, held for
 * a moment by an apply, a restore or the write at the end of a run, and waited
 * for at most 5 s: a start that finds the start lock taken that long, or the
 * write of a run that finds the regeneration lock taken, answers it. A second
 * Generera start that finds a run going is not busy, it is refused: the index
 * holds even for a start that took no lock.
 */
@Injectable()
export class OptimizationJobsService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(OptimizationJobsService.name);
  /** This instance's runs in flight, job id → who started it and the timer that renews its lease. */
  private readonly inFlight = new Map<string, { user: AuthenticatedUser; timer: NodeJS.Timeout }>();
  private sweeping: Promise<void> | null = null;

  constructor(
    private readonly proxy: OptimizationProxyService,
    private readonly prisma: PrismaService,
    @Optional() private readonly config?: ConfigService,
    @Optional() private readonly jobs?: JobRunner,
  ) {}

  onModuleInit(): void {
    if (!this.background() || !this.jobs) return;
    this.jobs.register({ name: GENERATE_SWEEP_JOB, intervalMs: GENERATE_SWEEP_INTERVAL_MS, tick: () => this.tick() });
  }

  /**
   * Leaves the runner, stops renewing, and fails this instance's runs in
   * flight with ENGINE_RUN_ABANDONED, best effort: the year is free at once
   * instead of after the lease, and the page says the service restarted. Each
   * under the administrator who started it, as every write of the run is.
   *
   * A run whose engine call comes back while the process is still draining
   * writes its own outcome over this, as a run the sweep gave up on does: what
   * happened wins over what was guessed (run()).
   */
  async onModuleDestroy(): Promise<void> {
    this.jobs?.unregister(GENERATE_SWEEP_JOB);
    const runs = [...this.inFlight];
    for (const [, { timer }] of runs) clearInterval(timer);
    this.inFlight.clear();
    await Promise.allSettled(
      runs.map(([jobId, { user }]) =>
        this.prisma.withRls(user, (tx) =>
          tx.optimizationJob.updateMany({
            where: { id: jobId, status: { in: ['PENDING', 'RUNNING'] } },
            data: {
              status: 'FAILED',
              error: INTERRUPTED_MESSAGE,
              errorCode: ENGINE_RUN_ABANDONED,
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
    return this.jobs?.isScheduled(GENERATE_SWEEP_JOB) ?? false;
  }

  /** The runs this instance is working on, by id. */
  get running(): string[] {
    return [...this.inFlight.keys()];
  }

  /** The one switch of both sweeps (CANDIDATES_BACKGROUND): a deployment that turns background jobs off turns this off too. */
  private background(): boolean {
    return (this.config?.get<CandidatesConfig>('candidates') ?? DEFAULT_CANDIDATES_CONFIG).background;
  }

  /**
   * app.optimization_jobs_sweep() in a short transaction of its own, with no
   * principal: the function is the owner's, takes no argument and refuses a
   * call that carries a login. Returns how many runs it failed.
   */
  async sweep(): Promise<number> {
    const rows = await this.prisma.withDeliveryService((tx) =>
      tx.$queryRaw<{ changed: number }[]>(Prisma.sql`SELECT app.optimization_jobs_sweep() AS "changed"`),
    );
    return Number(rows?.[0]?.changed ?? 0);
  }

  /** One pass of the job; a tick while the last one runs waits for it. Never throws. */
  async tick(): Promise<void> {
    if (this.sweeping) return this.sweeping;
    const started = new Date();
    this.sweeping = this.sweep()
      .then((changed) => this.jobs?.settled(GENERATE_SWEEP_JOB, started, { ok: true, counts: { changed } }))
      .catch((error: unknown) => {
        this.logger.warn(`Generera sweep failed [${errorName(error)}]`);
        this.jobs?.settled(GENERATE_SWEEP_JOB, started, { ok: false, error: errorName(error) });
      })
      .finally(() => {
        this.sweeping = null;
      });
    return this.sweeping;
  }

  private async sweepBeforeStart(): Promise<void> {
    try {
      await this.sweep();
    } catch (error) {
      // Its own transaction, so a failure here costs only what it would have
      // freed; the partial index still refuses a second active run.
      this.logger.warn(`Generera sweep before a start failed [${errorName(error)}]`);
    }
  }

  /**
   * A run, inserted PENDING, and its task started. Refused before the 202:
   *
   *   - 409 CANDIDATES_RUNNING beside a live schemaförslag run of the year;
   *   - 409 GENERATE_ALREADY_RUNNING beside a Generera run of the year that is
   *     going: the partial unique index, which two starts that pass the start
   *     lock one after the other meet too;
   *   - 409 SCHEDULE_BUSY when the year's start lock is not free within 5 s.
   *
   * The sweep runs first, in its own transaction, so a run whose process died
   * does not hold the year until the five-minute job comes round.
   */
  async start(
    academicYearId: string,
    user: AuthenticatedUser,
    weights?: ObjectiveWeights,
    rules?: ScheduleRules,
    startFrom?: StartRequest,
  ): Promise<{ jobId: string }> {
    if (!user.schoolId) {
      throw new NotFoundException('School context missing from token.');
    }

    await this.sweepBeforeStart();
    const job = await this.prisma.withRls(user, async (tx) => {
      // Nothing here reads a roster — run() does, through the proxy, on the
      // year's projected rosters (projected-rosters.ts). The basis is asked
      // for only for its refusal: a year two steps ahead of the active one
      // (R6) is answered at the click, not in a job that fails later.
      await rostersOfYear(tx, user, academicYearId);
      // Not beside a schemaförslag run of the year (design §3): the run is
      // solving from the draft this job would replace, and an apply of one of
      // its candidates would meet this job's write (GENERATE_STALE) or this
      // job the apply's. Only a run that is still alive holds Generera off —
      // inside its lease and its half hour — so a run whose instance died
      // never locks the button until the sweep comes round.
      await lockYearForSolveStart(tx, academicYearId, SCHEDULE_BUSY);
      if (await yearHasActiveCandidateRun(tx, academicYearId)) throw candidatesRunning();
      // Nor beside the analysis of a refused run (G6, D2: the engine's cores are shared, and the analysis takes the same year start lock).
      if (await yearHasRunningSuggestions(tx, academicYearId)) throw suggestionsRunning();
      // A schedule to start from that cannot be one is answered at the click (a version that is not this year's, a year with
      // no year before it), not in a job that fails later. What needs the week waits for the run.
      if (startFrom) await assertStartable(tx, academicYearId, startFrom);
      try {
        return await tx.optimizationJob.create({
          data: {
            schoolId: user.schoolId as string,
            academicYearId,
            actorId: user.userId ?? null,
            status: 'PENDING',
            weights: (weights ?? undefined) as Prisma.InputJsonValue | undefined,
          },
          select: { id: true },
        });
      } catch (error) {
        // The year's one active place (OptimizationJobs_one_active_per_year).
        if (isUniqueViolation(error)) throw generateAlreadyRunning();
        throw error;
      }
    });

    this.track(job.id, user);
    // Fire and forget — run() records its own outcome on the job row and is
    // written never to throw. The catch stays regardless: this promise is
    // deliberately unawaited, and Node answers an unhandled rejection by
    // terminating the process, so one slip inside run() would take the API down
    // for every school on the instance instead of failing a single job.
    void this.run(job.id, academicYearId, user, weights, rules, startFrom).catch(
      (error: unknown) => {
        this.untrack(job.id);
        this.logger.error(
          `Optimization job ${job.id} crashed outside its own error handling.`,
          error instanceof Error ? error.stack : String(error),
        );
      },
    );

    return { jobId: job.id };
  }

  async get(jobId: string, user: AuthenticatedUser): Promise<OptimizationJobView> {
    const job = await this.prisma.queryWithRls(user, (db) =>
      db.optimizationJob.findUnique({ where: { id: jobId }, select: JOB_SELECT }),
    );
    if (!job) {
      throw new NotFoundException('Optimization job not found.');
    }
    const [view] = await this.forReader([job], user);
    if (view!.status !== 'SUCCEEDED' || view!.notes.length === 0) return view!;
    return { ...view!, supersededBy: await this.supersedingCandidate(job, user) };
  }

  /**
   * The newest schemaförslag applied over the year since the run, from the
   * year's change log: the apply writes a REGENERATE entry with source
   * CANDIDATE, the candidate's ordinal and variant, and the id of the safety
   * version it saved first. The log keeps it whatever becomes of the
   * candidate's run — a newer batch, a discard and the seven-day sweep all
   * delete the run, and with it the appliedAt the candidates overview had —
   * so the notes a page shows for the run are never those of a timetable
   * that has since been replaced.
   *
   * SINCE THE RUN FINISHED. Prisma fills @default(now()) on the client, so
   * the entry's createdAt and the run's finishedAt are both the API's clock.
   * finishedAt is written in the update that ends RUNNING, and an apply
   * checks GENERATE_RUNNING against that status before it writes. So an apply
   * whose entry is older than finishedAt wrote before the run's own write
   * (which takes the year's regeneration lock after it, and solved from a
   * fetch the apply's write was already in or was refused GENERATE_STALE):
   * the run's notes describe what replaced it. createdAt would not do — an
   * apply that passed its check just before the run was started commits
   * after createdAt and before the run's write, and would hide notes that
   * are right. Generera's own entry has no source.
   *
   * UNDONE BY A RESTORE THAT PUTS THE RUN'S TIMETABLE BACK. The year's
   * applies and restores since the run finished are walked in order. The
   * run's timetable is the year's at first. An apply saves it as its safety
   * version ("Före schemaförslag N") only while it still is, and then
   * replaces it. A restore makes it the year's again only when the version
   * restored is one of those. So two applies and then "Före schemaförslag"
   * of the second bring back the first candidate, not the run, and the
   * notes stay replaced. A restore of the first apply's version, even after
   * the second, brings the run back. So does an apply after such a restore
   * that is undone by its own version. A restore of anything else, and a
   * RESTORE that names no version (discarding the draft), leaves the run's
   * timetable gone. An apply logged before the safety version's id was kept
   * can never be undone this way. The run's own hand edits and later
   * Generera runs are not walked: the card never tracked those.
   *
   * One read, of the year's entries of those two kinds since the run — a
   * handful a year, each one an administrator's deliberate act — and only
   * for a succeeded run with notes, so the reads the page polls while a run
   * goes stay one. Every administrator reads the log (its select arm), as
   * they read the run.
   */
  private async supersedingCandidate(job: JobRow, user: AuthenticatedUser): Promise<SupersedingCandidate | null> {
    if (job.finishedAt === null) return null;
    const finishedAt = job.finishedAt;
    const events = await this.prisma.queryWithRls(user, (db) =>
      db.scheduleChangeLog.findMany({
        where: {
          academicYearId: job.academicYearId,
          createdAt: { gt: finishedAt },
          OR: [{ action: 'REGENERATE', after: { path: ['source'], equals: 'CANDIDATE' } }, { action: 'RESTORE' }],
        },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        select: { action: true, createdAt: true, after: true },
      }),
    );
    let current = true;
    const holdingTheRun = new Set<string>();
    let last: (typeof events)[number] | null = null;
    for (const event of events) {
      const after = (event.after ?? {}) as { safetyVersionId?: unknown; versionId?: unknown };
      if (event.action === 'REGENERATE') {
        if (current && typeof after.safetyVersionId === 'string') holdingTheRun.add(after.safetyVersionId);
        current = false;
        last = event;
      } else {
        current = typeof after.versionId === 'string' && holdingTheRun.has(after.versionId);
      }
    }
    if (last === null || current) return null;
    const applied = (last.after ?? {}) as { ordinal?: unknown; variant?: unknown; runId?: unknown };
    return {
      appliedAt: last.createdAt.toISOString(),
      // A hand-edited entry without them still says a candidate was applied.
      ordinal: typeof applied.ordinal === 'number' && Number.isInteger(applied.ordinal) ? applied.ordinal : null,
      variant: typeof applied.variant === 'string' ? applied.variant : null,
      runId: typeof applied.runId === 'string' ? applied.runId : null,
    };
  }

  /** Latest runs for an academic year (run history for the Generate page). */
  async list(
    academicYearId: string,
    user: AuthenticatedUser,
  ): Promise<OptimizationJobView[]> {
    const jobs = await this.prisma.queryWithRls(user, (db) =>
      db.optimizationJob.findMany({
        where: { academicYearId },
        orderBy: { createdAt: 'desc' },
        take: 20,
        select: JOB_SELECT,
      }),
    );
    return this.forReader(jobs, user);
  }

  /**
   * The synchronous trigger's refusal, worded for its reader as a stored run
   * is: what to throw instead of `error`. Only a refusal about a post's days
   * (WorkDaysRefusal) is touched — it reaches the caller as the hidden
   * sentence, or with the days read back from the post for a reader with
   * HR-läs — and every other error is handed back as it came.
   *
   * NO NAME, where a stored run's view has errorNames. The answer leaves as
   * problem+json, and the filter that builds it keeps a thrower's code and
   * params and drops everything else on purpose (http-exception.filter.ts):
   * an error body is no place a person's name should be able to ride out
   * by accident. The post's id is in `limit`, the figure is the reader's to
   * see and recorded as read, and the same refusal read as a run through
   * /optimization/jobs names the teacher.
   */
  async refusalForReader(error: unknown, academicYearId: string, user: AuthenticatedUser): Promise<unknown> {
    if (!(error instanceof WorkDaysRefusal)) return error;
    const body = error.getResponse() as { message: string; code: string; params: Record<string, string | number> };
    const sentence: StoredSentence = {
      code: body.code,
      params: body.params,
      message: body.message,
      subjectIds: error.subjectIds,
    };
    const shown = await this.shownTo(user, [{ academicYearId, sentences: [sentence] }], [], (posts) => {
      const said = forReader(sentence, posts(academicYearId));
      return { result: said, revealed: said.revealed };
    });
    return new HttpException(
      { message: shown.message, code: shown.code, params: shown.params },
      error.getStatus(),
    );
  }

  /** Runs as this reader is shown them: see jobView and work-days.ts. */
  private async forReader(jobs: JobRow[], user: AuthenticatedUser): Promise<OptimizationJobView[]> {
    const views = await this.shownTo(
      user,
      jobs.map((job) => ({ academicYearId: job.academicYearId, sentences: hrSentencesOf(job) })),
      notedOf(jobs),
      (posts, names) => {
        const now = new Date();
        const shown = jobs.map((job) => jobView(job, posts(job.academicYearId), names, now));
        return { result: shown.map(({ view }) => view), revealed: shown.flatMap(({ revealed }) => revealed) };
      },
    );
    // The same for every run: a property of the deployment, not of the row.
    const waitSeconds = this.proxy.waitSeconds;
    return views.map((view) => ({ ...view, waitSeconds }));
  }

  /**
   * What a run needs before it can be shown: for a reader with HR-läs, the
   * posts its days sentences name, read back (nothing for a reader without:
   * they are shown the hidden sentence); and for every reader, the names of
   * the teachers its notes are about (`named`).
   *
   * A SECOND STATEMENT, and only then. The run itself is read in one
   * (queryWithRls), which has no room for the Läslogg's; every read the
   * Generera page polls stays that one statement for a run with neither, a
   * reader is charged one more for the names of a run that broke a wish,
   * and a transaction of its own when they are shown a post's days. The read
   * is of the posts as they stand, for the run's year: a post whose limit has
   * since been cleared, or that is gone, is not read back, and its sentence
   * stays hidden (forReader). What is shown of a post is written to the
   * Läslogg in the same transaction — Users ids, which is what
   * app.personal_data_read records.
   *
   * THE NAMES OF A FREE-DAY NOTE ARE NOT RECORDED. That note puts a teacher's
   * name beside their wished free day, which is on the work rule every member
   * of staff reads (the table's staff policy, GET /teacher-work-rules) and
   * not on the post: a name beside a staff-readable fact, as the timetable
   * layer names who teaches what (access-log.ts, NOT RECORDED). What the days
   * sentence records is the post's days it shows, not the name beside them,
   * and the publication check names the teachers it stops on the same way.
   * A note about a limit on teaching in a row is the post's, as the days are:
   * it is read back through this method for a reader with HR-läs, who is
   * shown it and so recorded (EMPLOYMENT), and for nobody else.
   */
  private async shownTo<T>(
    user: AuthenticatedUser,
    wanted: Array<{ academicYearId: string; sentences: StoredSentence[] }>,
    named: readonly string[],
    show: (
      posts: (academicYearId: string) => ReadonlyMap<string, PostShown> | null,
      names: ReadonlyMap<string, string>,
    ) => {
      result: T;
      revealed: string[];
    },
  ): Promise<T> {
    const subjects = [...new Set(wanted.flatMap(({ sentences }) => sentences.flatMap((s) => s.subjectIds)))];
    const people = { where: { id: { in: [...named] } }, select: { id: true, firstName: true, lastName: true } };
    if (!readsHr(user) || subjects.length === 0) {
      if (named.length === 0) return show(() => null, NO_NAMES).result;
      const rows = await this.prisma.queryWithRls(user, (db) => db.user.findMany(people));
      return show(() => null, namesOf(rows)).result;
    }
    const years = [...new Set(wanted.map(({ academicYearId }) => academicYearId))];
    return this.prisma.withRls(user, async (tx) => {
      const posts = await tx.teacherEmployment.findMany({
        where: {
          academicYearId: { in: years },
          userId: { in: subjects },
          // A post with a limit of either kind: deltid in days, or a limit on
          // teaching in a row (both are read back here, work-days.ts).
          OR: [{ maxTeachingDaysPerWeek: { not: null } }, { maxConsecutiveTeachingMinutes: { not: null } }],
        },
        select: {
          academicYearId: true,
          userId: true,
          maxTeachingDaysPerWeek: true,
          maxConsecutiveTeachingMinutes: true,
          consecutiveBreakMinutes: true,
          user: { select: { firstName: true, lastName: true } },
        },
      });
      const byYear = new Map<string, Map<string, PostShown>>();
      for (const post of posts) {
        const ofYear = byYear.get(post.academicYearId) ?? new Map<string, PostShown>();
        ofYear.set(post.userId, {
          days: post.maxTeachingDaysPerWeek,
          // Both columns or neither (the pair CHECK).
          stretch:
            post.maxConsecutiveTeachingMinutes !== null && post.consecutiveBreakMinutes !== null
              ? { max: post.maxConsecutiveTeachingMinutes, breakMinutes: post.consecutiveBreakMinutes }
              : null,
          name: `${post.user.firstName} ${post.user.lastName}`,
        });
        byYear.set(post.academicYearId, ofYear);
      }
      const rows = named.length > 0 ? await tx.user.findMany(people) : [];
      const { result, revealed } = show((academicYearId) => byYear.get(academicYearId) ?? new Map(), namesOf(rows));
      await recordRead(tx, 'EMPLOYMENT', revealed, user.channel);
      return result;
    });
  }

  private async run(
    jobId: string,
    academicYearId: string,
    user: AuthenticatedUser,
    weights?: ObjectiveWeights,
    rules?: ScheduleRules,
    startFrom?: StartRequest,
  ): Promise<void> {
    try {
      // Inside the try, not before it. This is the first database write after
      // the request has already returned — a pool exhaustion or a failover here
      // is the likeliest failure of the whole run — and outside the try its
      // rejection escapes into the unawaited promise above instead of landing
      // on the job row like every other failure.
      //
      // The first heartbeat: RUNNING, this process as the claimant, and the
      // lease. Nothing was updated when the run is no longer active (the sweep
      // gave it up in the moments since the insert, or its school is gone), and
      // then it is not this process's to run.
      if (!(await this.beat(jobId, user))) {
        this.logger.warn(`Optimization job is no longer active, nothing was run [jobId=${jobId}]`);
        return;
      }
      const response = await this.proxy.triggerScheduling(
        academicYearId,
        user,
        weights ?? null,
        rules ?? null,
        // Only a run that asked for a start carries the argument, so every other run calls the proxy as it always did.
        ...(startFrom ? ([startFrom] as const) : ([] as const)),
      );
      const conflicts: AiEngineConflictAnalysis | null | undefined = response.conflicts;
      await this.update(jobId, user, {
        status: 'SUCCEEDED',
        solverStatus: response.status,
        lessonsGenerated: response.lessons.length,
        conflictSummary: conflicts?.summary ?? null,
        conflictSummaryCode: conflicts?.summaryCode ?? null,
        conflictSummaryParams: storedParams(conflicts?.summaryParams, conflicts?.summarySubjectIds),
        // Stored as the proxy realised them: a days-bearing sentence already
        // without its figure, its teachers beside it (work-days.ts).
        conflicts: (conflicts?.conflicts ?? []).map(storedOf) as unknown as Prisma.InputJsonValue,
        // The wishes it did not keep, kept as a conflict is, the teacher's
        // Users id beside each and no name: the view names them when read.
        // Null when it kept every one, as on every run before.
        notes:
          response.notes && response.notes.length > 0
            ? (response.notes.map(storedOf) as unknown as Prisma.InputJsonValue)
            : Prisma.DbNull,
        // What happened wins over what was guessed: a run the sweep (or a
        // restart) gave up on while its engine call was still going, and that
        // then came back and wrote its timetable, ends SUCCEEDED, and what
        // was said of it as abandoned goes.
        error: null,
        errorCode: null,
        errorParams: Prisma.DbNull,
        // Where a TIMEOUT's time went, whitelisted (timeout-report.ts): only on a TIMEOUT, so no other run carries
        // one, and null where the engine sent none (an older one) or what it sent is not wholly well formed.
        report: reportToStore(response.status, response.report),
        // What the run did with the schedule it was asked to start from. Only a run that asked for one writes it: the
        // column is null for every other, and a row is written once.
        ...(response.startedFrom ? { startedFrom: response.startedFrom as unknown as Prisma.InputJsonValue } : {}),
        finishedAt: new Date(),
      });
    } catch (error) {
      this.logger.warn(`Optimization job failed [jobId=${jobId}]`);
      const refusal = refusalOf(error);
      await this.update(jobId, user, {
        status: 'FAILED',
        error: refusal.message,
        errorCode: refusal.code,
        errorParams: storedParams(refusal.params, refusal.subjectIds),
        finishedAt: new Date(),
      }).catch(() => undefined);
    } finally {
      this.untrack(jobId);
    }
  }

  /** Starts renewing the run's lease, and remembers it for a restart (onModuleDestroy). */
  private track(jobId: string, user: AuthenticatedUser): void {
    const timer = setInterval(() => void this.renew(jobId, user), HEARTBEAT_INTERVAL_MS);
    // A timer must never keep the process alive: a restart is exactly when it should go.
    timer.unref();
    this.inFlight.set(jobId, { user, timer });
  }

  private untrack(jobId: string): void {
    const entry = this.inFlight.get(jobId);
    if (!entry) return;
    clearInterval(entry.timer);
    this.inFlight.delete(jobId);
  }

  /**
   * One renewal of the timer. A renewal that finds the run no longer active —
   * the sweep gave it up, a restart failed it, it ended — stops the timer and
   * writes nothing; the run itself goes on to its own end, whose write is the
   * truth. Never throws: a lost connection costs one renewal, and the lease is
   * several of them long.
   */
  private async renew(jobId: string, user: AuthenticatedUser): Promise<void> {
    try {
      if (await this.beat(jobId, user)) return;
      this.logger.warn(`Optimization job is no longer active, its lease is not renewed [jobId=${jobId}]`);
      this.untrack(jobId);
    } catch (error) {
      this.logger.warn(`Optimization job heartbeat failed [jobId=${jobId}, ${errorName(error)}]`);
    }
  }

  /**
   * The compare-and-set every sign of life is: RUNNING, this process as the
   * claimant, the heartbeat now (the database's clock, the one the sweep
   * reads) and the lease, WHERE the run is still PENDING or RUNNING. False when
   * nothing was updated: the run is not active any more.
   *
   * The lease is the longest the engine can still be solving for the run
   * (leaseSecondsFor), from now.
   */
  private async beat(jobId: string, user: AuthenticatedUser): Promise<boolean> {
    const lease = leaseSecondsFor(this.proxy.waitSeconds);
    const updated = await this.prisma.withRls(user, (tx) =>
      tx.$executeRaw(
        Prisma.sql`UPDATE "OptimizationJobs"
                      SET "status" = 'RUNNING', "claimedBy" = ${INSTANCE_NAME}, "heartbeatAt" = now(),
                          "leaseUntil" = now() + make_interval(secs => ${lease})
                    WHERE "id" = ${jobId}::uuid AND "status" IN ('PENDING', 'RUNNING')`,
      ),
    );
    return Number(updated) > 0;
  }

  private async update(
    jobId: string,
    user: AuthenticatedUser,
    data: Prisma.OptimizationJobUpdateInput,
  ): Promise<void> {
    await this.prisma.withRls(user, (tx) =>
      tx.optimizationJob.update({ where: { id: jobId }, data }),
    );
  }
}
