import { IsUUID } from 'class-validator';

/**
 * Request body for `POST /api/v1/optimization/trigger`.
 * Only the `academicYearId` is needed; the proxy fetches all other
 * scheduling data itself and strips PII before forwarding to the AI engine.
 */
export class TriggerOptimizationDto {
  @IsUUID('4', { message: 'academicYearId must be a valid UUIDv4.' })
  academicYearId!: string;
}
