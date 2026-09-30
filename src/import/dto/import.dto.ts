import { LessonRecurrence } from '@prisma/client';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsEmail,
  IsEnum,
  IsHexColor,
  IsIn,
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
import { IsCalendarDate } from '../../resources/dto/is-calendar-date';

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

export class ImportRequirementRowDto {
  /** Group NAME as the timplan writes it (7A, Ma71) — resolved server-side. */
  @IsString()
  @IsNotEmpty()
  @MaxLength(60)
  groupName!: string;

  /**
   * The subject's CODE or NAME, whichever the school wrote in the cell. Both
   * are accepted because both appear in real timplaner — the short code in the
   * columns of a matrix, the full name in a list. 120 is the wider of the two
   * columns (Subject.name); a code is far shorter and needs no separate cap.
   */
  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  subject!: string;

  // The numeric bounds are the ones CreateTeachingRequirementDto states,
  // repeated rather than shared: they are the DTO's contract with the CSV, and
  // a row that scrapes past them here would only fail deeper in with a message
  // about a column the school never typed.
  @IsInt()
  @Min(1)
  @Max(40)
  lessonsPerWeek!: number;

  @IsInt()
  @Min(15)
  @Max(240)
  minutesPerLesson!: number;

  /**
   * Minutes the PUPILS are occupied outside the lesson: ombyte before
   * idrotten, dusch and ombyte after it. What they block, and what they
   * deliberately leave alone, is argued on CreateTeachingRequirementDto.
   *
   * OPTIONAL where the two above are required, and an absent or empty cell is 0
   * rather than a row error. Most subjects need no ombyte at all, so requiring
   * the columns would make every school type two zeroes per row to say nothing
   * — and a timplan a school wrote before these columns existed would stop
   * importing. Whether a 0 that arrives this way is written is decided in
   * `importRequirements`, not here: the file's column set travels separately
   * (see `columns`), which is what keeps "the file has no such column" from
   * reading as "set it to 0" on a requirement somebody gave a number in the app.
   *
   * 0..60 mirrors the CHECK constraints on the columns, like the create DTO, so
   * a number the database would refuse is refused here with the field named.
   */
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(60)
  minutesBefore?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(60)
  minutesAfter?: number;

  /** Lead teacher by email; empty column = no teacher assigned yet. */
  @IsOptional()
  @IsEmail()
  @MaxLength(254)
  teacherEmail?: string | null;

  /** Second teacher scheduled alongside the lead (co-teaching). */
  @IsOptional()
  @IsEmail()
  @MaxLength(254)
  coTeacherEmail?: string | null;

  /**
   * Already an enum here: the file says "alla"/"udda"/"jämna" for humans and
   * web/lib/csv.ts folds those (and their diacritic-free spellings) into the
   * enum while parsing. The API validates a value, not a vocabulary — the same
   * split the rest of this file makes between browser-side CSV shape and
   * server-side meaning.
   */
  @IsEnum(LessonRecurrence)
  recurrence!: LessonRecurrence;

  /**
   * The period, as `CreateTeachingRequirementDto` states it: plain YYYY-MM-DD
   * against `@IsCalendarDate`, not `@IsDateString`. Reusing the decorator
   * rather than adding a second regex here is the point — the shape check
   * alone let 2026-02-30 through and everything downstream rolled it silently
   * to 2026-03-02 (see is-calendar-date.ts).
   *
   * Whether the dates fit inside the läsår is NOT decided here: that needs the
   * year's bounds from the database, and it has to fail one row rather than the
   * whole upload. See `importRequirements`.
   */
  @IsOptional()
  @IsCalendarDate()
  startDate?: string | null;

  @IsOptional()
  @IsCalendarDate()
  endDate?: string | null;
}

/**
 * Every column a timplan file may carry — all eleven, not only the seven that
 * can be left out.
 *
 * The field means "which columns the file had", so the client reports the whole
 * header and the server takes what it needs. Narrowing this to the optional
 * ones was tried first and is wrong twice over: it makes an honest client
 * report a 400, and it puts the server's idea of which columns matter into the
 * wire format, so adding a writable column later would need the client to learn
 * about it before the server could use it.
 *
 * The two pupil buffers are the case that argument was written for. The header
 * is validated with `forbidNonWhitelisted`, so until this list knows a column
 * name the web cannot send it at all — the file round trip had to start here.
 *
 * Mirrors the keys of REQUIREMENT_COLUMNS in web/lib/csv.ts.
 */
export const REQUIREMENT_FILE_COLUMNS = [
  'groupName',
  'subject',
  'lessonsPerWeek',
  'minutesPerLesson',
  'minutesBefore',
  'minutesAfter',
  'teacherEmail',
  'coTeacherEmail',
  'recurrence',
  'startDate',
  'endDate',
] as const;

export type RequirementFileColumn = (typeof REQUIREMENT_FILE_COLUMNS)[number];

/**
 * The subset an import may leave standing. The other four are required of every
 * file and always written, so naming them changes nothing.
 *
 * The two buffers belong here and not among the required four for the reason the
 * teacher does: a school's own spreadsheet is usually just the four columns, and
 * uploading it to correct one lesson count must not zero an ombyte somebody
 * entered in the app. They are optional in the other direction too — a column
 * the file HAS with an empty cell means 0 — which is `importRequirements`'
 * business, not this list's.
 */
export const OPTIONAL_REQUIREMENT_COLUMNS = [
  'minutesBefore',
  'minutesAfter',
  'teacherEmail',
  'coTeacherEmail',
  'recurrence',
  'startDate',
  'endDate',
] as const;

export type OptionalRequirementColumn =
  (typeof OPTIONAL_REQUIREMENT_COLUMNS)[number];

export class ImportRequirementsDto {
  /** From the dialog, as for teachingGroups — never a column in the file. */
  @IsUUID('4')
  academicYearId!: string;

  /**
   * Which optional columns the FILE had — not which values the rows carry.
   *
   * This import updates rather than skips, so every field it writes replaces
   * something a school already entered, and a column the file never had must be
   * left exactly as it is. The rows cannot say that themselves: the global
   * ValidationPipe runs class-transformer, which materialises every declared
   * property, so a row posted without `teacherEmail` reaches the service with
   * `teacherEmail` present and undefined — the same shape as a cell someone
   * deliberately emptied. Measured inside the service, not assumed.
   *
   * Absent means the file had none of them, which is a legitimate four-column
   * file and writes only the lesson count and length. It is optional rather
   * than required so that a caller that is not the dialog cannot accidentally
   * reset seven fields by forgetting a key — the safe reading of silence is
   * "change nothing else".
   */
  @IsOptional()
  @IsArray()
  @IsIn(REQUIREMENT_FILE_COLUMNS as unknown as string[], { each: true })
  columns?: RequirementFileColumn[];

  // Capped between the people imports (500) and memberships (2000): a timplan
  // has one row per group and subject, so a large secondary school runs to a
  // few hundred, and 1000 leaves headroom without turning the endpoint into a
  // bulk pipe.
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(1000)
  @ValidateNested({ each: true })
  @Type(() => ImportRequirementRowDto)
  rows!: ImportRequirementRowDto[];
}

/** Uniform outcome: idempotent re-uploads land in `skipped`, never `errors`. */
export interface ImportReport {
  created: number;
  skipped: number;
  /**
   * Rows that already existed and were CHANGED by the upload. Optional, and
   * left undefined by the six create-only kinds, so none of them had to grow a
   * field that would always read 0 — only the timplan import updates.
   */
  updated?: number;
  /** 1-based DATA row numbers (the header row is not counted). */
  errors: { row: number; message: string }[];
}
