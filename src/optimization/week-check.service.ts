import { randomUUID } from 'node:crypto';
import { HttpException, HttpStatus, Injectable, Logger } from '@nestjs/common';
import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';
import { PrismaService } from '../database/prisma.service';
import type {
  AiEngineConflictAnalysis,
  AiEngineScheduleRequest,
} from './interfaces/ai-engine-payload.interface';
import {
  WEEK_CHECK_SKIPPED,
  WEEK_CHECK_VERDICTS,
  type AiEngineWeekCheckResponse,
  type WeekCheckSkipped,
  type WeekCheckView,
  type WeekCheckYear,
} from './interfaces/week-check.interface';
import { OptimizationProxyService } from './optimization-proxy.service';
import { conflictView, storedOf } from './stored-conflicts';

/** The engine's quick checks on a week (optimization-engine/app/api/v1/week_check.py). */
export const WEEK_CHECK_PATH = '/api/v1/check-week';

/**
 * This call's whole wait for the engine. The check is the one thing the
 * engine answers in seconds, so it is not given Generera's minutes
 * (AI_ENGINE_TIMEOUT_MS): a check that has not answered in this long is
 * failing the one thing it is for, and the run beside it is not held for it.
 */
export const WEEK_CHECK_TIMEOUT_MS = 30_000;

/** The gateway's code for an engine that does not know the route yet. */
export const ENGINE_LACKS_WEEK_CHECK = 'ENGINE_LACKS_WEEK_CHECK';

/**
 * An engine older than Kontrollera veckan answers 404: the route is not there
 * (the request is the one Generera sends, so an older engine accepts it and
 * simply does not know where it was sent). The deploy order the contract
 * allows (the engine ships with the API, from the same merge) leaves minutes
 * in which a school meets one, and what it should read is that the function is
 * coming, not "The AI engine returned an error."
 */
function engineLacksWeekCheck(): HttpException {
  return new HttpException(
    {
      message:
        'Schemamotorn är äldre än API:t och kan inte kontrollera veckan ännu. Försök igen om några minuter.',
      code: ENGINE_LACKS_WEEK_CHECK,
    },
    HttpStatus.SERVICE_UNAVAILABLE,
  );
}

/**
 * KONTROLLERA VECKAN: ask the engine what it can say about a week without
 * searching for a timetable, in seconds.
 *
 * THE WEEK IS BUILT BY GENERERA'S OWN FETCH (OptimizationProxyService.
 * prepareSchedule, the step a schemaförslag run shares), not a copy of it: the
 * request the engine is asked is byte for byte the one a Generera would send,
 * so the check says about a week what a run would be told about it, with the
 * same staffing pre-flight and the same block judgement in front.
 *
 * WRITES NOTHING, and holds nothing: no job row, no lock, no transaction open
 * across the engine call (which is made outside it, as Generera's is). What
 * the fetch reads of a person's data (a post's days) it logs to the Läslogg as
 * Generera's does.
 *
 * AN `OK` IS NOT "A TIMETABLE EXISTS". The engine can prove a week impossible
 * and say that it is tight, never that it is possible; `skipped` says what did
 * not run.
 */
@Injectable()
export class WeekCheckService {
  private readonly logger = new Logger(WeekCheckService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly proxy: OptimizationProxyService,
  ) {}

  async check(academicYearId: string, user: AuthenticatedUser): Promise<WeekCheckView> {
    const requestId = randomUUID();
    const started = Date.now();
    this.logger.log(`Week check requested [requestId=${requestId}, academicYearId=${academicYearId}]`);

    const prepared = await this.prisma.withRls(user, (tx) =>
      this.proxy.prepareSchedule(tx, academicYearId, user, { requestId }),
    );

    if (!prepared.ready) {
      // Two blocks on the same times that no longer fit together: the refusal
      // Generera throws, as its own 400 with the sentence's code and values.
      if (prepared.error) throw prepared.error;
      // A post without a teacher, or a block partly locked: Generera answers
      // these itself, before the engine is woken, and so does the check.
      this.logger.log(
        `Week check answered by the gateway's own pre-flight (${prepared.refusalCode}) [requestId=${requestId}]`,
      );
      return {
        verdict: 'IMPOSSIBLE',
        years: [],
        // Already realised: it is the answer triggerScheduling returns as it stands.
        conflicts: this.view(prepared.refusal.conflicts ?? null),
        skipped: [],
        elapsedMs: Date.now() - started,
        checkedBy: 'GATEWAY',
      };
    }

    // Every post hand-placed: Generera skips the engine and so does this. A
    // week with nothing to place has nothing to say.
    if (prepared.payload.requirements.length === 0) {
      return {
        verdict: 'OK',
        years: [],
        conflicts: null,
        skipped: ['ENGINE'],
        elapsedMs: Date.now() - started,
        checkedBy: 'GATEWAY',
      };
    }

    // The school's saved lunch rules, as a Generera without rules of its own.
    const payload: AiEngineScheduleRequest = {
      ...prepared.payload,
      ...(prepared.storedRules ? { rules: prepared.storedRules } : {}),
    };

    let response: AiEngineWeekCheckResponse;
    try {
      response = await this.proxy.callAiEngine<AiEngineWeekCheckResponse>(
        WEEK_CHECK_PATH,
        payload,
        prepared.anonMaps,
        { timeoutMs: WEEK_CHECK_TIMEOUT_MS },
      );
    } catch (error) {
      if (error instanceof HttpException && error.getStatus() === HttpStatus.NOT_FOUND) {
        this.logger.warn(`AI engine predates the week check; ${WEEK_CHECK_PATH} answered 404.`);
        throw engineLacksWeekCheck();
      }
      throw error;
    }

    // A newer engine's verdict is one this gateway cannot say. Said as the
    // engine's failure rather than passed on to a screen with no sentence for it.
    if (!WEEK_CHECK_VERDICTS.includes(response.verdict)) {
      this.logger.error(`Week check: the engine answered a verdict this gateway does not know (${String(response.verdict)}).`);
      throw new HttpException({ message: 'The AI engine returned an error.' }, HttpStatus.BAD_GATEWAY);
    }

    const view: WeekCheckView = {
      verdict: response.verdict,
      years: (response.years ?? []).map(yearOf),
      conflicts: this.view(this.proxy.realiseConflicts(response.conflicts, prepared.anonMaps)),
      // Only what the web has a sentence for: a name a newer engine adds is
      // not a missing translation on a school's screen.
      skipped: (response.skipped ?? []).filter((name): name is WeekCheckSkipped =>
        (WEEK_CHECK_SKIPPED as readonly string[]).includes(name),
      ),
      elapsedMs: Number.isFinite(response.elapsedMs) ? response.elapsedMs : Date.now() - started,
      checkedBy: 'ENGINE',
    };
    this.logger.log(
      `Week check complete [requestId=${requestId}, verdict=${view.verdict}, years=${view.years.length}, ` +
        `skipped=${view.skipped.join(',')}, ms=${Date.now() - started}]`,
    );
    return view;
  }

  /**
   * An analysis as a reader is shown it, field by field: never spread, so a
   * field kept for the server (the ids, the teachers a days-bearing sentence
   * is about) cannot leave beside one that may. conflictView is the whitelist a
   * run's rows are read through.
   */
  private view(analysis: AiEngineConflictAnalysis | null): WeekCheckView['conflicts'] {
    if (!analysis) return null;
    return {
      summary: analysis.summary,
      summaryCode: analysis.summaryCode,
      summaryParams: analysis.summaryParams ?? {},
      conflicts: analysis.conflicts.map((detail) => conflictView(storedOf(detail))),
    };
  }
}

function yearOf(year: WeekCheckYear): WeekCheckYear {
  return {
    year: year.year ?? null,
    demandMinutes: year.demandMinutes,
    capacityMinutes: year.capacityMinutes,
    percent: year.percent,
    over: year.over === true,
  };
}
