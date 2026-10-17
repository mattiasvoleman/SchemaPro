import type { GradeNumbering } from '@prisma/client';
import {
  IsBoolean,
  IsIn,
  IsNotEmpty,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
} from 'class-validator';

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export class CreateAcademicYearDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(60)
  name!: string;

  @Matches(ISO_DATE, { message: 'startDate must be YYYY-MM-DD.' })
  startDate!: string;

  @Matches(ISO_DATE, { message: 'endDate must be YYYY-MM-DD.' })
  endDate!: string;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  /**
   * The numbering of the läsår's årskurser (20261121091000). Left out, the
   * database fills it: NIOARIG before 2028-07-01, else the school's latest
   * läsår from that date, else TIOARIG. NIOARIG for a läsår from HT 2028 says
   * the school is not one of the four forms SFS 2025:729 renumbers. Written
   * once: the PATCH below does not take it.
   */
  @IsOptional()
  @IsIn(['NIOARIG', 'TIOARIG'], { message: "gradeNumbering: 'NIOARIG' eller 'TIOARIG'." })
  gradeNumbering?: GradeNumbering;
}

export class UpdateAcademicYearDto {
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(60)
  name?: string;

  @IsOptional()
  @Matches(ISO_DATE, { message: 'startDate must be YYYY-MM-DD.' })
  startDate?: string;

  @IsOptional()
  @Matches(ISO_DATE, { message: 'endDate must be YYYY-MM-DD.' })
  endDate?: string;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}
