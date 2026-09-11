import { BreakKind } from '@prisma/client';
import {
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import { IsCalendarDate } from './is-calendar-date';

/**
 * Lov och studiedagar: a named, inclusive range of whole days the school is
 * not teaching.
 *
 * Both dates are required, unlike a teaching requirement's optional period. A
 * lov with an open end is not a lov, it is the school closing indefinitely,
 * and the column is NOT NULL for the same reason. A single day is
 * `startDate === endDate`.
 */
export class CreateSchoolBreakDto {
  @IsUUID('4')
  academicYearId!: string;

  /**
   * What the school calls it. Trimmed and non-empty is a CHECK on the table;
   * repeated here so the answer names the field instead of arriving as a raw
   * constraint violation, which `rethrowPrismaError` has no mapping for and
   * which therefore leaves as a 500.
   */
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  name!: string;

  @IsOptional()
  @IsEnum(BreakKind)
  kind?: BreakKind;

  /**
   * `@IsCalendarDate` rather than `@IsDateString`, for the reasons that
   * decorator's own module spells out: the column is a DATE with no room for a
   * time of day, and a bare shape check lets 2026-02-30 through to be silently
   * rolled over to 2026-03-02 — which for a lov means a week of lessons
   * deleted one day off from the week the admin meant.
   */
  @IsCalendarDate()
  startDate!: string;

  /** Inclusive: the last day the school is closed, not the day it reopens. */
  @IsCalendarDate()
  endDate!: string;

  /**
   * Narrows the break to a span of years — prao for åk 9, a studiedag for the
   * lower ones. Both null (or both omitted) means the whole school, which is
   * what a lov almost always is; the table CHECKs that it is all or nothing.
   *
   * Same 0-12 bounds as an availability constraint's GRADE_LEVEL span, and
   * deliberately the same shape: a year is a property of a group's members, so
   * there is no row to point at and the pair has to carry itself.
   */
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(12)
  minGradeLevel?: number | null;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(12)
  maxGradeLevel?: number | null;
}

/**
 * Every field optional, and `undefined` means "leave it" while an explicit
 * `null` on the grade pair means "make it school-wide again" — the same
 * distinction the requirement DTOs make for their period, and the service
 * keeps it. The academic year is absent on purpose: moving a lov to another
 * läsår is not an edit, it is a different lov, and allowing it would let the
 * range escape the year it was validated against by changing the other side.
 */
export class UpdateSchoolBreakDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  name?: string;

  @IsOptional()
  @IsEnum(BreakKind)
  kind?: BreakKind;

  @IsOptional()
  @IsCalendarDate()
  startDate?: string;

  @IsOptional()
  @IsCalendarDate()
  endDate?: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(12)
  minGradeLevel?: number | null;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(12)
  maxGradeLevel?: number | null;
}
