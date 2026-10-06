import { SchoolForm } from '@prisma/client';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsEnum,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
  ValidateIf,
  ValidateNested,
} from 'class-validator';

/*
 * The bounds below mirror migration 20261006120000's CHECKs one for one. A
 * CHECK violation leaves the gateway as a bare 500, so the DTO is where a
 * bound names its field in Swedish; the CHECK is the second line for the
 * PostgREST writer that never meets this file.
 *
 *   LocalTimplans_name_is_sane           non-blank, at most 100 characters
 *   LocalTimplans_planningWeeks_is_sane  20.0..40.0, NUMERIC(4,1)
 *   LocalTimplans_decisionNote_is_sane   non-blank, at most 500
 *   LocalTimplanEntries_gradeLevel_is_sane      0..10
 *   LocalTimplanEntries_minutesPerWeek_is_sane  0..1200, any integer
 *   LocalTimplanEntries_note_is_sane            at most 500 (blank allowed)
 *
 * Non-blank is a pattern (`\S`) rather than IsNotEmpty, which lets "   "
 * through; the service trims what it stores, so a name is never saved with
 * the spaces a form left around it.
 */

const NAME_BLANK = 'name: timplanen behöver ett namn.';
const NAME_LONG = 'name: namnet kan vara högst 100 tecken.';
const WEEKS_SHAPE = 'planningWeeks: antalet veckor anges som ett tal med högst en decimal, till exempel 35,6.';
const WEEKS_LOW = 'planningWeeks: minst 20,0 veckor.';
const WEEKS_HIGH = 'planningWeeks: högst 40,0 veckor.';
const VERSION_ID = 'nationalTimplanVersionId: den nationella timplanen anges med sitt id.';

export class CreateLocalTimplanDto {
  @IsString({ message: NAME_BLANK })
  @Matches(/\S/, { message: NAME_BLANK })
  @MaxLength(100, { message: NAME_LONG })
  name!: string;

  @IsEnum(SchoolForm, {
    message: `schoolForm: skolformen är en av ${Object.values(SchoolForm).join(', ')}.`,
  })
  schoolForm!: SchoolForm;

  /** Must be a version of the same school form; the service checks it by name. */
  @IsUUID('4', { message: VERSION_ID })
  nationalTimplanVersionId!: string;

  /**
   * Standardveckor, default 35.6 (178 skoldagar / 5). One decimal, because the
   * column is NUMERIC(4,1) and a 35.65 would be rounded by the database into
   * a figure nobody typed.
   */
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 1, allowNaN: false, allowInfinity: false }, { message: WEEKS_SHAPE })
  @Min(20, { message: WEEKS_LOW })
  @Max(40, { message: WEEKS_HIGH })
  planningWeeks?: number;
}

/**
 * Name, weeks and version — while the plan is a DRAFT. The school form is not
 * here: changing it changes which bilaga every entry is read against, which is
 * a new plan (POST /:id/copy), not an edit.
 *
 * Null is refused on every field (ValidateIf on `!== undefined`, as the
 * subjects DTO does for countsTowardTimplan): the three columns are NOT NULL,
 * so a null could only mean "back to a default" for two of them and nothing
 * for the third.
 */
export class UpdateLocalTimplanDto {
  @ValidateIf((_, value) => value !== undefined)
  @IsString({ message: NAME_BLANK })
  @Matches(/\S/, { message: NAME_BLANK })
  @MaxLength(100, { message: NAME_LONG })
  name?: string;

  @ValidateIf((_, value) => value !== undefined)
  @IsNumber({ maxDecimalPlaces: 1, allowNaN: false, allowInfinity: false }, { message: WEEKS_SHAPE })
  @Min(20, { message: WEEKS_LOW })
  @Max(40, { message: WEEKS_HIGH })
  planningWeeks?: number;

  @ValidateIf((_, value) => value !== undefined)
  @IsUUID('4', { message: VERSION_ID })
  nationalTimplanVersionId?: string;
}

/**
 * One cell of the grid: minutes per week for a school subject in an årskurs.
 * Integer minutes and NOT on the five-minute grid — a target is not a lesson.
 * 0 is a value ("not taught this year"), not an absence.
 */
export class LocalTimplanEntryDto {
  @IsUUID('4', { message: 'subjectId: ämnet anges med sitt id.' })
  subjectId!: string;

  @IsInt({ message: 'gradeLevel: årskursen anges som ett heltal, 0 för förskoleklass.' })
  @Min(0, { message: 'gradeLevel: lägsta årskurs är 0 (förskoleklass).' })
  @Max(10, { message: 'gradeLevel: högsta årskurs är 10.' })
  gradeLevel!: number;

  @IsInt({ message: 'minutesPerWeek: minuter per vecka anges som ett heltal.' })
  @Min(0, { message: 'minutesPerWeek: minuter per vecka kan inte vara negativt.' })
  @Max(1200, { message: 'minutesPerWeek: högst 1200 minuter (20 timmar) per vecka i ett ämne.' })
  minutesPerWeek!: number;

  @IsOptional()
  @IsString({ message: 'note: anteckningen anges som text.' })
  @MaxLength(500, { message: 'note: anteckningen kan vara högst 500 tecken.' })
  note?: string | null;
}

/**
 * The plan's whole content, REPLACED wholesale — the shape of PUT
 * /student-groups/:id/members. The grid saves exactly what it shows, a
 * repeated call is idempotent, and an empty list empties the plan. 400 rows is
 * eleven årskurser × thirty-six subjects: more than any real timplan, and a
 * bound on what one request may rewrite.
 */
export class ReplaceLocalTimplanEntriesDto {
  @IsArray({ message: 'entries: posterna anges som en lista.' })
  @ArrayMaxSize(400, { message: 'entries: högst 400 poster per timplan.' })
  @ValidateNested({ each: true })
  @Type(() => LocalTimplanEntryDto)
  entries!: LocalTimplanEntryDto[];
}

/** What identifies the decision: "Beslutat av huvudman 2026-05-12, dnr …". */
export class DecideLocalTimplanDto {
  @IsString({ message: 'decisionNote: beslutet behöver en anteckning som identifierar det.' })
  @Matches(/\S/, { message: 'decisionNote: beslutet behöver en anteckning som identifierar det.' })
  @MaxLength(500, { message: 'decisionNote: anteckningen kan vara högst 500 tecken.' })
  decisionNote!: string;
}

/** The new draft's name; absent = the source's name with "(utkast)" or "(kopia)". */
export class CopyLocalTimplanDto {
  @IsOptional()
  @IsString({ message: NAME_BLANK })
  @Matches(/\S/, { message: NAME_BLANK })
  @MaxLength(100, { message: NAME_LONG })
  name?: string;
}
