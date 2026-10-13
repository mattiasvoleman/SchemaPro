import { IsOptional, IsUUID, Matches } from 'class-validator';

const DATE = /^\d{4}-\d{2}-\d{2}$/;

/** GET /api/v1/access-log: who read about one person, optionally within school days from..to. */
export class AccessLogQueryDto {
  @IsUUID('4')
  personId!: string;

  @IsOptional()
  @Matches(DATE, { message: 'from must be YYYY-MM-DD.' })
  from?: string;

  @IsOptional()
  @Matches(DATE, { message: 'to must be YYYY-MM-DD.' })
  to?: string;
}
