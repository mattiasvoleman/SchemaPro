import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';

/**
 * A clock of the day and nothing else: 00:00 to 23:59. `\d{2}:\d{2}` also let
 * "34:00" through, and parseTimeString wraps an hour past 23 into the next day
 * (34:00 is stored as 10:00), so a request could be judged at one time and
 * written at another.
 */
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

/** Byten och flyttar: the swaps and chains a picked lesson can take part in. */
export class SuggestSwapsDto {
  /** The lesson the schemaläggare picked. Its läsår is the one searched. */
  @IsUUID('4')
  lessonId!: string;

  /** How many proposals to answer with. */
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(30)
  limit?: number;
}

export class SwapSlotDto {
  @IsInt()
  @Min(1)
  @Max(7)
  dayOfWeek!: number;

  @Matches(TIME, { message: 'startTime must be HH:MM, 00:00–23:59.' })
  startTime!: string;

  @Matches(TIME, { message: 'endTime must be HH:MM, 00:00–23:59.' })
  endTime!: string;
}

export class SwapMoveDto {
  @IsUUID('4')
  lessonId!: string;

  /** Where the page saw the lesson: a lesson that has since moved makes the proposal stale. */
  @ValidateNested()
  @Type(() => SwapSlotDto)
  from!: SwapSlotDto;

  @ValidateNested()
  @Type(() => SwapSlotDto)
  to!: SwapSlotDto;
}

/**
 * Applies a proposal — or, with its moves reversed, takes one back. Every
 * move of the proposal, the parallel lessons included: a move set that leaves
 * a lesson beside one of its own behind is refused, never completed on the
 * page's behalf.
 */
export class ApplySwapDto {
  /** The lesson the schemaläggare picked: the only unit that may be locked. */
  @IsUUID('4')
  lessonId!: string;

  @IsArray()
  @ArrayMinSize(2)
  // A chain of three units of a block of a handful of members each.
  @ArrayMaxSize(60)
  @ValidateNested({ each: true })
  @Type(() => SwapMoveDto)
  moves!: SwapMoveDto[];

  /** As on a single lesson's PATCH: false leaves the published calendar alone. */
  @IsOptional()
  @IsBoolean()
  propagate?: boolean;

  /** What the safety version is called; the page says what the proposal was. */
  @IsOptional()
  @IsString()
  @MaxLength(120)
  versionName?: string;
}
