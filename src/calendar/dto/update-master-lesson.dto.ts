import {
  ArrayMaxSize,
  IsArray,
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
   * Locks/unlocks the lesson. Locked lessons are treated as fixed placements
   * by the optimizer and survive regeneration untouched.
   */
  @IsOptional()
  @IsBoolean()
  isLocked?: boolean;

  /**
   * When true (default) the change is propagated to future, still-SCHEDULED
   * calendar lessons materialized from this template that have no attendance.
   */
  @IsOptional()
  @IsBoolean()
  propagate?: boolean;

  /** Replaces the additional-classes list when provided. */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @IsUUID('4', { each: true })
  extraGroupIds?: string[];

  /** Replaces the individual-participants list when provided. */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(200)
  @IsUUID('4', { each: true })
  studentIds?: string[];
}
