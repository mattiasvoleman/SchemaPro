import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Post,
  UseGuards,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import { Role } from '../auth/enums/role.enum';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';
import { AttendanceService, AttendanceReportResult } from './attendance.service';
import { ReportAttendanceDto } from './dto/report-attendance.dto';

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
}
