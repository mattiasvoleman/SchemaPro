import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsInt,
  IsOptional,
  IsUUID,
  Max,
  Min,
} from 'class-validator';

/**
 * A soft wish that a subject's lessons land in particular rooms.
 *
 * Either a room type or a set of named rooms — never both, never neither. A
 * preference pointing at nothing can be neither satisfied nor violated, and
 * one pointing at both would leave the school unable to say which it meant.
 */
export class CreateRoomPreferenceDto {
  @IsUUID('4')
  subjectId!: string;

  @IsOptional()
  @IsUUID('4')
  roomTypeId?: string | null;

  @IsOptional()
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(50)
  @IsUUID('4', { each: true })
  roomIds?: string[];

  /**
   * What the optimizer pays per lesson placed elsewhere, relative to its other
   * objectives. Higher means the school would give up more to get it.
   */
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(1000)
  weight?: number;
}

export class UpdateRoomPreferenceDto {
  @IsOptional()
  @IsUUID('4')
  roomTypeId?: string | null;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(50)
  @IsUUID('4', { each: true })
  roomIds?: string[];

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(1000)
  weight?: number;
}
