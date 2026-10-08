import { Transform } from 'class-transformer';
import {
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  Min,
  ValidateIf,
} from 'class-validator';
import { IsCalendarDate } from '../../resources/dto/is-calendar-date';
import { MaxCodePoints } from '../../common/utils/max-code-points';

/*
 * Tillgodoräknad tid: the school's written decision that an activity on one
 * date counts as undervisningstid (migration 20261009100000).
 *
 * The bounds mirror the table's CHECKs one for one, so a value the database
 * would refuse is refused here with the field named; the CHECK is the second
 * line for a PostgREST writer, and rethrowPrismaError names the field for a
 * CHECK reached past this file all the same.
 *
 *   TimplanCredits_minutes_is_sane        1..600
 *   TimplanCredits_grade_span_is_whole    both or neither
 *   TimplanCredits_grade_span_is_ordered  0..12, min <= max
 *   TimplanCredits_scope_is_one           a group or a span, never both
 *   TimplanCredits_name_is_sane           non-blank, at most 80 code points
 *   TimplanCredits_note_is_sane           null, or non-blank and at most 500
 *
 * Non-blank is `\S`, the class the CHECK spells out; lengths are code points
 * (MaxCodePoints), as char_length counts them. The service trims what it
 * stores, and a note that is blank after trimming is stored as null: an
 * empty note field in the dialog is no note, not a refusal.
 *
 * The two-field rules (half a span, a span upside down, a group AND a span)
 * are the service's, where the 400 can carry the code TIMPLAN_CREDIT_SCOPE
 * and say which fields — as are the rules that need a row: the date inside
 * the läsår (TIMPLAN_CREDIT_OUTSIDE_YEAR) and the group of the same läsår
 * (TIMPLAN_CREDIT_GROUP_OF_ANOTHER_YEAR).
 */

const NAME = 'name: beslutet behöver ett namn, till exempel "Friluftsdag".';
const NAME_LONG = 'name: namnet kan vara högst 80 tecken.';
const NOTE_LONG = 'note: anteckningen kan vara högst 500 tecken.';
const MINUTES = 'minutes: 1 till 600 minuter för dagen, i hela minuter.';
const GRADE = (field: string) => `${field}: årskursen är 0 (förskoleklass) till 12.`;

const lower = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.toLowerCase() : value);

export class TimplanCreditsQueryDto {
  @Transform(lower)
  @IsUUID('4', { message: 'academicYearId: läsåret anges med sitt id.' })
  academicYearId!: string;
}

export class CreateTimplanCreditDto {
  @Transform(lower)
  @IsUUID('4', { message: 'academicYearId: läsåret anges med sitt id.' })
  academicYearId!: string;

  @IsCalendarDate({ message: 'date: ett riktigt datum som ÅÅÅÅ-MM-DD.' })
  date!: string;

  @IsInt({ message: MINUTES })
  @Min(1, { message: MINUTES })
  @Max(600, { message: MINUTES })
  minutes!: number;

  /** Null or absent: undervisningstid without a subject ("Utan ämne"). */
  @IsOptional()
  @Transform(lower)
  @IsUUID('4', { message: 'subjectId: ämnet anges med sitt id, eller null för inget ämne.' })
  subjectId?: string | null;

  /** The scope: a group, a grade span, or neither — the whole school. */
  @IsOptional()
  @Transform(lower)
  @IsUUID('4', { message: 'studentGroupId: gruppen anges med sitt id.' })
  studentGroupId?: string | null;

  @IsOptional()
  @IsInt({ message: GRADE('minGradeLevel') })
  @Min(0, { message: GRADE('minGradeLevel') })
  @Max(12, { message: GRADE('minGradeLevel') })
  minGradeLevel?: number | null;

  @IsOptional()
  @IsInt({ message: GRADE('maxGradeLevel') })
  @Min(0, { message: GRADE('maxGradeLevel') })
  @Max(12, { message: GRADE('maxGradeLevel') })
  maxGradeLevel?: number | null;

  @IsString({ message: NAME })
  @Matches(/\S/, { message: NAME })
  @MaxCodePoints(80, { message: NAME_LONG })
  name!: string;

  @IsOptional()
  @IsString({ message: 'note: anges som text.' })
  @MaxCodePoints(500, { message: NOTE_LONG })
  note?: string | null;
}

/**
 * A PATCH of one credit. The läsår is not in it: a decision about a day of
 * another year is another decision (delete and create).
 *
 * THE SCOPE IS ONE THING. Naming any of studentGroupId, minGradeLevel and
 * maxGradeLevel replaces the whole triple, and the ones not named become
 * null: {studentGroupId} moves a span-scoped credit to a group; {minGradeLevel,
 * maxGradeLevel} moves a group credit to a span; all three null make it the
 * whole school's. Naming none leaves the scope as it is. A half span named
 * alone ({minGradeLevel: 7}) is therefore half a span, and refused as one —
 * never silently merged with the stored other half.
 *
 * Null is refused on the NOT NULL fields (ValidateIf on `!== undefined`, as
 * the lokal timplan's DTOs do).
 */
export class UpdateTimplanCreditDto {
  @ValidateIf((_, value) => value !== undefined)
  @IsCalendarDate({ message: 'date: ett riktigt datum som ÅÅÅÅ-MM-DD.' })
  date?: string;

  @ValidateIf((_, value) => value !== undefined)
  @IsInt({ message: MINUTES })
  @Min(1, { message: MINUTES })
  @Max(600, { message: MINUTES })
  minutes?: number;

  @IsOptional()
  @Transform(lower)
  @IsUUID('4', { message: 'subjectId: ämnet anges med sitt id, eller null för inget ämne.' })
  subjectId?: string | null;

  @IsOptional()
  @Transform(lower)
  @IsUUID('4', { message: 'studentGroupId: gruppen anges med sitt id.' })
  studentGroupId?: string | null;

  @IsOptional()
  @IsInt({ message: GRADE('minGradeLevel') })
  @Min(0, { message: GRADE('minGradeLevel') })
  @Max(12, { message: GRADE('minGradeLevel') })
  minGradeLevel?: number | null;

  @IsOptional()
  @IsInt({ message: GRADE('maxGradeLevel') })
  @Min(0, { message: GRADE('maxGradeLevel') })
  @Max(12, { message: GRADE('maxGradeLevel') })
  maxGradeLevel?: number | null;

  @ValidateIf((_, value) => value !== undefined)
  @IsString({ message: NAME })
  @Matches(/\S/, { message: NAME })
  @MaxCodePoints(80, { message: NAME_LONG })
  name?: string;

  @IsOptional()
  @IsString({ message: 'note: anges som text.' })
  @MaxCodePoints(500, { message: NOTE_LONG })
  note?: string | null;
}
