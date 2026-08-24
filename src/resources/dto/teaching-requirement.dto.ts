import { LessonRecurrence } from '@prisma/client';
import {
  IsEnum,
  IsInt,
  IsOptional,
  IsUUID,
  Max,
  Min,
  ValidateIf,
} from 'class-validator';
import { IsCalendarDate } from './is-calendar-date';

export class CreateTeachingRequirementDto {
  @IsUUID('4')
  academicYearId!: string;

  @IsUUID('4')
  subjectId!: string;

  @IsUUID('4')
  studentGroupId!: string;

  @ValidateIf((dto: CreateTeachingRequirementDto) => dto.teacherId !== null)
  @IsOptional()
  @IsUUID('4')
  teacherId?: string | null;

  /** Optional second teacher scheduled together with the lead (co-teaching). */
  @ValidateIf((dto: CreateTeachingRequirementDto) => dto.coTeacherId !== null)
  @IsOptional()
  @IsUUID('4')
  coTeacherId?: string | null;

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
  @ValidateIf((dto: CreateTeachingRequirementDto) => dto.startDate !== null)
  @IsOptional()
  @IsCalendarDate()
  startDate?: string | null;

  /** Last date the subject is read; null or omitted runs it to the year's end. */
  @ValidateIf((dto: CreateTeachingRequirementDto) => dto.endDate !== null)
  @IsOptional()
  @IsCalendarDate()
  endDate?: string | null;
}

export class UpdateTeachingRequirementDto {
  @ValidateIf((dto: UpdateTeachingRequirementDto) => dto.teacherId !== null)
  @IsOptional()
  @IsUUID('4')
  teacherId?: string | null;

  @ValidateIf((dto: UpdateTeachingRequirementDto) => dto.coTeacherId !== null)
  @IsOptional()
  @IsUUID('4')
  coTeacherId?: string | null;

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

  @IsOptional()
  @IsEnum(LessonRecurrence)
  recurrence?: LessonRecurrence;

  /**
   * Null clears the bound back to "the academic year's own start"; omitting it
   * leaves whatever the row already carries. Same distinction `teacherId` has
   * always made, and the service keeps it — a PATCH that only moves `endDate`
   * must not quietly wipe the start of the period.
   */
  @ValidateIf((dto: UpdateTeachingRequirementDto) => dto.startDate !== null)
  @IsOptional()
  @IsCalendarDate()
  startDate?: string | null;

  @ValidateIf((dto: UpdateTeachingRequirementDto) => dto.endDate !== null)
  @IsOptional()
  @IsCalendarDate()
  endDate?: string | null;
}
