import { Transform, Type } from 'class-transformer';
import { IsBoolean, IsIn, IsInt, IsOptional, Max, Min } from 'class-validator';
import type { AbsenceWatchBasis, AbsenceWatchCadence, AbsenceWatchGroup, AbsenceWatchKind } from '@prisma/client';
import {
  ABSENCE_WATCH_BASES,
  ABSENCE_WATCH_CADENCES,
  ABSENCE_WATCH_GROUPS,
  ABSENCE_WATCH_KINDS,
  CONSECUTIVE_DAYS,
  PERCENT,
  WINDOW_DAYS,
} from '../absence-watch';

/** Every field optional: a save names what changed, and the rest keeps its value. */
export class AbsenceWatchSettingsDto {
  @IsOptional()
  @IsBoolean()
  enabled?: boolean;

  @IsOptional()
  @IsIn(ABSENCE_WATCH_CADENCES)
  mentorCadence?: AbsenceWatchCadence;

  @IsOptional()
  @IsIn(ABSENCE_WATCH_CADENCES)
  rektorCadence?: AbsenceWatchCadence;

  @IsOptional()
  @IsIn(ABSENCE_WATCH_CADENCES)
  kansliCadence?: AbsenceWatchCadence;

  @IsOptional()
  @IsIn(ABSENCE_WATCH_CADENCES)
  guardianCadence?: AbsenceWatchCadence;
}

/**
 * The figures of a limit. A share has percent and windowDays and no
 * consecutiveDays, a run the reverse (AbsenceWatchLimits_a_kind_has_its_figures);
 * the service holds the figures to the limit's kind.
 */
export class AbsenceWatchFiguresDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(PERCENT.min)
  @Max(PERCENT.max)
  percent?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(WINDOW_DAYS.min)
  @Max(WINDOW_DAYS.max)
  windowDays?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(CONSECUTIVE_DAYS.min)
  @Max(CONSECUTIVE_DAYS.max)
  consecutiveDays?: number;
}

export class AbsenceWatchLimitDto extends AbsenceWatchFiguresDto {
  @IsIn(ABSENCE_WATCH_GROUPS)
  recipientGroup!: AbsenceWatchGroup;

  @IsIn(ABSENCE_WATCH_KINDS)
  kind!: AbsenceWatchKind;

  @IsIn(ABSENCE_WATCH_BASES)
  basis!: AbsenceWatchBasis;
}

const flag = ({ value }: { value: unknown }) => value === true || value === 'true' || value === '1';

export class AbsenceWatchFindingsQueryDto {
  /** Also the findings closed in the last 60 days: the pupils who came back under, and since when they had passed. */
  @IsOptional()
  @Transform(flag)
  @IsBoolean()
  recent?: boolean;
}

