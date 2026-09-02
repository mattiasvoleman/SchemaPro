import { IsInt, IsOptional, IsString, Matches, Max, MaxLength, Min, MinLength, ValidateIf } from 'class-validator';

const TIME = /^\d{2}:\d{2}(:\d{2})?$/;

/**
 * A rast: minutes of the day one stage of the school is not taught.
 *
 * Shaped like CreateLunchServingDto — same span, same weekday, same window —
 * and deliberately not the same type. A serving PERMITS a meal and several
 * union into a wider permission; a rast OBLIGES a gap and several union into a
 * longer obligation. A shared DTO would invite a shared rule, and the rule that
 * shadows a serving on a weekday is wrong here: see RastsService.
 */
export class CreateRastDto {
  /** What the school calls it — printed on the pupil's band. */
  @IsString()
  @MinLength(1)
  @MaxLength(60)
  name!: string;

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
   * service as the every-day rast instead of being rejected as not-an-integer.
   */
  @ValidateIf((dto: CreateRastDto) => dto.dayOfWeek !== null)
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(7)
  dayOfWeek?: number | null;

  @Matches(TIME, { message: 'startTime must be HH:MM.' })
  startTime!: string;

  @Matches(TIME, { message: 'endTime must be HH:MM.' })
  endTime!: string;
}

/**
 * Every field optional, and each can break an invariant the payload never
 * mentions — a PATCH moving only `endTime` can put it before a `startTime` it
 * never sends. The service therefore checks the MERGE of stored and sent.
 */
export class UpdateRastDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(60)
  name?: string;

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

  @ValidateIf((dto: UpdateRastDto) => dto.dayOfWeek !== null)
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
}
