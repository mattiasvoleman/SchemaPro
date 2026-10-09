import { Transform } from 'class-transformer';
import { IsOptional, IsUUID } from 'class-validator';
import { IsCalendarDate } from '../../resources/dto/is-calendar-date';

/**
 * GET /api/v1/staffing/delivered — planerat, schemalagt och genomfört per
 * lärare över ett datumintervall (src/staffing/staffing-reconciliation.ts).
 *
 * `from` and `to` are optional calendar days, YYYY-MM-DD and real dates. The
 * defaults are the year's start and the school's today; a range reaching
 * outside the year is clamped into it with a notice, one entirely outside it
 * and one whose start lies after its end are 400s (the service says which).
 */
export class StaffingDeliveredQueryDto {
  @Transform(({ value }) => (typeof value === 'string' ? value.toLowerCase() : value))
  @IsUUID('4', { message: 'academicYearId: läsåret anges med sitt id.' })
  academicYearId!: string;

  @IsOptional()
  @IsCalendarDate({ message: 'from: periodens början anges som ÅÅÅÅ-MM-DD.' })
  from?: string;

  @IsOptional()
  @IsCalendarDate({ message: 'to: periodens slut anges som ÅÅÅÅ-MM-DD.' })
  to?: string;
}
