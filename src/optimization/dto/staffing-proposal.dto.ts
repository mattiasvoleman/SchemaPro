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
   * active staff). Off: also the posts the school has released for the engine
   * (släppt för motorn), though none that is staffed today ends unstaffed. A
   * teacher the school chose is never moved, whichever this is: a staffed
   * post that is not released stays as it is.
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

/** One change the caller confirms gives the teacher a subject or a årskurs they do not teach today. */
export class ConfirmedNewTeachingDto {
  @IsUUID('4')
  requirementId!: string;

  @IsUUID('4')
  toTeacherId!: string;
}

/** Body for `POST /api/v1/optimization/staffing/apply`, and for its undo. */
export class ApplyStaffingDto {
  @IsUUID('4', { message: 'academicYearId must be a valid UUIDv4.' })
  academicYearId!: string;

  /** The sha256 hex digest the proposal (or the previous apply) returned, or the one the week before and after returned (coversWeek). */
  @Matches(/^[0-9a-f]{64}$/, { message: 'basisSha256 must be a sha256 hex digest.' })
  basisSha256!: string;

  /**
   * `basisSha256` is the digest that covers the week as well as the proposal: the one staffing/proposal/week returned for the
   * figure the dialog showed. The apply then reads the week again under its lock and refuses it as stale (409
   * STAFF_PROPOSAL_STALE) if anything in it has changed since, though the tjänstefördelning has not. Absent, which is every
   * client that has not shown the week, the basis is the proposal's own and the week is never read: as it always was.
   */
  @IsOptional()
  @IsBoolean()
  coversWeek?: boolean;

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

  /**
   * The changes the caller has confirmed give a teacher a subject or a årskurs they do not teach today (the proposal names them in
   * `assignments[].newTeaching`): the second confirmation of the dialog, one entry for each row and the teacher it is given to.
   * An apply that holds such a change not listed here is refused 409 STAFF_NEW_TEACHING_UNCONFIRMED, and a row confirmed for one
   * teacher and given to another is not confirmed. Ignored on an undo, which puts back what was.
   */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(5000)
  @ValidateNested({ each: true })
  @Type(() => ConfirmedNewTeachingDto)
  confirmedNewTeaching?: ConfirmedNewTeachingDto[];
}
