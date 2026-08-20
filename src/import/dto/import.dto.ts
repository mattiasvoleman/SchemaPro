import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsEmail,
  IsHexColor,
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

/**
 * Rows arrive as JSON: the browser parses the CSV (delimiter detection, BOM,
 * quoting — see web/lib/csv.ts) so this API validates typed fields instead of
 * re-implementing CSV parsing. Every list is capped: an import is a bounded
 * administrative action, not a bulk pipe.
 */

export class ImportStudentRowDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  firstName!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  lastName!: string;

  @IsEmail()
  @MaxLength(254)
  email!: string;

  /** Group NAME as the school writes it (7A) — resolved server-side. */
  @IsString()
  @IsNotEmpty()
  @MaxLength(60)
  className!: string;
}

export class ImportStudentsDto {
  @IsUUID('4')
  academicYearId!: string;

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(500)
  @ValidateNested({ each: true })
  @Type(() => ImportStudentRowDto)
  rows!: ImportStudentRowDto[];
}

export class ImportTeacherRowDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  firstName!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  lastName!: string;

  @IsEmail()
  @MaxLength(254)
  email!: string;
}

export class ImportTeachersDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(500)
  @ValidateNested({ each: true })
  @Type(() => ImportTeacherRowDto)
  rows!: ImportTeacherRowDto[];
}

export class ImportGroupRowDto {
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

export class ImportGroupsDto {
  @IsUUID('4')
  academicYearId!: string;

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(500)
  @ValidateNested({ each: true })
  @Type(() => ImportGroupRowDto)
  rows!: ImportGroupRowDto[];
}

export class ImportSubjectRowDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  name!: string;

  @IsOptional()
  @IsString()
  @MaxLength(20)
  code?: string | null;

  /** Hex colour as the schedule views render it (#4f46e5). */
  @IsOptional()
  @IsHexColor()
  color?: string | null;

  /**
   * Room type by NAME, not id — a CSV a school edits in Excel carries
   * "Textilslöjd", never a uuid. Resolved server-side against the school's own
   * list; an unknown name is reported as a row error rather than silently
   * dropping the requirement, which would leave the subject schedulable
   * anywhere.
   */
  @IsOptional()
  @IsString()
  @MaxLength(60)
  roomType?: string | null;
}

export class ImportSubjectsDto {
  // No academicYearId: subjects belong to the school, not to a year.
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(500)
  @ValidateNested({ each: true })
  @Type(() => ImportSubjectRowDto)
  rows!: ImportSubjectRowDto[];
}

export class ImportRoomTypeRowDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(60)
  name!: string;
}

export class ImportRoomTypesDto {
  // No academicYearId: room types belong to the school, not to a year — the
  // same slöjdsal exists across every läsår.
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(200)
  @ValidateNested({ each: true })
  @Type(() => ImportRoomTypeRowDto)
  rows!: ImportRoomTypeRowDto[];
}

export class ImportMembershipRowDto {
  /** Teaching-group NAME (Ma71); created on the fly when missing. */
  @IsString()
  @IsNotEmpty()
  @MaxLength(60)
  groupName!: string;

  /** The student's email — the id a school actually has in its lists. */
  @IsEmail()
  @MaxLength(254)
  email!: string;
}

export class ImportMembershipsDto {
  @IsUUID('4')
  academicYearId!: string;

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(2000)
  @ValidateNested({ each: true })
  @Type(() => ImportMembershipRowDto)
  rows!: ImportMembershipRowDto[];
}

/** Uniform outcome: idempotent re-uploads land in `skipped`, never `errors`. */
export interface ImportReport {
  created: number;
  skipped: number;
  /** 1-based DATA row numbers (the header row is not counted). */
  errors: { row: number; message: string }[];
}
