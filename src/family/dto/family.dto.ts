import {
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

/** The contact's limits are LeaveRequests_a_contact_is_short's (20270201091000). */
export const LEAVE_CONTACT_NAME_MAX = 100;
export const LEAVE_CONTACT_RELATION_MAX = 60;
const LEAVE_CONTACT_PHONE = /^[0-9+()\s-]{5,30}$/;

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

  /**
   * A temporary contact during the leave (Ledighetspolicy, 20270201091000): a third
   * party's name, telephone and relation to the pupil. All three or none; an empty
   * string is none, as a form sends it. Whether the school asks for it, and requires it,
   * is the school's policy (GET /api/v1/leave-policy); the database refuses a filing that
   * breaks it and drops a contact the school has not asked for.
   */
  @ValidateIf((dto: CreateLeaveRequestDto) => dto.contactName != null && dto.contactName !== '')
  @IsString()
  @MaxLength(LEAVE_CONTACT_NAME_MAX)
  contactName?: string;

  @ValidateIf((dto: CreateLeaveRequestDto) => dto.contactPhone != null && dto.contactPhone !== '')
  @Matches(LEAVE_CONTACT_PHONE, { message: 'contactPhone must be a telephone number of 5 to 30 digits, spaces, + ( ) or -.' })
  contactPhone?: string;

  @ValidateIf((dto: CreateLeaveRequestDto) => dto.contactRelation != null && dto.contactRelation !== '')
  @IsString()
  @MaxLength(LEAVE_CONTACT_RELATION_MAX)
  contactRelation?: string;
}

/** A guardian's answer to a school's request for their consent to a leave request (Ledighetspolicy). */
export class AnswerLeaveConsentDto {
  @IsBoolean()
  consent!: boolean;
}

/**
 * The school's leave policy (Ledighetspolicy, 20270201091000), all of it, so that "off" is
 * said rather than left out: every guardian's consent, the fewest days ahead (1 to 90, or
 * null for no minimum) with what a later request meets, and the temporary contact.
 */
export class RecordLeavePolicyDto {
  @IsBoolean()
  requireAllGuardians!: boolean;

  @ValidateIf((dto: RecordLeavePolicyDto) => dto.minDaysAhead !== null)
  @IsInt({ message: 'minDaysAhead must be a whole number of days, or null.' })
  @Min(1)
  @Max(90)
  minDaysAhead!: number | null;

  @IsIn(['REFUSE', 'FLAG'])
  shortNotice!: 'REFUSE' | 'FLAG';

  @IsIn(['OFF', 'OPTIONAL', 'REQUIRED'])
  contact!: 'OFF' | 'OPTIONAL' | 'REQUIRED';
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
