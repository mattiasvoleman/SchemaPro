import type { NotificationKind } from './notifications.service';

/**
 * WHAT A PUSH MAY SAY.
 *
 * A push leaves SchemaPro: it transits Expo (650 Industries, US), Apple or
 * Google, and lands on a lock screen anybody near the phone can read. So a
 * push names NO person (not the child, the pupil, the teacher or the
 * substitute), carries NO free text (a decision note, a booking title, a
 * cancel note) and NO subject, group or room name: those can be
 * special-category data ("Modersmål arabiska", "Svenska som andraspråk",
 * "Anpassad grundskola 7", "Särskild undervisningsgrupp"). It says what kind
 * of thing happened and when, on the school's clock, and the in-app inbox
 * behind the login has the rest. `data` is { notificationId, type } only.
 *
 * TEACHER_ABSENCE_REPORTED has no text here: it is never pushed.
 *
 * Within one transaction a person gets one push per kind; with more than one
 * notice the body is the plural ("3 lektioner är inställda.").
 */

export type PushLocale = 'sv' | 'en';

/** A notice kind as a push tells it: LESSON_SUBSTITUTE splits in the class's notice and the substitute's own booking. */
export type PushKind = Exclude<NotificationKind, 'TEACHER_ABSENCE_REPORTED'> | 'LESSON_SUBSTITUTE_COVER';

export interface PushText {
  title: string;
  body: string;
}

interface Template {
  title: string;
  /** One notice; {when} / {date} / {from} / {to} filled from the meta, or `bare` when the meta lacks them. */
  one: string | ((approved: boolean) => string);
  bare: string | ((approved: boolean) => string);
  many: string;
}

const SV: Record<PushKind, Template> = {
  LESSON_CANCELLED: {
    title: 'Inställd lektion',
    one: 'En lektion {when} är inställd.',
    bare: 'En lektion är inställd.',
    many: '{count} lektioner är inställda.',
  },
  LESSON_SUBSTITUTE: {
    title: 'Vikarie',
    one: 'En lektion {when} har en vikarie.',
    bare: 'En lektion har en vikarie.',
    many: '{count} lektioner har vikarie.',
  },
  LESSON_SUBSTITUTE_COVER: {
    title: 'Vikariepass',
    one: 'Du har ett vikariepass {when}.',
    bare: 'Du har ett nytt vikariepass.',
    many: 'Du har {count} nya vikariepass.',
  },
  LESSON_COVER_WITHDRAWN: {
    title: 'Avbokat vikariepass',
    one: 'Vikariepasset {when} är avbokat.',
    bare: 'Ett vikariepass är avbokat.',
    many: '{count} vikariepass är avbokade.',
  },
  LESSON_ROOM_CHANGED: {
    title: 'Salsbyte',
    one: 'En lektion {when} har bytt sal.',
    bare: 'En lektion har bytt sal.',
    many: '{count} lektioner har bytt sal.',
  },
  SCHEDULE_CHANGED: {
    title: 'Schemaändring',
    one: 'Schemat har ändrats.',
    bare: 'Schemat har ändrats.',
    many: 'Schemat har ändrats.',
  },
  ABSENCE_UNREPORTED: {
    title: 'Frånvaro',
    one: 'Oanmäld frånvaro {date}. Öppna SchemaPro för att se mer.',
    bare: 'Oanmäld frånvaro. Öppna SchemaPro för att se mer.',
    many: '{count} oanmälda frånvaron {date}. Öppna SchemaPro för att se mer.',
  },
  LEAVE_DECIDED: {
    title: 'Ledighet',
    one: (approved) => `Ledighetsansökan {from}–{to} har ${approved ? 'beviljats' : 'avslagits'}.`,
    bare: (approved) => `En ledighetsansökan har ${approved ? 'beviljats' : 'avslagits'}.`,
    many: '{count} ledighetsansökningar har besvarats.',
  },
  ROOM_BOOKING_DECIDED: {
    title: 'Lokalbokning',
    one: (approved) => `Din lokalbokning {when} har ${approved ? 'godkänts' : 'avslagits'}.`,
    bare: (approved) => `Din lokalbokning har ${approved ? 'godkänts' : 'avslagits'}.`,
    many: '{count} lokalbokningar har besvarats.',
  },
};

const EN: Record<PushKind, Template> = {
  LESSON_CANCELLED: {
    title: 'Lesson cancelled',
    one: 'A lesson {when} is cancelled.',
    bare: 'A lesson is cancelled.',
    many: '{count} lessons are cancelled.',
  },
  LESSON_SUBSTITUTE: {
    title: 'Substitute',
    one: 'A lesson {when} has a substitute.',
    bare: 'A lesson has a substitute.',
    many: '{count} lessons have a substitute.',
  },
  LESSON_SUBSTITUTE_COVER: {
    title: 'Cover lesson',
    one: 'You have a cover lesson {when}.',
    bare: 'You have a new cover lesson.',
    many: 'You have {count} new cover lessons.',
  },
  LESSON_COVER_WITHDRAWN: {
    title: 'Cover withdrawn',
    one: 'The cover lesson {when} is withdrawn.',
    bare: 'A cover lesson is withdrawn.',
    many: '{count} cover lessons are withdrawn.',
  },
  LESSON_ROOM_CHANGED: {
    title: 'Room change',
    one: 'A lesson {when} has moved to another room.',
    bare: 'A lesson has moved to another room.',
    many: '{count} lessons have moved to another room.',
  },
  SCHEDULE_CHANGED: {
    title: 'Timetable change',
    one: 'The timetable has changed.',
    bare: 'The timetable has changed.',
    many: 'The timetable has changed.',
  },
  ABSENCE_UNREPORTED: {
    title: 'Absence',
    one: 'Unreported absence {date}. Open SchemaPro to see more.',
    bare: 'Unreported absence. Open SchemaPro to see more.',
    many: '{count} unreported absences {date}. Open SchemaPro to see more.',
  },
  LEAVE_DECIDED: {
    title: 'Leave',
    one: (approved) => `The leave request {from}–{to} has been ${approved ? 'approved' : 'rejected'}.`,
    bare: (approved) => `A leave request has been ${approved ? 'approved' : 'rejected'}.`,
    many: '{count} leave requests have been answered.',
  },
  ROOM_BOOKING_DECIDED: {
    title: 'Room booking',
    one: (approved) => `Your room booking {when} has been ${approved ? 'approved' : 'rejected'}.`,
    bare: (approved) => `Your room booking has been ${approved ? 'approved' : 'rejected'}.`,
    many: '{count} room bookings have been answered.',
  },
};

export const PUSH_TEMPLATES: Record<PushLocale, Record<PushKind, Template>> = { sv: SV, en: EN };

/** The kind a notice is pushed as; null for one that is never pushed. */
export function pushKindOf(type: NotificationKind, meta: Record<string, unknown>): PushKind | null {
  if (type === 'TEACHER_ABSENCE_REPORTED') return null;
  if (type === 'LESSON_SUBSTITUTE' && meta['cover'] === true) return 'LESSON_SUBSTITUTE_COVER';
  return type;
}

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

/** "tis 13 okt 08:00" / "Tue 13 Oct 08:00" on the school's clock; null for no instant. */
export function whenOf(value: unknown, locale: PushLocale, timezone: string): string | null {
  if (typeof value !== 'string') return null;
  const instant = new Date(value);
  if (Number.isNaN(instant.getTime())) return null;
  const tag = locale === 'sv' ? 'sv-SE' : 'en-GB';
  const day = new Intl.DateTimeFormat(tag, { timeZone: timezone, weekday: 'short', day: 'numeric', month: 'short' })
    .format(instant)
    .replace(/\./g, '')
    .replace(/,/g, '');
  const time = new Intl.DateTimeFormat(tag, { timeZone: timezone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(instant);
  return `${day} ${time}`;
}

/** "13 okt" / "13 Oct" of a YYYY-MM-DD; null for anything else. */
export function dateOf(value: unknown, locale: PushLocale): string | null {
  if (typeof value !== 'string' || !ISO_DAY.test(value)) return null;
  const day = new Date(`${value}T12:00:00.000Z`);
  if (Number.isNaN(day.getTime())) return null;
  return new Intl.DateTimeFormat(locale === 'sv' ? 'sv-SE' : 'en-GB', { timeZone: 'UTC', day: 'numeric', month: 'short' })
    .format(day)
    .replace(/\./g, '');
}

function fill(text: string, values: Record<string, string>): string {
  return text.replace(/\{(\w+)\}/g, (_match, key: string) => values[key] ?? '');
}

/**
 * The push for `count` notices of one kind to one person, in the device's
 * language, from the first notice's meta. Reads only startsAt, date,
 * startDate, endDate and status from the meta, whatever else it carries.
 */
export function pushText(
  kind: PushKind,
  meta: Record<string, unknown>,
  locale: PushLocale,
  timezone: string,
  count = 1,
): PushText {
  const template = PUSH_TEMPLATES[locale][kind];
  const approved = meta['status'] === 'APPROVED';
  const pick = (t: Template['one']) => (typeof t === 'function' ? t(approved) : t);
  const when = whenOf(meta['startsAt'], locale, timezone);
  const date = dateOf(meta['date'], locale);
  const from = dateOf(meta['startDate'], locale);
  const to = dateOf(meta['endDate'], locale);
  if (count > 1) {
    const plural = template.many;
    if (plural.includes('{date}') && !date) return { title: template.title, body: fill(pick(template.bare), {}) };
    return { title: template.title, body: fill(plural, { count: String(count), date: date ?? '' }) };
  }
  const one = pick(template.one);
  const needs = [...one.matchAll(/\{(\w+)\}/g)].map((m) => m[1]!);
  const values: Record<string, string | null> = { when, date, from, to };
  if (needs.some((key) => !values[key])) return { title: template.title, body: pick(template.bare) };
  return { title: template.title, body: fill(one, values as Record<string, string>) };
}
