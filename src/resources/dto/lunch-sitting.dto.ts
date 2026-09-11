import { IsInt, IsOptional, IsUUID, Matches, Max, Min } from 'class-validator';

const TIME = /^\d{2}:\d{2}(:\d{2})?$/;

/**
 * A lunch the school places by hand: one class, one weekday, one start.
 *
 * Only the start. The meal's length is the school's one lunchMinutes, and a
 * body that carried an end would be a second answer to "how long is lunch" —
 * which a day placed by hand would then disagree with the moment the setting
 * changed.
 */
export class PlaceLunchSittingDto {
  @IsUUID('4')
  academicYearId!: string;

  @IsUUID('4')
  studentGroupId!: string;

  @IsInt()
  @Min(1)
  @Max(7)
  dayOfWeek!: number;

  @Matches(TIME, { message: 'startTime must be HH:MM.' })
  startTime!: string;
}

/** A meal moved: to another weekday, another start, or both. */
export class MoveLunchSittingDto {
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(7)
  dayOfWeek?: number;

  @IsOptional()
  @Matches(TIME, { message: 'startTime must be HH:MM.' })
  startTime?: string;
}
