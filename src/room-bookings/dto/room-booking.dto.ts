import {
  IsIn,
  IsISO8601,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  MinLength,
} from 'class-validator';

/** Teacher/admin reserves a free room for a datetime range. */
export class CreateRoomBookingDto {
  @IsUUID('4')
  roomId!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(120)
  title!: string;

  // Full ISO-8601 timestamps (e.g. 2026-07-13T09:00:00.000Z), matching the
  // Timestamptz columns used for calendar lessons.
  @IsISO8601()
  startsAt!: string;

  @IsISO8601()
  endsAt!: string;
}

/** Admin approves or rejects a pending booking on a special room. */
export class DecideRoomBookingDto {
  @IsIn(['APPROVED', 'REJECTED'])
  status!: 'APPROVED' | 'REJECTED';

  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;
}
