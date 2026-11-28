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
  ValidateIf,
  ValidateNested,
} from 'class-validator';
import { PossibleBrickDto } from '../../calendar/dto/possible-times.dto';

/**
 * A clock of the day and nothing else: 00:00 to 23:59. `\d{2}:\d{2}` also let
 * "34:00" through, and parseTimeString wraps an hour past 23 into the next day
 * (34:00 is stored as 10:00), so a request could be judged at one time and
 * written at another.
 */
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

/**
 * Gör plats (E5a): aim the search at a time. The picked lesson is asked to stand at this day and clock, and the answer is the
 * sets of moves that make room for it: what stands in the way goes to an empty place or into a place another lesson leaves, up to
 * `depth` levels deep, and no lesson the generation keeps is moved.
 */
export class MakeRoomDto {
  /** A school day, Monday to Friday. */
  @IsInt()
  @Min(1)
  @Max(5)
  dayOfWeek!: number;

  /** The clock the lesson would start at. It keeps its own length. */
  @Matches(TIME, { message: 'startTime must be HH:MM, 00:00–23:59.' })
  startTime!: string;

  /** Levels of displacement: 1 moves only what stands in the way, 3 also what that has to move. Three when left out. */
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(3)
  depth?: number;
}

/**
 * Byten och flyttar: the swaps and chains a picked lesson can take part in, or (with `makeRoom`) what has to move for it to stand at
 * a time. Name either `lessonId` or, for a lesson that is not one yet, `brick`; a brick is asked with `makeRoom` only, as it has no
 * place to swap with.
 */
export class SuggestSwapsDto {
  /** The lesson the schemaläggare picked. Its läsår is the one searched. */
  @IsOptional()
  @IsUUID('4')
  lessonId?: string;

  /** A lesson that is not one yet (a brick of Att lägga): the same description the possible times take (E3). */
  @IsOptional()
  @ValidateNested()
  @Type(() => PossibleBrickDto)
  brick?: PossibleBrickDto;

  /** How many proposals to answer with. */
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(30)
  limit?: number;

  /** Aim the search at a time: Gör plats. Left out, the answer is the swaps and chains of three it always was. */
  @IsOptional()
  @ValidateNested()
  @Type(() => MakeRoomDto)
  makeRoom?: MakeRoomDto;
}

/**
 * Byt plats (E5a): two lessons the schemaläggare marked, each to take the other's start and keep its own length. The answer is the
 * swap as a proposal, with what it costs, or the reasons a lesson cannot stand where the other stands.
 */
export class PairSwapDto {
  @IsUUID('4')
  lessonId!: string;

  @IsUUID('4')
  otherLessonId!: string;
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
  /** The lesson the schemaläggare picked: the only unit that may be locked (and the ones `alsoPicked` names). Not needed with `forBrick`. */
  @ValidateIf((body: ApplySwapDto) => body.forBrick !== true)
  @IsUUID('4')
  lessonId!: string;

  /**
   * Byt plats (E5a): the other lessons the schemaläggare chose themselves. A locked lesson the person marked is the person's to move,
   * as on a PATCH; the generation's lock is for what an automat would move.
   */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(10)
  @IsUUID('4', { each: true })
  alsoPicked?: string[];

  /**
   * Gör plats for a lesson that stands nowhere (E5a): the moves make room for a brick or a parked lesson, which the page lays in the
   * room made. Every lesson of the moves is then one an automat moved, so none may be locked, and a single move is a proposal.
   */
  @IsOptional()
  @IsBoolean()
  forBrick?: boolean;

  // One move is a proposal only for `forBrick`: the service says so before it reads anything.
  @IsArray()
  @ArrayMinSize(1)
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
