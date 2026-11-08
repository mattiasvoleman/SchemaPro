import { IsISO8601, IsOptional, Matches } from 'class-validator';

/** A date from 2000-01-01 to 2100-12-31: the years the month arithmetic stays inside. */
const DATE = /^(20\d{2}|2100)-\d{2}-\d{2}$/;

/**
 * The period a pattern, a class's pupils or a pupil's patterns are read over:
 * the school's days, both ends included. Without them the period is the läsår
 * holding today, up to yesterday. The database holds the period to 1 200 days
 * and from before to; the message here names the field first.
 */
export class PeriodQueryDto {
  @IsOptional()
  @Matches(DATE, { message: 'from: ett datum ÅÅÅÅ-MM-DD mellan 2000-01-01 och 2100-12-31.' })
  @IsISO8601({ strict: true }, { message: 'from: ett datum som finns, ÅÅÅÅ-MM-DD.' })
  from?: string;

  @IsOptional()
  @Matches(DATE, { message: 'to: ett datum ÅÅÅÅ-MM-DD mellan 2000-01-01 och 2100-12-31.' })
  @IsISO8601({ strict: true }, { message: 'to: ett datum som finns, ÅÅÅÅ-MM-DD.' })
  to?: string;
}
