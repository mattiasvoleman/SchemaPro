import { Body, Controller, Get, HttpCode, HttpStatus, Param, ParseUUIDPipe, Post, Query, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { Area } from '../auth/decorators/area.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import { Role } from '../auth/enums/role.enum';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';
import { RolesGuard } from '../auth/roles.guard';
import { StartStaffingSearchDto } from './dto/staffing-search.dto';
import type { StaffingSearchFiguresDoc, StaffingSearchView } from './interfaces/staffing-search.interface';
import { OptimizationJobsService } from './optimization-jobs.service';
import type { StaffingProposal } from './staffing-proposal.service';
import { StaffingSearchService } from './staffing-search.service';

/**
 * Föreslå bemanning: a search for the choice of teachers that eases the week (lärarval F3, staffing-search.service.ts). Its own
 * controller under the optimization prefix, as Kontrollera veckan's and the week before and after a proposal are, so that the
 * routes of a run and of a proposal are not touched by it.
 *
 * Guarded as a schemaläggare is: school administrators who write Schemaläggning (the table's own policies say the same). A search
 * reads the school as a proposal does, and writes only its own row; the proposal it gives is applied by Föreslå bemannings own
 * apply, with that route's guard, its policy and its second confirmation.
 */
@Controller('api/v1/optimization')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.SCHOOL_ADMIN)
@Area('SCHEMALAGGNING')
export class StaffingSearchController {
  constructor(
    private readonly search: StaffingSearchService,
    private readonly jobs: OptimizationJobsService,
  ) {}

  /**
   * Starts a search and answers 202 with the run's id; the page polls it. Every refusal is answered here: 409 with the code of
   * what stands in the way (no behörigheter, an active search, the week refused by Generera's own checks), and a refusal of the
   * payload as the sentence's own code and values, worded for this caller as the check's is.
   *
   * Throttled like a Generera start: the search is minutes of the engine.
   */
  @Post('staffing/search')
  @HttpCode(HttpStatus.ACCEPTED)
  @Throttle({ default: { limit: 3, ttl: 60_000 } })
  start(@Body() dto: StartStaffingSearchDto, @CurrentUser() user: AuthenticatedUser): Promise<{ runId: string }> {
    return this.search.start(dto, user).catch(async (error: unknown) => {
      throw await this.jobs.refusalForReader(error, dto.academicYearId, user);
    });
  }

  /** The year's latest search (or null), for a dialog that is opened while one is going or after one ended. */
  @Get('staffing/search/latest')
  latest(
    @Query('academicYearId', new ParseUUIDPipe({ version: '4' })) academicYearId: string,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<StaffingSearchView | null> {
    return this.search.latest(academicYearId, user);
  }

  /** One search, as the page polls it. */
  @Get('staffing/search/:id')
  one(@Param('id', new ParseUUIDPipe({ version: '4' })) id: string, @CurrentUser() user: AuthenticatedUser): Promise<StaffingSearchView> {
    return this.search.view(id, user);
  }

  /**
   * The proposal a search that has ended gives, read against the school as it is now: 409 STAFF_PROPOSAL_STALE when the
   * tjänstefördelning, the releases or the week has changed since the search read them, and 404 when it found nothing to propose.
   * An ordinary proposal: the dialog shows it as it shows any, applies it with `coversWeek`, and asks for the week before and after.
   */
  @Get('staffing/search/:id/proposal')
  proposal(
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<{ proposal: StaffingProposal; figures: StaffingSearchFiguresDoc | null }> {
    return this.search.proposal(id, user);
  }

  /** Stops a search: its task sees it within seconds and ends it CANCELLED with the best it has. The run, as it stands. */
  @Post('staffing/search/:id/cancel')
  @HttpCode(HttpStatus.OK)
  cancel(@Param('id', new ParseUUIDPipe({ version: '4' })) id: string, @CurrentUser() user: AuthenticatedUser): Promise<StaffingSearchView> {
    return this.search.cancel(id, user);
  }
}
