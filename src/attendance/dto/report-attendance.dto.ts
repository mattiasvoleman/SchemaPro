import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsUUID,
  ValidateNested,
} from 'class-validator';
import { AttendanceEntryDto } from './attendance-entry.dto';

/**
 * Batch attendance report submitted by a teacher's mobile device.
 *
 * `calendarLessonId` identifies the concrete lesson instance, and
 * `records` contains one entry per student. The service validates that the
 * calling teacher is actually assigned to the lesson before writing any rows.
 */
export class ReportAttendanceDto {
  @IsUUID('4', { message: 'calendarLessonId must be a valid UUIDv4.' })
  calendarLessonId!: string;

  @IsArray()
  @ArrayMinSize(1, { message: 'records must contain at least one entry.' })
  @ArrayMaxSize(200, { message: 'records must not exceed 200 entries per batch.' })
  @ValidateNested({ each: true })
  @Type(() => AttendanceEntryDto)
  records!: AttendanceEntryDto[];
}
