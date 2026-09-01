import { ConstraintResource, ConstraintType } from '@prisma/client';
import {
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
  ValidateIf,
} from 'class-validator';

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const TIME = /^\d{2}:\d{2}(:\d{2})?$/;

export class CreateAvailabilityConstraintDto {
  @IsEnum(ConstraintResource)
  resourceType!: ConstraintResource;

  @ValidateIf((dto: CreateAvailabilityConstraintDto) => dto.userId !== null)
  @IsOptional()
  @IsUUID('4')
  userId?: string | null;

  @ValidateIf((dto: CreateAvailabilityConstraintDto) => dto.roomId !== null)
  @IsOptional()
  @IsUUID('4')
  roomId?: string | null;

  @ValidateIf((dto: CreateAvailabilityConstraintDto) => dto.studentGroupId !== null)
  @IsOptional()
  @IsUUID('4')
  studentGroupId?: string | null;

  /**
   * A year range instead of a named resource, for a GRADE_LEVEL lock.
   *
   * A school holding åk 4-6 free at some hour authors one rule, not one per
   * class. It evicts LESSONS from that hour; a lunch sitting is declared with a
   * LunchServing instead, which is what the solver reads as the meal's window.
   *
   * The solver matches a group when its own year span OVERLAPS this range, so a
   * class spanning 6-7 is caught by a 4-6 lock: a reservation holds students
   * free, and holding someone free needlessly is the safe error.
   */
  @ValidateIf((dto: CreateAvailabilityConstraintDto) => dto.minGradeLevel !== null)
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(12)
  minGradeLevel?: number | null;

  @ValidateIf((dto: CreateAvailabilityConstraintDto) => dto.maxGradeLevel !== null)
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(12)
  maxGradeLevel?: number | null;

  @ValidateIf((dto: CreateAvailabilityConstraintDto) => dto.dayOfWeek !== null)
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(7)
  dayOfWeek?: number | null;

  @ValidateIf((dto: CreateAvailabilityConstraintDto) => dto.date !== null)
  @IsOptional()
  @Matches(ISO_DATE, { message: 'date must be YYYY-MM-DD.' })
  date?: string | null;

  @Matches(TIME, { message: 'startTime must be HH:MM.' })
  startTime!: string;

  @Matches(TIME, { message: 'endTime must be HH:MM.' })
  endTime!: string;

  @IsOptional()
  @IsEnum(ConstraintType)
  type?: ConstraintType;

  @ValidateIf((dto: CreateAvailabilityConstraintDto) => dto.reason !== null)
  @IsOptional()
  @IsString()
  @MaxLength(300)
  reason?: string | null;
}

export class UpdateAvailabilityConstraintDto {
  @IsOptional()
  @IsEnum(ConstraintResource)
  resourceType?: ConstraintResource;

  @ValidateIf((dto: UpdateAvailabilityConstraintDto) => dto.userId !== null)
  @IsOptional()
  @IsUUID('4')
  userId?: string | null;

  @ValidateIf((dto: UpdateAvailabilityConstraintDto) => dto.roomId !== null)
  @IsOptional()
  @IsUUID('4')
  roomId?: string | null;

  @ValidateIf((dto: UpdateAvailabilityConstraintDto) => dto.studentGroupId !== null)
  @IsOptional()
  @IsUUID('4')
  studentGroupId?: string | null;

  /**
   * A year range instead of a named resource, for a GRADE_LEVEL lock.
   *
   * A school holding åk 4-6 free at some hour authors one rule, not one per
   * class. It evicts LESSONS from that hour; a lunch sitting is declared with a
   * LunchServing instead, which is what the solver reads as the meal's window.
   *
   * The solver matches a group when its own year span OVERLAPS this range, so a
   * class spanning 6-7 is caught by a 4-6 lock: a reservation holds students
   * free, and holding someone free needlessly is the safe error.
   */
  @ValidateIf((dto: UpdateAvailabilityConstraintDto) => dto.minGradeLevel !== null)
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(12)
  minGradeLevel?: number | null;

  @ValidateIf((dto: UpdateAvailabilityConstraintDto) => dto.maxGradeLevel !== null)
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(12)
  maxGradeLevel?: number | null;

  @ValidateIf((dto: UpdateAvailabilityConstraintDto) => dto.dayOfWeek !== null)
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(7)
  dayOfWeek?: number | null;

  @ValidateIf((dto: UpdateAvailabilityConstraintDto) => dto.date !== null)
  @IsOptional()
  @Matches(ISO_DATE, { message: 'date must be YYYY-MM-DD.' })
  date?: string | null;

  @IsOptional()
  @Matches(TIME, { message: 'startTime must be HH:MM.' })
  startTime?: string;

  @IsOptional()
  @Matches(TIME, { message: 'endTime must be HH:MM.' })
  endTime?: string;

  @IsOptional()
  @IsEnum(ConstraintType)
  type?: ConstraintType;

  @ValidateIf((dto: UpdateAvailabilityConstraintDto) => dto.reason !== null)
  @IsOptional()
  @IsString()
  @MaxLength(300)
  reason?: string | null;
}
