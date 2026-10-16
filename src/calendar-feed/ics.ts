/**
 * A calendar feed as iCalendar (RFC 5545), from what app.calendar_feed
 * answers (migration 20261112091000). Everything the feed shows was decided
 * in the database; this only writes it down:
 *
 *   - one VEVENT per lesson, its UID the lesson's own id with whose week it
 *     is (the feed's scope: a guardian holding two children's feeds, or a
 *     teacher their own and their child's, has two entries of a lesson they
 *     share, not one UID in two calendars), so a calendar follows a lesson
 *     that moves rather than seeing a new one; LAST-MODIFIED and SEQUENCE
 *     are the lesson's version (its row's updatedAt, written on the API's
 *     clock by whatever moves or cancels it), so a calendar that compares
 *     sequences takes the moved lesson; DTSTAMP is
 *     when the file was written, as METHOD:PUBLISH has it;
 *   - a cancelled lesson stays, STATUS:CANCELLED and "Inställd: …" in its
 *     summary (a calendar that hides cancelled events loses nothing it
 *     should show, one that shows them says so), and free time (TRANSPARENT);
 *   - lov and studiedagar as all-day entries, free time;
 *   - times on the school's clock with the school's VTIMEZONE when the
 *     school keeps Stockholm's (every school so far), in UTC otherwise, so a
 *     time is never written against a zone the file does not define.
 *
 * Lines end in CRLF and fold at 75 octets, between code points.
 */

export type FeedAudience = 'TEACHER' | 'STUDENT' | 'GUARDIAN';
export type FeedLocale = 'sv' | 'en';

export interface FeedLesson {
  id: string;
  /** YYYY-MM-DD, the school's day. */
  date: string;
  /** YYYYMMDDTHHMMSS on the school's clock. */
  start: string;
  end: string;
  /** YYYYMMDDTHHMMSSZ. */
  startUtc: string;
  endUtc: string;
  cancelled: boolean;
  subject: string;
  room: string | null;
  /** A teacher's feed: the lesson's groups, its own first. */
  groups: string[];
  /** A teacher's feed: the colleagues on it; a pupil's: the teachers as the school names them to families. */
  teachers: string[];
  /** A teacher's feed: they cover it; a pupil's: a substitute holds it. */
  substitute: boolean;
  /** YYYYMMDDTHHMMSSZ. */
  version: string;
}

export interface FeedBreak {
  id: string;
  name: string;
  kind: 'HOLIDAY' | 'STAFF_DAY';
  /** YYYYMMDD, inclusive. */
  from: string;
  /** YYYYMMDD, the day after the last. */
  until: string;
  version: string;
}

export interface FeedDocument {
  audience: FeedAudience;
  /** Whose week, for the UIDs: the pupil's id, or the teacher's own. */
  scope: string;
  locale: FeedLocale;
  /** Whose week: the teacher's or the pupil's name, a child's first name. */
  title: string;
  school: string;
  timezone: string;
  lessons: FeedLesson[];
  breaks: FeedBreak[];
}

const WORDS: Record<FeedLocale, { calendar: string; cancelled: string; covering: string; substitute: string; teachers: string }> = {
  sv: { calendar: 'Schema', cancelled: 'Inställd', covering: 'Du är vikarie', substitute: 'Vikarie', teachers: 'Lärare' },
  en: { calendar: 'Timetable', cancelled: 'Cancelled', covering: 'You are covering', substitute: 'Substitute', teachers: 'Teachers' },
};

/** Stockholm's rules since 1996: CEST from the last Sunday of March, CET from the last Sunday of October. */
const STOCKHOLM = 'Europe/Stockholm';
const STOCKHOLM_VTIMEZONE = [
  'BEGIN:VTIMEZONE',
  `TZID:${STOCKHOLM}`,
  `X-LIC-LOCATION:${STOCKHOLM}`,
  'BEGIN:DAYLIGHT',
  'TZOFFSETFROM:+0100',
  'TZOFFSETTO:+0200',
  'TZNAME:CEST',
  'DTSTART:19700329T020000',
  'RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=-1SU',
  'END:DAYLIGHT',
  'BEGIN:STANDARD',
  'TZOFFSETFROM:+0200',
  'TZOFFSETTO:+0100',
  'TZNAME:CET',
  'DTSTART:19701025T030000',
  'RRULE:FREQ=YEARLY;BYMONTH=10;BYDAY=-1SU',
  'END:STANDARD',
  'END:VTIMEZONE',
];

/** SEQUENCE from a version: whole seconds since 2024, so it grows as the lesson changes. */
const SEQUENCE_EPOCH = Date.UTC(2024, 0, 1);

export function sequenceOf(version: string): number {
  const match = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(version);
  if (!match) return 0;
  const [, y, mo, d, h, mi, s] = match.map(Number);
  const at = Date.UTC(y!, mo! - 1, d!, h!, mi!, s!);
  return Math.max(0, Math.floor((at - SEQUENCE_EPOCH) / 1000));
}

/**
 * RFC 5545 §3.3.11: backslash, semicolon and comma escaped, a line break
 * (CRLF, LF or a lone CR) as \n, and no other control character, which TEXT
 * does not admit and a lone CR would end the line with: a name the school
 * typed or pasted is never a property of its own.
 */
export function escapeText(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r\n|\r|\n/g, '\\n')
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '');
}

/** A moment as an iCalendar UTC date-time, YYYYMMDDTHHMMSSZ. */
export function utcStamp(at: Date): string {
  return at.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
}

const encoder = new TextEncoder();

/**
 * RFC 5545 §3.1: at most 75 octets a line, the rest on lines behind one
 * space, which counts toward their 75. Octets, not characters, so a Swedish
 * name reaches the limit sooner than its length says; never inside a code
 * point, which would corrupt the text for every client that unfolds it.
 */
export function fold(line: string): string {
  if (encoder.encode(line).length <= 75) return line;
  const physical: string[] = [];
  let current = '';
  let octets = 0;
  for (const char of line) {
    const size = encoder.encode(char).length;
    if (octets + size > 75) {
      physical.push(current);
      current = ' ';
      octets = 1;
    }
    current += char;
    octets += size;
  }
  physical.push(current);
  return physical.join('\r\n');
}

/** The feed as a calendar takes it, written at `stamp` (each entry's DTSTAMP). */
export function feedIcs(document: FeedDocument, stamp: Date): string {
  const words = WORDS[document.locale] ?? WORDS.sv;
  const dtstamp = utcStamp(stamp);
  const local = document.timezone === STOCKHOLM;
  const at = (localTime: string, utc: string) => (local ? `;TZID=${STOCKHOLM}:${localTime}` : `:${utc}`);
  const lines: string[] = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//SchemaPro//Kalenderprenumeration//SV',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    `X-WR-CALNAME:${escapeText(`${words.calendar} – ${document.title} (${document.school})`)}`,
    ...(local ? [`X-WR-TIMEZONE:${STOCKHOLM}`] : []),
    // A hint the calendar may take: ask again within the hour, so a
    // cancellation reaches it the same morning.
    'REFRESH-INTERVAL;VALUE=DURATION:PT1H',
    'X-PUBLISHED-TTL:PT1H',
    ...(local ? STOCKHOLM_VTIMEZONE : []),
  ];

  for (const lesson of document.lessons) {
    const description: string[] = [];
    if (document.audience === 'TEACHER') {
      if (lesson.groups.length > 0) description.push(lesson.groups.join(', '));
      if (lesson.substitute) description.push(words.covering);
      if (lesson.teachers.length > 0) description.push(`${words.teachers}: ${lesson.teachers.join(', ')}`);
    } else {
      if (lesson.substitute) description.push(words.substitute);
      else if (lesson.teachers.length > 0) description.push(`${words.teachers}: ${lesson.teachers.join(', ')}`);
    }
    const summary = lesson.cancelled ? `${words.cancelled}: ${lesson.subject}` : lesson.subject;
    lines.push(
      'BEGIN:VEVENT',
      `UID:${lesson.id}.${document.scope}@schemapro`,
      `DTSTAMP:${dtstamp}`,
      `LAST-MODIFIED:${lesson.version}`,
      `SEQUENCE:${sequenceOf(lesson.version)}`,
      `DTSTART${at(lesson.start, lesson.startUtc)}`,
      `DTEND${at(lesson.end, lesson.endUtc)}`,
      `SUMMARY:${escapeText(summary)}`,
      ...(lesson.room ? [`LOCATION:${escapeText(lesson.room)}`] : []),
      ...(description.length > 0 ? [`DESCRIPTION:${escapeText(description.join('\n'))}`] : []),
      `STATUS:${lesson.cancelled ? 'CANCELLED' : 'CONFIRMED'}`,
      `TRANSP:${lesson.cancelled ? 'TRANSPARENT' : 'OPAQUE'}`,
      'END:VEVENT',
    );
  }

  for (const entry of document.breaks) {
    lines.push(
      'BEGIN:VEVENT',
      `UID:break-${entry.id}.${document.scope}@schemapro`,
      `DTSTAMP:${dtstamp}`,
      `LAST-MODIFIED:${entry.version}`,
      `SEQUENCE:${sequenceOf(entry.version)}`,
      `DTSTART;VALUE=DATE:${entry.from}`,
      `DTEND;VALUE=DATE:${entry.until}`,
      `SUMMARY:${escapeText(entry.name)}`,
      'STATUS:CONFIRMED',
      'TRANSP:TRANSPARENT',
      'END:VEVENT',
    );
  }

  lines.push('END:VCALENDAR');
  return `${lines.map(fold).join('\r\n')}\r\n`;
}
