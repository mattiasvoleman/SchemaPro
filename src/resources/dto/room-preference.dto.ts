import { RoomRuleKind } from '@prisma/client';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsEnum,
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

  /**
   * WISH pays a price per lesson placed elsewhere; LOCK forbids everywhere else
   * and refuses the week by name if that cannot be honoured.
   *
   * Omitted means WISH, which is what every row written before this field
   * existed means. A caller that forgets it therefore gets the safe half.
   */
  @IsOptional()
  @IsEnum(RoomRuleKind)
  kind?: RoomRuleKind;

  /**
   * The years the rule applies to; omit both for every year.
   *
   * Matched by CONTAINMENT — a group's whole span must sit inside this one.
   * Overlap would let an åk 7-9 rule seize a teaching group spanning 6-7 and
   * send year-6 pupils to a högstadie room, which is the error that is not
   * survivable. Both bounds or neither; the database enforces it too.
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

  /**
   * WISH pays a price per lesson placed elsewhere; LOCK forbids everywhere else
   * and refuses the week by name if that cannot be honoured.
   *
   * Omitted means WISH, which is what every row written before this field
   * existed means. A caller that forgets it therefore gets the safe half.
   */
  @IsOptional()
  @IsEnum(RoomRuleKind)
  kind?: RoomRuleKind;

  /**
   * The years the rule applies to; omit both for every year.
   *
   * Matched by CONTAINMENT — a group's whole span must sit inside this one.
   * Overlap would let an åk 7-9 rule seize a teaching group spanning 6-7 and
   * send year-6 pupils to a högstadie room, which is the error that is not
   * survivable. Both bounds or neither; the database enforces it too.
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
