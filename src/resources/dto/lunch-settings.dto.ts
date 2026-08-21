import {
  IsBoolean,
  IsInt,
  IsOptional,
  Matches,
  Max,
  Min,
  ValidateIf,
} from 'class-validator';

const TIME = /^\d{2}:\d{2}(:\d{2})?$/;

/**
 * The school's lunch rules and the size of its dining hall.
 *
 * One payload, no separate create: a school has exactly one dining hall, so the
 * endpoint upserts the single row rather than pretending there is a collection
 * to page through.
 *
 * The bounds here mirror the solver's own limits deliberately. Its time grid
 * runs 08:00-18:00 in 15-minute slots and rejects anything that does not land
 * on one, and the gateway throws away the engine's error body before it reaches
 * an admin — so a window the solver cannot parse would be saved silently and
 * fail, unexplained, on every generation from then on.
 */
export class UpsertLunchSettingsDto {
  @IsBoolean()
  lunchEnabled!: boolean;

  @Matches(TIME, { message: 'lunchStartTime must be HH:MM.' })
  lunchStartTime!: string;

  @Matches(TIME, { message: 'lunchEndTime must be HH:MM.' })
  lunchEndTime!: string;

  /** A break shorter than a slot cannot be placed; 120 minutes is the engine's cap. */
  @IsInt()
  @Min(15)
  @Max(120)
  lunchMinutes!: number;

  /**
   * Seats in the dining hall. Null means the school has no limit worth
   * modelling, and the solver then places lunch exactly as it did before.
   */
  @ValidateIf((dto: UpsertLunchSettingsDto) => dto.diningSeats !== null)
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(5000)
  diningSeats?: number | null;

  @ValidateIf((dto: UpsertLunchSettingsDto) => dto.maxLessonsPerDayPerGroup !== null)
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(20)
  maxLessonsPerDayPerGroup?: number | null;
}
