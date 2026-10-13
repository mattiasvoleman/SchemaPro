import { Matches } from 'class-validator';

const DATE = /^\d{4}-\d{2}-\d{2}$/;

/** GET /api/v1/attendance/groups/:groupId/records: the lessons dated from..to, both included. */
export class GroupAttendanceQueryDto {
  @Matches(DATE, { message: 'from must be YYYY-MM-DD.' })
  from!: string;

  @Matches(DATE, { message: 'to must be YYYY-MM-DD.' })
  to!: string;
}

/** GET /api/v1/attendance/summary: records made on or after this day (00:00 UTC). */
export class AttendanceSummaryQueryDto {
  @Matches(DATE, { message: 'since must be YYYY-MM-DD.' })
  since!: string;
}
