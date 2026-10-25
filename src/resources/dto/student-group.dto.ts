import { StudentGroupKind } from '@prisma/client';
import { Type } from 'class-transformer';
import {
  IsEnum,
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

  /**
   * Ersättande grupper: the subject whose other lessons this teaching group's
   * members leave (SvA7 replaces Svenska), or null for none. Only a teaching
   * group that is not a half may replace (400 REPLACING_GROUP_NOT_A_TEACHING_GROUP;
   * the CHECK StudentGroups_only_a_teaching_group_replaces is the second
   * line), and the subject is one of the school's.
   */
  @IsOptional()
  @IsUUID('4')
  replacesSubjectId?: string | null;
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

  /**
   * Ersättande grupper: the subject whose other lessons this teaching group's
   * members leave (SvA7 replaces Svenska), or null for none. Only a teaching
   * group that is not a half may replace (400 REPLACING_GROUP_NOT_A_TEACHING_GROUP;
   * the CHECK StudentGroups_only_a_teaching_group_replaces is the second
   * line), and the subject is one of the school's.
   */
  @IsOptional()
  @IsUUID('4')
  replacesSubjectId?: string | null;
}

/**
 * "Dela klassen" (Halvklasser): the class split in two halves, named by the
 * school or, by default, after the class ("7A:1", "7A:2").
 */
export class SplitClassDto {
  @IsOptional()
  @IsArray()
  @ArrayMinSize(2)
  @ArrayMaxSize(2)
  @IsString({ each: true })
  @IsNotEmpty({ each: true })
  @MaxLength(60, { each: true })
  names?: string[];
}

/** One half and the pupils placed in it. */
export class HalfPlacementDto {
  @IsUUID('4')
  groupId!: string;

  @IsArray()
  @ArrayMaxSize(500)
  @IsUUID('4', { each: true })
  studentIds!: string[];
}

/**
 * Which pupil of the class is in which half: EVERY half of the class, each
 * with its complete list. It replaces the class's placement, so a pupil moved
 * from 7A:1 to 7A:2 is one save, and a pupil in neither list is unplaced.
 */
export class PlaceHalvesDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(10)
  @ValidateNested({ each: true })
  @Type(() => HalfPlacementDto)
  halves!: HalfPlacementDto[];
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
