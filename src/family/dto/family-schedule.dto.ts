import { Transform } from 'class-transformer';
import { IsOptional, IsUUID, Matches } from 'class-validator';

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const lower = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.toLowerCase() : value);

/**
 * GET /api/v1/family/schedule. `week` is any day of the ISO week asked for
 * (Monday to Sunday); without it, the school's today. That the date exists
 * (2026-02-30 does not) is the service's to say, with the field named.
 */
export class FamilyScheduleQueryDto {
  @Transform(lower)
  @IsUUID('4', { message: 'studentId: ange vilken elev.' })
  studentId!: string;

  @IsOptional()
  @Matches(ISO_DATE, { message: 'week: ett datum ÅÅÅÅ-MM-DD.' })
  week?: string;
}
