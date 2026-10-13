import { ArrayMaxSize, IsArray, IsOptional, IsString, IsUUID, MaxLength } from 'class-validator';

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

/** Every field optional: a rename, a new membership, or both. */
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
}
