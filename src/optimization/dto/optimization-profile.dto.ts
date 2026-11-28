import { IsInt, Max, Min } from 'class-validator';
import { PROFILE_WEIGHT_MAX, PROFILE_WEIGHT_MIN } from '../optimization-profile';

const MESSAGE = `Vikten är ett heltal ${PROFILE_WEIGHT_MIN}–${PROFILE_WEIGHT_MAX}.`;

/**
 * PUT /optimization/profile: the whole profile, all five weights. A profile is saved as it stands on the page, so a missing weight is a
 * mistake of the caller and not "leave it": the row is replaced, not patched, and a client that sends four never writes the fifth from
 * another day's state.
 */
export class SaveOptimizationProfileDto {
  @IsInt({ message: MESSAGE })
  @Min(PROFILE_WEIGHT_MIN, { message: MESSAGE })
  @Max(PROFILE_WEIGHT_MAX, { message: MESSAGE })
  preferredFree!: number;

  @IsInt({ message: MESSAGE })
  @Min(PROFILE_WEIGHT_MIN, { message: MESSAGE })
  @Max(PROFILE_WEIGHT_MAX, { message: MESSAGE })
  preferredBusy!: number;

  @IsInt({ message: MESSAGE })
  @Min(PROFILE_WEIGHT_MIN, { message: MESSAGE })
  @Max(PROFILE_WEIGHT_MAX, { message: MESSAGE })
  disruption!: number;

  @IsInt({ message: MESSAGE })
  @Min(PROFILE_WEIGHT_MIN, { message: MESSAGE })
  @Max(PROFILE_WEIGHT_MAX, { message: MESSAGE })
  spread!: number;

  @IsInt({ message: MESSAGE })
  @Min(PROFILE_WEIGHT_MIN, { message: MESSAGE })
  @Max(PROFILE_WEIGHT_MAX, { message: MESSAGE })
  teacherGap!: number;
}
