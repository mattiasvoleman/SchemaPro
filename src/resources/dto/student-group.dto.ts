import { StudentGroupKind } from '@prisma/client';
import {
  IsEnum,
  ArrayMaxSize,
  IsArray,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

export class CreateStudentGroupDto {
  @IsUUID('4')
  academicYearId!: string;

  /**
   * CLASS by default: the common case, and the safe one — a group wrongly
   * marked as a teaching group would silently stop being every member's home
   * class.
   */
  @IsOptional()
  @IsEnum(StudentGroupKind)
  kind?: StudentGroupKind;

  @IsString()
  @IsNotEmpty()
  @MaxLength(60)
  name!: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(12)
  gradeLevel?: number | null;
}

export class UpdateStudentGroupDto {
  @IsOptional()
  @IsUUID('4')
  academicYearId?: string;

  @IsOptional()
  @IsEnum(StudentGroupKind)
  kind?: StudentGroupKind;

  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(60)
  name?: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(12)
  gradeLevel?: number | null;
}

export class SetGroupMembersDto {
  /**
   * The complete membership list — the endpoint REPLACES, never appends, so a
   * repeated call is idempotent and the UI can save exactly what it displays.
   */
  @IsArray()
  @ArrayMaxSize(500)
  @IsUUID('4', { each: true })
  studentIds!: string[];
}
