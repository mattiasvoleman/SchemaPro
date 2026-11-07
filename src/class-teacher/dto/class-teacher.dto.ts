import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
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
  ValidateIf,
  ValidateNested,
} from 'class-validator';
import { CHANGE_KINDS, type ChangeKind } from '../class-teacher.types';

const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

/** What a change is about and where it goes; the fields each kind uses are checked by the service and the database. */
export class ChangeTargetDto {
  /** OCCASION_MOVE: the date it moves to (YYYY-MM-DD). */
  @IsOptional()
  @Matches(DATE, { message: 'targetDate must be YYYY-MM-DD.' })
  targetDate?: string;

  /** TEMPLATE_*: the weekday (1 = Monday ... 5 = Friday) the lesson, or the second part of it, goes to. */
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(5)
  targetDayOfWeek?: number;

  @IsOptional()
  @Matches(TIME, { message: 'targetStart must be HH:MM.' })
  targetStart?: string;

  @IsOptional()
  @Matches(TIME, { message: 'targetEnd must be HH:MM.' })
  targetEnd?: string;

  /** The room asked for. Null or absent: the lesson keeps its room (OCCASION_ROOM names one). */
  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsUUID('4')
  targetRoomId?: string | null;

  /** TEMPLATE_SPLIT: where the first part ends. */
  @IsOptional()
  @Matches(TIME, { message: 'keepEnd must be HH:MM.' })
  keepEnd?: string;

  /** For the schemaläggare, or for the class when the lesson is cancelled. At most 200 characters. */
  @IsOptional()
  @IsString()
  @MaxLength(200)
  note?: string;
}

export class CreateChangeDto extends ChangeTargetDto {
  @IsIn(CHANGE_KINDS)
  kind!: ChangeKind;

  @IsOptional()
  @IsUUID('4')
  masterLessonId?: string;

  @IsOptional()
  @IsUUID('4')
  calendarLessonId?: string;

  /** The lesson's `version` as the page read it; a lesson that has changed since is refused with 409. */
  @Matches(/^[0-9a-f]{32}$/, { message: 'baseVersion must be the version the page read.' })
  baseVersion!: string;
}

/** A change tried, not written: the same fields, and no version to hold it to. */
export class PreviewChangeDto extends ChangeTargetDto {
  @IsIn(CHANGE_KINDS)
  kind!: ChangeKind;

  @IsOptional()
  @IsUUID('4')
  masterLessonId?: string;

  @IsOptional()
  @IsUUID('4')
  calendarLessonId?: string;
}

export class UpdateChangeDto extends ChangeTargetDto {
  /** The revision the writer read. Another writer's change in between is a 409 with the draft as it stands. */
  @IsInt()
  @Min(1)
  rev!: number;
}

export class RevQueryDto {
  @Type(() => Number)
  @IsInt()
  @Min(1)
  rev!: number;
}

export class WeekQueryDto {
  /** Any date in the week wanted (YYYY-MM-DD). Absent: this week, on the school's clock. */
  @IsOptional()
  @Matches(DATE, { message: 'from must be YYYY-MM-DD.' })
  from?: string;
}

export class PublishDto {
  /** The drafts to publish. Absent: every draft of the class that waits. */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(200)
  @IsUUID('4', { each: true })
  changeIds?: string[];
}

export class AppointDto {
  @IsUUID('4')
  studentGroupId!: string;

  @IsUUID('4')
  userId!: string;
}

export class OpenSpanDto {
  @IsInt()
  @Min(1)
  @Max(5)
  dayOfWeek!: number;

  @Matches(TIME, { message: 'startTime must be HH:MM.' })
  startTime!: string;

  @Matches(TIME, { message: 'endTime must be HH:MM.' })
  endTime!: string;
}

/** The open spans of one scope, replaced whole: one class's, or every class of the läsår's (studentGroupId null). */
export class OpenTimesDto {
  @IsUUID('4')
  academicYearId!: string;

  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsUUID('4')
  studentGroupId?: string | null;

  @IsArray()
  @ArrayMaxSize(40)
  @ValidateNested({ each: true })
  @Type(() => OpenSpanDto)
  spans!: OpenSpanDto[];
}

export class OpenTimesQueryDto {
  @IsUUID('4')
  academicYearId!: string;
}

export class ClassTeacherSettingsDto {
  @IsBoolean()
  selfPublish!: boolean;
}

export class DraftsQueryDto {
  @IsOptional()
  @IsUUID('4')
  studentGroupId?: string;
}
