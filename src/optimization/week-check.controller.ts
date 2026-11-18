import { Body, Controller, HttpCode, HttpStatus, Post, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { Area } from '../auth/decorators/area.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import { Role } from '../auth/enums/role.enum';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';
import { RolesGuard } from '../auth/roles.guard';
import { WeekCheckDto } from './dto/week-check.dto';
import type { WeekCheckView } from './interfaces/week-check.interface';
import { OptimizationJobsService } from './optimization-jobs.service';
import { WeekCheckService } from './week-check.service';

/**
 * Kontrollera veckan: what the engine's quick checks find out about the week
 * before Generera is run. Its own controller, under the optimization prefix,
 * so that the routes of a run (OptimizationController) are not touched by it.
 *
 * Guarded exactly as the routes it sits beside are: school administrators with
 * Schemaläggning or Drift (see OptimizationController for why SYSTEM_ADMIN is
 * not listed). The check reads the school as a Generera does, so it needs what
 * a Generera needs; it writes nothing.
 */
@Controller('api/v1/optimization')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.SCHOOL_ADMIN)
@Area('SCHEMALAGGNING', 'DRIFT')
export class WeekCheckController {
  constructor(
    private readonly weekCheck: WeekCheckService,
    private readonly jobs: OptimizationJobsService,
  ) {}

  /**
   * The week as Generera would send it, asked about instead of solved. 200,
   * not 202: there is nothing running to be polled.
   *
   * Throttled looser than the routes that wake the solver (three a minute):
   * this one answers in seconds and a school changing a rule and asking again
   * asks several times in a row, but each ask reads the whole year, so it is
   * not unlimited.
   *
   * A refusal of the payload (the engine's 400, "locked lessons leave 7A no
   * lunch break") leaves as the sentence's own code and values, and one about
   * a post's days is worded for this caller first, as `trigger` does.
   */
  @Post('week-check')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  check(@Body() dto: WeekCheckDto, @CurrentUser() user: AuthenticatedUser): Promise<WeekCheckView> {
    return this.weekCheck.check(dto.academicYearId, user).catch(async (error: unknown) => {
      throw await this.jobs.refusalForReader(error, dto.academicYearId, user);
    });
  }
}
