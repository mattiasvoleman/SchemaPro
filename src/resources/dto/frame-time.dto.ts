import { IsInt, IsOptional, Matches, Max, Min, ValidateIf } from 'class-validator';

const TIME = /^\d{2}:\d{2}(:\d{2})?$/;

/**
 * A ramtid: the hours one stage of the school may be taught in.
 *
 * Both year bounds are required, unlike on a constraint or a lov. A frame
 * without years would say "the school day is this long", which is what the
 * engine's own day window already says — and a row that duplicates a setting is
 * a row that can disagree with it.
 */
export class CreateFrameTimeDto {
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
   * service as the every-day frame instead of being rejected as not-an-integer.
   */
  @ValidateIf((dto: CreateFrameTimeDto) => dto.dayOfWeek !== null)
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
 * Every field optional, and every one of them able to break the row's
 * invariants on its own — a PATCH that moves only `endTime` can put it before
 * a `startTime` it never mentions. The service therefore reads the stored row
 * and checks the merged result rather than the payload; see its update().
 */
export class UpdateFrameTimeDto {
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

  @ValidateIf((dto: UpdateFrameTimeDto) => dto.dayOfWeek !== null)
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
