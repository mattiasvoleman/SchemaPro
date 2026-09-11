import {
  Body,
  Controller,
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
import { Roles } from '../auth/decorators/roles.decorator';
import { Role } from '../auth/enums/role.enum';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';
import { TriggerOptimizationDto } from './dto/trigger-optimization.dto';
import { ApplyRoomChangesDto, RoomProposalDto } from './dto/room-optimization.dto';
import { OptimizationProxyService } from './optimization-proxy.service';
import {
  RoomOptimizationService,
  type RoomApplyResult,
  type RoomProposal,
} from './room-optimization.service';
import {
  OptimizationJobsService,
  type OptimizationJobView,
} from './optimization-jobs.service';
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
export class OptimizationController {
  constructor(
    private readonly proxy: OptimizationProxyService,
    private readonly jobsService: OptimizationJobsService,
    private readonly rooms: RoomOptimizationService,
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
    const result = await this.proxy.triggerScheduling(
      dto.academicYearId,
      user,
      dto.weights ?? null,
      dto.rules ?? null,
    );
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
}
