import { Injectable, Logger, type OnApplicationBootstrap, type OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { HttpService } from '@nestjs/axios';
import { firstValueFrom } from 'rxjs';
import { timeout } from 'rxjs/operators';
import { NodeEnv } from '../config/env.validation';
import type { AiEngineConfig, AppConfig } from '../config/configuration';
import {
  candidateBudgetNote,
  candidateTimesOf,
  parseEngineTiming,
  supportsDeadline,
  waitMsFor,
  waitShortfall,
  type CandidateTimes,
  type EngineRoute,
  type EngineTiming,
} from './engine-timing';

/** GET /api/v1/timing is a read of a few numbers; an engine that needs longer is not answering. */
export const TIMING_READ_MS = 5_000;
/** How often the times are read again, so an engine whose variables were changed is noticed. */
export const TIMING_REFRESH_MS = 10 * 60 * 1000;
/** How soon a call asks an engine that has said nothing again: a deploy brings the two up in either order. */
export const TIMING_RETRY_MS = 30 * 1000;

const TIMING_PATH = '/api/v1/timing';

/**
 * THE ENGINE'S TIMES, READ FROM THE ENGINE (M1, Tidskedjan).
 *
 * Holds what GET /api/v1/timing last answered, and nothing else about the
 * engine. Three things come of it:
 *
 *  - the API's wait for a call, counted from the engine's own ceiling instead of
 *    a second number set by hand (OptimizationProxyService.callAiEngine,
 *    waitSeconds), and the probe and headroom a schemaförslag call waits for;
 *  - whether the engine can be sent a deadline in the request, so an engine
 *    older than the field is never sent it;
 *  - at start, a refusal to start in production when AI_ENGINE_TIMEOUT_MS was
 *    SET and is shorter than the engine can need, with the sentence that says
 *    which number to change.
 *
 * NOTHING HERE DEPENDS ON THE ENGINE ANSWERING. An engine that is down, that
 * is older than the route (404), or that answers something unreadable leaves
 * the cache empty, and every number falls back on the one this gateway always
 * used. The deploy brings the engine and the API up together, in either order,
 * so a start that could not read the engine is the ordinary case and not a
 * fault; only a start that READ it and found the setting wrong refuses.
 */
@Injectable()
export class EngineTimingService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(EngineTimingService.name);
  private timing: EngineTiming | null = null;
  private timer: NodeJS.Timeout | null = null;
  /** When the engine was last asked, so one that says nothing is not asked on every call. */
  private lastAttempt = 0;
  /** The notes already written, so a wait that stays short is said once and not on every call. */
  private readonly said = new Set<string>();

  constructor(
    private readonly http: HttpService,
    private readonly configService: ConfigService,
  ) {}

  private get ai(): AiEngineConfig {
    return this.configService.getOrThrow<AiEngineConfig>('aiEngine');
  }

  /** What the engine last said, or null: nothing read yet, or an engine that says nothing. */
  current(): EngineTiming | null {
    return this.timing;
  }

  /** Whether the engine said it can be sent `deadlineSeconds` in the request. */
  supportsDeadline(): boolean {
    return supportsDeadline(this.timing);
  }

  /** The generator's probe and headroom, for a schemaförslag call's wait; undefined for an engine that said nothing. */
  candidateTimes(): CandidateTimes | undefined {
    return candidateTimesOf(this.timing);
  }

  /** How long the API waits for a call to `route`, in milliseconds. */
  waitMs(route: EngineRoute | null): number {
    return waitMsFor(route, this.timing, this.ai.timeoutMs);
  }

  /**
   * Called before a call is waited for: an engine that has said nothing is asked again, at most every
   * TIMING_RETRY_MS. The API can start before the engine does (a deploy brings them up together, in
   * either order), and an API with no AI_ENGINE_TIMEOUT_MS waits by what the engine says, so an empty
   * cache after the first minute is the engine's being down or older, not a reason to wait 120 s for
   * ten minutes. Never in a test, which has no engine behind it.
   */
  async ensure(): Promise<void> {
    if (this.timing !== null) return;
    if (this.configService.get<AppConfig>('app')?.nodeEnv === NodeEnv.Test) return;
    if (Date.now() - this.lastAttempt < TIMING_RETRY_MS) return;
    await this.refresh();
  }

  /**
   * The cached times forgotten: the engine answered a request carrying a field it
   * does not know (it was rolled back to an older one), so what it said is no
   * longer true. The next read puts them back, if it can.
   */
  forget(): void {
    this.timing = null;
  }

  /**
   * One read of the engine's times. Null on any failure and never an exception: a
   * 404, a refused connection, a timeout and a body that is not the engine's all
   * mean the same thing, an engine that does not say. The cache is replaced, so
   * an engine rolled back to an older one stops being believed.
   */
  async refresh(): Promise<EngineTiming | null> {
    this.lastAttempt = Date.now();
    let body: unknown = null;
    try {
      const response = await firstValueFrom(
        this.http
          .get<unknown>(`${this.ai.baseUrl}${TIMING_PATH}`, {
            headers: { 'X-API-Key': this.ai.apiKey, Accept: 'application/json' },
            // The service key must not follow a redirect to wherever it points (callAiEngine's reason).
            maxRedirects: 0,
            timeout: TIMING_READ_MS,
          })
          .pipe(timeout(TIMING_READ_MS)),
      );
      body = response.data;
    } catch {
      // A 404 is an older engine; anything else is an engine that is not there. Same answer.
      body = null;
    }
    this.timing = parseEngineTiming(body);
    return this.timing;
  }

  /**
   * Said once per distinct sentence: the API's own wait (AI_ENGINE_TIMEOUT_MS, set) is shorter than
   * the engine can need, as a call is about to be made with it. Asked only of a call that waits by
   * the configured number: a schemaförslag call has a wait of its own, for a request of its own. The request carries its deadline, so the
   * call is answered inside the wait, with a shorter search than the engine's budget;
   * this is where an operator can read why a TIMEOUT says 94 s of a budget of 180.
   */
  noteWait(route: EngineRoute | null, waitMs: number): void {
    if (route !== 'optimize') return;
    const shortfall = waitShortfall(this.timing, this.ai.timeoutMs === undefined ? undefined : waitMs);
    if (shortfall === null || this.said.has(shortfall.sentence)) return;
    this.said.add(shortfall.sentence);
    this.logger.error(shortfall.sentence);
  }

  /**
   * The start's check. Throws, which stops the API from starting, only when the
   * engine answered AND AI_ENGINE_TIMEOUT_MS was set AND is shorter than the
   * engine can need AND this is production: the API is then down, for no service
   * in Railway has a health check, so nothing keeps the deploy before it serving
   * while this one is refused (docs/DEPLOYMENT.md §5.1), and the log says which
   * number to change. Anywhere else it is a line in the log.
   */
  async onApplicationBootstrap(): Promise<void> {
    const nodeEnv = this.configService.get<AppConfig>('app')?.nodeEnv;
    // The test suites build the app with no engine behind it, and say nothing of one.
    if (nodeEnv === NodeEnv.Test) return;

    const timing = await this.refresh();
    // Read again from now on whether or not it answered: an engine that was not up yet is the ordinary
    // case at a deploy, and the engine's variables are changed on the engine's own service, which
    // restarts alone.
    this.timer = setInterval(() => {
      void this.refresh();
    }, TIMING_REFRESH_MS);
    this.timer.unref();
    if (timing === null) {
      this.logger.warn(
        `The engine at ${this.ai.baseUrl} does not state its times (older than GET ${TIMING_PATH}, or not reachable yet): ` +
          `the API waits ${this.ai.timeoutMs ?? 'its 120000 ms fallback'} ms for a call, as it always has.`,
      );
      return;
    }

    const shortfall = waitShortfall(timing, this.ai.timeoutMs);
    if (shortfall !== null) {
      if (nodeEnv === NodeEnv.Production) throw new Error(shortfall.sentence);
      this.logger.error(shortfall.sentence);
    }
    const candidates = this.configService.get<{ maxSeconds?: number }>('candidates');
    const note = candidateBudgetNote(timing, candidates?.maxSeconds);
    if (note !== null) this.logger.warn(note);
    const ceiling = timing.routes.optimize?.ceilingSeconds;
    this.logger.log(
      `The engine says its generator waits up to ${ceiling ?? '?'} s for a solve; the API waits ${
        this.waitMs('optimize') / 1000
      } s${this.ai.timeoutMs === undefined ? ' (counted from that)' : ' (AI_ENGINE_TIMEOUT_MS)'}.`,
    );
  }

  onModuleDestroy(): void {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
  }
}
