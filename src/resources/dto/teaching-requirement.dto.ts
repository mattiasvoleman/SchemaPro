import {
  IsInt,
  IsOptional,
  IsUUID,
  Max,
  Min,
  ValidateIf,
} from 'class-validator';

export class CreateTeachingRequirementDto {
  @IsUUID('4')
  academicYearId!: string;

  @IsUUID('4')
  subjectId!: string;

  @IsUUID('4')
  studentGroupId!: string;

  @ValidateIf((dto: CreateTeachingRequirementDto) => dto.teacherId !== null)
  @IsOptional()
  @IsUUID('4')
  teacherId?: string | null;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(40)
  lessonsPerWeek?: number;

  @IsOptional()
  @IsInt()
  @Min(15)
  @Max(240)
  minutesPerLesson?: number;
}

export class UpdateTeachingRequirementDto {
  @ValidateIf((dto: UpdateTeachingRequirementDto) => dto.teacherId !== null)
  @IsOptional()
  @IsUUID('4')
  teacherId?: string | null;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(40)
  lessonsPerWeek?: number;

  @IsOptional()
  @IsInt()
  @Min(15)
  @Max(240)
  minutesPerLesson?: number;
}
