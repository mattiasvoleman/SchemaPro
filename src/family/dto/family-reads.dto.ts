import { IsIn, IsOptional, IsUUID, Matches } from 'class-validator';

const DATE = /^\d{4}-\d{2}-\d{2}$/;

/** GET /api/v1/absence-reports: one day, one pupil, or both; neither is every report the caller may see. */
export class AbsenceReportsQueryDto {
  @IsOptional()
  @Matches(DATE, { message: 'date must be YYYY-MM-DD.' })
  date?: string;

  @IsOptional()
  @IsUUID('4')
  studentId?: string;
}

/** GET /api/v1/leave-requests: one status, or all of them. */
export class LeaveRequestsQueryDto {
  @IsOptional()
  @IsIn(['PENDING', 'APPROVED', 'REJECTED'])
  status?: 'PENDING' | 'APPROVED' | 'REJECTED';
}

/** GET /api/v1/guardian-links: one pupil's guardians. */
export class GuardianLinksQueryDto {
  @IsUUID('4')
  studentId!: string;
}
