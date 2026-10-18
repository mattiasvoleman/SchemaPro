import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Area } from '../auth/decorators/area.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import { Role } from '../auth/enums/role.enum';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';
import { TriggerOptimizationDto } from './dto/trigger-optimization.dto';
import { ApplyRoomChangesDto, RoomProposalDto } from './dto/room-optimization.dto';
import { ApplyStaffingDto, StaffingProposalDto } from './dto/staffing-proposal.dto';
import { ApplyCandidateDto, StartCandidatesDto } from './dto/schedule-candidates.dto';
import { OptimizationProxyService } from './optimization-proxy.service';
import {
  RoomOptimizationService,
  type RoomApplyResult,
  type RoomProposal,
} from './room-optimization.service';
import {
  StaffingProposalService,
  type StaffingApplyResult,
  type StaffingProposal,
} from './staffing-proposal.service';
import {
  OptimizationJobsService,
  type OptimizationJobView,
} from './optimization-jobs.service';
import {
  ScheduleCandidatesService,
  type CandidateApplyOutcome,
  type CandidateCheck,
  type CandidateLessonView,
  type CandidatesOverview,
} from './schedule-candidates.service';
import type { AiEngineScheduleResponse } from './interfaces/ai-engine-payload.interface';

/**
 * Exposes the scheduling optimization trigger exclusively to school
 * administrators. No PII ever passes through this endpoint — the proxy service
 * strips everything before forwarding to the AI engine.
 *
 * SYSTEM_ADMIN used to be listed here too, but the platform role deliberately
 * has no `Users` row (see Role in ../auth/enums/role.enum.ts) while every
 * policy behind these routes admits only `SCHOOL_ADMIN` in the caller's own
 * tenant. Such a token got past the guard and then read nothing and wrote
 * nothing — an advertised capability that could not work. Cross-tenant
 * operation needs explicit tenant delegation, not a role on the decorator.
 */
@Controller('api/v1/optimization')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.SCHOOL_ADMIN)
@Area('SCHEMALAGGNING', 'DRIFT')
export class OptimizationController {
  constructor(
    private readonly proxy: OptimizationProxyService,
    private readonly jobsService: OptimizationJobsService,
    private readonly rooms: RoomOptimizationService,
    private readonly staffing: StaffingProposalService,
    private readonly candidates: ScheduleCandidatesService,
  ) {}

  /**
   * Starts an asynchronous scheduling run and returns a job id the UI polls.
   */
  @Post('jobs')
  @HttpCode(HttpStatus.ACCEPTED)
  @Throttle({ default: { limit: 3, ttl: 60_000 } })
  startJob(
    @Body() dto: TriggerOptimizationDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<{ jobId: string }> {
    return this.jobsService.start(dto.academicYearId, user, dto.weights, dto.rules);
  }

  /** Latest optimization runs for an academic year (run history). */
  @Get('jobs')
  listJobs(
    @Query('academicYearId', new ParseUUIDPipe({ version: '4' }))
    academicYearId: string,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<OptimizationJobView[]> {
    return this.jobsService.list(academicYearId, user);
  }

  /** Returns live status + result (solver status, conflicts) for a job. */
  @Get('jobs/:id')
  getJob(
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<OptimizationJobView> {
    return this.jobsService.get(id, user);
  }

  /**
   * Synchronous trigger kept for scripted/CI use. Blocks until the solver
   * responds; prefer `POST /jobs` from interactive clients.
   */
  @Post('trigger')
  @HttpCode(HttpStatus.ACCEPTED)
  @Throttle({ default: { limit: 3, ttl: 60_000 } })
  async trigger(
    @Body() dto: TriggerOptimizationDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<{ status: AiEngineScheduleResponse['status']; lessonsGenerated: number }> {
    // Same body as POST /jobs, so the same tuning has to reach the solver.
    // Dropping it silently produced a schedule under the school's stored rules
    // while the caller believed their own had been applied.
    //
    // A refusal is thrown on as the engine's sentence, and one about a post's
    // days is worded for this caller first, as a stored run is for its
    // reader: the hidden sentence without HR-läs, the post's days read back
    // with it (work-days.ts). Every other error goes on untouched.
    const result = await this.proxy
      .triggerScheduling(dto.academicYearId, user, dto.weights ?? null, dto.rules ?? null)
      .catch(async (error: unknown) => {
        throw await this.jobsService.refusalForReader(error, dto.academicYearId, user);
      });
    return { status: result.status, lessonsGenerated: result.lessons.length };
  }

  /**
   * A salsoptimering of the grundschema, as a proposal: the times stay where
   * they are and only rooms move, so teachers (or classes) stop walking
   * between floors and buildings for no reason. Writes nothing.
   *
   * Throttled like the other routes that wake the solver, a little looser:
   * a school comparing "lärarna", "klasserna" and "båda" asks three times in
   * a row, and each ask is capped at the engine's ten seconds.
   */
  @Post('rooms/proposal')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  proposeRooms(
    @Body() dto: RoomProposalDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<RoomProposal> {
    return this.rooms.propose(dto, user);
  }

  /**
   * Applies a proposal — and, with its changes reversed, undoes one. Refused
   * with 409 ROOM_PROPOSAL_STALE when the grundschema has changed since the
   * basis was computed. No solver call, so the limit only guards the database.
   */
  @Post('rooms/apply')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  applyRooms(
    @Body() dto: ApplyRoomChangesDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<RoomApplyResult> {
    return this.rooms.apply(dto, user);
  }

  /**
   * Bemanningsförslag: who should lead every timplanspost, as a proposal.
   * Writes nothing. Loads and targets are HR figures, so this stays behind the
   * class-level SCHOOL_ADMIN like everything here — a TEACHER is refused at the
   * guard, before the year is read or the engine woken. Throttled like the
   * room proposal: each ask is capped at the engine's ten seconds.
   */
  @Post('staffing/proposal')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  proposeStaffing(
    @Body() dto: StaffingProposalDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<StaffingProposal> {
    return this.staffing.propose(dto, user);
  }

  /**
   * Applies a proposal (or the rows the admin kept selected) — and, with the
   * changes swapped and `undo: true`, undoes one. Refused with 409
   * STAFF_PROPOSAL_STALE when the tjänstefördelning has changed since the basis
   * was computed, and judged as one write by the school's staffing policy.
   */
  @Post('staffing/apply')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Area('SCHEMALAGGNING', 'PLANERING')
  applyStaffing(
    @Body() dto: ApplyStaffingDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<StaffingApplyResult> {
    return this.staffing.apply(dto, user);
  }

  /**
   * Schemaförslag: a run of two to four candidates of the year's grundschema,
   * solved in the background one after another, each its own emphasis.
   * Writes only the candidate tables — never the grundschema — so it names
   * SCHEMALAGGNING alone. Throttled like Generera's own start: a run is up to
   * four solves.
   *
   * 409 CANDIDATES_RUNNING, GENERATE_RUNNING, CANDIDATES_BUSY or
   * CANDIDATES_NEED_A_DRAFT, and 404 REFRESH_GONE for a refresh of a batch
   * that is gone; see ScheduleCandidatesService.start.
   */
  @Post('candidates')
  @HttpCode(HttpStatus.ACCEPTED)
  @Throttle({ default: { limit: 3, ttl: 60_000 } })
  @Area('SCHEMALAGGNING')
  startCandidates(
    @Body() dto: StartCandidatesDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<{ runId: string }> {
    return this.candidates.start(dto, user);
  }

  /**
   * The year's newest run and newest batch, polled by the page while a run
   * is going. No basis is rebuilt here; that is the check below.
   */
  @Get('candidates')
  listCandidates(
    @Query('academicYearId', new ParseUUIDPipe({ version: '4' }))
    academicYearId: string,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<CandidatesOverview> {
    return this.candidates.overview(academicYearId, user);
  }

  /**
   * Whether a batch still fits the draft, which parts changed if not, and
   * the mode an apply must name. One rebuild of Generera's fetch per call,
   * hence the limit; the page reads it once per batch.
   */
  @Get('candidates/runs/:runId/check')
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  checkCandidates(
    @Param('runId', new ParseUUIDPipe({ version: '4' })) runId: string,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<CandidateCheck> {
    return this.candidates.check(runId, user);
  }

  /** One candidate's lessons in the MasterLesson shape, resolved from their timplansposter now. */
  @Get('candidates/:id/lessons')
  candidateLessons(
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<CandidateLessonView[]> {
    return this.candidates.lessons(id, user);
  }

  /**
   * Applies a candidate: the draft is replaced exactly as Generera replaces
   * it, after a safety version. The class's areas, SCHEMALAGGNING and DRIFT,
   * because in DIRECT the write also takes the replaced lessons off the
   * calendar, as Generera's does. No solver call, so the room apply's limit.
   * 409 PUBLISH_MODE_CHANGED, SCHEDULE_CANDIDATE_BUSY, _NOT_APPLICABLE or
   * _STALE (with the basis parts that changed); see the service.
   */
  @Post('candidates/:id/apply')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  applyCandidate(
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Body() dto: ApplyCandidateDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<CandidateApplyOutcome> {
    return this.candidates.apply(id, dto.expectedMode, user);
  }

  /**
   * Removes the year's finished runs, and asks an active one to stop; it is
   * never deleted under its task. Candidate tables only: SCHEMALAGGNING.
   */
  @Delete('candidates')
  @HttpCode(HttpStatus.NO_CONTENT)
  @Area('SCHEMALAGGNING')
  discardCandidates(
    @Query('academicYearId', new ParseUUIDPipe({ version: '4' }))
    academicYearId: string,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<void> {
    return this.candidates.discard(academicYearId, user);
  }
}
