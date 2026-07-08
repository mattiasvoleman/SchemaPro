import { IsOptional, IsString, IsUUID, MaxLength } from 'class-validator';

/** Cancels a scheduled lesson, optionally recording a reason. */
export class CancelLessonDto {
  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;
}

/** Assigns a substitute teacher to a single calendar lesson. */
export class AssignSubstituteDto {
  @IsUUID('4')
  teacherId!: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;
}
