import { Transform, Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsString, Max, MaxLength, Min, MinLength, ValidateIf } from 'class-validator';
import {
  MAX_MONTHS,
  MIN_MONTHS,
  RETENTION_DATA_TYPES,
  RETENTION_DECISIONS,
  type RetentionDataTypeValue,
  type RetentionDecisionValue,
} from '../retention';

const trimmed = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);
const blankIsAbsent = ({ value }: { value: unknown }) =>
  typeof value === 'string' && value.trim() === '' ? undefined : trimmed({ value });

/*
 * The CHECKs of 20261021110000, where a field can say them: months 1..120 on
 * a period and nowhere else (RetentionDecisions_a_period_has_months), a
 * reference of at most 200 characters. One kind per decision: the page saves
 * one row at a time.
 */

export class RetentionDecisionDto {
  @IsIn(RETENTION_DATA_TYPES)
  dataType!: RetentionDataTypeValue;

  @IsIn(RETENTION_DECISIONS)
  decision!: RetentionDecisionValue;

  /** Required with PURGE_AFTER, refused with anything else. */
  @ValidateIf((dto: RetentionDecisionDto) => dto.decision === 'PURGE_AFTER' || dto.months !== undefined)
  @Type(() => Number)
  @IsInt()
  @Min(MIN_MONTHS)
  @Max(MAX_MONTHS)
  months?: number;

  /** The dokumenthanteringsplan's reference (dnr, punkt). */
  @IsOptional()
  @Transform(blankIsAbsent)
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  reference?: string;
}

export class RetentionPreviewQueryDto {
  @IsIn(RETENTION_DATA_TYPES)
  dataType!: RetentionDataTypeValue;

  @Type(() => Number)
  @IsInt()
  @Min(MIN_MONTHS)
  @Max(MAX_MONTHS)
  months!: number;
}
