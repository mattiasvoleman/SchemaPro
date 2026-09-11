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
} from 'class-validator';

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

  @IsOptional()
  @IsBoolean()
  requiresApproval?: boolean;
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

  @IsOptional()
  @IsBoolean()
  requiresApproval?: boolean;
}
