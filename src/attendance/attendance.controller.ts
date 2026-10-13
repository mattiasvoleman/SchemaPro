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
import { Area } from '../auth/decorators/area.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import { Role } from '../auth/enums/role.enum';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';
import {
  AttendanceService,
  AttendanceReportResult,
  AttendanceSummaryResult,
  GroupAttendanceResult,
  LessonAttendanceResult,
  LessonRosterResult,
  ReportedAbsencesResult,
} from './attendance.service';
import { ReportAttendanceDto } from './dto/report-attendance.dto';
import { AttendanceSummaryQueryDto, GroupAttendanceQueryDto } from './dto/attendance-reads.dto';

/**
 * High-performance attendance ingestion endpoint.
 *
 * ## Rate limiting
 *
 * During morning peak hours every teacher's device may submit simultaneously.
 * A per-IP + per-user throttle of 120 req / 60 s (module default) guards the
 * service, with a tighter per-route override of 10 requests per 30 s for this
 * endpoint specifically. Adjust THROTTLE_TTL_SECONDS / THROTTLE_LIMIT via env
 * to tune for your school's concurrency profile.
 *
 * The counters live in this process (WindowedThrottlerStorage), which is right
 * for a single instance. A multi-instance deployment needs a shared store:
 * AppModule sketches the Redis path, but it is not wired — setting REDIS_URL on
 * its own changes nothing.
 */
@Controller('api/v1/attendance')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.TEACHER, Role.SCHOOL_ADMIN)
@Area('DRIFT')
export class AttendanceController {
  constructor(private readonly attendanceService: AttendanceService) {}

  /**
   * `POST /api/v1/attendance/report`
   *
   * Accepts a batch of attendance records for a single calendar lesson.
   * Idempotent — safe to retry from the mobile offline queue.
   */
  @Post('report')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 10, ttl: 30_000 } })
  async report(
    @Body() dto: ReportAttendanceDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<AttendanceReportResult> {
    return this.attendanceService.reportAttendance(dto, user);
  }

  /**
   * `GET /api/v1/attendance/lessons/:lessonId/reported-absences`
   *
   * The pupils of the lesson whose absence was reported before it, for the
   * list to open with them as Anmäld frånvaro. Ids only: a teacher reads no
   * absence report, and with it no note and no type (20261015120000).
   */
  @Get('lessons/:lessonId/reported-absences')
  async reportedAbsences(
    @Param('lessonId', new ParseUUIDPipe({ version: '4' })) lessonId: string,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<ReportedAbsencesResult> {
    return this.attendanceService.reportedAbsences(lessonId, user);
  }

  /**
   * `GET /api/v1/attendance/lessons/:lessonId/roster`
   *
   * The pupils the register lists, by name: the lesson's active pupils, as
   * the one roster reader answers it for the broadcast and the notices too.
   */
  @Get('lessons/:lessonId/roster')
  async roster(
    @Param('lessonId', new ParseUUIDPipe({ version: '4' })) lessonId: string,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<LessonRosterResult> {
    return this.attendanceService.lessonRoster(lessonId, user);
  }

  /**
   * `GET /api/v1/attendance/lessons/:lessonId/records`
   *
   * The marks already recorded for the lesson, as the register opens with
   * them. The same door as the roster.
   */
  @Get('lessons/:lessonId/records')
  async lessonRecords(
    @Param('lessonId', new ParseUUIDPipe({ version: '4' })) lessonId: string,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<LessonAttendanceResult> {
    return this.attendanceService.lessonRecords(lessonId, user);
  }

  /**
   * `GET /api/v1/attendance/groups/:groupId/records?from&to`
   *
   * A class's marks over a period, for the administrator's attendance report.
   */
  @Get('groups/:groupId/records')
  @Roles(Role.SCHOOL_ADMIN)
  async groupRecords(
    @Param('groupId', new ParseUUIDPipe({ version: '4' })) groupId: string,
    @Query() query: GroupAttendanceQueryDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<GroupAttendanceResult> {
    return this.attendanceService.groupRecords(groupId, query.from, query.to, user);
  }

  /** `GET /api/v1/attendance/summary?since`: the dashboard's figure, counts only. */
  @Get('summary')
  @Roles(Role.SCHOOL_ADMIN)
  async summary(
    @Query() query: AttendanceSummaryQueryDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<AttendanceSummaryResult> {
    return this.attendanceService.summary(query.since, user);
  }
}
