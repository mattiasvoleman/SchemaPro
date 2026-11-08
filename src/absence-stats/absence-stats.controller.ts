import { Controller, Get, Param, ParseUUIDPipe, Query, UseGuards } from '@nestjs/common';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import { Role } from '../auth/enums/role.enum';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';
import {
  AbsenceStatsService,
  type ClassesView,
  type ClassPupilsView,
  type ClassStatsView,
  type PupilStatsView,
  type SchoolStatsView,
  type WindowView,
} from './absence-stats.service';
import { PeriodQueryDto } from './dto/absence-stats.dto';

const uuid = new ParseUUIDPipe({ version: '4' });

/**
 * Frånvarostatistik över tid (the "Frånvarostatistik" tab of /admin/reports, and
 * the mentor's page /teacher/absence-stats).
 *
 * Every route only reads, and every one is open to an administrator and a
 * teacher; which of them reads what is the database's question
 * (app.absence_stats_*), asked under the caller's own claims: an
 * administrator reads the school, every class and every pupil; a teacher
 * only their own mentees and classes; the huvudman's reader (an administrator
 * with no user id) the sums of the school and its classes and never a pupil.
 * A pupil, a guardian and the integrations have no route here.
 */
@Controller('api/v1/absence-stats')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.SCHOOL_ADMIN, Role.TEACHER)
export class AbsenceStatsController {
  constructor(private readonly absenceStats: AbsenceStatsService) {}

  /** The first month of the three läsår shown, the school's today and the läsår holding it. */
  @Get('window')
  window(@CurrentUser() user: AuthenticatedUser): Promise<WindowView> {
    return this.absenceStats.window(user);
  }

  /** The whole school month by month. Administrators only. */
  @Get('school')
  school(@CurrentUser() user: AuthenticatedUser): Promise<SchoolStatsView> {
    return this.absenceStats.school(user);
  }

  /** The classes, each with the sum of its months over a period. A mentor's: their own classes. */
  @Get('classes')
  classes(@Query() query: PeriodQueryDto, @CurrentUser() user: AuthenticatedUser): Promise<ClassesView> {
    return this.absenceStats.classes(query, user);
  }

  /** A class and its predecessors month by month, and its patterns. Sums: nobody is named. */
  @Get('classes/:classId')
  classView(@Param('classId', uuid) classId: string, @Query() query: PeriodQueryDto, @CurrentUser() user: AuthenticatedUser): Promise<ClassStatsView> {
    return this.absenceStats.classView(classId, query, user);
  }

  /** The pupils of a class with their sums, for a development talk. Recorded in the read log. */
  @Get('classes/:classId/pupils')
  classPupils(@Param('classId', uuid) classId: string, @Query() query: PeriodQueryDto, @CurrentUser() user: AuthenticatedUser): Promise<ClassPupilsView> {
    return this.absenceStats.classPupils(classId, query, user);
  }

  /** One pupil over three läsår, with the class and the reporting beside. Recorded in the read log. */
  @Get('pupils/:studentId')
  pupil(@Param('studentId', uuid) studentId: string, @Query() query: PeriodQueryDto, @CurrentUser() user: AuthenticatedUser): Promise<PupilStatsView> {
    return this.absenceStats.pupil(studentId, query, user);
  }
}
