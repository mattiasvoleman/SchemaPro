import { ArrayMaxSize, IsArray, IsIn, IsInt, IsNotEmpty, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';
import type { SchoolUnitType } from '@prisma/client';
import { SCHOOL_UNIT_TYPES } from '../school-unit-map';

/**
 * A skolenhet as the admin writes it. The code arrives as typed (spaces
 * allowed, "1234 5678") and is normalised by the service; the span is both
 * ends or neither, which the service checks, since a PATCH may send one.
 */
export class CreateSchoolUnitDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(300)
  name!: string;

  @IsOptional()
  @IsString()
  @MaxLength(20)
  code?: string | null;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(SCHOOL_UNIT_TYPES.length * 2)
  @IsIn(SCHOOL_UNIT_TYPES as string[], { each: true })
  schoolTypes?: SchoolUnitType[];

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(10)
  gradeFrom?: number | null;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(10)
  gradeTo?: number | null;
}

export class UpdateSchoolUnitDto {
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(300)
  name?: string;

  @IsOptional()
  @IsString()
  @MaxLength(20)
  code?: string | null;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(SCHOOL_UNIT_TYPES.length * 2)
  @IsIn(SCHOOL_UNIT_TYPES as string[], { each: true })
  schoolTypes?: SchoolUnitType[];

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(10)
  gradeFrom?: number | null;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(10)
  gradeTo?: number | null;
}
