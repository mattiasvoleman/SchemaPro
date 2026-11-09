import { LessonRecurrence } from '@prisma/client';
import { Type } from 'class-transformer';
import { ArrayMaxSize, IsArray, IsEnum, IsInt, IsOptional, IsUUID, Matches, Max, Min, ValidateNested } from 'class-validator';

/** The most förläggningar one post can hold: its lessons a week, odd and even in pairs, with room to spare. */
export const MAX_PLACEMENTS_PER_POST = 80;

/**
 * One förlagd lektion of a timplanspost: where it stands. Bounds mirror the
 * table's CHECKs (day 1..5, 15..240 minutes); whether the day, the time and the
 * grid are the school's (08:00 to 18:00 on the five-minute grid), whether the
 * length is one of the post's, and whether the lesson clashes with anything,
 * are the service's to say, with the reason named (placement-fit.ts,
 * placement-judge.ts), so the dialog can put it at the right row.
 */
export class PlacementInputDto {
  @IsInt({ message: 'placements: veckodagen anges som ett heltal, 1 för måndag till 5 för fredag.' })
  @Min(1, { message: 'placements: veckodagen är 1 (måndag) till 5 (fredag).' })
  @Max(5, { message: 'placements: veckodagen är 1 (måndag) till 5 (fredag).' })
  dayOfWeek!: number;

  @Matches(/^([01]\d|2[0-3]):[0-5]\d$/, { message: 'placements: starttiden anges som HH:MM.' })
  startTime!: string;

  @IsInt({ message: 'placements: lektionslängden anges i hela minuter.' })
  @Min(15, { message: 'placements: minst 15 minuter per lektion.' })
  @Max(240, { message: 'placements: högst 240 minuter per lektion.' })
  minutes!: number;

  @IsUUID('4', { message: 'placements: salen anges med sitt id.' })
  roomId!: string;

  @IsEnum(LessonRecurrence, { message: 'placements: veckor är ALL_WEEKS, ODD_WEEKS eller EVEN_WEEKS.' })
  recurrence!: LessonRecurrence;

  /**
   * Delade lektioner: whose lesson it is, on a post that shares its lessons
   * between teachers — its huvudlärare or a share's teacher. Required there
   * (NO_TEACHER otherwise); left out, or null, on a post that shares nothing,
   * whose teacher is every lesson's (TEACHER otherwise).
   */
  @IsOptional()
  @IsUUID('4', { message: 'placements: läraren anges med sitt id.' })
  teacherId?: string | null;
}

/** The whole list of a post's förläggningar, which replaces the stored one; empty removes them all. */
export class ReplacePlacementsDto {
  @IsArray({ message: 'placements: anges som en lista.' })
  @ArrayMaxSize(MAX_PLACEMENTS_PER_POST, { message: `placements: högst ${MAX_PLACEMENTS_PER_POST} förläggningar per post.` })
  @ValidateNested({ each: true })
  @Type(() => PlacementInputDto)
  placements!: PlacementInputDto[];
}
