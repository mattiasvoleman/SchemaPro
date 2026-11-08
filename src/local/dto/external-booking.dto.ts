import {
  ArrayMaxSize,
  ArrayMinSize,
  ArrayUnique,
  IsArray,
  IsBoolean,
  IsEmail,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import { IsCalendarDate } from '../../resources/dto/is-calendar-date';

const CLOCK = /^([01]\d|2[0-3]):[0-5]\d$/;

/**
 * The rule of a series: which room or resource, which weekdays, which clock
 * times, which dates. Shared by the preview and the registration, so that the
 * preview is the registration without the writes.
 *
 * Times are the school's own clock. A booking stays inside one day: it ends
 * after it starts, on the same date.
 */
export class ExternalBookingRuleDto {
  @IsIn(['ROOM', 'RESOURCE'])
  target!: 'ROOM' | 'RESOURCE';

  /** The room, when `target` is ROOM. */
  @IsOptional()
  @IsUUID('4')
  roomId?: string;

  /** The resource, when `target` is RESOURCE. */
  @IsOptional()
  @IsUUID('4')
  resourceId?: string;

  /** How many of the resource the hirer holds; 1 when omitted. */
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(1000)
  resourceQuantity?: number;

  /** ISO weekdays, 1 (Monday) to 7 (Sunday), each once. */
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(7)
  @ArrayUnique()
  @IsInt({ each: true })
  @Min(1, { each: true })
  @Max(7, { each: true })
  weekdays!: number[];

  /** 1 is every week, 2 every other week from the week of `startDate`; 1..4. */
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(4)
  intervalWeeks?: number;

  @IsCalendarDate()
  startDate!: string;

  /** Inclusive; at most 400 days after `startDate`. */
  @IsCalendarDate()
  endDate!: string;

  @Matches(CLOCK, { message: 'startTime must be HH:MM.' })
  startTime!: string;

  @Matches(CLOCK, { message: 'endTime must be HH:MM.' })
  endTime!: string;
}

/**
 * Registers a series for somebody who is not a user. The contact is personal
 * data about a person with no login: it is read by administrators through the
 * gateway alone and is gallrad with the series (EXTERNAL_BOOKINGS).
 */
export class CreateExternalBookingDto extends ExternalBookingRuleDto {
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  organisation!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(120)
  contactName!: string;

  /** At least one of the telephone number and the address (the table's CHECK). */
  @IsOptional()
  @IsString()
  @MinLength(3)
  @MaxLength(40)
  contactPhone?: string | null;

  @IsOptional()
  @IsEmail()
  @MaxLength(254)
  contactEmail?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  purpose?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string | null;

  /**
   * Book the days that are free and leave the ones that clash, naming them in
   * the answer. Without it a clash refuses the whole series (409), so nobody
   * gets half a term by mistake.
   */
  @IsOptional()
  @IsBoolean()
  skipConflicts?: boolean;
}

/** What may change on a series: who it is for, not when. A new rule is a new series. */
export class UpdateExternalBookingDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  organisation?: string;

  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  contactName?: string;

  @IsOptional()
  @IsString()
  @MinLength(3)
  @MaxLength(40)
  contactPhone?: string | null;

  @IsOptional()
  @IsEmail()
  @MaxLength(254)
  contactEmail?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  purpose?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string | null;
}

/** A booking of the same kind as the preview body, for a nested use. */
export class ExternalBookingPreviewDto extends ExternalBookingRuleDto {}

