import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  ArrayUnique,
  IsArray,
  IsBoolean,
  IsInt,
  IsOptional,
  IsUUID,
  Matches,
  Max,
  Min,
  ValidateNested,
} from 'class-validator';

const TIME = /^\d{2}:\d{2}$/;

/** A lesson of the block a card leaves where it stands, and the owner it gets back. */
export class LeftLessonDto {
  @IsUUID('4')
  id!: string;

  @IsBoolean()
  isGenerated!: boolean;
}

/**
 * Moves a parallel block's card: the lessons of its members that stand in one
 * slot, to another slot, as one move (MasterLessonsService.moveBlockCard).
 *
 * The lessons are named rather than the block, because a block has a card per
 * lesson of its week and the timetable moves the one it shows. The gateway
 * holds them to being a card — one block, one lesson per member, one slot —
 * so a stale page refuses instead of moving what it no longer sees.
 */
export class MoveBlockCardDto {
  @IsArray()
  @ArrayMinSize(2, { message: 'lessonIds: ett block har minst två lektioner i varje tid.' })
  // A block is a school's språkval or elevens val: a handful of groups.
  @ArrayMaxSize(50)
  @ArrayUnique()
  @IsUUID('4', { each: true })
  lessonIds!: string[];

  @IsInt()
  @Min(1)
  @Max(7)
  dayOfWeek!: number;

  @Matches(TIME, { message: 'startTime must be HH:MM.' })
  startTime!: string;

  @Matches(TIME, { message: 'endTime must be HH:MM.' })
  endTime!: string;

  /** As on a single lesson's PATCH: false leaves the published calendar alone. */
  @IsOptional()
  @IsBoolean()
  propagate?: boolean;

  /**
   * Lessons of the block standing with the card that it leaves behind, each
   * with the owner it had: the undo of a card move that took them in (the
   * move's `joined`). Named here they are no sign of a stale card.
   */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(50)
  @ValidateNested({ each: true })
  @Type(() => LeftLessonDto)
  leave?: LeftLessonDto[];

  /**
   * The lessons of a block on the same times (a term split's spring card)
   * that move with this card: exactly these, standing whole at the card's day
   * and clock, or the card is stale; none when empty. The undo of a card move
   * names the move's `followed`, so it takes back what the move took and
   * nothing the move left. Absent: the other block's card standing whole at
   * the card's day and clock.
   */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(50)
  @ArrayUnique()
  @IsUUID('4', { each: true })
  follow?: string[];
}

/**
 * Locks or unlocks a parallel block's lessons (MasterLessonsService.lockBlock).
 *
 * The block's every lesson, by default: the generation refuses a block whose
 * lessons are partly locked (BLOCK_PARTLY_LOCKED), so a block is locked whole
 * or not at all. `lessonIds` narrows it to lessons of the block, for an undo
 * that puts back only what the lock it reverses changed.
 */
export class LockBlockDto {
  @IsUUID('4')
  blockId!: string;

  @IsBoolean()
  isLocked!: boolean;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(500)
  @ArrayUnique()
  @IsUUID('4', { each: true })
  lessonIds?: string[];
}
