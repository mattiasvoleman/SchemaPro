import {
  ArrayMaxSize,
  IsArray,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  ValidateIf,
} from 'class-validator';

/** Omitted is allowed; null is validated, and refused, like any other value. */
const presentOrNull = (_: object, value: unknown): boolean => value !== undefined;

/**
 * A parallel block: timplansposter of one läsår whose lessons are placed at
 * the same times — "Språkval åk 7" holds Spanska, Tyska and Franska for the
 * teaching groups cut across the year's classes.
 *
 * The name is trimmed by the service and must then be 1..80 characters, the
 * bound TeachingBlocks_name_is_sane holds for PostgREST too. `requirementIds`
 * is the block's whole membership: rows named join, rows not named leave.
 * 40 is the most a block may hold in one request, generous beside an elevens
 * val of eight groups and a gymnasium band of a dozen.
 */
export class CreateTeachingBlockDto {
  @IsUUID('4')
  academicYearId!: string;

  @IsString({ message: 'name: blocket behöver ett namn.' })
  @MaxLength(200, { message: 'name: blocket behöver ett namn på högst 80 tecken.' })
  name!: string;

  @IsOptional()
  @IsArray({ message: 'requirementIds: anges som en lista med timplansposternas id.' })
  @ArrayMaxSize(40, { message: 'requirementIds: ett block har högst 40 timplansposter.' })
  @IsUUID('4', { each: true, message: 'requirementIds: varje post anges med sitt id.' })
  requirementIds?: string[];
}

/**
 * Every field optional: a rename, a new membership, the block's lessons, or
 * any of them together.
 *
 * THE LESSONS ARE THE WHOLE BLOCK'S. lessonsPerWeek, minutesPerLesson and
 * lessonLengths mean what they mean on a timplanspost (the same bounds as
 * CreateTeachingRequirementDto), merged over the members' shape by the
 * timplanspost's own merge and written to every member in one UPDATE, so the
 * block trigger judges the block as it ends up. A membership in the same
 * request is written first, and the lessons then go to every member of it.
 */
export class UpdateTeachingBlockDto {
  @IsOptional()
  @IsString({ message: 'name: blocket behöver ett namn.' })
  @MaxLength(200, { message: 'name: blocket behöver ett namn på högst 80 tecken.' })
  name?: string;

  @IsOptional()
  @IsArray({ message: 'requirementIds: anges som en lista med timplansposternas id.' })
  @ArrayMaxSize(40, { message: 'requirementIds: ett block har högst 40 timplansposter.' })
  @IsUUID('4', { each: true, message: 'requirementIds: varje post anges med sitt id.' })
  requirementIds?: string[];

  @ValidateIf(presentOrNull)
  @IsInt({ message: 'lessonsPerWeek: anges som ett heltal.' })
  @Min(1, { message: 'lessonsPerWeek: minst 1 lektion per vecka.' })
  @Max(40, { message: 'lessonsPerWeek: högst 40 lektioner per vecka.' })
  lessonsPerWeek?: number;

  @ValidateIf(presentOrNull)
  @IsInt({ message: 'minutesPerLesson: anges i hela minuter.' })
  @Min(15, { message: 'minutesPerLesson: minst 15 minuter per lektion.' })
  @Max(240, { message: 'minutesPerLesson: högst 240 minuter per lektion.' })
  minutesPerLesson?: number;

  @ValidateIf(presentOrNull)
  @IsArray({ message: 'lessonLengths: anges som en lista med en längd per lektion.' })
  @ArrayMaxSize(40, { message: 'lessonLengths: högst 40 lektioner per vecka.' })
  @IsInt({ each: true, message: 'lessonLengths: varje längd anges i hela minuter.' })
  @Min(15, { each: true, message: 'lessonLengths: minst 15 minuter per lektion.' })
  @Max(240, { each: true, message: 'lessonLengths: högst 240 minuter per lektion.' })
  lessonLengths?: number[];
}
