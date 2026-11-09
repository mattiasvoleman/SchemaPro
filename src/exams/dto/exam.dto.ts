import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsISO8601,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const CLOCK = /^([01]\d|2[0-3]):[0-5]\d$/;
const lower = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.toLowerCase() : value);
const trimmed = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);

export const EXAM_WINDOW_KINDS = ['WEEK', 'FIXED'] as const;
export type ExamWindowKind = (typeof EXAM_WINDOW_KINDS)[number];

/** The school's decisions about exams: whether the planner is on, the caps, the invigilators' ratio. */
export class ExamSettingsDto {
  @IsBoolean({ message: 'enabled: true eller false.' })
  enabled!: boolean;

  @IsInt()
  @Min(1)
  @Max(10)
  maxPerClassPerDay!: number;

  @IsInt()
  @Min(1)
  @Max(30)
  maxPerClassPerWeek!: number;

  @IsInt()
  @Min(1)
  @Max(200)
  writersPerInvigilator!: number;

  @IsInt()
  @Min(0)
  @Max(120)
  turnoverMinutes!: number;

  /** A subject that does not count toward the timplan; null leaves it unchosen. */
  @IsOptional()
  @IsUUID('4', { message: 'replacementSubjectId: ämnet anges med sitt id.' })
  replacementSubjectId?: string | null;
}

/** A room made a skrivsal, with the seats an exam has there. */
export class ExamRoomDto {
  @IsInt()
  @Min(1)
  @Max(2000)
  seats!: number;
}

/**
 * What the school asks of the planner: the exam, its classes and groups, and
 * the window it wants. The same fields on a create and on a change (the whole
 * description again, as an activity's).
 */
export class ExamDescriptionDto {
  @IsUUID('4', { message: 'subjectId: provets ämne anges med sitt id.' })
  subjectId!: string;

  @IsString()
  @Transform(trimmed)
  @MinLength(1, { message: 'name: provet behöver ett namn, till exempel "Matematik, algebra".' })
  // 80 less the "Prov: " the activity puts before it (an activity's name is 80 at most).
  @MaxLength(72)
  name!: string;

  @IsInt()
  @Min(5)
  @Max(480)
  lengthMinutes!: number;

  @IsInt()
  @Min(1)
  @Max(2000)
  writers!: number;

  @IsIn(EXAM_WINDOW_KINDS, { message: "windowKind: 'WEEK' eller 'FIXED'." })
  windowKind!: ExamWindowKind;

  @Matches(ISO_DATE, { message: 'windowFrom: YYYY-MM-DD.' })
  @IsISO8601({ strict: true }, { message: 'windowFrom: en dag som finns i kalendern.' })
  windowFrom!: string;

  @Matches(ISO_DATE, { message: 'windowTo: YYYY-MM-DD.' })
  @IsISO8601({ strict: true }, { message: 'windowTo: en dag som finns i kalendern.' })
  windowTo!: string;

  /** FIXED only: the start. */
  @IsOptional()
  @Matches(CLOCK, { message: 'fixedStart: HH:MM.' })
  fixedStart?: string;

  /** WEEK only: no earlier start than this on any day of the window. */
  @IsOptional()
  @Matches(CLOCK, { message: 'earliestStart: HH:MM.' })
  earliestStart?: string;

  /** WEEK only: no later end than this on any day of the window. */
  @IsOptional()
  @Matches(CLOCK, { message: 'latestEnd: HH:MM.' })
  latestEnd?: string;

  @IsArray()
  @ArrayMinSize(1, { message: 'groupIds: minst en klass eller grupp.' })
  @ArrayMaxSize(60)
  @IsUUID('4', { each: true })
  groupIds!: string[];
}

export class CreateExamDto extends ExamDescriptionDto {
  @Transform(lower)
  @IsUUID('4', { message: 'academicYearId: läsåret anges med sitt id.' })
  academicYearId!: string;
}

export class UpdateExamDto extends ExamDescriptionDto {}

export class ExamListQueryDto {
  @Transform(lower)
  @IsUUID('4', { message: 'academicYearId: läsåret anges med sitt id.' })
  academicYearId!: string;
}

/** Plan the school's unplaced exams of a year, or just these. */
export class PlanExamsDto {
  @Transform(lower)
  @IsUUID('4', { message: 'academicYearId: läsåret anges med sitt id.' })
  academicYearId!: string;

  @IsOptional()
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(300)
  @IsUUID('4', { each: true })
  examIds?: string[];
}

export class ApplyRoomDto {
  @IsUUID('4')
  roomId!: string;

  @IsInt()
  @Min(1)
  @Max(2000)
  writers!: number;

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(40)
  @IsUUID('4', { each: true })
  teacherIds!: string[];
}

/** One placed exam of a proposal, as the proposal gave it; the server asks everything again. */
export class ApplyItemDto {
  @IsUUID('4')
  examId!: string;

  /** The exam's updatedAt as the proposal read it: an exam changed since answers stale. */
  @IsString()
  @MaxLength(40)
  examVersion!: string;

  @Matches(ISO_DATE, { message: 'date: YYYY-MM-DD.' })
  @IsISO8601({ strict: true }, { message: 'date: en dag som finns i kalendern.' })
  date!: string;

  @Matches(CLOCK, { message: 'start: HH:MM.' })
  start!: string;

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(20)
  @ValidateNested({ each: true })
  @Type(() => ApplyRoomDto)
  rooms!: ApplyRoomDto[];
}

export class ApplyExamPlanDto {
  @Transform(lower)
  @IsUUID('4', { message: 'academicYearId: läsåret anges med sitt id.' })
  academicYearId!: string;

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(300)
  @ValidateNested({ each: true })
  @Type(() => ApplyItemDto)
  items!: ApplyItemDto[];

  /** One notice per person an exam touches, as an activity sends. Default true. */
  @IsOptional()
  @IsBoolean({ message: 'notify: true eller false.' })
  notify?: boolean;
}
