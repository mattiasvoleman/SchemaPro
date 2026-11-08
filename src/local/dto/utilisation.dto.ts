import { IsIn, IsOptional, Matches } from 'class-validator';
import { IsCalendarDate } from '../../resources/dto/is-calendar-date';

const CLOCK = /^([01]\d|2[0-3]):[0-5]\d$/;

/** The period and the open hours of a utilisation report; the service holds the rest (400 days, openTo after openFrom). */
export class UtilisationQueryDto {
  @IsCalendarDate()
  from!: string;

  @IsCalendarDate()
  to!: string;

  @IsOptional()
  @IsIn(['ALL', 'ROOM', 'RESOURCE'])
  kind?: 'ALL' | 'ROOM' | 'RESOURCE';

  @IsOptional()
  @Matches(CLOCK, { message: 'openFrom must be HH:MM.' })
  openFrom?: string;

  @IsOptional()
  @Matches(CLOCK, { message: 'openTo must be HH:MM.' })
  openTo?: string;
}

export class ResourceAvailabilityQueryDto {
  @Matches(/^\d{4}-\d{2}-\d{2}T/, { message: 'from must be an ISO instant.' })
  from!: string;

  @Matches(/^\d{4}-\d{2}-\d{2}T/, { message: 'to must be an ISO instant.' })
  to!: string;
}

export class ResourceBookingListQueryDto {
  @IsOptional()
  @IsIn(['PENDING', 'APPROVED', 'REJECTED', 'CANCELLED'])
  status?: 'PENDING' | 'APPROVED' | 'REJECTED' | 'CANCELLED';

  @IsOptional()
  @IsIn(['true', 'false'])
  mine?: 'true' | 'false';
}

export class ExternalBookingListQueryDto {
  @IsOptional()
  @IsIn(['active', 'ended', 'cancelled', 'all'])
  state?: 'active' | 'ended' | 'cancelled' | 'all';
}
