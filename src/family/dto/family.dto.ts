import {
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
  ValidateIf,
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

/**
 * The most days one leave request covers, first and last day included: a
 * year. LeaveRequests_a_year_at_most (20261023091000) holds every insert to
 * it, PostgREST's included. The gateway's bound is LeaveService's, a 400
 * with a code (LEAVE_REQUEST_TOO_LONG, LEAVE_REQUEST_ENDS_BEFORE_START) that
 * the family's page words in its own language; a check here, before it,
 * would answer with the validation pipe's English sentence instead.
 */
export const LEAVE_REQUEST_MAX_DAYS = 366;

/** A guardian requests leave (ledighetsansökan) for a child, or a pupil for themselves. */
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

/** A decision on a leave request: the admin's, or the deciding mentor's (20261023091000). */
export class DecideLeaveRequestDto {
  @IsIn(['APPROVED', 'REJECTED'])
  status!: 'APPROVED' | 'REJECTED';

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  note?: string;
}

/**
 * Rektor's delegation (20261023091000): the mentor decides a request of at
 * most this many skoldagar, 1 to 10, or no request (null). Required, so that
 * "no delegation" is said rather than left out.
 */
export class RecordLeaveDelegationDto {
  @ValidateIf((dto: RecordLeaveDelegationDto) => dto.mentorMaxSchoolDays !== null)
  @IsInt({ message: 'mentorMaxSchoolDays must be a whole number of skoldagar, or null.' })
  @Min(1)
  @Max(10)
  mentorMaxSchoolDays!: number | null;

  /** The delegationsordning's reference (dnr). */
  @IsOptional()
  @IsString()
  @Matches(/\S/, { message: 'reference must not be blank.' })
  @MaxLength(200)
  reference?: string;
}
