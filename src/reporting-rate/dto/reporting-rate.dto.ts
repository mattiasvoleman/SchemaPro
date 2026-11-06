import { IsBoolean, IsIn, IsInt, IsISO8601, IsOptional, Matches, Max, Min } from 'class-validator';
import { OPEN_AFTER_DAYS, REPORTING_PERIODS, type ReportingPeriod } from '../reporting-rate';

/** A date from 2000-01-01 to 2100-12-31: the years the week, month and läsår arithmetic stays inside. */
const ANCHOR_DATE = /^(20\d{2}|2100)-\d{2}-\d{2}$/;

/**
 * GET /api/v1/reporting-rate. `period` is WEEK without it, `anchor` the
 * school's today: any day of the week, month or läsår asked for. The date must
 * exist (2026-02-30 does not) and lie in 2000-2100 (a week of 9999-12-29 runs
 * into year 10000, which no date column holds), and the message names the
 * field.
 */
export class ReportingRateQueryDto {
  @IsOptional()
  @IsIn(REPORTING_PERIODS, { message: 'period: WEEK, MONTH eller YEAR.' })
  period?: ReportingPeriod;

  @IsOptional()
  @Matches(ANCHOR_DATE, { message: 'anchor: ett datum ÅÅÅÅ-MM-DD mellan 2000-01-01 och 2100-12-31.' })
  @IsISO8601({ strict: true }, { message: 'anchor: ett datum som finns, ÅÅÅÅ-MM-DD.' })
  anchor?: string;
}

/**
 * PUT /api/v1/reporting-rate/settings. Every field optional: a save names what
 * changed, and the rest keeps its value.
 */
export class ReportingSettingsDto {
  @IsOptional()
  @IsBoolean({ message: 'teacherReminders: sant eller falskt.' })
  teacherReminders?: boolean;

  @IsOptional()
  @IsBoolean({ message: 'rektorDigest: sant eller falskt.' })
  rektorDigest?: boolean;

  @IsOptional()
  @IsInt({ message: `openAfterDays: ett helt antal dagar, ${OPEN_AFTER_DAYS.min} till ${OPEN_AFTER_DAYS.max}.` })
  @Min(OPEN_AFTER_DAYS.min, { message: `openAfterDays: minst ${OPEN_AFTER_DAYS.min} dag.` })
  @Max(OPEN_AFTER_DAYS.max, { message: `openAfterDays: högst ${OPEN_AFTER_DAYS.max} dagar.` })
  openAfterDays?: number;
}
