import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import { Role } from '../auth/enums/role.enum';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';
import { PrintTimetablesQueryDto, TimetableValidityQueryDto } from './dto/print.dto';
import { PrintTimetablesService, type PrintSet, type WeekValidity } from './print-timetables.service';

/**
 * Utskrift (20261102090000).
 *
 *   GET print/timetables   the admin's set: every class's, teacher's or
 *                          room's published week, one sheet each. Throttled
 *                          like a preview (a set is a few hundred lessons).
 *   GET timetable-validity the periods a week is valid for, for whoever
 *                          prints a week of their own: a pupil, a guardian,
 *                          a teacher, the admin.
 */
@Controller('api/v1')
@UseGuards(JwtAuthGuard, RolesGuard)
export class PrintController {
  constructor(private readonly print: PrintTimetablesService) {}

  @Get('print/timetables')
  @Roles(Role.SCHOOL_ADMIN)
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  timetables(@Query() query: PrintTimetablesQueryDto, @CurrentUser() user: AuthenticatedUser): Promise<PrintSet> {
    return this.print.timetables(query, user);
  }

  @Get('timetable-validity')
  @Roles(Role.SCHOOL_ADMIN, Role.TEACHER, Role.STUDENT, Role.GUARDIAN)
  validity(@Query() query: TimetableValidityQueryDto, @CurrentUser() user: AuthenticatedUser): Promise<WeekValidity> {
    return this.print.validity(query, user);
  }
}
