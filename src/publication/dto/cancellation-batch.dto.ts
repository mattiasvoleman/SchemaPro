import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const CLOCK = /^([01]\d|2[0-3]):[0-5]\d$/;
const lower = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.toLowerCase() : value);

export const BATCH_SCOPES = ['SCHOOL', 'GRADES', 'GROUPS'] as const;
export type BatchScope = (typeof BATCH_SCOPES)[number];

/**
 * What a bulk avbokning selects. Mirrors CancellationBatches' CHECKs
 * (20261011110000): at most 31 days inclusive, a time window with both
 * bounds or neither, a span for GRADES, 1–200 groups for GROUPS; the cause
 * EVENT or MANUAL, never a teacher's or a room's. The cross-field rules are
 * the service's to say with the fields named (a DTO cannot compare two).
 */
export class CancellationSelectionDto {
  @Transform(lower)
  @IsUUID('4', { message: 'academicYearId: läsåret anges med sitt id.' })
  academicYearId!: string;

  @IsString()
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @MinLength(1, { message: 'name: avbokningen behöver ett namn, till exempel "Prao åk 9".' })
  @MaxLength(120)
  name!: string;

  @IsIn(['EVENT', 'MANUAL'], { message: "cause: 'EVENT' (en aktivitet) eller 'MANUAL'." })
  cause!: 'EVENT' | 'MANUAL';

  @Matches(ISO_DATE, { message: 'fromDate: YYYY-MM-DD.' })
  fromDate!: string;

  @Matches(ISO_DATE, { message: 'toDate: YYYY-MM-DD.' })
  toDate!: string;

  @IsOptional()
  @Matches(CLOCK, { message: 'startTime: HH:MM.' })
  startTime?: string;

  @IsOptional()
  @Matches(CLOCK, { message: 'endTime: HH:MM.' })
  endTime?: string;

  @IsIn(BATCH_SCOPES, { message: "scope: 'SCHOOL', 'GRADES' eller 'GROUPS'." })
  scope!: BatchScope;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(10)
  minGradeLevel?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(10)
  maxGradeLevel?: number;

  @IsOptional()
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(200)
  @IsUUID('4', { each: true })
  groupIds?: string[];
}

/** The day counted as teaching (TimplanCredits): whole days only, ahead only. */
export class CancellationCreditDto {
  @IsInt()
  @Min(1)
  @Max(600)
  minutes!: number;

  @IsOptional()
  @IsUUID('4')
  subjectId?: string;
}

export class CreateCancellationBatchDto extends CancellationSelectionDto {
  /** The preview's digest: a selection that changed since answers 409 CANCELLATION_STALE. */
  @IsOptional()
  @Matches(/^[0-9a-f]{64}$/, { message: 'expectedDigest: förhandsgranskningens kontrollsumma.' })
  expectedDigest?: string;

  @IsOptional()
  @ValidateNested()
  @Type(() => CancellationCreditDto)
  credit?: CancellationCreditDto;
}

export class CancellationBatchListQueryDto {
  @Transform(lower)
  @IsUUID('4', { message: 'academicYearId: läsåret anges med sitt id.' })
  academicYearId!: string;
}
