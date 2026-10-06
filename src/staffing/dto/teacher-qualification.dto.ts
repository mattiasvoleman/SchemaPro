import { TeacherQualificationKind } from '@prisma/client';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { IsCalendarDate } from '../../resources/dto/is-calendar-date';

/**
 * One behörighet: a subject, the inclusive grade span it covers, and which of
 * the three kinds the teacher holds.
 *
 * ONE ROW PER SUBJECT. Ma 1-6 plus Ma 7-9 is written as one row 1-9, which the
 * table's unique (school, teacher, subject) enforces and the service refuses a
 * duplicate of by name. A kind has NO default anywhere — which of the three a
 * teacher holds is stated, never presumed, because LEGITIMATION is a legal
 * fact about a person and TILLÅTEN is a rektor's decision.
 *
 * The bounds mirror the table's CHECKs; the two cross-field rules (max ≥ min,
 * validTo ≥ validFrom) are the service's.
 */
export class TeacherQualificationItemDto {
  @IsUUID('4', { message: 'Ämnet anges med sitt id.' })
  subjectId!: string;

  @IsInt({ message: 'Lägsta årskurs anges som ett heltal.' })
  @Min(0, { message: 'Lägsta årskurs är 0 (förskoleklass).' })
  @Max(12, { message: 'Högsta möjliga årskurs är 12.' })
  minGradeLevel!: number;

  @IsInt({ message: 'Högsta årskurs anges som ett heltal.' })
  @Min(0, { message: 'Lägsta årskurs är 0 (förskoleklass).' })
  @Max(12, { message: 'Högsta möjliga årskurs är 12.' })
  maxGradeLevel!: number;

  @IsEnum(TeacherQualificationKind, {
    message: 'Behörigheten är LEGITIMATION, BEHORIG eller TILLATEN.',
  })
  kind!: TeacherQualificationKind;

  /** Tidsbegränsad legitimation. Either alone is legal. */
  @IsOptional()
  @IsCalendarDate()
  validFrom?: string | null;

  @IsOptional()
  @IsCalendarDate()
  validTo?: string | null;

  @IsOptional()
  @IsString({ message: 'Anteckningen anges som text.' })
  @MaxLength(500, { message: 'Anteckningen kan vara högst 500 tecken.' })
  note?: string | null;
}

/**
 * The teacher's whole list, REPLACED wholesale — the pattern of
 * PUT student-groups/:id/members. A repeated call is idempotent, the form saves
 * exactly what it displays, and an empty list is how a school takes every
 * behörighet away. Capped at 100: a grundskola has a few dozen subjects, and a
 * teacher qualified in a hundred is a client bug, not a person.
 */
export class ReplaceTeacherQualificationsDto {
  @IsArray()
  @ArrayMaxSize(100)
  @ValidateNested({ each: true })
  @Type(() => TeacherQualificationItemDto)
  items!: TeacherQualificationItemDto[];
}
