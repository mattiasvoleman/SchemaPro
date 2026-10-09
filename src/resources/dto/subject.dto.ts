import {
  IsBoolean,
  IsHexColor,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  ValidateIf,
} from 'class-validator';

/**
 * The two timplan fields, shared by create and update.
 *
 * `nationalCode` is only checked for SHAPE here. Whether it is a code the
 * statute knows is a question for the reference table, asked by the service
 * inside the writing transaction (see national-codes.ts) and answered in
 * Swedish with the field named; a decorator holding the list would have to be
 * re-issued every time Skolverket adds an ämne. Twenty characters is the same
 * cap as `code` beside it, and the longest real code (FORDELNINGSBAR) is 14.
 *
 * `countsTowardTimplan` refuses null on purpose, where every other optional
 * here accepts it. The column is NOT NULL with a default, so there is no
 * "cleared" state for null to mean: on a PATCH it could only be read as "back
 * to the default" or as "false", and the two readings differ for exactly the
 * subjects the flag exists for (Mentorstid, Resurs). ValidateIf on
 * `!== undefined` lets an omitted field through and makes null a 400 that
 * names the field, which IsOptional would wave past.
 */
const COUNTS_MESSAGE =
  'countsTowardTimplan: om ämnet räknas som undervisningstid anges med true eller false.';

/**
 * Skola24's "Faktor ämne", read only under the policy's loadModel FACTOR. The
 * bounds are Subjects_loadFactor_is_sane's (20261010100000), and null is
 * refused for countsTowardTimplan's reason: the column is NOT NULL with a
 * default, so null has no "cleared" meaning — 1 is how a school says "the
 * minutes as they are".
 */
export const LOAD_FACTOR_MESSAGE =
  'loadFactor: faktorn är ett tal mellan 0,5 och 3 med högst tre decimaler.';

export class CreateSubjectDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  name!: string;

  @IsOptional()
  @IsString()
  @MaxLength(20)
  code?: string | null;

  @IsOptional()
  @IsHexColor()
  color?: string | null;

  /** When set, the optimizer only places this subject in rooms of this type. */
  @IsOptional()
  @IsUUID('4')
  requiredRoomTypeId?: string | null;

  /**
   * Which cell of the national timplan this subject feeds ('MA', 'SV_SVA',
   * 'BI'); null or absent means "outside the national timplan".
   */
  @IsOptional()
  @IsString()
  @MaxLength(20)
  nationalCode?: string | null;

  /** False for Resurs, Mentorstid and the like. Absent means true. */
  @ValidateIf((dto: CreateSubjectDto) => dto.countsTowardTimplan !== undefined)
  @IsBoolean({ message: COUNTS_MESSAGE })
  countsTowardTimplan?: boolean;

  /** The subject's Faktor, 0.5..3 with at most three decimals. Absent means 1. */
  @ValidateIf((dto: CreateSubjectDto) => dto.loadFactor !== undefined)
  @IsNumber({ maxDecimalPlaces: 3, allowNaN: false, allowInfinity: false }, { message: LOAD_FACTOR_MESSAGE })
  @Min(0.5, { message: LOAD_FACTOR_MESSAGE })
  @Max(3, { message: LOAD_FACTOR_MESSAGE })
  loadFactor?: number;
}

export class UpdateSubjectDto {
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  name?: string;

  @IsOptional()
  @IsString()
  @MaxLength(20)
  code?: string | null;

  @IsOptional()
  @IsHexColor()
  color?: string | null;

  @IsOptional()
  @IsUUID('4')
  requiredRoomTypeId?: string | null;

  /** Null clears the mapping; absent leaves it as it is. */
  @IsOptional()
  @IsString()
  @MaxLength(20)
  nationalCode?: string | null;

  @ValidateIf((dto: UpdateSubjectDto) => dto.countsTowardTimplan !== undefined)
  @IsBoolean({ message: COUNTS_MESSAGE })
  countsTowardTimplan?: boolean;

  /** Absent leaves the factor as it is. */
  @ValidateIf((dto: UpdateSubjectDto) => dto.loadFactor !== undefined)
  @IsNumber({ maxDecimalPlaces: 3, allowNaN: false, allowInfinity: false }, { message: LOAD_FACTOR_MESSAGE })
  @Min(0.5, { message: LOAD_FACTOR_MESSAGE })
  @Max(3, { message: LOAD_FACTOR_MESSAGE })
  loadFactor?: number;
}
