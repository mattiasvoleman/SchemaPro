/**
 * The laid timetable as the exchange formats see it (Schemat som tabell och i
 * öppna format, round 9 / S0).
 *
 * ONE MODEL, FOUR FORMATS. The flat table (CSV and Excel), Untis GPU001/GPU002
 * and aSc XML are all written from an ExchangeDocument and all read into a
 * ParsedExchange. The codecs are pure: no database, no ids that are not in the
 * file, no clock. What a lesson MEANS to the school (which group is that name,
 * which teacher is that signature, does it fit the frame) is decided once, in
 * the import service, and not once per format.
 *
 * CONVENTIONS, the same in every format:
 *
 *   day    ISO weekday, 1 = Monday ... 7 = Sunday (MasterLesson.dayOfWeek).
 *   start, end
 *          'HH:MM', 24 hours, end after start. A lesson's length is end - start.
 *   weeks  ALL = every week the period covers, ODD = odd ISO week numbers,
 *          EVEN = even ISO week numbers (LessonRecurrence). A week pattern is
 *          written A for ODD and B for EVEN wherever a format wants letters:
 *          "A-vecka" is the week the school calls udda. This is a choice, and
 *          the one place it is made: weekLetter / weekPatternOf below.
 *   from, to
 *          'YYYY-MM-DD' or null, the first and last date the lesson runs
 *          (MasterLesson.startDate / endDate). Null is "from the start of the
 *          year" / "until the year ends". A term split is a pair of dates.
 *   names  The other systems know a class, a subject, a room by name and a
 *          teacher by short name (signature). Ids ride along (`ids`) only for
 *          the flat table, which is the format that reads itself back.
 *
 * NO PERSONNUMMER. Nothing here has a field for one, and no codec may read or
 * keep one if a foreign file carries it (the user's decision of 2026-11-05).
 */

/** Which weeks a lesson runs; the same three values as LessonRecurrence. */
export type WeekPattern = 'ALL' | 'ODD' | 'EVEN';

/** A at odd ISO weeks, B at even; the letter formats write and read. */
export function weekLetter(weeks: WeekPattern): 'A' | 'B' | '' {
  return weeks === 'ODD' ? 'A' : weeks === 'EVEN' ? 'B' : '';
}

/** The inverse of weekLetter for the spellings schools use; null when not a pattern. */
export function weekPatternOf(text: string | null | undefined): WeekPattern | null {
  const t = (text ?? '').trim().toLowerCase();
  if (t === '' || t === 'alla' || t === 'varje vecka' || t === 'all' || t === 'every week' || t === 'ab') return 'ALL';
  if (t === 'a' || t === 'udda' || t === 'odd' || t === 'u') return 'ODD';
  if (t === 'b' || t === 'jämn' || t === 'jamn' || t === 'jämna' || t === 'even' || t === 'j') return 'EVEN';
  return null;
}

/** A teacher as a file names them. At least `short` or `email` identifies one; `id` only in the flat table. */
export interface TeacherRef {
  /** Lärarsignatur (TeacherEmployment.signature), the other systems' short name. */
  short: string | null;
  /** "Anna Svensson"; informational on import, never a key (names repeat). */
  name: string | null;
  email: string | null;
  /** Users.id, written by the flat table so it can be read back; ignored by every other format. */
  id: string | null;
}

/** The ids the flat table carries beside the names; absent in the foreign formats. */
export interface ExchangeIds {
  lesson?: string | null;
  group?: string | null;
  extraGroups?: (string | null)[];
  subject?: string | null;
  room?: string | null;
}

/** One lesson of the grundschema: a MasterLesson, by names. */
export interface ExchangeLesson {
  /**
   * Where the lesson was read from, in words the reader of a refusal
   * recognises: "rad 12", "GPU001 rad 4", "lektion 17". Empty on export.
   */
  ref: string;
  /** The lesson's own group: a class or a teaching group (StudentGroup.name). */
  group: string;
  /** Other groups attending the lesson (MasterLessonGroup), by name; never the lesson's own. */
  extraGroups: string[];
  /** Subject name. */
  subject: string;
  /** Subject code (Subjects.code) when the file has one; used before the name. */
  subjectCode: string | null;
  /** Lead teacher first, then the co-teacher; zero, one or two. */
  teachers: TeacherRef[];
  room: string | null;
  day: number;
  start: string;
  end: string;
  weeks: WeekPattern;
  from: string | null;
  to: string | null;
  /** The parallel block (TeachingBlock.name) the lesson's post runs in, when the file says. */
  block: string | null;
  ids: ExchangeIds;
}

/** A group of the year, for the formats that list entities besides the lessons. */
export interface GroupRef {
  name: string;
  kind: 'CLASS' | 'TEACHING_GROUP';
  gradeLevel: number | null;
  /** The class this group is a half of, by name. */
  halfOf: string | null;
}

export interface SubjectRef {
  name: string;
  code: string | null;
}

/**
 * What the writers are given: the lessons and the entities around them. The
 * lists hold every entity of the year, not only those with a lesson, because
 * Untis and aSc import a class with no lessons yet as readily as one with.
 */
export interface ExchangeDocument {
  school: string;
  year: { name: string; start: string; end: string };
  lessons: ExchangeLesson[];
  groups: GroupRef[];
  subjects: SubjectRef[];
  rooms: string[];
  /** Every teacher a lesson names, with a `short` (the service makes one up for a teacher with no signature). */
  teachers: TeacherRef[];
}

/**
 * A thing in a file a reader could not make into a lesson: named, never
 * guessed. `ref` is as ExchangeLesson.ref. `code` is stable (the page words
 * it); `message` is Swedish prose for the log and the tests.
 */
export interface ReadProblem {
  ref: string;
  code: string;
  message: string;
}

/**
 * What the readers return. `notes` are the choices a reader made where the
 * format is ambiguous ("GPU001 har inga veckomönster: alla lektioner läses
 * som varje vecka"); the preview shows them so that nothing is decided in
 * silence.
 */
export interface ParsedExchange {
  lessons: ExchangeLesson[];
  problems: ReadProblem[];
  notes: string[];
}

/** 'HH:MM' to minutes since midnight, or null when it is not a time of day. */
export function minutesOfClock(text: string): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(text.trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return h * 60 + min;
}

/** Minutes since midnight to 'HH:MM'. */
export function clockOfMinutes(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

/** An empty lesson to build on; every reader starts from this so no field is forgotten. */
export function blankLesson(partial: Partial<ExchangeLesson> & Pick<ExchangeLesson, 'ref' | 'group' | 'subject' | 'day' | 'start' | 'end'>): ExchangeLesson {
  return {
    extraGroups: [],
    subjectCode: null,
    teachers: [],
    room: null,
    weeks: 'ALL',
    from: null,
    to: null,
    block: null,
    ids: {},
    ...partial,
  };
}

/** The most rows and bytes any reader will take: a school has hundreds of lessons, not millions. */
export const MAX_EXCHANGE_LESSONS = 5000;
export const MAX_EXCHANGE_BYTES = 8 * 1024 * 1024;

/**
 * The largest file the upload takes: 700 KiB, because the page sends it as
 * base64 inside a JSON body and the gateway takes 1 MB of body
 * (common/http-defaults.ts MAX_BODY_SIZE, which no route may exceed: the body is
 * read before the guards ask who sent it). 700 KiB is 933 kB of base64 and a
 * little JSON round it. The page's own copy is MAX_UPLOAD_BYTES in
 * web/lib/schedule-exchange.ts. An export larger than this cannot be read back
 * (the second review of PR #256, L2: a CSV of 5 000 lessons is 906 kB), so the
 * export says so with the file.
 */
export const MAX_UPLOAD_BYTES = 700 * 1024;

/**
 * What a zip that holds an exchange file may unpack to. The generic limits of
 * zip.ts (32 MB an entry, 64 MB in all) are for a zip of anything; a file here
 * is read as text only up to MAX_EXCHANGE_BYTES, so a zip that unpacks to more
 * is refused before it is unpacked and not after (the review of PR #256: a
 * zip under 1 MB that unpacks to tens of MB cost CPU and a few hundred MB of
 * memory per call before the 8 MB check refused it).
 */
export const EXCHANGE_ZIP_LIMITS = { maxEntryBytes: MAX_EXCHANGE_BYTES, maxTotalBytes: MAX_EXCHANGE_BYTES } as const;
