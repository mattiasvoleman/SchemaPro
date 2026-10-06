import { LessonRecurrence } from '@prisma/client';
import {
  IsEnum,
  IsInt,
  IsOptional,
  IsUUID,
  Max,
  Min,
} from 'class-validator';
import { IsCalendarDate } from './is-calendar-date';

export class CreateTeachingRequirementDto {
  @IsUUID('4')
  academicYearId!: string;

  @IsUUID('4')
  subjectId!: string;

  @IsUUID('4')
  studentGroupId!: string;

  @IsOptional()
  @IsUUID('4')
  teacherId?: string | null;

  /** Optional second teacher scheduled together with the lead (co-teaching). */
  @IsOptional()
  @IsUUID('4')
  coTeacherId?: string | null;

  /**
   * How much of the row each teacher is CHARGED in the tjänstefördelning,
   * 0..200 % — Skola24's "Justera längd för lärare (%)". 100 is the whole
   * row; a co-teacher counted at half writes 50 here, a lab session that
   * costs its teacher double writes 200. It moves no lesson: the solver never
   * sees it (optimization-proxy.service.ts sends lessons × minutes, not
   * what a teacher is charged for them), and lektionsminuter stay what the
   * pupils sit through. Omitted is 100, the column's default, so a client
   * that has never heard of the field writes the row it always wrote.
   *
   * 0..200 mirrors TeachingRequirements_*_load_percent_is_sane, so the
   * number the table would refuse is refused here with the field named.
   */
  @IsOptional()
  @IsInt({ message: 'teacherLoadPercent: anges som ett heltal i procent.' })
  @Min(0, { message: 'teacherLoadPercent: kan inte vara negativ.' })
  @Max(200, { message: 'teacherLoadPercent: högst 200 %.' })
  teacherLoadPercent?: number;

  @IsOptional()
  @IsInt({ message: 'coTeacherLoadPercent: anges som ett heltal i procent.' })
  @Min(0, { message: 'coTeacherLoadPercent: kan inte vara negativ.' })
  @Max(200, { message: 'coTeacherLoadPercent: högst 200 %.' })
  coTeacherLoadPercent?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(40)
  lessonsPerWeek?: number;

  @IsOptional()
  @IsInt()
  @Min(15)
  @Max(240)
  minutesPerLesson?: number;

  /**
   * Minutes the PUPILS are occupied before the lesson, and after it: ombyte
   * before idrotten, dusch and ombyte after it.
   *
   * Outside the lesson, not part of it — `minutesPerLesson` keeps its number
   * and the timplan keeps its hours, while the class is unavailable for the
   * lesson plus both buffers. Only the children: the teacher may take the slot
   * on either side, and the sal stands empty while the class is in the
   * omklädningsrummet. See the schema for why the corridor's argument against
   * padding both ends does not reach these two.
   *
   * 0..60 mirrors the CHECK constraints on the columns, so a number the
   * database would refuse is refused here instead — with the field named.
   */
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(60)
  minutesBefore?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(60)
  minutesAfter?: number;

  /**
   * Which weeks the subject is read over. Said once here and inherited by
   * every lesson generated from the requirement, instead of once per lesson in
   * the master timetable after the lessons already exist.
   */
  @IsOptional()
  @IsEnum(LessonRecurrence)
  recurrence?: LessonRecurrence;

  /**
   * First date the subject is read; null or omitted means "from the start of
   * the academic year". With `endDate` this is a term-only subject.
   *
   * A plain YYYY-MM-DD rather than `@IsDateString`, which also passes a full
   * instant. The column is a DATE, so the time of day has nowhere to go — the
   * master-lesson DTOs take the instant and silently slice it off, and a
   * caller who sent one deserves to hear that it was ignored.
   *
   * `@IsCalendarDate` rather than a bare shape match: the shape alone let
   * 2026-02-30 through, and everything downstream rolled it to 2026-03-02
   * without a word (see is-calendar-date.ts).
   */
  @IsOptional()
  @IsCalendarDate()
  startDate?: string | null;

  /** Last date the subject is read; null or omitted runs it to the year's end. */
  @IsOptional()
  @IsCalendarDate()
  endDate?: string | null;
}

export class UpdateTeachingRequirementDto {
  @IsOptional()
  @IsUUID('4')
  teacherId?: string | null;

  @IsOptional()
  @IsUUID('4')
  coTeacherId?: string | null;

  /** What each teacher is charged, 0..200 %; see the create DTO. */
  @IsOptional()
  @IsInt({ message: 'teacherLoadPercent: anges som ett heltal i procent.' })
  @Min(0, { message: 'teacherLoadPercent: kan inte vara negativ.' })
  @Max(200, { message: 'teacherLoadPercent: högst 200 %.' })
  teacherLoadPercent?: number;

  @IsOptional()
  @IsInt({ message: 'coTeacherLoadPercent: anges som ett heltal i procent.' })
  @Min(0, { message: 'coTeacherLoadPercent: kan inte vara negativ.' })
  @Max(200, { message: 'coTeacherLoadPercent: högst 200 %.' })
  coTeacherLoadPercent?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(40)
  lessonsPerWeek?: number;

  @IsOptional()
  @IsInt()
  @Min(15)
  @Max(240)
  minutesPerLesson?: number;

  /** Pupil buffers around the lesson; see the create DTO for what they mean. */
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(60)
  minutesBefore?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(60)
  minutesAfter?: number;

  @IsOptional()
  @IsEnum(LessonRecurrence)
  recurrence?: LessonRecurrence;

  /**
   * Null clears the bound back to "the academic year's own start"; omitting it
   * leaves whatever the row already carries. Same distinction `teacherId` has
   * always made, and the service keeps it — a PATCH that only moves `endDate`
   * must not quietly wipe the start of the period.
   */
  @IsOptional()
  @IsCalendarDate()
  startDate?: string | null;

  @IsOptional()
  @IsCalendarDate()
  endDate?: string | null;
}
