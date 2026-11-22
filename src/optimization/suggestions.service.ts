import { randomUUID } from 'node:crypto';
import { ConflictException, HttpException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Prisma, type PrismaClient } from '@prisma/client';
import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';
import { PrismaService } from '../database/prisma.service';
import type { AiEngineSuggestChangesResponse } from './interfaces/suggest-changes.interface';
import { OptimizationProxyService } from './optimization-proxy.service';
import { lockYearForSolveStart, SCHEDULE_BUSY } from './regeneration-lock';
import { yearHasActiveCandidateRun } from './schedule-candidates.service';
import {
  STALE_AFTER_MS,
  failedSuggestions,
  suggestionsMayBeAskedFor,
  refusedSuggestions,
  runningSuggestions,
  suggestionsFromEngine,
  suggestionsOf,
  viewOf,
  type SuggestionsFailure,
  type SuggestionsStored,
  type SuggestionsView,
} from './suggestions';

/** The engine's route (optimization-engine/app/api/v1/suggest_changes.py). */
export const SUGGEST_CHANGES_PATH = '/api/v1/suggest-changes';

/**
 * WHAT THE ANALYSIS ASKS OF THE ENGINE, in one place. The search is a third of production's budget for a Generera and takes it
 * all (phase 2 goes on improving until the budget ends); the engine adds up to 30 s for the check and two builds' headroom, so its
 * own ceiling for this is search + 90 s, 150 s here. The wait is the ceiling and a margin, and the deadline the engine is told is a
 * little under it, so that the engine answers inside the wait and not by a 503 this call has stopped waiting for.
 */
export const SUGGEST_SEARCH_SECONDS = 60;
/** Half of the engine's cores, a Generera of another year may be running beside it (the engine's gate is one analysis at a time). */
export const SUGGEST_WORKERS = 4;
export const SUGGEST_DEADLINE_SECONDS = 195;
export const SUGGEST_WAIT_MS = 200_000;

/** The gateway's codes: what a refused start says, flat, for the page to word. */
export const SUGGESTIONS_NOT_FOR_THIS_RUN = 'SUGGESTIONS_NOT_FOR_THIS_RUN';
export const SUGGESTIONS_RUN_IS_OLD = 'SUGGESTIONS_RUN_IS_OLD';
export const SUGGESTIONS_YEAR_BUSY = 'SUGGESTIONS_YEAR_BUSY';

/** How a failed call to the engine is said. A 400 is not a failure: the engine's hard rules refuse the week (refusedSuggestions). */
export function failureOf(error: unknown): SuggestionsFailure | 'REFUSED' {
  if (error instanceof HttpException) {
    const status = error.getStatus();
    // An engine older than the route: FastAPI answers 404 for a path it has not got, 405 for one with another method.
    if (status === 404 || status === 405) return 'ENGINE_LACKS_SUGGESTIONS';
    if (status === 429) return 'ENGINE_BUSY';
    if (status === 400) return 'REFUSED';
  }
  return 'ENGINE_FAILED';
}

/**
 * ÅTGÄRDSFÖRSLAG VID VÄGRAN (omgång 13, G6, del 2): the analysis that turns a refusal or a timeout into the changes that would let the
 * week be laid.
 *
 * ASKED FOR, NEVER STARTED BY ITSELF. An administrator presses a button on the run that ended without a timetable (POST jobs/:id/
 * suggestions), and the answer comes back on the same run when the page reads it (GET jobs/:id). It costs the engine up to a minute and
 * a half of its cores, so it waits for no one and runs for nobody who did not ask.
 *
 * A SECOND, SEPARATE REQUEST TO THE ENGINE, not a step inside the run that ended: the run has used its budget, and the analysis has
 * its own (suggestions.ts, the engine's /suggest-changes). It reads the school as it is NOW (the same fetch Generera makes), with the
 * run's rules; a week the school has changed since the run is analysed as it stands, and the page says when the analysis was made.
 *
 * ITS STATE IS ITS OWN COLUMN (OptimizationJobs."suggestions"), not the run's lease: the run is over. RUNNING carries the start, and a
 * RUNNING that has been so for longer than an analysis lasts is read as abandoned (suggestions.ts): a process that went away (a deploy
 * of the API happens at every merge) leaves nothing that finishes it, and that must read as what it is. A second press while one runs
 * is the same answer, not a second analysis.
 *
 * IT WRITES NOTHING BUT THAT COLUMN. No timetable is placed, no setting changed, no row but the run's own touched: what a school does
 * with a suggestion it does on the page that owns the data.
 */
@Injectable()
export class SuggestionsService {
  private readonly logger = new Logger(SuggestionsService.name);
  /** The analyses this process has in flight: what a test waits for, and nothing else reads. */
  private readonly inFlight = new Set<Promise<void>>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly proxy: OptimizationProxyService,
  ) {}

  /** Resolves when every analysis this process started has ended. */
  async settled(): Promise<void> {
    await Promise.allSettled([...this.inFlight]);
  }

  /**
   * Starts the analysis of a run, and returns at once with it RUNNING. A run it may not be asked for is 409 with the reason as a code.
   */
  async start(jobId: string, user: AuthenticatedUser): Promise<SuggestionsView> {
    const now = new Date();
    const running = runningSuggestions(now);
    const claim = await this.prisma.withRls(user, async (tx) => {
      const job = await tx.optimizationJob.findUnique({
        where: { id: jobId },
        select: { id: true, academicYearId: true, status: true, solverStatus: true, errorCode: true, suggestions: true },
      });
      if (!job) throw new NotFoundException('Run not found.');
      if (!suggestionsMayBeAskedFor(job)) {
        throw new ConflictException({
          message: 'Förslag kan inte tas fram för den här körningen.',
          code: SUGGESTIONS_NOT_FOR_THIS_RUN,
        });
      }
      // The year's newest run only: an older one describes a week that has been run since.
      const newest = await tx.optimizationJob.findFirst({
        where: { academicYearId: job.academicYearId },
        orderBy: { createdAt: 'desc' },
        select: { id: true },
      });
      if (newest?.id !== job.id) {
        throw new ConflictException({
          message: 'Det finns en nyare körning för läsåret.',
          code: SUGGESTIONS_RUN_IS_OLD,
        });
      }
      // A second press is the first one's answer, not a second analysis.
      const held = suggestionsOf(job.suggestions);
      if (held !== null && held.state === 'RUNNING' && now.getTime() - Date.parse(held.startedAt) <= STALE_AFTER_MS) {
        return { academicYearId: job.academicYearId, stored: held, started: false };
      }
      // The engine's cores are the school's own Generera's: an analysis does not start beside one. Under the year's solve-start lock, the
      // one Generera's start and a schemaförslag run's start take, so that a start that meets this claim sees it (it is refused, see
      // suggestions-running.ts) or is seen by it, and the two are not both let through.
      await lockYearForSolveStart(tx, job.academicYearId, SCHEDULE_BUSY);
      const active = await tx.optimizationJob.count({
        where: { academicYearId: job.academicYearId, status: { in: ['PENDING', 'RUNNING'] } },
      });
      if (active > 0 || (await yearHasActiveCandidateRun(tx, job.academicYearId))) {
        throw new ConflictException({
          message: 'Läsåret har en körning igång. Försök igen när den är klar.',
          code: SUGGESTIONS_YEAR_BUSY,
        });
      }
      // The claim is one statement, so that two presses at once are one analysis whatever the order they come in.
      const claimed = await tx.$executeRaw(
        Prisma.sql`UPDATE "OptimizationJobs"
                      SET "suggestions" = ${JSON.stringify(running)}::jsonb
                    WHERE id = ${job.id}::uuid
                      AND ("suggestions" IS NULL
                           OR "suggestions"->>'state' <> 'RUNNING'
                           OR ("suggestions"->>'startedAt')::timestamptz < now() - make_interval(secs => ${STALE_AFTER_MS / 1000}))`,
      );
      if (claimed === 0) {
        const again = await tx.optimizationJob.findUnique({ where: { id: job.id }, select: { suggestions: true } });
        return { academicYearId: job.academicYearId, stored: suggestionsOf(again?.suggestions) ?? running, started: false };
      }
      return { academicYearId: job.academicYearId, stored: running, started: true };
    });

    if (claim.started) {
      const task = this.run(jobId, claim.academicYearId, user, claim.stored.startedAt).catch((error: unknown) => {
        this.logger.error(`Suggestions run failed outside its own handling [job=${jobId}]: ${String(error)}`);
      });
      this.inFlight.add(task);
      void task.finally(() => this.inFlight.delete(task));
    }
    return viewOf(claim.stored, new Map());
  }

  /** The analysis itself: the fetch, the engine, the write. Every way out writes the column, so that no run is left RUNNING by an error. */
  private async run(jobId: string, academicYearId: string, user: AuthenticatedUser, startedAt: string): Promise<void> {
    const requestId = randomUUID();
    let outcome: SuggestionsStored;
    try {
      const prepared = await this.prisma.withRls(user, (tx) =>
        this.proxy.prepareSchedule(tx, academicYearId, user, { requestId }),
      );
      if (!prepared.ready) {
        // The gateway's own pre-flight refuses the week (a post without a teacher, a block partly locked): a hard rule, as the engine's.
        this.logger.log(`Suggestions answered by the gateway's pre-flight (${prepared.refusalCode}) [job=${jobId}]`);
        outcome = refusedSuggestions(startedAt, new Date());
      } else if (prepared.payload.requirements.length === 0) {
        // Every post is hand-placed: nothing is searched for and nothing is to be changed.
        outcome = failedSuggestions(startedAt, 'NOTHING_TO_PLACE', new Date());
      } else {
        const payload = {
          ...prepared.payload,
          ...(prepared.storedRules ? { rules: prepared.storedRules } : {}),
          search: { maxSeconds: SUGGEST_SEARCH_SECONDS, workers: SUGGEST_WORKERS },
          deadlineSeconds: SUGGEST_DEADLINE_SECONDS,
        };
        const response = await this.proxy.callAiEngine<AiEngineSuggestChangesResponse>(
          SUGGEST_CHANGES_PATH,
          payload,
          prepared.anonMaps,
          { timeoutMs: SUGGEST_WAIT_MS },
        );
        outcome = suggestionsFromEngine(response, this.proxy.realiserOf(prepared.anonMaps), startedAt, new Date());
      }
    } catch (error) {
      const failure = failureOf(error);
      this.logger.warn(`Suggestions ended without a list [job=${jobId}, failure=${failure}]: ${String(error)}`);
      outcome = failure === 'REFUSED' ? refusedSuggestions(startedAt, new Date()) : failedSuggestions(startedAt, failure, new Date());
    }
    await this.write(jobId, user, startedAt, outcome);
  }

  /**
   * The column, written once, and only over the analysis this call started: a later press that took the claim after this one was
   * abandoned is not overwritten by it. Through the whitelist on the way in, as it is on the way out.
   */
  private async write(jobId: string, user: AuthenticatedUser, startedAt: string, outcome: SuggestionsStored): Promise<void> {
    const safe = suggestionsOf(outcome) ?? failedSuggestions(startedAt, 'ENGINE_FAILED', new Date());
    await this.prisma.withRls(user, async (tx: PrismaClient) => {
      await tx.$executeRaw(
        Prisma.sql`UPDATE "OptimizationJobs"
                      SET "suggestions" = ${JSON.stringify(safe)}::jsonb
                    WHERE id = ${jobId}::uuid
                      AND "suggestions"->>'state' = 'RUNNING'
                      AND "suggestions"->>'startedAt' = ${startedAt}`,
      );
    });
  }
}
