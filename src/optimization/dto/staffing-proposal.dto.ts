import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  ArrayUnique,
  IsArray,
  IsBoolean,
  IsInt,
  IsOptional,
  IsUUID,
  Matches,
  Max,
  Min,
  ValidateIf,
  ValidateNested,
} from 'class-validator';

/**
 * The secondary objective's weights, each a whole number 0..100; an absent one
 * is the engine's default (app/schemas/staffing.py StaffWeights). Staffing as
 * many rows as possible is not a weight: it is the engine's first stage and is
 * never traded for any of these.
 */
export class StaffingWeightsDto {
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(100)
  balance?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(100)
  classTeachers?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(100)
  continuity?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(100)
  keepCurrent?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(100)
  unqualified?: number;
}

/** Body for `POST /api/v1/optimization/staffing/proposal`. Writes nothing. */
export class StaffingProposalDto {
  @IsUUID('4', { message: 'academicYearId must be a valid UUIDv4.' })
  academicYearId!: string;

  /**
   * Only rows nobody teaches — and rows whose teacher has left (is no longer
   * active staff). Off: every row not pinned may change hands, though none
   * that is staffed today ends unstaffed.
   */
  @IsBoolean()
  onlyUnstaffed!: boolean;

  /** Hard: never give a row to a teacher without a covering behörighet. Forced on under REFUSE. */
  @IsBoolean()
  respectQualifications!: boolean;

  /**
   * Rows the admin keeps as they are. At most as many as the engine takes
   * requirements; 5000 ids are about 195 kB of JSON, inside the body limit.
   */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(5000)
  @ArrayUnique()
  @IsUUID('4', { each: true })
  pinnedRequirementIds?: string[];

  @IsOptional()
  @ValidateNested()
  @Type(() => StaffingWeightsDto)
  weights?: StaffingWeightsDto;
}

/**
 * One row's lead change, carrying the lead it changes FROM — what makes an
 * apply safe to replay and to reverse: the row is only changed if it still
 * has that lead, and undo is the same change with the two swapped. Both are
 * required and nullable: null is "nobody".
 */
export class StaffingChangeDto {
  @IsUUID('4')
  requirementId!: string;

  @ValidateIf((change: StaffingChangeDto) => change.fromTeacherId !== null)
  @IsUUID('4')
  fromTeacherId!: string | null;

  /** Null only on an undo (the service refuses it otherwise): a proposal never unstaffs. */
  @ValidateIf((change: StaffingChangeDto) => change.toTeacherId !== null)
  @IsUUID('4')
  toTeacherId!: string | null;
}

/** Body for `POST /api/v1/optimization/staffing/apply`, and for its undo. */
export class ApplyStaffingDto {
  @IsUUID('4', { message: 'academicYearId must be a valid UUIDv4.' })
  academicYearId!: string;

  /** The sha256 hex digest the proposal (or the previous apply) returned. */
  @Matches(/^[0-9a-f]{64}$/, { message: 'basisSha256 must be a sha256 hex digest.' })
  basisSha256!: string;

  /** Reverses an apply: the only body whose changes may leave a row with nobody. */
  @IsOptional()
  @IsBoolean()
  undo?: boolean;

  /**
   * Capped at the engine's own requirement cap. 5000 changes are about 800 kB
   * of JSON, inside the 1 MB body limit.
   */
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(5000)
  @ValidateNested({ each: true })
  @Type(() => StaffingChangeDto)
  changes!: StaffingChangeDto[];
}
