import { BadRequestException } from '@nestjs/common';

/** Parses "HH:MM" or "HH:MM:SS" into a Date suitable for Prisma `@db.Time`. */
export function parseTimeString(time: string): Date {
  const match = /^(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(time);
  if (!match) {
    throw new BadRequestException(`Invalid time: ${time}. Expected HH:MM.`);
  }
  const date = new Date(0);
  date.setUTCHours(Number(match[1]), Number(match[2]), Number(match[3] ?? 0), 0);
  return date;
}

/** Parses "YYYY-MM-DD" into a Date suitable for Prisma `@db.Date`. */
export function parseDateString(date: string): Date {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw new BadRequestException(`Invalid date: ${date}. Expected YYYY-MM-DD.`);
  }
  const parsed = new Date(`${date}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime())) {
    throw new BadRequestException(`Invalid date: ${date}.`);
  }
  return parsed;
}

/**
 * A `@db.Time` column back out as the wall clock it is: "HH:MM".
 *
 * The inverse of `parseTimeString`, and the missing half of it. Prisma hands a
 * time column back as a `Date` anchored at 1970-01-01, which `JSON.stringify`
 * turns into "1970-01-01T11:00:00.000Z" — so an endpoint that returns the row
 * unserialised sends a timestamp where the client is expecting a clock. The
 * lunch card sliced the first five characters off it, as its comment said
 * PostgreSQL's own format allowed, and put "1970-" into an `<input type="time">`
 * that then rendered empty every time the page loaded.
 *
 * READ IN UTC ON PURPOSE. The stored value is a wall clock with no day and no
 * zone attached; reading it in local time would turn 11:00 into 12:00 for half
 * the year in Stockholm, which is the trap `formatTime` on the web still falls
 * into for this shape. There is nothing to convert — the digits ARE the answer.
 */
export function toWallClock(time: Date): string {
  const hours = time.getUTCHours().toString().padStart(2, '0');
  const minutes = time.getUTCMinutes().toString().padStart(2, '0');
  return `${hours}:${minutes}`;
}

/**
 * The calendar day it is right now IN A SCHOOL'S TIMEZONE, as the UTC midnight
 * that `@db.Date` columns store.
 *
 * `new Date()` with `setUTCHours(0,0,0,0)` gives the UTC day, and for an hour
 * or two after local midnight that is YESTERDAY in Stockholm. Anywhere that
 * compares it against a DATE column to mean "from today onwards" is then off by
 * a day for that window — which is harmless when it merely widens a read, and
 * is not harmless at all when it decides which lessons may be deleted: a day
 * the school has already taught becomes deletable.
 *
 * Formatted through `en-CA`, whose short date format IS yyyy-mm-dd, so the
 * parts do not have to be reassembled by hand.
 */
export function todayInZone(timeZone: string, now: Date = new Date()): Date {
  const day = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
  return new Date(`${day}T00:00:00.000Z`);
}

/**
 * Converts a wall-clock time in a given IANA timezone to the corresponding
 * UTC instant. Used when materializing calendar lessons so "09:00" means
 * 09:00 in the school's timezone regardless of server locale.
 */
export function zonedTimeToUtc(
  dateString: string,
  timeString: string,
  timeZone: string,
): Date {
  const naive = new Date(`${dateString}T${normalizeTime(timeString)}Z`);

  // Determine the timezone offset at (approximately) that instant, then
  // shift the naive UTC timestamp by it. A second pass handles DST edges.
  let utc = shiftByZoneOffset(naive, timeZone);
  utc = shiftByZoneOffset(naive, timeZone, utc);
  return utc;
}

function normalizeTime(time: string): string {
  return /^\d{2}:\d{2}$/.test(time) ? `${time}:00` : time;
}

function shiftByZoneOffset(naive: Date, timeZone: string, probe?: Date): Date {
  const reference = probe ?? naive;
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });

  const parts = formatter.formatToParts(reference);
  const get = (type: string): number =>
    Number(parts.find((part) => part.type === type)?.value ?? '0');

  const asIfUtc = Date.UTC(
    get('year'),
    get('month') - 1,
    get('day'),
    get('hour') % 24,
    get('minute'),
    get('second'),
  );
  const offsetMs = asIfUtc - reference.getTime();
  return new Date(naive.getTime() - offsetMs);
}
