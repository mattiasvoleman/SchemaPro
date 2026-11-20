import { Type } from 'class-transformer';
import { ArrayMaxSize, ArrayUnique, IsArray, IsUUID, Matches, ValidateIf, ValidateNested } from 'class-validator';

/**
 * One lead change of a proposal, as the dialog holds it: the post, the lead it has now (null: nobody), and the one the
 * proposal gives it. Unlike an apply's change, `toTeacherId` is never null: a proposal never leaves a post with nobody.
 */
export class StaffingWeekChangeDto {
  @IsUUID('4')
  requirementId!: string;

  @ValidateIf((change: StaffingWeekChangeDto) => change.fromTeacherId !== null)
  @IsUUID('4')
  fromTeacherId!: string | null;

  @IsUUID('4')
  toTeacherId!: string;
}

/**
 * Body for `POST /api/v1/optimization/staffing/proposal/week`: the week before and after the part of a proposal the
 * admin has selected. Writes nothing.
 */
export class StaffingWeekDto {
  @IsUUID('4', { message: 'academicYearId must be a valid UUIDv4.' })
  academicYearId!: string;

  /**
   * The basis the PROPOSAL returned. The week is only judged against the state the proposal was read from: when the
   * tjänstefördelning has moved since, the answer is 409 STAFF_PROPOSAL_STALE, as an apply's is, and the digest this
   * route returns for an apply to carry is built on it.
   */
  @Matches(/^[0-9a-f]{64}$/, { message: 'basisSha256 must be a sha256 hex digest.' })
  basisSha256!: string;

  /**
   * The selected changes, at most as many as an apply takes. Empty is a question with an answer (the week as it
   * stands), not an error: the admin may have left every row out.
   */
  @IsArray()
  @ArrayMaxSize(5000)
  @ArrayUnique((change: StaffingWeekChangeDto) => change.requirementId)
  @ValidateNested({ each: true })
  @Type(() => StaffingWeekChangeDto)
  changes!: StaffingWeekChangeDto[];
}
