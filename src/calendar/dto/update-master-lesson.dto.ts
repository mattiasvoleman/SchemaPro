import { LessonRecurrence } from '@prisma/client';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsDateString,
  IsEnum,
  IsIn,
  IsInt,
  IsOptional,
  IsUUID,
  Matches,
  Max,
  Min,
  ValidateNested,
} from 'class-validator';
import { EXEMPTABLE_RULES, type ExemptableRule } from '../lesson-exemption';

const TIME = /^\d{2}:\d{2}$/;
/** A day the way a lesson's window is told: `YYYY-MM-DD` and nothing else (a time of day after it is no part of a date). */
const DAY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * WHAT THE PAGE SAW of a lesson, for the fields its request is about to write (Säkerhetsnät, E9). Every field is optional and means "this is
 * what the page read; refuse if it is not what stands now": a field left out is not asked about, and `null` is an answer (no room, no first
 * day). The names and the forms are the request's own, so the page copies what it read onto the same keys.
 *
 * The check is of VALUES and not of a time stamp, because what a write must not do is put a value over one somebody else has changed
 * since the page read it. A colleague's change of another field, a lock set or a room given while this request moves the lesson, is not in
 * its way, and the page's own earlier writes (a drag dropped twice in a row, an undo) are what the lesson holds by then.
 */
export class ExpectedLessonDto {
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

  @IsOptional()
  @IsUUID('4')
  coTeacherId?: string | null;

  @IsOptional()
  @IsBoolean()
  isLocked?: boolean;

  @IsOptional()
  @IsBoolean()
  isParked?: boolean;

  @IsOptional()
  @IsEnum(LessonRecurrence)
  recurrence?: LessonRecurrence;

  @IsOptional()
  @Matches(DAY, { message: 'startDate must be YYYY-MM-DD.' })
  startDate?: string | null;

  @IsOptional()
  @Matches(DAY, { message: 'endDate must be YYYY-MM-DD.' })
  endDate?: string | null;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @IsUUID('4', { each: true })
  extraGroupIds?: string[];

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(200)
  @IsUUID('4', { each: true })
  studentIds?: string[];

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(EXEMPTABLE_RULES.length)
  @IsIn(EXEMPTABLE_RULES, { each: true })
  exempt?: ExemptableRule[];
}

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
  /**
   * UNDANTAG MED FLIT: the rules of the board the administrator answers yes to ("Lägg ändå") for THIS time, by name: `FRAME` (the stage's
   * ramtid) and `LUNCH` (the class's meal). Only these two can be named; a teacher, a room, a class or its pupils, a closed hour, a rule on
   * årskurser, another school's time and the school day cannot. A rule named that the time does not break is saved on nothing. A saved
   * exemption locks the lesson and is for the time it was given for. `[]` takes back what the lesson had.
   */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(EXEMPTABLE_RULES.length)
  @IsIn(EXEMPTABLE_RULES, { each: true })
  exempt?: ExemptableRule[];

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

  /**
   * SÄKERHETSNÄT (E9): what the page saw of the lesson, so that this request does not put a value over one somebody else changed since. Held to
   * the lesson as it stands, under the lesson's row lock, in the transaction of the write: a value that is not what the page read is a 409
   * LESSON_CHANGED naming the fields, and nothing is written. A request without it is written as it always was (the mobile app and an older
   * page send none).
   */
  @IsOptional()
  @ValidateNested()
  @Type(() => ExpectedLessonDto)
  expected?: ExpectedLessonDto;
}
