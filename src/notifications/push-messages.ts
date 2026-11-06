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
 * A leave request waiting for the mentor (LEAVE_REQUESTED) says its days and
 * nothing of the pupil or the reason. A rastvaktspass booked or withdrawn
 * (SUPERVISION_COVER, _WITHDRAWN) says when, and not where: an area's name is
 * the school's own words.
 *
 * TEACHER_ABSENCE_REPORTED has no text here: it is never pushed. A request
 * to cover (COVER_REQUESTED) says when, never which lesson or who is away; the
 * end of one (COVER_REQUEST_CLOSED) is pushed as TAKEN, WITHDRAWN or
 * NOT_NEEDED to the colleagues and as UNANSWERED to the administrator. An
 * avbokning digest (CANCELLATION_DIGEST) says how many of the person's
 * lessons and over which days, never the avbokning's name ("Prao åk 9" is
 * free text the admin typed); its reversal is a kind of its own.
 *
 * A summary of absence (ABSENCE_WATCH_DIGEST) says that there is one, and
 * not how many pupils it counts or which: the count is data about pupils.
 *
 * An alarm (CRISIS_ALARM, Krisläge) says that an alarm is going, and that it is
 * an exercise when it is: no kind of alarm, no pupil, group or place, and no
 * time (the phone shows when the push arrived). Its end and the notice to the
 * guardians afterwards (CRISIS_GUARDIAN_AFTER) say as little.
 * The reporting rate (Rapporteringsgrad) is told the same way: a reminder
 * (LESSON_REPORT_REMINDER) says that lessons are waiting for their register,
 * not how many, which or when, and the weekly notice to rektor
 * (REPORTING_RATE_DIGEST) says that there is one, with no figure. A figure is
 * about the teachers, and the lock screen is not the place for it.
 *
 * Within one transaction a person gets one push per kind; with more than one
 * notice the body is the plural ("3 lektioner är inställda.").
 *
 * A push names no app either ("Öppna appen", never the product's name). The
 * phone already shows the owning app's name and icon above it, and the
 * gateway does not know which of the two apps holds a token: one Expo
 * request carries a class's pupils and guardians alike.
 */

export type PushLocale = 'sv' | 'en';

/**
 * A notice kind as a push tells it: LESSON_SUBSTITUTE splits in the class's
 * notice and the substitute's own booking, CANCELLATION_DIGEST in the
 * avbokning and its reversal.
 */
export type PushKind =
  | Exclude<NotificationKind, 'TEACHER_ABSENCE_REPORTED' | 'COVER_REQUEST_CLOSED'>
  | 'LESSON_SUBSTITUTE_COVER'
  | 'CANCELLATION_DIGEST_REVERSED'
  | 'COVER_REQUEST_TAKEN'
  | 'COVER_REQUEST_WITHDRAWN'
  | 'COVER_REQUEST_NOT_NEEDED'
  | 'COVER_REQUEST_UNANSWERED'
  | 'CRISIS_ALARM_DRILL'
  | 'CRISIS_ENDED_DRILL';

export interface PushText {
  title: string;
  body: string;
}

/** What a template may choose its words by: a decision's outcome, a digest's number of lessons. */
interface Context {
  approved: boolean;
  lessons: number;
}

interface Template {
  title: string;
  /** One notice; {when} / {date} / {from} / {to} / {span} filled from the meta, or `bare` when the meta lacks them. */
  one: string | ((context: Context) => string);
  bare: string | ((context: Context) => string);
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
    one: 'Oanmäld frånvaro {date}. Öppna appen för att se mer.',
    bare: 'Oanmäld frånvaro. Öppna appen för att se mer.',
    many: '{count} oanmälda frånvaron {date}. Öppna appen för att se mer.',
  },
  LEAVE_DECIDED: {
    title: 'Ledighet',
    one: ({ approved }) => `Ledighetsansökan {from}–{to} har ${approved ? 'beviljats' : 'avslagits'}.`,
    bare: ({ approved }) => `En ledighetsansökan har ${approved ? 'beviljats' : 'avslagits'}.`,
    many: '{count} ledighetsansökningar har besvarats.',
  },
  ROOM_BOOKING_DECIDED: {
    title: 'Lokalbokning',
    one: ({ approved }) => `Din lokalbokning {when} har ${approved ? 'godkänts' : 'avslagits'}.`,
    bare: ({ approved }) => `Din lokalbokning har ${approved ? 'godkänts' : 'avslagits'}.`,
    many: '{count} lokalbokningar har besvarats.',
  },
  LESSON_REINSTATED: {
    title: 'Lektion enligt schema',
    one: 'En lektion {when} blir av som planerat.',
    bare: 'En lektion blir av som planerat.',
    many: '{count} lektioner blir av som planerat.',
  },
  LESSON_SUPERVISED_STUDY: {
    title: 'Självstudier',
    one: 'En lektion {when} blir självstudier under tillsyn.',
    bare: 'En lektion blir självstudier under tillsyn.',
    many: '{count} lektioner blir självstudier under tillsyn.',
  },
  CANCELLATION_DIGEST: {
    title: 'Inställda lektioner',
    one: ({ lessons }) => (lessons === 1 ? 'En lektion {span} är inställd.' : `${lessons} lektioner {span} är inställda.`),
    bare: 'Lektioner är inställda.',
    many: 'Lektioner är inställda.',
  },
  LEAVE_REQUESTED: {
    title: 'Ledighet',
    one: 'En ledighetsansökan {span} väntar på ditt beslut.',
    bare: 'En ledighetsansökan väntar på ditt beslut.',
    many: '{count} ledighetsansökningar väntar på ditt beslut.',
  },
  SUPERVISION_COVER: {
    title: 'Rastvaktspass',
    one: 'Du har ett rastvaktspass {when}.',
    bare: 'Du har ett nytt rastvaktspass.',
    many: 'Du har {count} nya rastvaktspass.',
  },
  SUPERVISION_COVER_WITHDRAWN: {
    title: 'Avbokat rastvaktspass',
    one: 'Rastvaktspasset {when} är avbokat.',
    bare: 'Ett rastvaktspass är avbokat.',
    many: '{count} rastvaktspass är avbokade.',
  },
  COVER_REQUESTED: {
    title: 'Vikariefråga',
    one: 'Kan du vikariera {when}? Svara i appen.',
    bare: 'Kan du vikariera? Svara i appen.',
    many: '{count} vikariefrågor väntar på svar.',
  },
  COVER_REQUEST_ACCEPTED: {
    title: 'Vikarie tillsatt',
    one: 'En kollega har tackat ja till passet {when}.',
    bare: 'En kollega har tackat ja till ett vikariepass.',
    many: '{count} vikariepass har fått en vikarie.',
  },
  COVER_REQUEST_TAKEN: {
    title: 'Uppdraget är tillsatt',
    one: 'Passet {when} är redan tillsatt av en kollega.',
    bare: 'Ett pass är redan tillsatt av en kollega.',
    many: '{count} pass är redan tillsatta.',
  },
  COVER_REQUEST_WITHDRAWN: {
    title: 'Vikariefrågan indragen',
    one: 'Frågan om passet {when} är indragen. Du behöver inte svara.',
    bare: 'En vikariefråga är indragen. Du behöver inte svara.',
    many: '{count} vikariefrågor är indragna. Du behöver inte svara.',
  },
  COVER_REQUEST_NOT_NEEDED: {
    title: 'Vikariefrågan behövs inte',
    one: 'Frågan om passet {when} behövs inte längre. Du behöver inte svara.',
    bare: 'En vikariefråga behövs inte längre. Du behöver inte svara.',
    many: '{count} vikariefrågor behövs inte längre. Du behöver inte svara.',
  },
  COVER_REQUEST_UNANSWERED: {
    title: 'Ingen har tackat ja',
    one: 'Ingen har tackat ja till passet {when}.',
    bare: 'Ingen har tackat ja till en vikariefråga.',
    many: 'Ingen har tackat ja till {count} vikariefrågor.',
  },
  ABSENCE_WATCH_DIGEST: {
    title: 'Frånvaro',
    one: 'Du har en ny frånvarosammanställning. Öppna appen för att se mer.',
    bare: 'Du har en ny frånvarosammanställning. Öppna appen för att se mer.',
    many: 'Du har en ny frånvarosammanställning. Öppna appen för att se mer.',
  },
  CRISIS_ALARM: {
    title: 'Larm pågår',
    one: 'Ett larm pågår. Öppna appen och räkna din grupp.',
    bare: 'Ett larm pågår. Öppna appen och räkna din grupp.',
    many: 'Ett larm pågår. Öppna appen och räkna din grupp.',
  },
  CRISIS_ALARM_DRILL: {
    title: 'Övning pågår',
    one: 'En övning pågår. Öppna appen och räkna din grupp.',
    bare: 'En övning pågår. Öppna appen och räkna din grupp.',
    many: 'En övning pågår. Öppna appen och räkna din grupp.',
  },
  CRISIS_ENDED: {
    title: 'Larmet är över',
    one: 'Larmet är avslutat.',
    bare: 'Larmet är avslutat.',
    many: 'Larmet är avslutat.',
  },
  CRISIS_ENDED_DRILL: {
    title: 'Övningen är över',
    one: 'Övningen är avslutad.',
    bare: 'Övningen är avslutad.',
    many: 'Övningen är avslutad.',
  },
  CRISIS_GUARDIAN_AFTER: {
    title: 'Larm på skolan',
    one: 'Skolan har haft ett larm. Det är avslutat. Läs mer i appen.',
    bare: 'Skolan har haft ett larm. Det är avslutat. Läs mer i appen.',
    many: 'Skolan har haft ett larm. Det är avslutat. Läs mer i appen.',
  },
  LESSON_REPORT_REMINDER: {
    title: 'Närvaro',
    one: 'Du har lektioner utan sparad närvaro. Öppna appen för att se vilka.',
    bare: 'Du har lektioner utan sparad närvaro. Öppna appen för att se vilka.',
    many: 'Du har lektioner utan sparad närvaro. Öppna appen för att se vilka.',
  },
  REPORTING_RATE_DIGEST: {
    title: 'Rapporteringsgrad',
    one: 'Du har ett nytt veckobesked om rapporteringsgraden. Öppna appen för att se mer.',
    bare: 'Du har ett nytt veckobesked om rapporteringsgraden. Öppna appen för att se mer.',
    many: 'Du har ett nytt veckobesked om rapporteringsgraden. Öppna appen för att se mer.',
  },
  CANCELLATION_DIGEST_REVERSED: {
    title: 'Lektioner blir av',
    one: ({ lessons }) =>
      lessons === 1
        ? 'En inställd lektion {span} blir av som planerat.'
        : `${lessons} inställda lektioner {span} blir av som planerat.`,
    bare: 'Inställda lektioner blir av som planerat.',
    many: 'Inställda lektioner blir av som planerat.',
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
    one: 'Unreported absence {date}. Open the app to see more.',
    bare: 'Unreported absence. Open the app to see more.',
    many: '{count} unreported absences {date}. Open the app to see more.',
  },
  LEAVE_DECIDED: {
    title: 'Leave',
    one: ({ approved }) => `The leave request {from}–{to} has been ${approved ? 'approved' : 'rejected'}.`,
    bare: ({ approved }) => `A leave request has been ${approved ? 'approved' : 'rejected'}.`,
    many: '{count} leave requests have been answered.',
  },
  ROOM_BOOKING_DECIDED: {
    title: 'Room booking',
    one: ({ approved }) => `Your room booking {when} has been ${approved ? 'approved' : 'rejected'}.`,
    bare: ({ approved }) => `Your room booking has been ${approved ? 'approved' : 'rejected'}.`,
    many: '{count} room bookings have been answered.',
  },
  LESSON_REINSTATED: {
    title: 'Lesson as planned',
    one: 'A lesson {when} goes ahead as planned.',
    bare: 'A lesson goes ahead as planned.',
    many: '{count} lessons go ahead as planned.',
  },
  LESSON_SUPERVISED_STUDY: {
    title: 'Supervised study',
    one: 'A lesson {when} becomes supervised self-study.',
    bare: 'A lesson becomes supervised self-study.',
    many: '{count} lessons become supervised self-study.',
  },
  CANCELLATION_DIGEST: {
    title: 'Lessons cancelled',
    one: ({ lessons }) => (lessons === 1 ? 'A lesson {span} is cancelled.' : `${lessons} lessons {span} are cancelled.`),
    bare: 'Lessons are cancelled.',
    many: 'Lessons are cancelled.',
  },
  LEAVE_REQUESTED: {
    title: 'Leave',
    one: 'A leave request {span} is waiting for your decision.',
    bare: 'A leave request is waiting for your decision.',
    many: '{count} leave requests are waiting for your decision.',
  },
  SUPERVISION_COVER: {
    title: 'Break duty',
    one: 'You have break duty {when}.',
    bare: 'You have a new break duty.',
    many: 'You have {count} new break duties.',
  },
  SUPERVISION_COVER_WITHDRAWN: {
    title: 'Break duty withdrawn',
    one: 'The break duty {when} is withdrawn.',
    bare: 'A break duty is withdrawn.',
    many: '{count} break duties are withdrawn.',
  },
  COVER_REQUESTED: {
    title: 'Cover request',
    one: 'Can you cover {when}? Answer in the app.',
    bare: 'Can you cover a lesson? Answer in the app.',
    many: '{count} cover requests are waiting for an answer.',
  },
  COVER_REQUEST_ACCEPTED: {
    title: 'Cover found',
    one: 'A colleague has said yes to the lesson {when}.',
    bare: 'A colleague has said yes to a cover lesson.',
    many: '{count} cover lessons have a substitute.',
  },
  COVER_REQUEST_TAKEN: {
    title: 'Already covered',
    one: 'The lesson {when} is already covered by a colleague.',
    bare: 'A lesson is already covered by a colleague.',
    many: '{count} lessons are already covered.',
  },
  COVER_REQUEST_WITHDRAWN: {
    title: 'Cover request withdrawn',
    one: 'The question about the lesson {when} is withdrawn.',
    bare: 'A cover request is withdrawn.',
    many: '{count} cover requests are withdrawn.',
  },
  COVER_REQUEST_NOT_NEEDED: {
    title: 'Cover request not needed',
    one: 'The question about the lesson {when} is no longer needed. You need not answer.',
    bare: 'A cover request is no longer needed. You need not answer.',
    many: '{count} cover requests are no longer needed. You need not answer.',
  },
  COVER_REQUEST_UNANSWERED: {
    title: 'Nobody said yes',
    one: 'Nobody said yes to the lesson {when}.',
    bare: 'Nobody said yes to a cover request.',
    many: 'Nobody said yes to {count} cover requests.',
  },
  ABSENCE_WATCH_DIGEST: {
    title: 'Absence',
    one: 'You have a new absence summary. Open the app to see more.',
    bare: 'You have a new absence summary. Open the app to see more.',
    many: 'You have a new absence summary. Open the app to see more.',
  },
  CRISIS_ALARM: {
    title: 'Alarm going',
    one: 'An alarm is going. Open the app and count your group.',
    bare: 'An alarm is going. Open the app and count your group.',
    many: 'An alarm is going. Open the app and count your group.',
  },
  CRISIS_ALARM_DRILL: {
    title: 'Drill going',
    one: 'A drill is going. Open the app and count your group.',
    bare: 'A drill is going. Open the app and count your group.',
    many: 'A drill is going. Open the app and count your group.',
  },
  CRISIS_ENDED: {
    title: 'The alarm is over',
    one: 'The alarm has ended.',
    bare: 'The alarm has ended.',
    many: 'The alarm has ended.',
  },
  CRISIS_ENDED_DRILL: {
    title: 'The drill is over',
    one: 'The drill has ended.',
    bare: 'The drill has ended.',
    many: 'The drill has ended.',
  },
  CRISIS_GUARDIAN_AFTER: {
    title: 'Alarm at the school',
    one: 'The school has had an alarm. It has ended. Read more in the app.',
    bare: 'The school has had an alarm. It has ended. Read more in the app.',
    many: 'The school has had an alarm. It has ended. Read more in the app.',
  },
  LESSON_REPORT_REMINDER: {
    title: 'Attendance',
    one: 'You have lessons with no saved attendance. Open the app to see which.',
    bare: 'You have lessons with no saved attendance. Open the app to see which.',
    many: 'You have lessons with no saved attendance. Open the app to see which.',
  },
  REPORTING_RATE_DIGEST: {
    title: 'Reporting rate',
    one: 'You have a new weekly summary of the reporting rate. Open the app to see more.',
    bare: 'You have a new weekly summary of the reporting rate. Open the app to see more.',
    many: 'You have a new weekly summary of the reporting rate. Open the app to see more.',
  },
  CANCELLATION_DIGEST_REVERSED: {
    title: 'Lessons back on',
    one: ({ lessons }) =>
      lessons === 1
        ? 'A cancelled lesson {span} goes ahead as planned.'
        : `${lessons} cancelled lessons {span} go ahead as planned.`,
    bare: 'Cancelled lessons go ahead as planned.',
    many: 'Cancelled lessons go ahead as planned.',
  },
};

export const PUSH_TEMPLATES: Record<PushLocale, Record<PushKind, Template>> = { sv: SV, en: EN };

/** The kind a notice is pushed as; null for one that is never pushed. */
export function pushKindOf(type: NotificationKind, meta: Record<string, unknown>): PushKind | null {
  if (type === 'TEACHER_ABSENCE_REPORTED') return null;
  if (type === 'LESSON_SUBSTITUTE' && meta['cover'] === true) return 'LESSON_SUBSTITUTE_COVER';
  if (type === 'CANCELLATION_DIGEST' && meta['reversed'] === true) return 'CANCELLATION_DIGEST_REVERSED';
  if (type === 'CRISIS_ALARM' && meta['mode'] === 'DRILL') return 'CRISIS_ALARM_DRILL';
  if (type === 'CRISIS_ENDED' && meta['mode'] === 'DRILL') return 'CRISIS_ENDED_DRILL';
  if (type === 'COVER_REQUEST_CLOSED') {
    const reason = meta['reason'];
    if (reason === 'WITHDRAWN') return 'COVER_REQUEST_WITHDRAWN';
    if (reason === 'NOT_NEEDED') return 'COVER_REQUEST_NOT_NEEDED';
    if (reason === 'UNANSWERED') return 'COVER_REQUEST_UNANSWERED';
    return 'COVER_REQUEST_TAKEN';
  }
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
 * startDate, endDate, status and lessonCount from the meta, whatever else it
 * carries. {span} is startDate–endDate, or the one day when they are equal.
 */
export function pushText(
  kind: PushKind,
  meta: Record<string, unknown>,
  locale: PushLocale,
  timezone: string,
  count = 1,
): PushText {
  const template = PUSH_TEMPLATES[locale][kind];
  const lessonCount = meta['lessonCount'];
  const context: Context = {
    approved: meta['status'] === 'APPROVED',
    lessons: typeof lessonCount === 'number' && Number.isInteger(lessonCount) && lessonCount > 0 ? lessonCount : 0,
  };
  const pick = (t: Template['one']) => (typeof t === 'function' ? t(context) : t);
  const when = whenOf(meta['startsAt'], locale, timezone);
  const date = dateOf(meta['date'], locale);
  const from = dateOf(meta['startDate'], locale);
  const to = dateOf(meta['endDate'], locale);
  const span = from && to ? (from === to ? from : `${from}–${to}`) : null;
  if (count > 1) {
    const plural = template.many;
    if (plural.includes('{date}') && !date) return { title: template.title, body: fill(pick(template.bare), {}) };
    return { title: template.title, body: fill(plural, { count: String(count), date: date ?? '' }) };
  }
  // A digest without a number of lessons says the bare words.
  if (kind.startsWith('CANCELLATION_DIGEST') && context.lessons === 0) return { title: template.title, body: pick(template.bare) };
  const one = pick(template.one);
  const needs = [...one.matchAll(/\{(\w+)\}/g)].map((m) => m[1]!);
  const values: Record<string, string | null> = { when, date, from, to, span };
  if (needs.some((key) => !values[key])) return { title: template.title, body: pick(template.bare) };
  return { title: template.title, body: fill(one, values as Record<string, string>) };
}
