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

  @IsOptional()
  @IsUUID('4')
  roomId?: string | null;

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

  /**
   * Locks/unlocks the lesson. Locked lessons are treated as fixed placements
   * by the optimizer and survive regeneration untouched.
   */
  @IsOptional()
  @IsBoolean()
  isLocked?: boolean;

  /**
   * Sets the lesson aside on the grid's tray, or puts it back.
   *
   * A parked lesson occupies nothing: it is skipped by every clash check, by
   * publish, by the solver's fixed placements and by the SS12000 feed. Parking
   * therefore never conflicts; UN-parking is a placement like any other and is
   * checked like one, against the day and time sent with it.
   */
  @IsOptional()
  @IsBoolean()
  isParked?: boolean;

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
