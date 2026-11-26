import { Type } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsOptional,
  IsUUID,
  Matches,
  Max,
  Min,
  ValidateIf,
  ValidateNested,
} from 'class-validator';
import { START_SOURCES, type StartSource } from '../start-schedule';

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
 * Ett schema som start (M9): the schedule a run starts from instead of from nothing. Absent is Generera as it was. The
 * engine holds each lesson of the schedule where it was, lets go of what clashes with the week and lays only that.
 *
 *   CURRENT        this year's grundschema as it stands (what the next Generera replaces);
 *   PREVIOUS_YEAR  last year's grundschema, under each class's successor;
 *   VERSION        a saved version of this year, which `versionId` names (a schedule read in from a file is saved as one).
 */
export class StartFromDto {
  @IsIn(START_SOURCES, { message: 'source must be CURRENT, PREVIOUS_YEAR or VERSION.' })
  source!: StartSource;

  /** The saved version, for VERSION and for no other source. */
  @ValidateIf((dto: StartFromDto) => dto.source === 'VERSION')
  @IsUUID('4', { message: 'versionId must be a valid UUIDv4.' })
  versionId?: string;
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

  /** Where the run starts from; absent starts from nothing, as Generera always did. */
  @IsOptional()
  @ValidateNested()
  @Type(() => StartFromDto)
  startFrom?: StartFromDto;
}
