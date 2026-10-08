import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsDivisibleBy,
  IsIn,
  IsInt,
  IsObject,
  IsOptional,
  IsUUID,
  Max,
  Min,
  ValidateIf,
  ValidateNested,
} from 'class-validator';
import { SLOT_MINUTES } from '../../common/solver-grid';

/*
 * POST /local-timplans/:id/generate-requirements. The lesson bounds are
 * CreateTeachingRequirementDto's (1..40 lessons, 15..240 minutes) and the
 * solver's grid (SLOT_MINUTES), so a generated row is one the requirements
 * form could have saved and the engine will accept.
 */

const lowerUuid = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.toLowerCase() : value;

const LENGTH_GRID = `minutesPerLesson: lektionslängden måste vara ett helt antal ${SLOT_MINUTES}-minutersintervall — schemaläggaren räknar i ${SLOT_MINUTES}-minuterssteg.`;

/** One previewed row the admin edited before applying. */
export class GenerateOverrideDto {
  @Transform(lowerUuid)
  @IsUUID('4', { message: 'overrides: klassen anges med sitt id (studentGroupId).' })
  studentGroupId!: string;

  @Transform(lowerUuid)
  @IsUUID('4', { message: 'overrides: ämnet anges med sitt id (subjectId).' })
  subjectId!: string;

  @IsInt({ message: 'overrides: lessonsPerWeek anges som ett heltal.' })
  @Min(1, { message: 'overrides: minst 1 lektion per vecka.' })
  @Max(40, { message: 'overrides: högst 40 lektioner per vecka.' })
  lessonsPerWeek!: number;

  @IsInt({ message: 'overrides: minutesPerLesson anges i hela minuter.' })
  @Min(15, { message: 'overrides: minst 15 minuter per lektion.' })
  @Max(240, { message: 'overrides: högst 240 minuter per lektion.' })
  @IsDivisibleBy(SLOT_MINUTES, { message: `overrides: ${LENGTH_GRID}` })
  minutesPerLesson!: number;
}

export class GenerateRequirementsDto {
  @Transform(lowerUuid)
  @IsUUID('4', { message: 'academicYearId: läsåret anges med sitt id.' })
  academicYearId!: string;

  /** The default length every proposed row gets; the dialog suggests one. */
  @IsInt({ message: 'minutesPerLesson: lektionslängden anges i hela minuter.' })
  @Min(15, { message: 'minutesPerLesson: minst 15 minuter per lektion.' })
  @Max(240, { message: 'minutesPerLesson: högst 240 minuter per lektion.' })
  @IsDivisibleBy(SLOT_MINUTES, { message: LENGTH_GRID })
  minutesPerLesson!: number;

  /**
   * What the minutes that do not fill a whole lesson become
   * (generate-requirements.ts, splitWeeklyMinutes): SPLIT meets the target
   * with up to two lengths (175 at 60 is 2 × 60 + 1 × 55), ROUND_UP adds a
   * whole lesson (3 × 60, +5). OMITTED IS ROUND_UP, the rule generate always
   * had, so a client that has never heard of the field — and every answer it
   * gets — is unchanged; the web's dialog states it. Null is refused rather
   * than read as either.
   */
  @ValidateIf((_: object, value: unknown) => value !== undefined)
  @IsIn(['SPLIT', 'ROUND_UP'], {
    message: 'remainder: anges som SPLIT (dela upp resten) eller ROUND_UP (avrunda uppåt).',
  })
  remainder?: 'SPLIT' | 'ROUND_UP';

  /**
   * Required: true answers the preview and writes nothing; false creates the
   * rows. Never defaulted — a client that forgot the field must not write.
   */
  @IsBoolean({ message: 'dryRun: anges som true (förhandsvisning) eller false (skapa).' })
  dryRun!: boolean;

  @IsOptional()
  @IsArray({ message: 'overrides: raderna anges som en lista.' })
  @ArrayMaxSize(1000, { message: 'overrides: högst 1000 rader.' })
  @IsObject({ each: true, message: 'overrides: varje rad anges som ett objekt.' })
  @ValidateNested({ each: true })
  @Type(() => GenerateOverrideDto)
  overrides?: GenerateOverrideDto[];
}
