import { IsUUID } from 'class-validator';

/**
 * Request body for `POST /api/v1/optimization/week-check`. Only the
 * `academicYearId`: the gateway fetches the week itself, as it does for a
 * Generera, and the school's stored rules are the ones the check counts under.
 */
export class WeekCheckDto {
  @IsUUID('4', { message: 'academicYearId must be a valid UUIDv4.' })
  academicYearId!: string;
}
