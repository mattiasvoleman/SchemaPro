import { IsInt, IsOptional, Matches, Max, Min, ValidateIf } from 'class-validator';

const TIME = /^\d{2}:\d{2}(:\d{2})?$/;

/**
 * A lunchsittning: the window one stage of the school may eat in.
 *
 * Shaped like CreateFrameTimeDto — same span, same weekday, same window — plus
 * an optional seat count for this sitting alone. The two are deliberately not
 * one type: a frame BOUNDS a day and several intersect, a serving PERMITS a
 * meal and several union, and a shared DTO would invite a shared rule.
 */
export class CreateLunchServingDto {
  @IsInt()
  @Min(0)
  @Max(12)
  minGradeLevel!: number;

  @IsInt()
  @Min(0)
  @Max(12)
  maxGradeLevel!: number;

  /**
   * ISO weekday 1-7, or null for every teaching day.
   *
   * ValidateIf rather than IsOptional alone, so an explicit `null` reaches the
   * service as the every-day sitting instead of being rejected as not-an-integer.
   */
  @ValidateIf((dto: CreateLunchServingDto) => dto.dayOfWeek !== null)
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(7)
  dayOfWeek?: number | null;

  @Matches(TIME, { message: 'startTime must be HH:MM.' })
  startTime!: string;

  @Matches(TIME, { message: 'endTime must be HH:MM.' })
  endTime!: string;

  /** Chairs for this sitting; omitted or null means the hall's own limit. */
  @ValidateIf((dto: CreateLunchServingDto) => dto.seats !== null)
  @IsOptional()
  @IsInt()
  @Min(1)
  seats?: number | null;
}

/**
 * Every field optional, and each can break an invariant the payload never
 * mentions — a PATCH moving only `endTime` can put it before a `startTime` it
 * never sends. The service therefore checks the MERGE of stored and sent; see
 * its update().
 */
export class UpdateLunchServingDto {
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(12)
  minGradeLevel?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(12)
  maxGradeLevel?: number;

  @ValidateIf((dto: UpdateLunchServingDto) => dto.dayOfWeek !== null)
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(7)
  dayOfWeek?: number | null;

  @IsOptional()
  @Matches(TIME, { message: 'startTime must be HH:MM.' })
  startTime?: string;

  @IsOptional()
  @Matches(TIME, { message: 'endTime must be HH:MM.' })
  endTime?: string;

  @ValidateIf((dto: UpdateLunchServingDto) => dto.seats !== null)
  @IsOptional()
  @IsInt()
  @Min(1)
  seats?: number | null;
}
