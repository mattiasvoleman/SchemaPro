import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsDateString,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateIf,
  ValidateNested,
} from 'class-validator';

const CLOCK = /^\d{2}:\d{2}(:\d{2})?$/;

/**
 * The minutes to another school of the huvudman, 0..240 as the table holds
 * them (SchoolTravelTimes_minutes_range); null removes the figure.
 */
export class PutSchoolTravelDto {
  @ValidateIf((_, value) => value !== null)
  @IsInt()
  @Min(0)
  @Max(240)
  minutes!: number | null;
}

/** One weekly window of a loan: a weekday and the minutes it holds. */
export class RoomLoanWindowDto {
  @IsInt()
  @Min(1)
  @Max(7)
  dayOfWeek!: number;

  @IsString()
  @Matches(CLOCK)
  startTime!: string;

  @IsString()
  @Matches(CLOCK)
  endTime!: string;
}

/**
 * A request to borrow a room of another school of the huvudman: one or more
 * weekly windows between two dates, each its own loan the owner answers.
 * The room the school holds it by is its own: the one it already has for
 * the room, the room named, or a new room the gateway makes (named after
 * the room and its school unless the request names it).
 */
export class CreateRoomLoanDto {
  @IsUUID()
  roomId!: string;

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(10)
  @ValidateNested({ each: true })
  @Type(() => RoomLoanWindowDto)
  windows!: RoomLoanWindowDto[];

  @IsDateString({ strict: true })
  startDate!: string;

  @IsDateString({ strict: true })
  endDate!: string;

  @IsOptional()
  @IsString()
  @MaxLength(300)
  note?: string;

  /** A room of the school's own to hold the loan by. */
  @IsOptional()
  @IsUUID()
  localRoomId?: string;

  /** The name of the room the gateway makes, when the school has none for it. */
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  localRoomName?: string;

  /** The school's own room type for the room it makes. */
  @IsOptional()
  @IsUUID()
  localRoomTypeId?: string;
}
