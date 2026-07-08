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
