import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsString, IsUUID, Max, MaxLength, Min, ValidateNested } from 'class-validator';
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
 *
 * `mode` is Bästa möjliga schema: ONE candidate, solved with the school's own
 * shaping rules allowed to give way, for the week where Generera placed
 * nothing. It needs the school's switch (LunchSettings.generatorBestEffort,
 * else 409 BEST_EFFORT_NOT_ENABLED) and no draft, and it is not read with
 * `count` (the run has one candidate) or `refreshOf` (a refresh of a batch
 * from the mode keeps its mode, and is asked for with `refreshOf` alone).
 * Absent is the run this DTO has always asked for.
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

  @IsOptional()
  @IsIn(['BEST_EFFORT'], { message: "mode must be BEST_EFFORT when it is sent." })
  mode?: 'BEST_EFFORT';
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

  /**
   * Bästa möjliga schema: the digest of the deviations the administrator has
   * read and accepts (the candidate view's `deviationsDigest`). Required by a
   * candidate with at least one deviation, which is otherwise refused (409
   * SCHEDULE_CANDIDATE_DEVIATIONS_NOT_ACCEPTED) with nothing written; a
   * candidate without any takes none, and one that is sent is not read. Bounded
   * and otherwise free text, so that a wrong value is that 409 and not a 400:
   * the digest is the server's to compare, not the client's to shape.
   */
  @IsOptional()
  @IsString()
  @MaxLength(128)
  acceptedDeviations?: string;
}
