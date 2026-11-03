import { SchoolForm } from '@prisma/client';
import { Transform, Type } from 'class-transformer';
import { MaxCodePoints } from '../../common/utils/max-code-points';
import {
  ArrayMaxSize,
  IsArray,
  IsEnum,
  IsInt,
  IsNumber,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
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
 *   LocalTimplans_gradeSpan_is_a_pair    gradeFrom and gradeTo, or neither
 *   LocalTimplans_gradeSpan_is_sane      0..11 and gradeFrom <= gradeTo (20261219090000)
 *   LocalTimplanEntries_gradeLevel_is_sane      0..11 (20261126090000)
 *   LocalTimplanEntries_minutesPerWeek_is_sane  0..1200, any integer
 *   LocalTimplanEntries_note_is_sane            at most 500 (blank allowed)
 *
 * Non-blank is a pattern (`\S`) rather than IsNotEmpty, which lets "   "
 * through; the service trims what it stores, so a name is never saved with
 * the spaces a form left around it. The CHECK spells out the same class of
 * blanks JavaScript's \s has. Lengths are code points (MaxCodePoints), as
 * char_length counts them, not MaxLength's count, which drops variation
 * selectors and let a 200-code-point name through to a 500.
 */

const NAME_BLANK = 'name: timplanen behöver ett namn.';
const NAME_LONG = 'name: namnet kan vara högst 100 tecken.';
const WEEKS_SHAPE = 'planningWeeks: antalet veckor anges som ett tal med högst en decimal, till exempel 35,6.';
const WEEKS_LOW = 'planningWeeks: minst 20,0 veckor.';
const WEEKS_HIGH = 'planningWeeks: högst 40,0 veckor.';
const VERSION_ID = 'nationalTimplanVersionId: den nationella timplanen anges med sitt id.';
const GRADE_SHAPE = 'gradeFrom och gradeTo: årskurserna anges som heltal, 0 för förskoleklass.';
const GRADE_LOW = 'gradeFrom och gradeTo: lägsta årskurs är 0 (förskoleklass).';
const GRADE_HIGH = 'gradeFrom och gradeTo: högsta årskurs är 11.';

/*
 * The plan's årskurs span is two optional integers. `null` is a value, not an
 * absence: both null is "the whole school form" (and, on an update or a copy,
 * "clear the span"); both absent is "say nothing". Whether the pair is whole
 * and in order, and whether it holds any årskurs of the plan's lydelse, needs
 * both fields and the version, so it is the service's (readGradeSpan).
 */

export class CreateLocalTimplanDto {
  @IsString({ message: NAME_BLANK })
  @Matches(/\S/, { message: NAME_BLANK })
  @MaxCodePoints(100, { message: NAME_LONG })
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

  /**
   * The årskurser the plan is for, in the numbering of its lydelse; both or
   * neither (the service refuses half a pair and an inverted one by name).
   * Absent or null: the whole school form.
   */
  @IsOptional()
  @IsInt({ message: GRADE_SHAPE })
  @Min(0, { message: GRADE_LOW })
  @Max(11, { message: GRADE_HIGH })
  gradeFrom?: number | null;

  @IsOptional()
  @IsInt({ message: GRADE_SHAPE })
  @Min(0, { message: GRADE_LOW })
  @Max(11, { message: GRADE_HIGH })
  gradeTo?: number | null;
}

/**
 * Name, weeks and version — while the plan is a DRAFT. The school form is not
 * here: changing it changes which bilaga every entry is read against, which is
 * a new plan (POST /local-timplans), not an edit. Not a copy either: POST
 * /:id/copy keeps the source's school form (CopyLocalTimplanDto has a name
 * only).
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
  @MaxCodePoints(100, { message: NAME_LONG })
  name?: string;

  @ValidateIf((_, value) => value !== undefined)
  @IsNumber({ maxDecimalPlaces: 1, allowNaN: false, allowInfinity: false }, { message: WEEKS_SHAPE })
  @Min(20, { message: WEEKS_LOW })
  @Max(40, { message: WEEKS_HIGH })
  planningWeeks?: number;

  @ValidateIf((_, value) => value !== undefined)
  @IsUUID('4', { message: VERSION_ID })
  nationalTimplanVersionId?: string;

  /**
   * The årskurs span of a DRAFT; absent leaves it, both null clears it. A
   * DECIDED plan takes a span here once, from none, and nothing else with it
   * (the service names the one change it admits, the trigger of 20261219090000
   * holds it).
   */
  @IsOptional()
  @IsInt({ message: GRADE_SHAPE })
  @Min(0, { message: GRADE_LOW })
  @Max(11, { message: GRADE_HIGH })
  gradeFrom?: number | null;

  @IsOptional()
  @IsInt({ message: GRADE_SHAPE })
  @Min(0, { message: GRADE_LOW })
  @Max(11, { message: GRADE_HIGH })
  gradeTo?: number | null;
}

/**
 * One cell of the grid: minutes per week for a school subject in an årskurs.
 * Integer minutes and NOT on the five-minute grid — a target is not a lesson.
 * 0 is a value ("not taught this year"), not an absence.
 */
export class LocalTimplanEntryDto {
  /**
   * Lower-cased: IsUUID and PostgreSQL accept capitals, but the service keys
   * the subjects it found, and the cells it checks for duplicates, by the
   * text — so "9E27…" was reported as not in the school, and the same cell in
   * two cases escaped the duplicate check.
   */
  @Transform(({ value }) => (typeof value === 'string' ? value.toLowerCase() : value))
  @IsUUID('4', { message: 'subjectId: ämnet anges med sitt id.' })
  subjectId!: string;

  @IsInt({ message: 'gradeLevel: årskursen anges som ett heltal, 0 för förskoleklass.' })
  @Min(0, { message: 'gradeLevel: lägsta årskurs är 0 (förskoleklass).' })
  @Max(11, { message: 'gradeLevel: högsta årskurs är 11.' })
  gradeLevel!: number;

  @IsInt({ message: 'minutesPerWeek: minuter per vecka anges som ett heltal.' })
  @Min(0, { message: 'minutesPerWeek: minuter per vecka kan inte vara negativt.' })
  @Max(1200, { message: 'minutesPerWeek: högst 1200 minuter (20 timmar) per vecka i ett ämne.' })
  minutesPerWeek!: number;

  @IsOptional()
  @IsString({ message: 'note: anteckningen anges som text.' })
  @MaxCodePoints(500, { message: 'note: anteckningen kan vara högst 500 tecken.' })
  note?: string | null;
}

/**
 * The most cells one plan holds: the entries PUT's cap, and the timplan
 * import's per file AND per plan (an import adds without deleting, so it
 * checks the plan's size after the file, not only the file's).
 */
export const LOCAL_TIMPLAN_MAX_ENTRIES = 400;

/**
 * The plan's whole content, REPLACED wholesale — the shape of PUT
 * /student-groups/:id/members. The grid saves exactly what it shows, a
 * repeated call is idempotent, and an empty list empties the plan. 400 rows is
 * eleven årskurser × thirty-six subjects: more than any real timplan, and a
 * bound on what one request may rewrite.
 */
export class ReplaceLocalTimplanEntriesDto {
  @IsArray({ message: 'entries: posterna anges som en lista.' })
  @ArrayMaxSize(LOCAL_TIMPLAN_MAX_ENTRIES, { message: `entries: högst ${LOCAL_TIMPLAN_MAX_ENTRIES} poster per timplan.` })
  // ValidateNested descends into an inner array and validates ITS elements,
  // so [[cell]] — or 401 cells wrapped in one list — passed the pipe and
  // reached the service as entries without a subjectId (a 500). Each element
  // must itself be an object.
  @IsObject({ each: true, message: 'entries: varje post anges som ett objekt.' })
  @ValidateNested({ each: true })
  @Type(() => LocalTimplanEntryDto)
  entries!: LocalTimplanEntryDto[];
}

/** What identifies the decision: "Beslutat av huvudman 2026-05-12, dnr …". */
export class DecideLocalTimplanDto {
  @IsString({ message: 'decisionNote: beslutet behöver en anteckning som identifierar det.' })
  @Matches(/\S/, { message: 'decisionNote: beslutet behöver en anteckning som identifierar det.' })
  @MaxCodePoints(500, { message: 'decisionNote: anteckningen kan vara högst 500 tecken.' })
  decisionNote!: string;
}

/**
 * The new draft's name; absent = the source's name with "(utkast)" or
 * "(kopia)". The span: absent copies the source's, both null makes the draft
 * for the whole form, two årskurser give it that span (a plan decided before
 * the span existed has none to copy, and reopening it is the moment to give
 * it one).
 */
export class CopyLocalTimplanDto {
  @IsOptional()
  @IsString({ message: NAME_BLANK })
  @Matches(/\S/, { message: NAME_BLANK })
  @MaxCodePoints(100, { message: NAME_LONG })
  name?: string;

  @IsOptional()
  @IsInt({ message: GRADE_SHAPE })
  @Min(0, { message: GRADE_LOW })
  @Max(11, { message: GRADE_HIGH })
  gradeFrom?: number | null;

  @IsOptional()
  @IsInt({ message: GRADE_SHAPE })
  @Min(0, { message: GRADE_LOW })
  @Max(11, { message: GRADE_HIGH })
  gradeTo?: number | null;
}
