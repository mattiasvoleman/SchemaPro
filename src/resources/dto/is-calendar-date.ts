import { registerDecorator, type ValidationOptions } from 'class-validator';

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Whether a string is a date that exists, not merely one that is shaped right.
 *
 * `/^\d{4}-\d{2}-\d{2}$/` alone is a shape check, and JavaScript's own parser
 * finishes the job badly: `new Date('2026-02-30T00:00:00.000Z')` does not fail,
 * it ROLLS OVER to 2026-03-02. Only the month and day *fields* are range
 * checked (`2026-13-01` and `2026-00-10` are Invalid Date); the day of month is
 * not checked against the length of the month at all. So an admin who typed
 * 30 for 28 got a period silently starting two days into March, saved without
 * complaint and never mentioned again — the one class of mistake that is
 * invisible precisely because the input looked plausible.
 *
 * The round trip is the check: parse, print the parsed instant back as
 * YYYY-MM-DD, and require it to be the string we were given. A rolled-over date
 * prints as the day it rolled to and cannot match. Rejected as 400 rather than
 * corrected to the 28th — guessing which of "28", "29" or "1 mars" was meant is
 * a guess, and a silently corrected date is the same failure as before with a
 * friendlier face.
 *
 * Considered and rejected: `@IsDateString()`, which also accepts a full instant
 * (`2026-02-28T13:00:00Z`). These columns are DATE, the time of day has nowhere
 * to be stored, and a caller who sent one deserves to hear that rather than
 * have it quietly sliced off — the same argument the period fields already make
 * for not using it.
 */
export function isCalendarDate(value: unknown): value is string {
  if (typeof value !== 'string' || !ISO_DATE.test(value)) return false;

  // Parsed as UTC midnight, printed back the same way, so the comparison never
  // depends on the server's timezone — a local-time parse would print the
  // previous day for every server west of Greenwich and reject every date.
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime())) return false;
  return parsed.toISOString().slice(0, 10) === value;
}

/**
 * `@IsCalendarDate()` — YYYY-MM-DD *and* a date that exists.
 *
 * Its own module rather than a private helper inside one DTO: the same
 * `ISO_DATE` shape check is copied into availability-constraint.dto.ts,
 * academic-year.dto.ts, publish-schedule.dto.ts and family.dto.ts, all with the
 * same hole. They are not converted here (each is owned by other work in
 * flight), but converting one is a one-line change once this exists.
 */
export function IsCalendarDate(options?: ValidationOptions) {
  return function (object: object, propertyName: string): void {
    registerDecorator({
      name: 'isCalendarDate',
      target: object.constructor,
      propertyName,
      options: {
        message: `${propertyName} must be a real date in YYYY-MM-DD form.`,
        ...options,
      },
      validator: { validate: (value: unknown) => isCalendarDate(value) },
    });
  };
}
