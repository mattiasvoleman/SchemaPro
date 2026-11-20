import { Body, Controller, HttpCode, HttpStatus, Post, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { Area } from '../auth/decorators/area.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import { Role } from '../auth/enums/role.enum';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';
import { RolesGuard } from '../auth/roles.guard';
import { StaffingWeekDto } from './dto/staffing-week.dto';
import type { StaffingWeekView } from './interfaces/staffing-week.interface';
import { OptimizationJobsService } from './optimization-jobs.service';
import { StaffingWeekService } from './staffing-week.service';

/**
 * Föreslå bemanning: the week before and after a proposal (staffing-week.ts). Its own controller, under the optimization
 * prefix, as Kontrollera veckan's is, so that the routes of a run and of a proposal are not touched by it.
 *
 * Guarded exactly as the proposal it belongs to is: school administrators with Schemaläggning or Drift. It reads the
 * school as a Generera does and the staffing as a proposal does; it writes nothing.
 */
@Controller('api/v1/optimization')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.SCHOOL_ADMIN)
@Area('SCHEMALAGGNING', 'DRIFT')
export class StaffingWeekController {
  constructor(
    private readonly week: StaffingWeekService,
    private readonly jobs: OptimizationJobsService,
  ) {}

  /**
   * The week as it stands and with the selected part of a proposal laid over it, each asked of the engine's own check.
   * 200 with `NOT_CHECKED` when no figure could be made (the dialog goes on without one); 409 STAFF_PROPOSAL_STALE when
   * the tjänstefördelning has moved since the proposal's basis was computed, as an apply's is.
   *
   * Two checks of the engine for a request, asked again when the selection changes, so throttled between the
   * week check's ten a minute and the proposal's five: six.
   *
   * A refusal of the payload leaves as the sentence's own code and values, and one about a post's days is worded for this
   * caller first, as the check's is.
   */
  @Post('staffing/proposal/week')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 6, ttl: 60_000 } })
  weekOfProposal(@Body() dto: StaffingWeekDto, @CurrentUser() user: AuthenticatedUser): Promise<StaffingWeekView> {
    return this.week.check(dto, user).catch(async (error: unknown) => {
      throw await this.jobs.refusalForReader(error, dto.academicYearId, user);
    });
  }
}
