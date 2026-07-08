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
