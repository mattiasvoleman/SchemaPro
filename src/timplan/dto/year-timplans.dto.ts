import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsInt,
  IsObject,
  IsUUID,
  Max,
  Min,
  ValidateIf,
  ValidateNested,
} from 'class-validator';

/*
 * The year dialog's "Timplan per årskurs". gradeLevel mirrors the CHECK
 * AcademicYearTimplans_gradeLevel_is_sane (0..10) of migration 20261007130000,
 * so the CHECK stays the PostgREST writer's line and this one names the field.
 */

/** One årskurs: the plan it follows, or null for none. */
export class YearTimplanDto {
  @IsInt({ message: 'gradeLevel: årskursen anges som ett heltal, 0 för förskoleklass.' })
  @Min(0, { message: 'gradeLevel: lägsta årskurs är 0 (förskoleklass).' })
  @Max(10, { message: 'gradeLevel: högsta årskurs är 10.' })
  gradeLevel!: number;

  /**
   * Required, and null is a value: "this årskurs follows no plan" deletes the
   * row. Absent is not null — a form that forgot the field must not empty a
   * grade by omission. Lower-cased like every id the timplan DTOs key on.
   */
  @Transform(({ value }) => (typeof value === 'string' ? value.toLowerCase() : value))
  @ValidateIf((_, value) => value !== null)
  @IsUUID('4', {
    message: 'localTimplanId: den lokala timplanen anges med sitt id, eller null för ingen.',
  })
  localTimplanId!: string | null;
}

/**
 * The year's whole mapping, REPLACED wholesale like a plan's entries: a grade
 * absent from the list, or present with null, follows no plan afterwards. At
 * most the eleven årskurser the column admits.
 */
export class ReplaceYearTimplansDto {
  @IsArray({ message: 'timplans: årskurserna anges som en lista.' })
  @ArrayMaxSize(11, { message: 'timplans: högst elva årskurser (0–10).' })
  @IsObject({ each: true, message: 'timplans: varje årskurs anges som ett objekt.' })
  @ValidateNested({ each: true })
  @Type(() => YearTimplanDto)
  timplans!: YearTimplanDto[];
}
