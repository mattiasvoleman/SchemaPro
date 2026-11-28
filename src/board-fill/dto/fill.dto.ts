import { Type } from 'class-transformer';
import { ArrayMaxSize, ArrayMinSize, IsArray, IsIn, IsInt, IsOptional, IsString, IsUUID, Matches, Max, MaxLength, Min, ValidateIf, ValidateNested } from 'class-validator';

const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

/** What Lägg det som går is asked to fill: the bricks marked, a class, a year, or the school. */
export const FILL_SCOPES = ['BRICKS', 'CLASS', 'GRADE', 'SCHOOL'] as const;
export type FillScope = (typeof FILL_SCOPES)[number];

/** The most bricks one question is asked for: a school of a thousand lessons has a tray far shorter than this on a day it is asked. */
export const FILL_MAX_BRICKS = 600;

/** One brick of the tray as the page holds it: the part (post, teacher, length) and its place among the part's bricks (`nth`, the tray's). */
export class FillBrickRefDto {
  @IsUUID('4')
  postId!: string;

  @IsOptional()
  @IsUUID('4')
  teacherId?: string | null;

  @IsInt()
  @Min(5)
  @Max(600)
  minutes!: number;

  @IsInt()
  @Min(1)
  nth!: number;
}

/** POST /board-fill/propose: nothing is written. */
export class FillProposeDto {
  @IsUUID('4')
  academicYearId!: string;

  @IsIn(FILL_SCOPES)
  scope!: FillScope;

  /** BRICKS: the bricks marked. */
  @ValidateIf((dto: FillProposeDto) => dto.scope === 'BRICKS')
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(FILL_MAX_BRICKS)
  @ValidateNested({ each: true })
  @Type(() => FillBrickRefDto)
  bricks?: FillBrickRefDto[];

  /** CLASS: the class (or the teaching group) whose bricks are laid. */
  @ValidateIf((dto: FillProposeDto) => dto.scope === 'CLASS')
  @IsUUID('4')
  studentGroupId?: string;

  /** GRADE: the year, in the läsår's own numbering, whose classes' and groups' bricks are laid. */
  @ValidateIf((dto: FillProposeDto) => dto.scope === 'GRADE')
  @IsInt()
  @Min(1)
  @Max(12)
  gradeLevel?: number;
}

/** One lesson of a proposal, as the page read it: the brick's key and where it was proposed to stand. */
export class FillItemDto {
  /** The key the proposal named the brick by: postId|teacherId (or -)|minutes|nth. */
  @IsString()
  @MaxLength(200)
  @Matches(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\|(-|[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\|[0-9]{1,3}\|[0-9]{1,4}$/)
  key!: string;

  @IsInt()
  @Min(1)
  @Max(5)
  dayOfWeek!: number;

  @Matches(TIME, { message: 'startTime must be HH:MM, 00:00–23:59.' })
  startTime!: string;

  /** The room the proposal named; null for none ("Utan sal"). */
  @IsOptional()
  @IsUUID('4')
  roomId?: string | null;
}

/** POST /board-fill/apply: "Ta in". The proposal as it was read, with the basis it was made on. */
export class FillApplyDto {
  @IsUUID('4')
  academicYearId!: string;

  /** The proposal's `basis`: the write is refused (409 BOARD_FILL_STALE) and nothing is written when the grundschema is no longer the one it was made on. */
  @Matches(/^[0-9a-f]{32}$/)
  basis!: string;

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(FILL_MAX_BRICKS)
  @ValidateNested({ each: true })
  @Type(() => FillItemDto)
  items!: FillItemDto[];

  /** What the version saved before the write is called. */
  @IsOptional()
  @IsString()
  @MaxLength(80)
  versionName?: string;
}
