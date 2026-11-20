import { randomUUID } from 'node:crypto';
import { HttpException, HttpStatus, Injectable, Logger, NotFoundException } from '@nestjs/common';
import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';
import { fromNioarig, type GradeNumbering } from '../common/grade-numbering';
import { PrismaService } from '../database/prisma.service';
import type { StaffingWeekDto } from './dto/staffing-week.dto';
import type { AiEngineScheduleRequest } from './interfaces/ai-engine-payload.interface';
import type {
  StaffingWeekOverlay,
  StaffingWeekReason,
  StaffingWeekView,
  StaffingWeekYear,
} from './interfaces/staffing-week.interface';
import { WEEK_CHECK_VERDICTS, type AiEngineWeekCheckResponse } from './interfaces/week-check.interface';
import type { ChoiceCount } from './interfaces/week-check-choice.interface';
import { OptimizationProxyService, type AnonMaps } from './optimization-proxy.service';
import { StaffingProposalService, stale } from './staffing-proposal.service';
import { MAX_YEARS_SHOWN, compareCounts, isWorse, overlayLeads, weekBasisOf, withWeekBasis, yearsToShow, type PayloadIds } from './staffing-week';
import { countOf } from './week-check-choice';
import { realisedAnswerOf } from './week-check-choice.service';
import { WEEK_CHECK_PATH, WEEK_CHECK_TIMEOUT_MS } from './week-check.service';
import type { PeriodStretch } from './year-periods';

/**
 * The whole question's wait, from the request: the week as it stands and the week with the proposal, each a /check-week
 * of up to the week load's four seconds. Under the web's own wait (web/lib/staffing-week.ts), and no second check is begun
 * that could not finish inside it: a school whose checks are slow gets the first and is told so.
 */
export const STAFFING_WEEK_BUDGET_MS = 30_000;

/** The least time left that the second check is begun in: its four seconds and the payload's own checks around them. */
export const STAFFING_WEEK_MIN_CALL_MS = 6_000;

/** What the transaction reads, so that no engine call is made inside it (as Generera's is not). */
type Read =
  | { ready: false; reason: StaffingWeekReason }
  | {
      ready: true;
      payload: AiEngineScheduleRequest;
      anonMaps: AnonMaps;
      ids: PayloadIds;
      stretches: PeriodStretch[][] | null;
      numbering: GradeNumbering;
      /** The proposal's basis and the week's together: what an apply carries when this figure was shown. */
      basisSha256: string;
    };

/**
 * FÖRESLÅ BEMANNING: THE WEEK BEFORE AND AFTER A PROPOSAL, asked of the engine's own check (staffing-week.ts says what is
 * asked and why a figure is set beside another only where the engine's rules allow it).
 *
 * ITS OWN ROUTE, NOT PART OF THE PROPOSAL. The proposal answers in the engine's ten seconds and is what the dialog is
 * for; this is two more checks, asked for by the dialog once the proposal is on the screen and again when the admin
 * changes what is selected. A figure that could not be made is an answer (`NOT_CHECKED`), never an error: the proposal
 * and its apply go on without it.
 *
 * THE PROPOSAL MUST STILL BE THE CURRENT ONE. The request carries the proposal's basis, and a tjänstefördelning that has
 * moved since is the apply's own refusal (409 STAFF_PROPOSAL_STALE): the digest this route returns for an apply to carry
 * is built from that basis and the week's, so it could not otherwise stand for the proposal the admin was looking at.
 *
 * WRITES NOTHING, holds nothing across an engine call, and names no person: the teachers stay anonymous in the engine,
 * and what leaves is years, figures and the dates of a period.
 */
@Injectable()
export class StaffingWeekService {
  private readonly logger = new Logger(StaffingWeekService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly proxy: OptimizationProxyService,
    private readonly staffing: StaffingProposalService,
  ) {}

  async check(dto: StaffingWeekDto, user: AuthenticatedUser): Promise<StaffingWeekView> {
    const requestId = randomUUID();
    const started = Date.now();
    const deadline = started + STAFFING_WEEK_BUDGET_MS;
    this.logger.log(
      `Staffing week requested [requestId=${requestId}, academicYearId=${dto.academicYearId}, changes=${dto.changes.length}]`,
    );

    const given = dto.changes.length;
    let calls = 0;
    const notChecked = (reason: StaffingWeekReason, overlay?: StaffingWeekOverlay): StaffingWeekView => ({
      status: 'NOT_CHECKED',
      reason,
      years: [],
      verdicts: null,
      worse: false,
      basisSha256: null,
      overlay: overlay ?? { given, laidOver: 0, notLaidOver: given, fromNobody: 0, newToTheWeek: 0 },
      calls,
      elapsedMs: Date.now() - started,
    });
    // Nothing selected: the week is as it stands, and there is neither a proposal to compare nor a week to fetch for it.
    if (given === 0) return notChecked('NO_CHANGES');

    const read = await this.read(dto, user, requestId);
    if (!read.ready) return notChecked(read.reason);

    const laid = overlayLeads(read.payload, dto.changes, read.ids);
    // Nothing of the selection is in the week the engine is asked about: the week after is the week before.
    if (laid.overlay.laidOver === 0) return notChecked('NO_CHANGES', laid.overlay);

    // The engine, asked twice and one after the other: the week as it stands, then with the proposal. Each answer is
    // counted by what the engine said of the very payload it was sent, so the two figures are made in this call.
    const ask = async (sent: AiEngineScheduleRequest): Promise<AiEngineWeekCheckResponse | 'OLDER' | null> => {
      const remaining = deadline - Date.now();
      calls += 1;
      try {
        const response = await this.proxy.callAiEngine<AiEngineWeekCheckResponse>(WEEK_CHECK_PATH, sent, read.anonMaps, {
          timeoutMs: Math.min(WEEK_CHECK_TIMEOUT_MS, Math.max(remaining, STAFFING_WEEK_MIN_CALL_MS)),
        });
        // An answer this gateway cannot read (a newer engine's verdict, no years): left out, as a failure.
        return response && Array.isArray(response.years) && Array.isArray(response.skipped) && WEEK_CHECK_VERDICTS.includes(response.verdict)
          ? response
          : null;
      } catch (error) {
        if (error instanceof HttpException && error.getStatus() === HttpStatus.NOT_FOUND) {
          this.logger.warn('AI engine predates the week check; the staffing week was not checked.');
          return 'OLDER';
        }
        this.logger.warn(
          `Staffing week: a check failed and the figure is left out [requestId=${requestId}]: ${
            error instanceof HttpException ? error.getStatus() : 'error'
          }`,
        );
        return null;
      }
    };

    const before = await ask(read.payload);
    if (before === 'OLDER') return notChecked('ENGINE_OLDER', laid.overlay);
    if (before === null) return notChecked('ENGINE_ERROR', laid.overlay);
    if (deadline - Date.now() < STAFFING_WEEK_MIN_CALL_MS) return notChecked('TOO_SLOW', laid.overlay);
    const after = await ask(laid.payload);
    if (after === 'OLDER') return notChecked('ENGINE_OLDER', laid.overlay);
    if (after === null) return notChecked('ENGINE_ERROR', laid.overlay);

    const countFor = (response: AiEngineWeekCheckResponse, payload: AiEngineScheduleRequest, year: number): ChoiceCount =>
      countOf(response, year, realisedAnswerOf(this.proxy, response, read.anonMaps), payload.requirements, read.stretches);
    const heaviest = (year: number): number =>
      Math.max(
        ...[before, after].map((response) => response.years.find((row) => row.year === year)?.percent ?? 0),
      );
    // Every year the changes touch, and the heaviest of them shown: the warning is about all of them, so a year that is
    // tighter after the proposal is not left out of it because six heavier ones fit on the screen.
    const touched = yearsToShow(
      before.years.map((row) => row.year),
      after.years.map((row) => row.year),
      laid.years,
      heaviest,
      Number.POSITIVE_INFINITY,
    );
    const counted: StaffingWeekYear[] = touched.map((year) => {
      const was = countFor(before, read.payload, year);
      const is = countFor(after, laid.payload, year);
      return { year: fromNioarig(year, read.numbering) ?? year, before: was, after: is, verdict: compareCounts(was, is) };
    });
    const years = counted.slice(0, MAX_YEARS_SHOWN);
    // The engine refuses the whole week after the proposal and did not before, whether or not it names a year.
    const refusedNow = after.verdict === 'IMPOSSIBLE' && before.verdict !== 'IMPOSSIBLE';
    const view: StaffingWeekView = {
      status: 'DONE',
      years,
      verdicts: { before: before.verdict, after: after.verdict },
      worse: refusedNow || counted.some((year) => isWorse(year.verdict)),
      basisSha256: read.basisSha256,
      overlay: laid.overlay,
      calls,
      elapsedMs: Date.now() - started,
    };
    this.logger.log(
      `Staffing week complete [requestId=${requestId}, years=${years.length}, worse=${view.worse}, ` +
        `laidOver=${laid.overlay.laidOver}/${given}, calls=${calls}, ms=${Date.now() - started}]`,
    );
    return view;
  }

  /**
   * The proposal still current, the week as Generera would send it, and what the digest of both is, read in one
   * transaction so that the three agree. A year the school has not got is a 404, as the other proposals say it.
   */
  private async read(dto: StaffingWeekDto, user: AuthenticatedUser, requestId: string): Promise<Read> {
    return this.prisma.withRls(user, async (tx) => {
      const year = await tx.academicYear.findUnique({
        where: { id: dto.academicYearId },
        select: { id: true, gradeNumbering: true },
      });
      if (!year) throw new NotFoundException('Academic year not found.');
      const numbering: GradeNumbering = year.gradeNumbering === 'TIOARIG' ? 'TIOARIG' : 'NIOARIG';

      const staffingBasis = await this.staffing.currentBasis(tx, user, dto.academicYearId);
      // A proposal that covers the week itself (a search's) carries the tjänstefördelning's digest and the week's together, so it is
      // compared once the week is read, below; every other proposal carries the tjänstefördelning's alone.
      if (dto.coversWeek !== true && staffingBasis !== dto.basisSha256) throw stale();

      // The week as a Generera would be sent it, with the posts nobody teaches in it as they are: the question is about
      // them, so a school whose policy refuses to generate with posts unstaffed is asked about too.
      const prepared = await this.proxy.prepareSchedule(tx, dto.academicYearId, user, {
        requestId,
        skipUnstaffedRefusal: true,
      });
      // Two blocks on the same times that no longer fit, a block partly locked: Generera's own refusals, and the check's.
      if (!prepared.ready) return { ready: false, reason: 'NOT_READY' } as const;
      // Every post hand-placed: nothing is sent to the engine, and nothing to ask.
      if (prepared.payload.requirements.length === 0) return { ready: false, reason: 'NO_POSTS' } as const;

      const basisSha256 = withWeekBasis(staffingBasis, weekBasisOf(prepared.basisParts));
      // The proposal's basis covers the week: it holds only while the tjänstefördelning, the releases and the week are as they were.
      if (dto.coversWeek === true && basisSha256 !== dto.basisSha256) throw stale();
      return {
        ready: true,
        // The school's saved lunch rules, as the check sends them (WeekCheckService.check).
        payload: { ...prepared.payload, ...(prepared.storedRules ? { rules: prepared.storedRules } : {}) },
        anonMaps: prepared.anonMaps,
        ids: { requirementOf: prepared.anonMaps.requirementAnonMap, teacherOf: prepared.teacherAnonMap },
        stretches: prepared.periodStretches,
        numbering,
        basisSha256,
      } as const;
    });
  }
}
