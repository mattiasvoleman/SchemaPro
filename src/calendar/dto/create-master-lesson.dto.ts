import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsInt,
  IsOptional,
  IsUUID,
  Matches,
  Max,
  Min,
  ValidateIf,
} from 'class-validator';

const TIME = /^\d{2}:\d{2}$/;

/**
 * Manually adds a lesson to the master timetable (independent of the AI
 * optimizer). The new slot is validated against the rest of the timetable
 * (teacher/room/group double-bookings, weekly availability constraints) and is
 * rejected with 409 + a conflict list when it would collide.
 */
export class CreateMasterLessonDto {
  @IsUUID('4')
  academicYearId!: string;

  @IsUUID('4')
  subjectId!: string;

  @IsUUID('4')
  studentGroupId!: string;

  @ValidateIf((dto: CreateMasterLessonDto) => dto.teacherId !== null)
  @IsOptional()
  @IsUUID('4')
  teacherId?: string | null;

  @ValidateIf((dto: CreateMasterLessonDto) => dto.roomId !== null)
  @IsOptional()
  @IsUUID('4')
  roomId?: string | null;

  @IsInt()
  @Min(1)
  @Max(7)
  dayOfWeek!: number;

  @Matches(TIME, { message: 'startTime must be HH:MM.' })
  startTime!: string;

  @Matches(TIME, { message: 'endTime must be HH:MM.' })
  endTime!: string;

  /** Manually placed lessons are often meant to stay put — lock on create. */
  @IsOptional()
  @IsBoolean()
  isLocked?: boolean;

  /** Additional classes attending this lesson (beyond the primary group). */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @IsUUID('4', { each: true })
  extraGroupIds?: string[];

  /** Individual participating students (electives across classes). */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(200)
  @IsUUID('4', { each: true })
  studentIds?: string[];
}
