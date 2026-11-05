import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
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
import { BATCH_SCOPES, type BatchScope } from './cancellation-batch.dto';

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const CLOCK = /^([01]\d|2[0-3]):[0-5]\d$/;
const lower = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.toLowerCase() : value);
const trimmed = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);

/** A teacher responsible for a class or group during the activity. At most one LEAD per group. */
export class ActivityTeacherDto {
  @IsUUID('4', { message: 'studentGroupId: klassen eller gruppen anges med sitt id.' })
  studentGroupId!: string;

  @IsUUID('4', { message: 'teacherId: läraren anges med sitt id.' })
  teacherId!: string;

  @IsOptional()
  @IsIn(['LEAD', 'ASSISTANT'], { message: "role: 'LEAD' eller 'ASSISTANT'." })
  role?: 'LEAD' | 'ASSISTANT';
}

/** The minutes the day gives a subject (a TimplanCredit on each of the activity's days ahead). */
export class ActivityCreditDto {
  @IsUUID('4', { message: 'subjectId: ämnet anges med sitt id.' })
  subjectId!: string;

  @IsInt()
  @Min(1)
  @Max(600)
  minutes!: number;
}

/**
 * What a schemabrytande aktivitet is: the avbokning's selection (the same
 * fields and the same rules, cause EVENT always), the subject its replacement
 * lessons are held in, what the pupils read on them, who is responsible for
 * each class, and which subjects the day's minutes are credited to.
 */
export class ScheduleActivitySelectionDto {
  @Transform(lower)
  @IsUUID('4', { message: 'academicYearId: läsåret anges med sitt id.' })
  academicYearId!: string;

  @IsString()
  @Transform(trimmed)
  @MinLength(1, { message: 'name: aktiviteten behöver ett namn, till exempel "Friluftsdag åk 7".' })
  // 80, not the avbokning's 120: the name is also the name of each credit (TimplanCredits CHECK).
  @MaxLength(80)
  name!: string;

  @Matches(ISO_DATE, { message: 'fromDate: YYYY-MM-DD.' })
  fromDate!: string;

  @Matches(ISO_DATE, { message: 'toDate: YYYY-MM-DD.' })
  toDate!: string;

  @IsOptional()
  @Matches(CLOCK, { message: 'startTime: HH:MM.' })
  startTime?: string;

  @IsOptional()
  @Matches(CLOCK, { message: 'endTime: HH:MM.' })
  endTime?: string;

  @IsIn(BATCH_SCOPES, { message: "scope: 'SCHOOL', 'GRADES' eller 'GROUPS'." })
  scope!: BatchScope;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(11)
  minGradeLevel?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(11)
  maxGradeLevel?: number;

  @IsOptional()
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(200)
  @IsUUID('4', { each: true })
  groupIds?: string[];

  /** A subject that does not count toward the timplan: the minutes come as credits. */
  @IsUUID('4', { message: 'replacementSubjectId: ersättningslektionens ämne anges med sitt id.' })
  replacementSubjectId!: string;

  /** What the pupils read on the replacement lesson, after the name. */
  @IsOptional()
  @IsString()
  @Transform(trimmed)
  @MaxLength(300)
  description?: string;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(400)
  @ValidateNested({ each: true })
  @Type(() => ActivityTeacherDto)
  teachers?: ActivityTeacherDto[];

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(12)
  @ValidateNested({ each: true })
  @Type(() => ActivityCreditDto)
  credits?: ActivityCreditDto[];
}

export class CreateScheduleActivityDto extends ScheduleActivitySelectionDto {
  /** The preview's digest: a plan that changed since answers 409 CANCELLATION_STALE. */
  @IsOptional()
  @Matches(/^[0-9a-f]{64}$/, { message: 'expectedDigest: förhandsgranskningens kontrollsumma.' })
  expectedDigest?: string;

  /**
   * One notice per person the activity touches, and another when it is
   * removed or its lessons come back. Default true: telling the families is
   * what an activity is for.
   */
  @IsOptional()
  @IsBoolean({ message: 'notify: true eller false.' })
  notify?: boolean;
}

/** A change: the whole description again, as a create, so the plan is judged as one thing. */
export class UpdateScheduleActivityDto extends CreateScheduleActivityDto {}

export class ScheduleActivityListQueryDto {
  @Transform(lower)
  @IsUUID('4', { message: 'academicYearId: läsåret anges med sitt id.' })
  academicYearId!: string;
}
