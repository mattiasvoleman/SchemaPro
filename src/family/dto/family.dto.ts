import {
  IsIn,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';

const TIME = /^\d{2}:\d{2}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Links a guardian account to a student (admin only). */
export class CreateGuardianLinkDto {
  @IsUUID('4')
  guardianId!: string;

  @IsUUID('4')
  studentId!: string;
}

/**
 * A guardian (or adult student) reports an absence for one date.
 * Omit startTime/endTime for a full-day absence.
 */
export class CreateAbsenceReportDto {
  @IsUUID('4')
  studentId!: string;

  @Matches(DATE, { message: 'date must be YYYY-MM-DD.' })
  date!: string;

  @IsOptional()
  @Matches(TIME, { message: 'startTime must be HH:MM.' })
  startTime?: string;

  @IsOptional()
  @Matches(TIME, { message: 'endTime must be HH:MM.' })
  endTime?: string;

  @IsIn(['SICK', 'APPOINTMENT', 'OTHER'])
  type!: 'SICK' | 'APPOINTMENT' | 'OTHER';

  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;
}

/** A guardian requests leave (ledighetsansökan) for a child. */
export class CreateLeaveRequestDto {
  @IsUUID('4')
  studentId!: string;

  @Matches(DATE, { message: 'startDate must be YYYY-MM-DD.' })
  startDate!: string;

  @Matches(DATE, { message: 'endDate must be YYYY-MM-DD.' })
  endDate!: string;

  @IsString()
  @MinLength(3)
  @MaxLength(1000)
  reason!: string;
}

/** Admin decision on a leave request. */
export class DecideLeaveRequestDto {
  @IsIn(['APPROVED', 'REJECTED'])
  status!: 'APPROVED' | 'REJECTED';

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  note?: string;
}
