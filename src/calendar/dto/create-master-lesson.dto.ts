import { LessonRecurrence } from '@prisma/client';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsDateString,
  IsEnum,
  IsInt,
  IsOptional,
  IsUUID,
  Matches,
  Max,
  Min,
} from 'class-validator';

const TIME = /^\d{2}:\d{2}$/;

/**
 * Manually adds a lesson to the master timetable (independent of the AI
 * optimizer). The new slot is validated against the rest of the timetable
 * (teacher/room/group double-bookings, weekly availability constraints) and is
 * rejected with 409 + a conflict list when it would collide.
 */
export class CreateMasterLessonDto {
  @IsUUID('4')
  academicYearId!: string;

  @IsUUID('4')
  subjectId!: string;

  @IsUUID('4')
  studentGroupId!: string;

  @IsOptional()
  @IsUUID('4')
  teacherId?: string | null;

  /**
   * The second teacher of a co-taught lesson.
   *
   * Absent from both DTOs until now, so a co-taught lesson could be created and
   * updated but never with its second teacher — and undoing a delete, which
   * recreates through this route, dropped it silently. Only the solver's own
   * write-back set the column, and it bypasses this validator entirely.
   */
  @IsOptional()
  @IsUUID('4')
  coTeacherId?: string | null;

  @IsOptional()
  @IsUUID('4')
  roomId?: string | null;

  @IsInt()
  @Min(1)
  @Max(7)
  dayOfWeek!: number;

  @Matches(TIME, { message: 'startTime must be HH:MM.' })
  startTime!: string;

  @Matches(TIME, { message: 'endTime must be HH:MM.' })
  endTime!: string;

  /** Manually placed lessons are often meant to stay put — lock on create. */
  @IsOptional()
  @IsBoolean()
  isLocked?: boolean;

  /**
   * Which weeks the lesson runs. Alternating weeks are anchored to ISO week
   * numbers — "udda veckor" — because that is what a school tells its
   * students and it reads the same whenever anyone checks.
   */
  @IsOptional()
  @IsEnum(LessonRecurrence)
  recurrence?: LessonRecurrence;

  /** First date the lesson runs; omit for "from the start of the year". */
  @IsOptional()
  @IsDateString({ strict: true })
  startDate?: string | null;

  /** Last date the lesson runs; omit for "until the year ends". */
  @IsOptional()
  @IsDateString({ strict: true })
  endDate?: string | null;


  /** Additional classes attending this lesson (beyond the primary group). */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @IsUUID('4', { each: true })
  extraGroupIds?: string[];

  /** Individual participating students (electives across classes). */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(200)
  @IsUUID('4', { each: true })
  studentIds?: string[];
}
