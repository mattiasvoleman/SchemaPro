import { Transform, Type } from 'class-transformer';
import { IsBoolean, IsInt, IsISO8601, IsOptional, Matches, Max, MaxLength, Min } from 'class-validator';
import { CLOCK, KITCHEN_EMAIL, KITCHEN_EMAIL_MAX, MEAL_COUNTS_MAX_DAYS } from '../meal-counts';

/** A date from 2000-01-01 to 2100-12-31: the years the date arithmetic stays inside. */
const DAY = /^(20\d{2}|2100)-\d{2}-\d{2}$/;

/**
 * GET /api/v1/meal-counts (and /csv). `from` is the first day (today without it) and `to` the last (the
 * same day without it), or `days` says how many days from `from` (the week ahead is `days=7`, which a page
 * can ask for without knowing the school's today): at most 14 days, none before today, and not both `to` and
 * `days`. The dates must exist (2027-02-30 does not) and the message names the field.
 */
export class MealCountsQueryDto {
  @IsOptional()
  @Matches(DAY, { message: 'from: ett datum ÅÅÅÅ-MM-DD mellan 2000-01-01 och 2100-12-31.' })
  @IsISO8601({ strict: true }, { message: 'from: ett datum som finns, ÅÅÅÅ-MM-DD.' })
  from?: string;

  @IsOptional()
  @Matches(DAY, { message: 'to: ett datum ÅÅÅÅ-MM-DD mellan 2000-01-01 och 2100-12-31.' })
  @IsISO8601({ strict: true }, { message: 'to: ett datum som finns, ÅÅÅÅ-MM-DD.' })
  to?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: `days: ett helt antal dagar, 1 till ${MEAL_COUNTS_MAX_DAYS}.` })
  @Min(1, { message: `days: ett helt antal dagar, 1 till ${MEAL_COUNTS_MAX_DAYS}.` })
  @Max(MEAL_COUNTS_MAX_DAYS, { message: `days: ett helt antal dagar, 1 till ${MEAL_COUNTS_MAX_DAYS}.` })
  days?: number;
}

/** Blank is none: the address field of a form sends "" for a field left empty. */
const blankIsNull = ({ value }: { value: unknown }) => {
  if (typeof value !== 'string') return value;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
};

/**
 * PUT /api/v1/meal-counts/settings. Every field is optional: a save names what changed and the rest keeps its
 * value; null clears the cut-off or the address. That the letter, once on, has both is the service's refusal,
 * said with a code, and the database's CHECK behind it.
 */
export class MealSettingsDto {
  @IsOptional()
  @Matches(CLOCK, { message: 'cutoffTime: en tid TT:MM mellan 00:00 och 23:59.' })
  cutoffTime?: string | null;

  @IsOptional()
  @IsBoolean({ message: 'letterEnabled: sant eller falskt.' })
  letterEnabled?: boolean;

  @IsOptional()
  @Transform(blankIsNull)
  @MaxLength(KITCHEN_EMAIL_MAX, { message: 'kitchenEmail: högst 254 tecken.' })
  @Matches(KITCHEN_EMAIL, { message: 'kitchenEmail: en e-postadress, bara en.' })
  kitchenEmail?: string | null;
}
