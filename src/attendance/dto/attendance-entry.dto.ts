import { IsEnum, IsOptional, IsString, IsUUID, MaxLength } from 'class-validator';
import { AttendanceStatus } from '@prisma/client';

/**
 * A single attendance record within a batch report. The `studentId` is the
 * opaque UUID — no names or other PII are accepted in this payload.
 */
export class AttendanceEntryDto {
  @IsUUID('4', { message: 'studentId must be a valid UUIDv4.' })
  studentId!: string;

  @IsEnum(AttendanceStatus, {
    message: `status must be one of: ${Object.values(AttendanceStatus).join(', ')}`,
  })
  status!: AttendanceStatus;

  @IsOptional()
  @IsString()
  @MaxLength(500, { message: 'note must not exceed 500 characters.' })
  note?: string;
}
