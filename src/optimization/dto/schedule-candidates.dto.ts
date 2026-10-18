import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsUUID, Max, Min, ValidateNested } from 'class-validator';
import type { PublishMode } from '../../publication/publish-mode';
import { MAX_CANDIDATE_COUNT, MIN_CANDIDATE_COUNT } from '../candidate-variants';
import { ObjectiveWeightsDto } from './trigger-optimization.dto';

/**
 * POST /api/v1/optimization/candidates: a run of schemaförslag for a year.
 *
 * `count` is how many candidates a new run asks for (2..4, three when absent;
 * candidate-variants.ts says which emphases). `weights` is the run's base,
 * the same five integers Generera takes, and each candidate lays its
 * variant's overrides on top. `refreshOf` is "Uppdatera förslagen": the run
 * named re-solved on today's draft, candidate for candidate, which is why its
 * own count is the old batch's and `count` is then not read.
 */
export class StartCandidatesDto {
  @IsUUID('4', { message: 'academicYearId must be a valid UUIDv4.' })
  academicYearId!: string;

  @IsOptional()
  @IsInt()
  @Min(MIN_CANDIDATE_COUNT)
  @Max(MAX_CANDIDATE_COUNT)
  count?: number;

  @IsOptional()
  @ValidateNested()
  @Type(() => ObjectiveWeightsDto)
  weights?: ObjectiveWeightsDto;

  @IsOptional()
  @IsUUID('4', { message: 'refreshOf must be a valid UUIDv4.' })
  refreshOf?: string;
}

/**
 * POST /api/v1/optimization/candidates/:id/apply. The publication mode the
 * dialog was confirmed in: in DIRECT an apply takes the replaced lessons off
 * the calendar until the next publish, and the dialog says so, so an apply
 * whose school changed mode since is refused (409 PUBLISH_MODE_CHANGED)
 * rather than doing what the admin was not told.
 */
export class ApplyCandidateDto {
  @IsIn(['DRAFT', 'DIRECT'], { message: 'expectedMode must be DRAFT or DIRECT.' })
  expectedMode!: PublishMode;
}
