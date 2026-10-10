import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
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
  ValidateIf,
  ValidateNested,
} from 'class-validator';

/*
 * The cover board's DTOs. They mirror the CHECKs of 20261012090000–
 * 20261012110000 where a single field can say it; the cross-field rules (from
 * ≤ to, 186 local days, a start before an end on one day, an admin's
 * today−30, a teacher's today) are the service's, with the field named.
 *
 * NO FREE TEXT ON ANY WRITE HERE. An absence has a category, never a note; a
 * board decision carries no note (a note is shown to the class, so it would
 * be a reason shown to the class). forbidNonWhitelisted refuses a `note` or
 * a `reason` sent anyway.
 */

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const CLOCK = /^([01]\d|2[0-3]):[0-5]\d$/;
const lower = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.toLowerCase() : value);

export const COVER_DECISION_KINDS = ['SUBSTITUTE', 'CANCELLED', 'SUPERVISED_STUDY', 'CO_TEACHER'] as const;
export type CoverDecisionKindValue = (typeof COVER_DECISION_KINDS)[number];
export const COVER_STATUSES = ['OPEN', 'COVERED', 'CANCELLED', 'HANDLED'] as const;
export type CoverStatusValue = (typeof COVER_STATUSES)[number];
export const POOL_PREFERENCES = ['PREFER', 'NEUTRAL', 'LAST_RESORT'] as const;

export class ListAbsencesQueryDto {
  @IsOptional()
  @Matches(ISO_DATE, { message: 'from: YYYY-MM-DD.' })
  from?: string;

  @IsOptional()
  @Matches(ISO_DATE, { message: 'to: YYYY-MM-DD.' })
  to?: string;

  @IsOptional()
  @Transform(lower)
  @IsUUID('4')
  userId?: string;

  @IsOptional()
  @IsIn(['true', 'false'])
  includeEnded?: 'true' | 'false';
}

export class CreateAbsenceDto {
  @Transform(lower)
  @IsUUID('4', { message: 'userId: läraren anges med sitt id.' })
  userId!: string;

  @Matches(ISO_DATE, { message: 'from: YYYY-MM-DD.' })
  from!: string;

  @Matches(ISO_DATE, { message: 'to: YYYY-MM-DD.' })
  to!: string;

  /** Part of a day: the time on the first day. Absent with endTime = whole days. */
  @IsOptional()
  @Matches(CLOCK, { message: 'startTime: HH:MM.' })
  startTime?: string;

  /** Part of a day: the time on the last day. */
  @IsOptional()
  @Matches(CLOCK, { message: 'endTime: HH:MM.' })
  endTime?: string;

  /** A category of the school's list; null or absent = "ej angiven". */
  @IsOptional()
  @ValidateIf((dto: CreateAbsenceDto) => dto.reasonId !== null)
  @Transform(lower)
  @IsUUID('4', { message: 'reasonId: orsaken anges med sitt id, eller null.' })
  reasonId?: string | null;
}

/** An admin's edit. There is no userId: an absence never changes person. */
export class UpdateAbsenceDto {
  @IsOptional()
  @Matches(ISO_DATE, { message: 'from: YYYY-MM-DD.' })
  from?: string;

  @IsOptional()
  @Matches(ISO_DATE, { message: 'to: YYYY-MM-DD.' })
  to?: string;

  @IsOptional()
  @ValidateIf((dto: UpdateAbsenceDto) => dto.startTime !== null)
  @Matches(CLOCK, { message: 'startTime: HH:MM, eller null för hela dagar.' })
  startTime?: string | null;

  @IsOptional()
  @ValidateIf((dto: UpdateAbsenceDto) => dto.endTime !== null)
  @Matches(CLOCK, { message: 'endTime: HH:MM, eller null för hela dagar.' })
  endTime?: string | null;

  @IsOptional()
  @ValidateIf((dto: UpdateAbsenceDto) => dto.reasonId !== null)
  @Transform(lower)
  @IsUUID('4', { message: 'reasonId: orsaken anges med sitt id, eller null.' })
  reasonId?: string | null;

  /** Undo the decisions on lessons the new period leaves (ABSENCE_HAS_DECISIONS otherwise). */
  @IsOptional()
  @IsBoolean()
  undoDecisionsOutside?: boolean;
}

export class EndAbsenceDto {
  /** The instant the absence ends (ISO 8601). */
  @IsString()
  @Matches(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})$/, {
    message: 'at: en tidpunkt i ISO 8601, till exempel 2026-10-14T12:00:00Z.',
  })
  at!: string;

  @IsOptional()
  @IsBoolean()
  undoDecisions?: boolean;
}

export class WithdrawAbsenceDto {
  @IsOptional()
  @IsBoolean()
  undoDecisions?: boolean;
}

export class CreateReasonDto {
  @IsString()
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @MinLength(1, { message: 'label: orsaken behöver ett namn.' })
  @MaxLength(60, { message: 'label: högst 60 tecken.' })
  label!: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(999)
  sortOrder?: number;
}

export class UpdateReasonDto {
  /** A label of the school's own; a built-in cannot be renamed, only archived. */
  @IsOptional()
  @IsString()
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @MinLength(1, { message: 'label: orsaken behöver ett namn.' })
  @MaxLength(60, { message: 'label: högst 60 tecken.' })
  label?: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(999)
  sortOrder?: number;

  @IsOptional()
  @IsBoolean()
  archived?: boolean;
}

export class CoverSettingsDto {
  @IsIn(POOL_PREFERENCES, { message: "poolPreference: 'PREFER', 'NEUTRAL' eller 'LAST_RESORT'." })
  poolPreference!: (typeof POOL_PREFERENCES)[number];

  @IsBoolean()
  teacherSelfReport!: boolean;
}

/** A board window: at most seven days (the service checks the span). */
export class BoardQueryDto {
  @Matches(ISO_DATE, { message: 'from: YYYY-MM-DD.' })
  from!: string;

  @Matches(ISO_DATE, { message: 'to: YYYY-MM-DD.' })
  to!: string;
}

export class DecisionDto {
  @Transform(lower)
  @IsUUID('4', { message: 'absenceId: frånvaron anges med sitt id.' })
  absenceId!: string;

  @IsIn(COVER_DECISION_KINDS, {
    message: "kind: 'SUBSTITUTE', 'CANCELLED', 'SUPERVISED_STUDY' eller 'CO_TEACHER'.",
  })
  kind!: CoverDecisionKindValue;

  /** Required for SUBSTITUTE, refused otherwise (the service names it). */
  @IsOptional()
  @Transform(lower)
  @IsUUID('4', { message: 'substituteId: vikarien anges med sitt id.' })
  substituteId?: string;

  /** The status the admin saw: a decision on anything else is COVER_STALE. */
  @IsIn(COVER_STATUSES, { message: "expected: 'OPEN', 'COVERED', 'CANCELLED' eller 'HANDLED'." })
  expected!: CoverStatusValue;
}

export class UndoQueryDto {
  @Transform(lower)
  @IsUUID('4', { message: 'absenceId: frånvaron anges med sitt id.' })
  absenceId!: string;
}

export class BulkItemDto {
  @Transform(lower)
  @IsUUID('4')
  lessonId!: string;

  @Transform(lower)
  @IsUUID('4')
  absenceId!: string;

  @IsIn(COVER_STATUSES)
  expected!: CoverStatusValue;
}

export class BulkDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(200, { message: 'items: högst 200 lektioner åt gången.' })
  @ValidateNested({ each: true })
  @Type(() => BulkItemDto)
  items!: BulkItemDto[];

  @IsIn(['CANCELLED', 'SUPERVISED_STUDY', 'UNDO'], { message: "action: 'CANCELLED', 'SUPERVISED_STUDY' eller 'UNDO'." })
  action!: 'CANCELLED' | 'SUPERVISED_STUDY' | 'UNDO';
}

export class CandidatesQueryDto {
  @Transform(lower)
  @IsUUID('4', { message: 'absenceId: frånvaron anges med sitt id.' })
  absenceId!: string;
}

export class ProposalDto {
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(500)
  @IsUUID('4', { each: true })
  excludeUserIds?: string[];
}

export class ApplyItemDto {
  @Transform(lower)
  @IsUUID('4')
  lessonId!: string;

  @Transform(lower)
  @IsUUID('4')
  absenceId!: string;

  @Transform(lower)
  @IsUUID('4')
  userId!: string;
}

export class ApplyDto {
  @Matches(/^[0-9a-f]{64}$/, { message: 'basis: förslagets underlag, som det kom.' })
  basis!: string;

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(200)
  @ValidateNested({ each: true })
  @Type(() => ApplyItemDto)
  items!: ApplyItemDto[];
}

export class CounterQueryDto {
  @Matches(ISO_DATE, { message: 'date: YYYY-MM-DD.' })
  date!: string;
}

export class HoursQueryDto {
  @Matches(ISO_DATE, { message: 'from: YYYY-MM-DD.' })
  from!: string;

  @Matches(ISO_DATE, { message: 'to: YYYY-MM-DD.' })
  to!: string;

  @IsOptional()
  @Transform(lower)
  @IsUUID('4')
  userId?: string;
}

export class PoolMemberDto {
  @Transform(lower)
  @IsUUID('4', { message: 'userId: läraren anges med sitt id.' })
  userId!: string;
}

export class AvailabilityQueryDto {
  @IsOptional()
  @Transform(lower)
  @IsUUID('4')
  userId?: string;
}

/** A window a pool member can work: a date or a weekday (exactly one), start before end. */
export class CreateAvailabilityDto {
  /** The member; a teacher may leave it out (their own) and may name nobody else. */
  @IsOptional()
  @Transform(lower)
  @IsUUID('4')
  userId?: string;

  @IsOptional()
  @Matches(ISO_DATE, { message: 'date: YYYY-MM-DD.' })
  date?: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(7)
  dayOfWeek?: number;

  @Matches(CLOCK, { message: 'startTime: HH:MM.' })
  startTime!: string;

  @Matches(CLOCK, { message: 'endTime: HH:MM.' })
  endTime!: string;
}
