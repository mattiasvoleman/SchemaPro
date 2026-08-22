import {
  IsEnum,
  IsISO8601,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
} from 'class-validator';
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

  /**
   * When the teacher actually marked this, if it was marked offline.
   *
   * A batch can sit in the device queue for a day. Stamping the server's clock
   * on arrival puts the whole class in the register at one instant, hours after
   * the lesson ended, and the register is what an absence follow-up is read
   * from. Absent — an online report — the server's clock is right and is used.
   */
  @IsOptional()
  @IsISO8601({ strict: true }, { message: 'recordedAt must be an ISO-8601 instant.' })
  recordedAt?: string;
}
