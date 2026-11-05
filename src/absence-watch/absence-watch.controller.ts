import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, ParseUUIDPipe, Post, Put, Query, UseGuards } from '@nestjs/common';
import { Area } from '../auth/decorators/area.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import { Role } from '../auth/enums/role.enum';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';
import {
  AbsenceWatchService,
  type AbsenceWatchFindingsView,
  type AbsenceWatchLimitView,
  type AbsenceWatchOverview,
} from './absence-watch.service';
import {
  AbsenceWatchFiguresDto,
  AbsenceWatchFindingsQueryDto,
  AbsenceWatchLimitDto,
  AbsenceWatchSettingsDto,
} from './dto/absence-watch.dto';

/**
 * Frånvarobevakning (/admin/absence-watch, and the findings view of mentors
 * and guardians).
 *
 * The switch and the limits are the administrators' and Drift writes them, as
 * the attendance and the leave they count are. The findings are read by three
 * roles, each the rows its own arm admits (row security says which, not this
 * controller); a teacher who mentors nobody, or a guardian whose school sets
 * no limit for guardians, is handed an empty list.
 */
@Controller('api/v1/absence-watch')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.SCHOOL_ADMIN)
@Area('DRIFT')
export class AbsenceWatchController {
  constructor(private readonly absenceWatch: AbsenceWatchService) {}

  /** The switch, the cadences and the limits. */
  @Get()
  overview(@CurrentUser() user: AuthenticatedUser): Promise<AbsenceWatchOverview> {
    return this.absenceWatch.overview(user);
  }

  @Put('settings')
  updateSettings(@Body() dto: AbsenceWatchSettingsDto, @CurrentUser() user: AuthenticatedUser): Promise<AbsenceWatchOverview> {
    return this.absenceWatch.updateSettings(dto, user);
  }

  @Post('limits')
  createLimit(@Body() dto: AbsenceWatchLimitDto, @CurrentUser() user: AuthenticatedUser): Promise<AbsenceWatchLimitView> {
    return this.absenceWatch.createLimit(dto, user);
  }

  @Put('limits/:id')
  updateLimit(
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Body() dto: AbsenceWatchFiguresDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<AbsenceWatchLimitView> {
    return this.absenceWatch.updateLimit(id, dto, user);
  }

  @Delete('limits/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  async deleteLimit(@Param('id', new ParseUUIDPipe({ version: '4' })) id: string, @CurrentUser() user: AuthenticatedUser): Promise<void> {
    await this.absenceWatch.deleteLimit(id, user);
  }

  /** The pupils over a limit, and since when. Recorded in the read log. */
  @Get('findings')
  @Roles(Role.SCHOOL_ADMIN, Role.TEACHER, Role.GUARDIAN)
  findings(@Query() query: AbsenceWatchFindingsQueryDto, @CurrentUser() user: AuthenticatedUser): Promise<AbsenceWatchFindingsView> {
    return this.absenceWatch.findings(query, user);
  }
}
