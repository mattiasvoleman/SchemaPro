import {
  IsBoolean,
  IsInt,
  IsOptional,
  IsUUID,
  Matches,
  Max,
  Min,
  ValidateIf,
} from 'class-validator';

const TIME = /^\d{2}:\d{2}$/;

/**
 * Adjusts a single master-timetable slot. All fields are optional — only the
 * provided ones change. `roomId`/`teacherId` accept `null` to clear the
 * assignment.
 *
 * The update is validated against the rest of the master timetable (teacher,
 * room and group double-bookings, weekly availability constraints) and is
 * rejected with 409 + a conflict list when it would collide.
 */
export class UpdateMasterLessonDto {
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(7)
  dayOfWeek?: number;

  @IsOptional()
  @Matches(TIME, { message: 'startTime must be HH:MM.' })
  startTime?: string;

  @IsOptional()
  @Matches(TIME, { message: 'endTime must be HH:MM.' })
  endTime?: string;

  @ValidateIf((dto: UpdateMasterLessonDto) => dto.roomId !== null)
  @IsOptional()
  @IsUUID('4')
  roomId?: string | null;

  @ValidateIf((dto: UpdateMasterLessonDto) => dto.teacherId !== null)
  @IsOptional()
  @IsUUID('4')
  teacherId?: string | null;

  /**
   * When true (default) the change is propagated to future, still-SCHEDULED
   * calendar lessons materialized from this template that have no attendance.
   */
  @IsOptional()
  @IsBoolean()
  propagate?: boolean;
}
