import { Body, Controller, Get, Put, Query, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { AnyAdministrator, Decides } from '../auth/decorators/area.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import { Role } from '../auth/enums/role.enum';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';
import { FreeQueryDto, GridQueryDto, SchoolDaySettingsDto } from './dto/school-day.dto';
import { SchoolDayService } from './school-day.service';
import { PER_ADDRESS, SchoolDayThrottlerGuard } from './school-day-throttler.guard';
import type { FreeView, SchoolDaySettingsView, SchoolDayView } from './school-day.types';

/**
 * Skolans dag i ett svep (/admin/school-day, and a teacher's page when the
 * school opens one). Every route here reads; the one write is the school's
 * decision about its teachers' share, made by those who decide.
 *
 * Every administrator reads, whatever the profile: the läsare and the
 * huvudman's reader included, since nothing here writes. A teacher reads what
 * SchoolDaySettings.teacherView gives them, and the service answers 403
 * (SCHOOL_DAY_NOT_OPEN) while it says NONE. A pupil and a guardian have no
 * route: the class guard stops them before the service. Row security says
 * which rows each role reads, not this controller.
 */
@Controller('api/v1/school-day')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.SCHOOL_ADMIN, Role.TEACHER)
@AnyAdministrator('Reads only; the one write, the teachers\' share, is Decides.')
export class SchoolDayController {
  constructor(private readonly schoolDay: SchoolDayService) {}

  /**
   * The day or the week: lessons, bookings, closures and the rows, from `from` to `to`. A week of a large school
   * is built in the API process and weighs up to 2 MB, and every teacher the school lets in reads it, so it is
   * limited to 30 a minute per login (SchoolDayThrottlerGuard). Not per address: the web asks from each person's
   * browser, and a school's staff share one. The global guard keeps a high ceiling per address instead.
   */
  @Get()
  @UseGuards(SchoolDayThrottlerGuard)
  @Throttle({ default: PER_ADDRESS })
  grid(@Query() query: GridQueryDto, @CurrentUser() user: AuthenticatedUser): Promise<SchoolDayView> {
    return this.schoolDay.grid(query, user);
  }

  /** Who and what is free over an interval of a date, by the rules the Vikarietavla uses. Limited as the grid is. */
  @Get('free')
  @UseGuards(SchoolDayThrottlerGuard)
  @Throttle({ default: PER_ADDRESS })
  free(@Query() query: FreeQueryDto, @CurrentUser() user: AuthenticatedUser): Promise<FreeView> {
    return this.schoolDay.free(query, user);
  }

  /** What a teacher has of Skolans dag; every member of staff may ask, a teacher to know whether to show the page. */
  @Get('settings')
  settings(@CurrentUser() user: AuthenticatedUser): Promise<SchoolDaySettingsView> {
    return this.schoolDay.settings(user);
  }

  @Put('settings')
  @Roles(Role.SCHOOL_ADMIN)
  @Decides()
  updateSettings(@Body() dto: SchoolDaySettingsDto, @CurrentUser() user: AuthenticatedUser): Promise<SchoolDaySettingsView> {
    return this.schoolDay.updateSettings(dto, user);
  }
}
