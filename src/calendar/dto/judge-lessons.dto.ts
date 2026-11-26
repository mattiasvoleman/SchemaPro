import { LessonRecurrence } from '@prisma/client';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsDateString,
  IsEnum,
  IsIn,
  IsInt,
  IsOptional,
  IsUUID,
  Matches,
  Max,
  Min,
  ValidateNested,
} from 'class-validator';
import { EXEMPTABLE_RULES, type ExemptableRule } from '../lesson-exemption';

/**
 * A clock the way a swap's moves say it (swaps.dto.ts): "34:00" is no clock, and parseTimeString would wrap it to 10:00,
 * so a question could be judged at one time and the PATCH that follows written at another.
 */
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

/**
 * One lesson's tänkta drag: what a PATCH of it would change, said the way the PATCH says it (every field optional, a
 * field left out keeps the lesson's own). Nothing is written.
 */
export class JudgeMoveDto {
  @IsUUID('4')
  lessonId!: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(7)
  dayOfWeek?: number;

  @IsOptional()
  @Matches(TIME, { message: 'startTime must be HH:MM, 00:00–23:59.' })
  startTime?: string;

  @IsOptional()
  @Matches(TIME, { message: 'endTime must be HH:MM, 00:00–23:59.' })
  endTime?: string;

  @IsOptional()
  @IsUUID('4')
  roomId?: string | null;

  @IsOptional()
  @IsUUID('4')
  teacherId?: string | null;

  @IsOptional()
  @IsUUID('4')
  coTeacherId?: string | null;

  /** Set aside on the tray, which occupies nothing and is judged by nothing; false is a lesson put back, a placement like any other. */
  @IsOptional()
  @IsBoolean()
  isParked?: boolean;

  @IsOptional()
  @IsEnum(LessonRecurrence)
  recurrence?: LessonRecurrence;

  @IsOptional()
  @IsDateString({ strict: true })
  startDate?: string | null;

  @IsOptional()
  @IsDateString({ strict: true })
  endDate?: string | null;

  /**
   * UNDANTAG MED FLIT: the rules of the board the administrator answers yes to ("Lägg ändå") for THIS time, by name: `FRAME` (the stage's
   * ramtid) and `LUNCH` (the class's meal). Only these two can be named; a teacher, a room, a class or its pupils, a closed hour, a rule on
   * årskurser, another school's time and the school day cannot. A rule named that the time does not break is saved on nothing. A saved
   * exemption locks the lesson and is for the time it was given for. `[]` takes back what the lesson had.
   */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(EXEMPTABLE_RULES.length)
  @IsIn(EXEMPTABLE_RULES, { each: true })
  exempt?: ExemptableRule[];

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @IsUUID('4', { each: true })
  extraGroupIds?: string[];

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(200)
  @IsUUID('4', { each: true })
  studentIds?: string[];
}

/** The läsande frågan: one or more tänkta drag, judged together as ONE move (as a block's card or a swap is). */
export class JudgeLessonsDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(60)
  @ValidateNested({ each: true })
  @Type(() => JudgeMoveDto)
  moves!: JudgeMoveDto[];
}
