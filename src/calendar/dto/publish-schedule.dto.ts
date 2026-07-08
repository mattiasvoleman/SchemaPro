import { IsOptional, IsUUID, Matches } from 'class-validator';

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Publishes the master timetable for an academic year by materializing dated
 * `CalendarLessons`. The optional date window is clamped to the academic
 * year; when omitted the whole remaining year (from today) is published.
 */
export class PublishScheduleDto {
  @IsUUID('4')
  academicYearId!: string;

  @IsOptional()
  @Matches(ISO_DATE, { message: 'fromDate must be YYYY-MM-DD.' })
  fromDate?: string;

  @IsOptional()
  @Matches(ISO_DATE, { message: 'toDate must be YYYY-MM-DD.' })
  toDate?: string;
}
