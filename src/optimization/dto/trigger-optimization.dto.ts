import { Type } from 'class-transformer';
import {
  IsInt,
  IsOptional,
  IsUUID,
  Matches,
  Max,
  Min,
  ValidateNested,
} from 'class-validator';

const TIME_HHMMSS = /^\d{2}:\d{2}:\d{2}$/;

/**
 * Optional per-run objective weights. Unset fields fall back to the AI
 * engine's server-side defaults.
 */
export class ObjectiveWeightsDto {
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(1000)
  preferredFree?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(1000)
  preferredBusy?: number;

  /** Higher = keep more of the previous schedule (minimal disruption). */
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(1000)
  disruption?: number;

  /** Higher = spread a subject's lessons across different weekdays. */
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(1000)
  spread?: number;

  /** Higher = more compact teacher days (fewer gaps). */
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(1000)
  teacherGap?: number;
}

/** Optional hard scheduling rules (lunch break, daily lesson cap). */
export class ScheduleRulesDto {
  @IsOptional()
  @Matches(TIME_HHMMSS, { message: 'lunchStartTime must be HH:MM:SS.' })
  lunchStartTime?: string;

  @IsOptional()
  @Matches(TIME_HHMMSS, { message: 'lunchEndTime must be HH:MM:SS.' })
  lunchEndTime?: string;

  @IsOptional()
  @IsInt()
  @Min(15)
  @Max(120)
  lunchMinutes?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(20)
  maxLessonsPerDayPerGroup?: number;
}

/**
 * Request body for `POST /api/v1/optimization/jobs` and `/trigger`.
 * Only the `academicYearId` is needed; the proxy fetches all other
 * scheduling data itself and strips PII before forwarding to the AI engine.
 */
export class TriggerOptimizationDto {
  @IsUUID('4', { message: 'academicYearId must be a valid UUIDv4.' })
  academicYearId!: string;

  @IsOptional()
  @ValidateNested()
  @Type(() => ObjectiveWeightsDto)
  weights?: ObjectiveWeightsDto;

  @IsOptional()
  @ValidateNested()
  @Type(() => ScheduleRulesDto)
  rules?: ScheduleRulesDto;
}
