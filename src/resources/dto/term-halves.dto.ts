import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  ValidateNested,
} from 'class-validator';
import { IsCalendarDate } from './is-calendar-date';

/** One of the two subjects a term split swaps, and who teaches it. */
export class TermSubjectDto {
  @IsUUID('4', { message: 'subjects: varje ämne anges med sitt id.' })
  subjectId!: string;

  /** Null or omitted leaves the subject's two posts without a teacher. */
  @IsOptional()
  @IsUUID('4', { message: 'subjects: läraren anges med sitt id.' })
  teacherId?: string | null;
}

/**
 * "Dela terminsvis i halvklass" (term-halves.service.ts): a class's post
 * replaced by four on the class's two halves. `subjects[0]` is the first
 * half's subject in the autumn and the second half's in the spring,
 * `subjects[1]` the other way round; the spring term starts on
 * `springStartDate`. `halfNames` names the halves when the class has none yet
 * ("7A:1", "7A:2" if omitted), and `blockNames` the two parallel blocks, the
 * autumn's first (named after the post if omitted).
 */
export class SplitByTermDto {
  @IsArray({ message: 'subjects: två ämnen, ett för varje halva på hösten.' })
  @ArrayMinSize(2, { message: 'subjects: två ämnen, ett för varje halva på hösten.' })
  @ArrayMaxSize(2, { message: 'subjects: två ämnen, ett för varje halva på hösten.' })
  @ValidateNested({ each: true })
  @Type(() => TermSubjectDto)
  subjects!: TermSubjectDto[];

  @IsCalendarDate()
  springStartDate!: string;

  @IsOptional()
  @IsArray()
  @ArrayMinSize(2)
  @ArrayMaxSize(2)
  @IsString({ each: true })
  @IsNotEmpty({ each: true })
  @MaxLength(60, { each: true })
  halfNames?: string[];

  @IsOptional()
  @IsArray()
  @ArrayMinSize(2)
  @ArrayMaxSize(2)
  @IsString({ each: true })
  @MaxLength(200, { each: true, message: 'blockNames: ett block har ett namn på högst 80 tecken.' })
  blockNames?: string[];
}
