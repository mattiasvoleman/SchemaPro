import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { IsCalendarDate } from './is-calendar-date';

/** A subject the halves read in turn, and who teaches it. */
export class TermSubjectDto {
  @IsUUID('4', { message: 'subjects: varje ämne anges med sitt id.' })
  subjectId!: string;

  /** Null or omitted leaves the subject's two posts without a teacher. */
  @IsOptional()
  @IsUUID('4', { message: 'subjects: läraren anges med sitt id.' })
  teacherId?: string | null;

  /**
   * The subject's co-teacher. Omitted carries the class's post's co-teacher
   * over; null is none. A person on both subjects is refused, so a class's
   * co-teacher has to be named for one of them.
   */
  @IsOptional()
  @IsUUID('4', { message: 'subjects: medläraren anges med sitt id.' })
  coTeacherId?: string | null;
}

/** One of the two periods the halves take turns over, both days included. */
export class TermPeriodDto {
  @IsCalendarDate()
  startDate!: string;

  @IsCalendarDate()
  endDate!: string;
}

/**
 * The class's own post in the swap's other subject, with the week it gets in
 * the same save: hemkunskap swapped with slöjd gives each pupil slöjd in the
 * other period, which the class's slöjd post can give back.
 */
export class AdjustedPostDto {
  @IsUUID('4', { message: 'adjustedPost: posten anges med sitt id.' })
  requirementId!: string;

  @IsArray({ message: 'adjustedPost.lessons: anges som en lista med en längd per lektion.' })
  @ArrayMinSize(1, { message: 'adjustedPost.lessons: minst en lektion i veckan.' })
  @ArrayMaxSize(40, { message: 'adjustedPost.lessons: högst 40 lektioner per vecka.' })
  @IsInt({ each: true, message: 'adjustedPost.lessons: varje längd anges i hela minuter.' })
  @Min(15, { each: true, message: 'adjustedPost.lessons: minst 15 minuter per lektion.' })
  @Max(240, { each: true, message: 'adjustedPost.lessons: högst 240 minuter per lektion.' })
  lessons!: number[];
}

/**
 * "Dela i halvklass" (term-halves.service.ts): a class's post replaced by
 * posts on the class's two halves, which take turns over two periods.
 *
 * `subjects[0]` is the first half's subject in the first period and the
 * second half's in the second. `subjects[1]`, when given, is the other way
 * round: two subjects make four posts, the halves swapping (slöjd). One
 * subject makes two, the halves reading it in turn and nothing of it outside
 * their period (hemkunskap).
 *
 * The periods are the autumn and the spring split at `springStartDate`, or
 * `periods`: two of the year's own stretches, the first before the second,
 * half a term each or any other part of the year. Exactly one of the two.
 *
 * `lessons` is the halves' week, one length per lesson ([60, 60] is
 * 2 × 60), when it is not the class's post's: a half that reads its
 * hemkunskap in a quarter of the year reads it at four times the class's pace
 * to get the class's hours.
 *
 * `halfNames` names the halves when the class has none yet ("7A:1", "7A:2" if
 * omitted), `halfIds` orders the halves it has, and `blockNames` names the two
 * parallel blocks, the first period's first (named after the post if
 * omitted).
 *
 * `adjustedPost`, with two subjects only, is the class's own post in the
 * swap's other subject (either of the two, but not the post being split)
 * with its new week (`lessons` as above), written in the same transaction
 * with the guards of the post's own dialog.
 */
export class SplitByTermDto {
  @IsArray({ message: 'subjects: ett eller två ämnen, det första för den första halvan i den första perioden.' })
  @ArrayMinSize(1, { message: 'subjects: ett eller två ämnen, det första för den första halvan i den första perioden.' })
  @ArrayMaxSize(2, { message: 'subjects: ett eller två ämnen, det första för den första halvan i den första perioden.' })
  @ValidateNested({ each: true })
  @Type(() => TermSubjectDto)
  subjects!: TermSubjectDto[];

  /** The autumn to the day before, the spring from it; or `periods` instead. */
  @IsOptional()
  @IsCalendarDate()
  springStartDate?: string;

  @IsOptional()
  @IsArray({ message: 'periods: två perioder, den första före den andra.' })
  @ArrayMinSize(2, { message: 'periods: två perioder, den första före den andra.' })
  @ArrayMaxSize(2, { message: 'periods: två perioder, den första före den andra.' })
  @ValidateNested({ each: true })
  @Type(() => TermPeriodDto)
  periods?: TermPeriodDto[];

  /** Mirrors the timplanspost's own bounds; the grid and the kinds are the service's. */
  @IsOptional()
  @IsArray({ message: 'lessons: anges som en lista med en längd per lektion.' })
  @ArrayMinSize(1, { message: 'lessons: minst en lektion i veckan.' })
  @ArrayMaxSize(40, { message: 'lessons: högst 40 lektioner per vecka.' })
  @IsInt({ each: true, message: 'lessons: varje längd anges i hela minuter.' })
  @Min(15, { each: true, message: 'lessons: minst 15 minuter per lektion.' })
  @Max(240, { each: true, message: 'lessons: högst 240 minuter per lektion.' })
  lessons?: number[];

  @IsOptional()
  @IsArray()
  @ArrayMinSize(2)
  @ArrayMaxSize(2)
  @IsString({ each: true })
  @IsNotEmpty({ each: true })
  @MaxLength(60, { each: true })
  halfNames?: string[];

  /**
   * The class's two halves, the first half first, when it has them: the
   * order the client drew. Omitted, the halves are taken by name.
   */
  @IsOptional()
  @IsArray()
  @ArrayMinSize(2)
  @ArrayMaxSize(2)
  @IsUUID('4', { each: true, message: 'halfIds: varje halva anges med sitt id.' })
  halfIds?: string[];

  @IsOptional()
  @IsArray()
  @ArrayMinSize(2)
  @ArrayMaxSize(2)
  @IsString({ each: true })
  @MaxLength(200, { each: true, message: 'blockNames: ett block har ett namn på högst 80 tecken.' })
  blockNames?: string[];

  @IsOptional()
  @ValidateNested()
  @Type(() => AdjustedPostDto)
  adjustedPost?: AdjustedPostDto;
}
