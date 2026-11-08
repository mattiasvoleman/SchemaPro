import {
  IsUUID,
  IsBoolean,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
  Max,
  Min,
  ValidateIf,
} from 'class-validator';

/**
 * Placeringsregler (20270126090000), regel 3: the room may hold several
 * lessons at the same time as long as their pupils fit its capacity together.
 * The column is NOT NULL with a default of false (exclusive, as every room has
 * always been), so null has no "cleared" meaning and is refused by name, and
 * absent leaves the mark as it is. A room without a capacity has no limit to
 * share under and stays exclusive whatever this says: the generator reads the
 * mark only while the school's Skolregler hold the rule on (placementSharedMode)
 * and only on a room with a capacity.
 */
export const CAN_BE_SHARED_MESSAGE =
  'canBeShared: om flera grupper får ha lektion i salen samtidigt anges med true eller false.';

export class CreateRoomDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  name!: string;

  @IsOptional()
  @IsString()
  @MaxLength(20)
  code?: string | null;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(10000)
  capacity?: number | null;

  @IsOptional()
  @IsOptional()
  @IsUUID('4')
  roomTypeId?: string | null;

  /**
   * Inclusive year range this room may host; omit or null for no limit.
   * A school uses these to keep a stage's rooms to that stage.
   */
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(12)
  minGradeLevel?: number | null;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(12)
  maxGradeLevel?: number | null;

  /**
   * The building the room is in, for the room optimisation's walking cost.
   * Trimmed by the service, and a blank means "not given": a name made of
   * spaces would be a building of its own that nobody can see is different.
   */
  @IsOptional()
  @IsString()
  @MaxLength(60)
  building?: string | null;

  /** Which floor; null is unknown and never counted as a floor change. */
  @IsOptional()
  @IsInt()
  @Min(-5)
  @Max(50)
  floor?: number | null;

  /**
   * The skolområde the room stands on (Sites, 20261124090000); null is
   * unknown, and no travel is counted to or from the room. A site of another
   * school is refused by the composite key.
   */
  @IsOptional()
  @IsUUID('all')
  siteId?: string | null;

  @IsOptional()
  @IsBoolean()
  requiresApproval?: boolean;

  /** Several groups may be in the room at once, up to its capacity (regel 3). Absent means false. */
  @ValidateIf((dto: CreateRoomDto) => dto.canBeShared !== undefined)
  @IsBoolean({ message: CAN_BE_SHARED_MESSAGE })
  canBeShared?: boolean;
}

export class UpdateRoomDto {
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  name?: string;

  @IsOptional()
  @IsString()
  @MaxLength(20)
  code?: string | null;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(10000)
  capacity?: number | null;

  @IsOptional()
  @IsOptional()
  @IsUUID('4')
  roomTypeId?: string | null;

  /**
   * Inclusive year range this room may host; omit or null for no limit.
   * A school uses these to keep a stage's rooms to that stage.
   */
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(12)
  minGradeLevel?: number | null;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(12)
  maxGradeLevel?: number | null;

  /**
   * The building the room is in, for the room optimisation's walking cost.
   * Trimmed by the service, and a blank means "not given": a name made of
   * spaces would be a building of its own that nobody can see is different.
   */
  @IsOptional()
  @IsString()
  @MaxLength(60)
  building?: string | null;

  /** Which floor; null is unknown and never counted as a floor change. */
  @IsOptional()
  @IsInt()
  @Min(-5)
  @Max(50)
  floor?: number | null;

  /**
   * The skolområde the room stands on (Sites, 20261124090000); null is
   * unknown, and no travel is counted to or from the room. A site of another
   * school is refused by the composite key.
   */
  @IsOptional()
  @IsUUID('all')
  siteId?: string | null;

  @IsOptional()
  @IsBoolean()
  requiresApproval?: boolean;

  /** Absent leaves the mark as it is. */
  @ValidateIf((dto: UpdateRoomDto) => dto.canBeShared !== undefined)
  @IsBoolean({ message: CAN_BE_SHARED_MESSAGE })
  canBeShared?: boolean;
}
