/**
 * Måltidskollen (20270123090000): the portions of each lunch sitting, for the kitchen. The shapes are the
 * gateway's (GET /api/v1/meal-counts, src/meal-counts/meal-counts.ts), held to it by one fixture both
 * sides read (src/meal-counts/__fixtures__/week.json), and the small helpers the page and its settings use.
 *
 * What a portion is, in the one sentence the page also says: the pupils of the classes that eat in the
 * sitting, less those reported absent for the whole sitting before the cut-off, plus the staff whose
 * pedagogisk lunch the school has placed there. Nothing here names a pupil or knows a diet.
 */

export interface MealClass {
  groupId: string;
  name: string;
  pupils: number;
  absentBefore: number;
  absentAfter: number;
  underActivity: boolean;
  /** pupils - absentBefore: what the class adds to the sitting. */
  portions: number;
}

export interface MealTotals {
  pupils: number;
  /** Reported absent for the whole sitting before the cut-off: taken off. */
  absentBefore: number;
  staff: number;
  portions: number;
  /** Reported after the cut-off: shown, never taken off. */
  absentAfter: number;
  /** Pupils in classes with a replacement lesson over the sitting: counted all the same. */
  underActivity: number;
}

export interface MealSitting extends MealTotals {
  /** HH:MM, in the school's time. */
  start: string;
  end: string;
  classes: MealClass[];
}

export interface MealDay {
  /** yyyy-mm-dd. */
  date: string;
  /** ISO weekday, 1 (Monday) to 7. */
  weekday: number;
  sittings: MealSitting[];
  totals: MealTotals;
}

export interface MealCountsView {
  from: string;
  to: string;
  /** HH:MM, or null: no cut-off, so no absence is taken off. */
  cutoff: string | null;
  /** False: no pedagogisk lunch with a fixed time is placed, and no staff are in the counts. */
  staffModelled: boolean;
  days: MealDay[];
}

export interface MealSettings {
  /** HH:MM in the school's time; null is none. */
  cutoffTime: string | null;
  letterEnabled: boolean;
  kitchenEmail: string | null;
  /** yyyy-mm-dd of the last letter, as far back as the job's trace goes (35 days). */
  lastLetterOn: string | null;
}

export interface MealSettingsChange {
  cutoffTime?: string | null;
  letterEnabled?: boolean;
  kitchenEmail?: string | null;
}

/** The week ahead the page opens on, and the most days the gateway answers for. */
export const MEAL_WEEK_DAYS = 7;
export const MEAL_MAX_DAYS = 14;

/** A time of day, 00:00 to 23:59 (the gateway's CLOCK). */
export const CLOCK = /^([01]\d|2[0-3]):[0-5]\d$/;
/** One address, as the gateway and the database say it. */
export const KITCHEN_EMAIL = /^[^@\s,;<>"()]+@[^@\s,;<>"()]+\.[^@\s,;<>"()]+$/;
export const KITCHEN_EMAIL_MAX = 254;

export const isKitchenEmail = (value: string): boolean => value.length <= KITCHEN_EMAIL_MAX && KITCHEN_EMAIL.test(value);

/** A yyyy-mm-dd day `count` days on (or back), as a calendar date, whatever the browser's time zone. */
export function addDays(day: string, count: number): string {
  const [year, month, date] = day.split("-").map(Number) as [number, number, number];
  return new Date(Date.UTC(year, month - 1, date + count)).toISOString().slice(0, 10);
}

/** What the settings form holds: text, as the fields do. */
export interface MealSettingsForm {
  cutoff: string;
  email: string;
  enabled: boolean;
}

export const formOf = (settings: MealSettings): MealSettingsForm => ({
  cutoff: settings.cutoffTime ?? "",
  email: settings.kitchenEmail ?? "",
  enabled: settings.letterEnabled,
});

/** Whether a form can hold the letter on: an hour and one address. */
export function letterPossible(form: Pick<MealSettingsForm, "cutoff" | "email">): boolean {
  return CLOCK.test(form.cutoff) && isKitchenEmail(form.email.trim());
}

/** The first thing wrong with a form, as the key of its message, or null. */
export function formProblem(form: MealSettingsForm): "cutoff" | "email" | "letter" | null {
  if (form.cutoff !== "" && !CLOCK.test(form.cutoff)) return "cutoff";
  if (form.email.trim() !== "" && !isKitchenEmail(form.email.trim())) return "email";
  if (form.enabled && !letterPossible(form)) return "letter";
  return null;
}

/** The save for a form: what differs from what is stored, so a save names what changed. */
export function changeOf(form: MealSettingsForm, stored: MealSettings): MealSettingsChange {
  const change: MealSettingsChange = {};
  const cutoff = form.cutoff === "" ? null : form.cutoff;
  const email = form.email.trim() === "" ? null : form.email.trim();
  if (cutoff !== stored.cutoffTime) change.cutoffTime = cutoff;
  if (email !== stored.kitchenEmail) change.kitchenEmail = email;
  if (form.enabled !== stored.letterEnabled) change.letterEnabled = form.enabled;
  return change;
}

/** The file's name for a range, as the gateway names it (src/meal-counts/meal-counts.ts mealCsvName). */
export const csvName = (from: string, to: string): string =>
  from === to ? `portioner-${from}.csv` : `portioner-${from}-${to}.csv`;
