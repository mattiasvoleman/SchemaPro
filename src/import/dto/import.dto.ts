import {
  LessonRecurrence,
  TeacherContractKind,
  TeacherDutyKind,
  TeacherQualificationKind,
} from '@prisma/client';
import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsEmail,
  IsEnum,
  IsHexColor,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsNumber,
  IsObject,
  IsOptional,
  IsPositive,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { MaxCodePoints } from '../../common/utils/max-code-points';
import { LOCAL_TIMPLAN_MAX_ENTRIES } from '../../timplan/dto/local-timplan.dto';
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

  /**
   * The teacher's post for the ACTIVE läsår, optional column by column.
   *
   * A staff list is usually three columns wide and stays importable as such;
   * a file that also carries tjänstgöringsgrad writes a TeacherEmployment for
   * the active year — created when none exists, updated when the file says
   * something else — which is why this is the second import kind that updates
   * (see importTeachers). The other three columns mean nothing without
   * employmentPercent and are a row error with it absent: half a post cannot
   * be read.
   *
   * The bounds mirror UpsertTeacherEmploymentDto and the table's CHECKs, with
   * the same Swedish messages, so a cell the database would refuse is refused
   * here with the column named.
   */
  @IsOptional()
  @IsNumber(
    { maxDecimalPlaces: 3 },
    { message: 'Tjänstgöringsgraden anges i procent med högst tre decimaler.' },
  )
  @IsPositive({ message: 'En tjänstgöringsgrad på 0 % är ingen tjänst — lämna cellen tom.' })
  @Max(100, { message: 'En tjänstgöringsgrad över 100 % är inte en tjänst.' })
  employmentPercent?: number | null;

  @IsOptional()
  @IsNumber(
    { maxDecimalPlaces: 3 },
    { message: 'Nedsättningen anges i procent med högst tre decimaler.' },
  )
  @Min(0, { message: 'Nedsättningen kan inte vara negativ.' })
  @Max(100, { message: 'En nedsättning över 100 % är mer än hela tjänsten.' })
  reductionPercent?: number | null;

  @IsOptional()
  @IsEnum(TeacherContractKind, { message: 'Avtalsformen är FERIE eller SEMESTER.' })
  contractKind?: TeacherContractKind | null;

  @IsOptional()
  @IsString({ message: 'Signaturen anges som text.' })
  @MinLength(1, { message: 'Signaturen måste vara minst ett tecken.' })
  @MaxLength(8, { message: 'Signaturen kan vara högst åtta tecken.' })
  @Matches(/\S/, { message: 'Signaturen kan inte bestå av bara mellanslag.' })
  signature?: string | null;
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

  /**
   * The national ämneskod the subject feeds ('MA', 'SV_SVA', 'BI'), or empty
   * for a subject outside the national timplan. Checked for SHAPE here and for
   * EXISTENCE against NationalSubjects in the service, where an unknown code
   * fails the row with the code named — like an unknown room type, and for the
   * same reason: creating the subject without its mapping would leave every
   * timplan sum silently short of it.
   */
  @IsOptional()
  @IsString()
  @MaxLength(20)
  nationalCode?: string | null;

  /**
   * Whether the subject is undervisningstid in the statute's sense. An empty
   * cell is null here, unlike the API DTO's refusal of null: a CSV column is
   * either filled or empty, and empty can only mean the default (true), which
   * the service writes.
   */
  @IsOptional()
  @IsBoolean({
    message:
      'countsTowardTimplan: om ämnet räknas som undervisningstid anges med true eller false.',
  })
  countsTowardTimplan?: boolean | null;
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
   * What each teacher is charged in the tjänstefördelning, 0..200 % — the
   * columns CreateTeachingRequirementDto states, with its messages. Optional
   * like the buffers and for their reason: an absent column leaves the stored
   * figure alone, an EMPTY cell in a column the file has is the default, 100.
   */
  @IsOptional()
  @IsInt({ message: 'teacherLoadPercent: anges som ett heltal i procent.' })
  @Min(0, { message: 'teacherLoadPercent: kan inte vara negativ.' })
  @Max(200, { message: 'teacherLoadPercent: högst 200 %.' })
  teacherLoadPercent?: number | null;

  @IsOptional()
  @IsInt({ message: 'coTeacherLoadPercent: anges som ett heltal i procent.' })
  @Min(0, { message: 'coTeacherLoadPercent: kan inte vara negativ.' })
  @Max(200, { message: 'coTeacherLoadPercent: högst 200 %.' })
  coTeacherLoadPercent?: number | null;

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
  'teacherLoadPercent',
  'coTeacherLoadPercent',
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
  'teacherLoadPercent',
  'coTeacherLoadPercent',
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

export class ImportTeacherQualificationRowDto {
  /** The teacher's email — the id a school actually has in its lists. */
  @IsEmail()
  @MaxLength(254)
  teacherEmail!: string;

  /** The subject's CODE or NAME, whichever the school wrote; see the timplan row. */
  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  subject!: string;

  /** Inclusive span, 0..12, as the table CHECKs it; max ≥ min is the service's. */
  @IsInt({ message: 'Lägsta årskurs anges som ett heltal.' })
  @Min(0, { message: 'Lägsta årskurs är 0 (förskoleklass).' })
  @Max(12, { message: 'Högsta möjliga årskurs är 12.' })
  minGrade!: number;

  @IsInt({ message: 'Högsta årskurs anges som ett heltal.' })
  @Min(0, { message: 'Lägsta årskurs är 0 (förskoleklass).' })
  @Max(12, { message: 'Högsta möjliga årskurs är 12.' })
  maxGrade!: number;

  /**
   * Already an enum here, like a timplan row's recurrence: the file says
   * "legitimation"/"behörig"/"tillåten" for humans and the browser folds those
   * into the enum while parsing. No default — which of the three a teacher
   * holds is stated, never presumed.
   */
  @IsEnum(TeacherQualificationKind, {
    message: 'Behörigheten är LEGITIMATION, BEHORIG eller TILLATEN.',
  })
  kind!: TeacherQualificationKind;
}

/**
 * Behörigheter in bulk. No academicYearId: a legitimation belongs to the
 * person, not to a year. Capped like memberships — one row per teacher and
 * subject, so even a large school runs to a few hundred.
 */
export class ImportTeacherQualificationsDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(2000)
  @ValidateNested({ each: true })
  @Type(() => ImportTeacherQualificationRowDto)
  rows!: ImportTeacherQualificationRowDto[];
}

/**
 * One uppdrag from a file: lärare (email), typ, benämning, minuter per vecka,
 * and optionally whether it counts as teaching, its ämne (code or name), its
 * grupp (by name, in the dialog's year) and a note.
 *
 * NO BLOCKED TIME. A fixed slot is a constraint the solver honours, created
 * and moved with the uppdrag in one transaction by POST /teacher-duties; a
 * spreadsheet of 300 rastvakter is not where a school places them on the
 * week, and a file that silently moved them would move the timetable.
 *
 * The bounds are CreateTeacherDutyDto's — the table's CHECKs — with its
 * messages, repeated rather than shared as the requirements row repeats its
 * create DTO.
 */
export class ImportTeacherDutyRowDto {
  @IsEmail({}, { message: 'teacherEmail: anges som lärarens e-postadress.' })
  @MaxLength(254)
  teacherEmail!: string;

  /**
   * Already an enum here: the browser folds "mentor", "rastvakt", "APT" and
   * their spellings into it while parsing, as it does a recurrence.
   */
  @IsEnum(TeacherDutyKind, {
    message:
      'kind: MENTORSKAP, AMNESANSVAR, FORSTELARARE, RASTVAKT, PEDAGOGISK_LUNCH, APT_KONFERENS, VFU_HANDLEDNING, APL eller ANNAT.',
  })
  kind!: TeacherDutyKind;

  @IsString({ message: 'label: anges som text.' })
  @MinLength(1, { message: 'label: får inte vara tom.' })
  @MaxCodePoints(80, { message: 'label: högst 80 tecken.' })
  @Matches(/\S/, { message: 'label: kan inte bestå av bara mellanslag.' })
  label!: string;

  @IsInt({ message: 'minutesPerWeek: anges i hela minuter per vecka.' })
  @Min(1, { message: 'minutesPerWeek: minst 1 minut per vecka.' })
  @Max(2400, { message: 'minutesPerWeek: högst 2400 minuter (40 timmar) per vecka.' })
  minutesPerWeek!: number;

  /** Empty cell: false, the column's default. */
  @IsOptional()
  @IsBoolean({ message: 'countsAsTeaching: om uppdraget räknas som undervisning anges med true eller false.' })
  countsAsTeaching?: boolean | null;

  /** The subject's CODE or NAME, as on every other kind. */
  @IsOptional()
  @IsString()
  @MaxLength(120)
  subject?: string | null;

  /** A group of the dialog's year, by name (Mentor 7B → 7B). */
  @IsOptional()
  @IsString()
  @MaxLength(60)
  groupName?: string | null;

  @IsOptional()
  @IsString({ message: 'note: anges som text.' })
  @MaxCodePoints(500, { message: 'note: högst 500 tecken.' })
  note?: string | null;
}

/** Every column an uppdrag file may carry; see REQUIREMENT_FILE_COLUMNS for why the whole header. */
export const TEACHER_DUTY_FILE_COLUMNS = [
  'teacherEmail',
  'kind',
  'label',
  'minutesPerWeek',
  'countsAsTeaching',
  'subject',
  'groupName',
  'note',
] as const;

export type TeacherDutyFileColumn = (typeof TEACHER_DUTY_FILE_COLUMNS)[number];

export class ImportTeacherDutiesDto {
  /** The läsår the uppdrag belong to, from the dialog — never a column. */
  @IsUUID('4')
  academicYearId!: string;

  /**
   * Which columns the FILE had. The four optional ones are written only when
   * present, so a re-upload of a four-column file does not clear the subject,
   * class, note or countsAsTeaching somebody set in the app. Absent: none.
   */
  @IsOptional()
  @IsArray()
  @IsIn(TEACHER_DUTY_FILE_COLUMNS as unknown as string[], { each: true })
  columns?: TeacherDutyFileColumn[];

  // One row per teacher and uppdrag; a school of 80 teachers with five each
  // is 400. 2000, as memberships and behörigheter.
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(2000)
  @IsObject({ each: true, message: 'rows: varje rad anges som ett objekt.' })
  @ValidateNested({ each: true })
  @Type(() => ImportTeacherDutyRowDto)
  rows!: ImportTeacherDutyRowDto[];
}

/**
 * "F", "f" or a number 0..10, as a school writes an årskurs, made into the
 * integer the table holds — or left as it came, for @IsInt to refuse with the
 * sentence below. The browser may post either the cell's text or a number it
 * already parsed; both arrive here.
 */
export function parseTimplanGrade(value: unknown): unknown {
  if (typeof value === 'number') return value;
  if (typeof value !== 'string') return value;
  const text = value.trim();
  if (/^f$/i.test(text)) return 0;
  if (/^\d{1,2}$/.test(text)) return Number(text);
  return value;
}

const GRADE_MESSAGE = 'årskurs: anges som F (förskoleklass) eller ett heltal 0–10.';

/**
 * One row of a lokal timplan file: ämne, årskurs, minuter per vecka, notering.
 *
 * The bounds are LocalTimplanEntryDto's — the table's CHECKs — repeated rather
 * than shared, like the requirements row repeats its create DTO: they are this
 * DTO's contract with the CSV. The subject is a CODE or NAME, resolved
 * server-side like every other kind's.
 */
export class ImportTimplanRowDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  subject!: string;

  @Transform(({ value }) => parseTimplanGrade(value))
  @IsInt({ message: GRADE_MESSAGE })
  @Min(0, { message: GRADE_MESSAGE })
  @Max(10, { message: GRADE_MESSAGE })
  gradeLevel!: number;

  @IsInt({ message: 'minuterPerVecka: anges i hela minuter.' })
  @Min(0, { message: 'minuterPerVecka: kan inte vara negativt.' })
  @Max(1200, { message: 'minuterPerVecka: högst 1200 minuter (20 timmar) per vecka i ett ämne.' })
  minutesPerWeek!: number;

  @IsOptional()
  @IsString({ message: 'notering: anges som text.' })
  // Code points, as the column's char_length counts (see MaxCodePoints).
  @MaxCodePoints(500, { message: 'notering: högst 500 tecken.' })
  note?: string | null;
}

/** Every column a timplan file may carry; see REQUIREMENT_FILE_COLUMNS for why the whole header. */
export const TIMPLAN_FILE_COLUMNS = ['subject', 'gradeLevel', 'minutesPerWeek', 'note'] as const;

export type TimplanFileColumn = (typeof TIMPLAN_FILE_COLUMNS)[number];

export class ImportTimplanDto {
  /** The DRAFT plan the rows go into, chosen in the dialog — never a column. */
  @IsUUID('4')
  localTimplanId!: string;

  /**
   * Which columns the FILE had. Only `note` is optional, and a file without
   * the column leaves every stored note as it is — the reason the
   * requirements import carries its header. Absent reads as "no note column".
   */
  @IsOptional()
  @IsArray()
  @IsIn(TIMPLAN_FILE_COLUMNS as unknown as string[], { each: true })
  columns?: TimplanFileColumn[];

  // Eleven årskurser × thirty-six subjects is 396; 400 is the entries PUT's
  // cap, so a file and the grid can hold the same plan.
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(LOCAL_TIMPLAN_MAX_ENTRIES)
  // Without it [[row]] passes: ValidateNested descends into the inner list.
  @IsObject({ each: true, message: 'rows: varje rad anges som ett objekt.' })
  @ValidateNested({ each: true })
  @Type(() => ImportTimplanRowDto)
  rows!: ImportTimplanRowDto[];
}

/** Uniform outcome: idempotent re-uploads land in `skipped`, never `errors`. */
export interface ImportReport {
  created: number;
  skipped: number;
  /**
   * Rows that already existed and were CHANGED by the upload. Optional, and
   * left undefined by the create-only kinds, so none of them had to grow a
   * field that would always read 0. The timplan import, the lokal timplan
   * import and the behörighet import update; the teachers import does when
   * the file carries a post.
   */
  updated?: number;
  /** 1-based DATA row numbers (the header row is not counted). */
  errors: { row: number; message: string }[];
}
