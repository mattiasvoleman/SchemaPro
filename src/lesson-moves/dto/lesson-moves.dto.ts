import { Transform } from 'class-transformer';
import { IsUUID } from 'class-validator';

/*
 * Elevens lektion för dagen's DTOs. NO FREE TEXT: a move names a pupil and two
 * lessons, never a reason (a reason would be a note about a child that every
 * teacher of the two lessons reads, and the school's rule for those is the
 * mentor's). forbidNonWhitelisted refuses a `reason` or a `note` sent anyway.
 */

const lower = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.toLowerCase() : value);

export class MoveLessonPupilDto {
  @Transform(lower)
  @IsUUID('4', { message: 'studentId: eleven anges med sitt id.' })
  studentId!: string;

  /** The lesson the pupil is on: their own, or the one a move put them on. */
  @Transform(lower)
  @IsUUID('4', { message: 'fromLessonId: lektionen eleven går från anges med sitt id.' })
  fromLessonId!: string;

  @Transform(lower)
  @IsUUID('4', { message: 'toLessonId: lektionen eleven flyttas till anges med sitt id.' })
  toLessonId!: string;
}

export class MoveCandidatesQueryDto {
  @Transform(lower)
  @IsUUID('4', { message: 'studentId: eleven anges med sitt id.' })
  studentId!: string;
}
