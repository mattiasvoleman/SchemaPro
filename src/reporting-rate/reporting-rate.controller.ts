import { Body, Controller, Get, Put, Query, UseGuards } from '@nestjs/common';
import { Area } from '../auth/decorators/area.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import { Role } from '../auth/enums/role.enum';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';
import { ReportingRateQueryDto, ReportingSettingsDto } from './dto/reporting-rate.dto';
import {
  ReportingRateService,
  type MyReportingView,
  type ReportingRateView,
  type ReportingSettingsView,
} from './reporting-rate.service';

/**
 * Rapporteringsgrad (/admin/reporting-rate, and a teacher's own page).
 *
 * The school's figures and the two switches are the administrators': every
 * profile reads, and Drift writes the switches and the limit, as the
 * attendance they count. A teacher reads their own open lessons and their own
 * rate (`mine`) and nothing of anyone else's; a pupil and a guardian have no
 * route here. Row security says which rows each role reads, not this
 * controller.
 */
@Controller('api/v1/reporting-rate')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.SCHOOL_ADMIN)
@Area('DRIFT')
export class ReportingRateController {
  constructor(private readonly reportingRate: ReportingRateService) {}

  /** The school's share of lessons with a saved register, and each teacher's. Recorded in the read log. */
  @Get()
  overview(@Query() query: ReportingRateQueryDto, @CurrentUser() user: AuthenticatedUser): Promise<ReportingRateView> {
    return this.reportingRate.overview(query, user);
  }

  /** Whether the reminders and the weekly notice are on, and the limit for an open lesson. */
  @Get('settings')
  settings(@CurrentUser() user: AuthenticatedUser): Promise<ReportingSettingsView> {
    return this.reportingRate.settings(user);
  }

  @Put('settings')
  updateSettings(@Body() dto: ReportingSettingsDto, @CurrentUser() user: AuthenticatedUser): Promise<ReportingSettingsView> {
    return this.reportingRate.updateSettings(dto, user);
  }

  /** The teacher's own: lessons waiting for their register, and their share this week, month and läsår. */
  @Get('mine')
  @Roles(Role.TEACHER)
  mine(@CurrentUser() user: AuthenticatedUser): Promise<MyReportingView> {
    return this.reportingRate.mine(user);
  }
}
