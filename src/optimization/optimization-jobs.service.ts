import { HttpException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';
import { PrismaService } from '../database/prisma.service';
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
  TEACHER_WORK_DAYS_HIDDEN,
  WorkDaysRefusal,
  forReader,
  isDaysBearing,
  type PostShown,
  type SentenceShown,
  type StoredSentence,
} from './work-days';
import { candidatesRunning, yearHasActiveCandidateRun } from './schedule-candidates.service';
import {
  asParams,
  conflictView,
  entriesOf,
  namesOf,
  notedTeachersOf,
  notesViewOf,
  storedOf,
  subjectsOf,
  type ConflictView,
} from './stored-conflicts';
import { lockYearForSolveStart, SCHEDULE_BUSY } from './regeneration-lock';

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
  return {
    message: error instanceof Error ? error.message : fallback,
    code: null,
    params: null,
    subjectIds: [],
  };
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
   * The schemaförslag applied over the year since this run — the newest —
   * whose timetable its notes no longer describe, as the apply's own
   * REGENERATE entry names it; null when none was. Read by GET jobs/:id for a
   * succeeded run with notes, the one card that shows them; null in the
   * history, which shows no notes.
   */
  supersededBy: SupersedingCandidate | null;
  createdAt: string;
  finishedAt: string | null;
}

/** A candidate applied over a run's timetable (ScheduleCandidatesService.apply's REGENERATE entry). */
export interface SupersedingCandidate {
  appliedAt: string;
  /** Null for an entry that does not say (written by hand): a candidate was applied, and which is unknown. */
  ordinal: number | null;
  variant: string | null;
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
}

/**
 * Every days-bearing sentence of a run, with whom it is about: what a reader
 * with HR-läs needs read back from the posts before the run can be shown.
 */
function daysSentencesOf(job: JobRow): StoredSentence[] {
  return [
    ...entriesOf(job.conflicts).map((entry) => sentenceOf(entry.code, entry.params, entry.message, subjectsOf(entry))),
    summaryOf(job),
    failureOf(job),
  ].filter((sentence) => isDaysBearing(sentence.code));
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

/** The teachers the notes of these runs are about: whom their view names. */
function notedOf(jobs: readonly JobRow[]): string[] {
  return [...new Set(jobs.flatMap((job) => notedTeachersOf(job.notes)))];
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
 */
export function jobView(
  job: JobRow,
  posts: ReadonlyMap<string, PostShown> | null,
  names: ReadonlyMap<string, string> = NO_NAMES,
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
      resourceNames: [...stored.resourceNames, ...shown.names],
    });
  }

  const summary = say(summaryOf(job));
  const failure = say(failureOf(job));

  return {
    view: {
      id: job.id,
      status: job.status as JobStatus,
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
      // the name the school gives the teacher now, never a stored copy.
      notes: notesViewOf(job.notes, names),
      error: failure.message,
      supersededBy: null,
      createdAt: job.createdAt.toISOString(),
      finishedAt: job.finishedAt ? job.finishedAt.toISOString() : null,
    },
    revealed,
  };
}

/**
 * DB-backed optimization job store (replaces the former in-memory queue). The
 * row is what the Generate page polls and what the per-year run history reads;
 * RLS scopes every row to the admin's school.
 *
 * The row is durable, the *work* is not. `run` executes in whichever API
 * process took the request, with no lease and no sweeper, so a restart
 * mid-solve strands the row at RUNNING for ever and nothing stops two admins
 * starting overlapping runs for the same year. Turning this into a real queue
 * needs a claim column, a partial unique index on the active job per year, and
 * a startup pass that fails abandoned rows — until then, do not read this
 * class as one.
 */
@Injectable()
export class OptimizationJobsService {
  private readonly logger = new Logger(OptimizationJobsService.name);

  constructor(
    private readonly proxy: OptimizationProxyService,
    private readonly prisma: PrismaService,
  ) {}

  async start(
    academicYearId: string,
    user: AuthenticatedUser,
    weights?: ObjectiveWeights,
    rules?: ScheduleRules,
  ): Promise<{ jobId: string }> {
    if (!user.schoolId) {
      throw new NotFoundException('School context missing from token.');
    }

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
      return tx.optimizationJob.create({
        data: {
          schoolId: user.schoolId as string,
          academicYearId,
          actorId: user.userId ?? null,
          status: 'PENDING',
          weights: (weights ?? undefined) as Prisma.InputJsonValue | undefined,
        },
        select: { id: true },
      });
    });

    // Fire and forget — run() records its own outcome on the job row and is
    // written never to throw. The catch stays regardless: this promise is
    // deliberately unawaited, and Node answers an unhandled rejection by
    // terminating the process, so one slip inside run() would take the API down
    // for every school on the instance instead of failing a single job.
    void this.run(job.id, academicYearId, user, weights, rules).catch(
      (error: unknown) => {
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
   * CANDIDATE and the candidate's ordinal and variant. The log keeps it
   * whatever becomes of the candidate's run — a newer batch, a discard and
   * the seven-day sweep all delete the run, and with it the appliedAt the
   * candidates overview had — so the notes a page shows for the run are
   * never those of a timetable that has since been replaced.
   *
   * Since the run was CREATED, not since it finished: both are the
   * database's clock (the entry's and the job's defaults), where finishedAt
   * is the API's, and no apply lands while the run is solving (an apply is
   * refused beside a Generera job, GENERATE_RUNNING). Generera's own entry
   * has no source. A second statement, read only for a succeeded run with
   * notes, so the reads the page polls while a run goes stay one. Every
   * administrator reads the log (its select arm), as they read the run.
   */
  private async supersedingCandidate(job: JobRow, user: AuthenticatedUser): Promise<SupersedingCandidate | null> {
    const entry = await this.prisma.queryWithRls(user, (db) =>
      db.scheduleChangeLog.findFirst({
        where: {
          academicYearId: job.academicYearId,
          action: 'REGENERATE',
          createdAt: { gt: job.createdAt },
          after: { path: ['source'], equals: 'CANDIDATE' },
        },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        select: { createdAt: true, after: true },
      }),
    );
    if (!entry) return null;
    const after = (entry.after ?? {}) as { ordinal?: unknown; variant?: unknown };
    return {
      appliedAt: entry.createdAt.toISOString(),
      // A hand-edited entry without them still says a candidate was applied.
      ordinal: typeof after.ordinal === 'number' && Number.isInteger(after.ordinal) ? after.ordinal : null,
      variant: typeof after.variant === 'string' ? after.variant : null,
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
  private forReader(jobs: JobRow[], user: AuthenticatedUser): Promise<OptimizationJobView[]> {
    return this.shownTo(
      user,
      jobs.map((job) => ({ academicYearId: job.academicYearId, sentences: daysSentencesOf(job) })),
      notedOf(jobs),
      (posts, names) => {
        const shown = jobs.map((job) => jobView(job, posts(job.academicYearId), names));
        return { result: shown.map(({ view }) => view), revealed: shown.flatMap(({ revealed }) => revealed) };
      },
    );
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
   * THE NAMES ARE NOT RECORDED. A note puts a teacher's name beside their
   * wished free day, which is on the work rule every member of staff reads
   * (the table's staff policy, GET /teacher-work-rules) and not on the post:
   * a name beside a staff-readable fact, as the timetable layer names who
   * teaches what (access-log.ts, NOT RECORDED). What the days sentence
   * records is the post's days it shows, not the name beside them, and the
   * publication check names the teachers it stops on the same way.
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
          maxTeachingDaysPerWeek: { not: null },
        },
        select: {
          academicYearId: true,
          userId: true,
          maxTeachingDaysPerWeek: true,
          user: { select: { firstName: true, lastName: true } },
        },
      });
      const byYear = new Map<string, Map<string, PostShown>>();
      for (const post of posts) {
        const ofYear = byYear.get(post.academicYearId) ?? new Map<string, PostShown>();
        ofYear.set(post.userId, {
          // The where admits no null.
          days: post.maxTeachingDaysPerWeek as number,
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
  ): Promise<void> {
    try {
      // Inside the try, not before it. This is the first database write after
      // the request has already returned — a pool exhaustion or a failover here
      // is the likeliest failure of the whole run — and outside the try its
      // rejection escapes into the unawaited promise above instead of landing
      // on the job row like every other failure.
      await this.update(jobId, user, { status: 'RUNNING' });
      const response = await this.proxy.triggerScheduling(
        academicYearId,
        user,
        weights ?? null,
        rules ?? null,
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
    }
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
