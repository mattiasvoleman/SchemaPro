import { LessonRecurrence } from '@prisma/client';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsDateString,
  IsEnum,
  IsInt,
  IsOptional,
  IsUUID,
  Matches,
  Max,
  Min,
  ValidateNested,
} from 'class-validator';

/** A clock of the day and nothing else (see judge-lessons.dto.ts): "34:00" is no clock. */
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

/** A lesson that is not there yet (a brick of Att lägga): what the schemaläggare knows of it. */
export class PossibleBrickDto {
  @IsUUID('4')
  academicYearId!: string;

  @IsUUID('4')
  studentGroupId!: string;

  @IsUUID('4')
  subjectId!: string;

  /** How long the lesson is. */
  @IsInt()
  @Min(5)
  @Max(480)
  minutes!: number;

  @IsOptional()
  @IsUUID('4')
  teacherId?: string | null;

  @IsOptional()
  @IsUUID('4')
  coTeacherId?: string | null;

  /** The room the lesson would like. The question moves to another when this one is taken. */
  @IsOptional()
  @IsUUID('4')
  roomId?: string | null;

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

  @IsOptional()
  @IsEnum(LessonRecurrence)
  recurrence?: LessonRecurrence;

  @IsOptional()
  @IsDateString({ strict: true })
  startDate?: string | null;

  @IsOptional()
  @IsDateString({ strict: true })
  endDate?: string | null;
}

/**
 * E3: where can this lesson stand? Either a lesson that exists (`lessonId`), or one that does not yet (`brick`): exactly one of
 * the two. Nothing is written.
 */
export class PossibleTimesDto {
  @IsOptional()
  @IsUUID('4')
  lessonId?: string;

  @IsOptional()
  @ValidateNested()
  @Type(() => PossibleBrickDto)
  brick?: PossibleBrickDto;

  /** The school days asked about; Monday to Friday when left out. */
  @IsOptional()
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(5)
  @IsInt({ each: true })
  @Min(1, { each: true })
  @Max(5, { each: true })
  days?: number[];

  /** The earliest start asked about, and the latest end: the board's visible day. 07:00 and 18:00 when left out. */
  @IsOptional()
  @Matches(TIME, { message: 'from must be HH:MM, 00:00–23:59.' })
  from?: string;

  @IsOptional()
  @Matches(TIME, { message: 'to must be HH:MM, 00:00–23:59.' })
  to?: string;

  /** The distance between two start times asked about. Five minutes when left out. */
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(60)
  stepMinutes?: number;

  /** How many of the best to answer with, ranked. */
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(40)
  limit?: number;
}
