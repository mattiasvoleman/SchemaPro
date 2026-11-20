import { ArrayMaxSize, ArrayUnique, IsArray, IsOptional, IsUUID } from 'class-validator';

/**
 * Body for `POST /api/v1/optimization/staffing/search`: a search for the choice of teachers that eases the week, among the
 * posts the school has released. It carries what Föreslå bemanning's own question carries that a search reads: the posts the
 * school has pinned. Which posts may move (released, staffed, not pinned) and who may take them is the plan's, as for a
 * proposal; nothing is written by a search.
 */
export class StartStaffingSearchDto {
  @IsUUID('4', { message: 'academicYearId must be a valid UUIDv4.' })
  academicYearId!: string;

  /** Posts the admin has pinned in the dialog: never moved, as for a proposal. */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(5000)
  @ArrayUnique()
  @IsUUID('4', { each: true })
  pinnedRequirementIds?: string[];
}
