/**
 * The flat timetable (Schemat som tabell och i öppna format, round 9 / S0): the
 * grundschema as ONE TABLE, one row per lesson, and the same table read back.
 * The table is what CSV and Excel carry (csv.ts, xlsx.ts turn it into bytes and
 * back; this file knows nothing about bytes): the format the school can open,
 * sort, filter and fix by hand, and import again.
 *
 * THE CONTRACT. Twenty-eight columns in a fixed order (COLUMNS below). The
 * Swedish header is canonical and what the writer writes; the reader accepts,
 * ignoring case, spaces, punctuation and diacritics (so "Lärare e-post",
 * "LARARE E POST" and "lararepost" are one header), the Swedish header, the
 * English alias and the few aliases that are listed with the column. Columns
 * may come in any order, extra columns are allowed, and a title above the
 * table (Excel users add one) is skipped: the header row is the FIRST row that
 * holds all five required headers (class/group, subject, day, start, end).
 *
 * WHAT THE READER DECIDES, AND WHAT IT LEAVES ALONE.
 *
 *   It reads cells and refuses what is not readable: a day that is not a day,
 *   a time that is not a time, an end before the start, a date that is not a
 *   date, a week pattern that is not one, a lesson with a co-teacher and no lead
 *   teacher. Each is a ReadProblem on its own row, the lesson is SKIPPED, and
 *   nothing is guessed (no "assume the second one was meant"). One row can have
 *   several problems; all are reported, so that a file is fixed in one pass.
 *
 *   It does NOT decide what a name MEANS. "7a" and "7A" are two different cells
 *   and stay two: that "7a" is the class the school calls 7A is the import
 *   service's job (it knows the school's groups); a reader that folded case
 *   would make that decision once, here, wrongly for every school whose groups
 *   differ only in case.
 *
 *   The columns Längd (length), Period and Låst (locked) are DERIVED. On write
 *   they are filled so that a school user sorting by length or filtering by
 *   period has something to work with; on read, Period and Låst are ignored
 *   (Från/Till are the keys; every imported lesson is locked anyway) and Längd
 *   is a CHECK: a table whose length disagrees with its own start and end has
 *   been edited by hand in one place and not the other, and the lesson is
 *   refused, naming both numbers, instead of silently trusting one of them.
 *
 * PERSONNUMMER. A column whose header says personnummer, samordningsnummer or
 * any of their usual abbreviations is dropped UNREAD: it is never parsed,
 * never stored, never echoed in a problem or a note (only the HEADER is, so
 * that the school learns the column was not taken). Rastra does not take
 * personnummer (the user's decision of 2026-11-05) and a timetable has no use
 * for one; but a file exported from a student system may carry one, and the
 * guarantee must hold for that file.
 *
 * ROW NUMBERS. A problem's `ref` is "rad N", N being the row as the user sees
 * it in Excel: the header is the row it really is on, a title above it counts.
 * Excel files keep their rows in place (readXlsx), so N is the index plus one;
 * CSV drops blank lines, so parseCsv returns the original numbers
 * (`rowNumbers`) and the caller passes them as the second argument.
 *
 * LIMITS. At most MAX_EXCHANGE_LESSONS rows with content; more is one problem,
 * TABLE_TOO_MANY_ROWS, and no lesson is read (a prefix of a table is a
 * different timetable, and the user should hear that before, not after).
 */

import {
  blankLesson,
  clockOfMinutes,
  MAX_EXCHANGE_LESSONS,
  minutesOfClock,
  weekLetter,
  weekPatternOf,
  type ExchangeDocument,
  type ExchangeIds,
  type ExchangeLesson,
  type ParsedExchange,
  type ReadProblem,
  type TeacherRef,
} from './exchange-model';

// ---------------------------------------------------------------------------
// The columns
// ---------------------------------------------------------------------------

type ColumnKey =
  | 'lessonId'
  | 'group'
  | 'groupId'
  | 'extraGroups'
  | 'extraGroupIds'
  | 'subject'
  | 'subjectCode'
  | 'subjectId'
  | 'teacher'
  | 'teacherName'
  | 'teacherEmail'
  | 'teacherId'
  | 'coTeacher'
  | 'coTeacherName'
  | 'coTeacherEmail'
  | 'coTeacherId'
  | 'room'
  | 'roomId'
  | 'day'
  | 'start'
  | 'end'
  | 'length'
  | 'period'
  | 'from'
  | 'to'
  | 'weeks'
  | 'block'
  | 'locked';

interface Column {
  key: ColumnKey;
  /** The canonical header, what the writer writes. */
  sv: string;
  en: string;
  /** More spellings the reader takes. */
  aliases: string[];
}

/** In file order. */
const COLUMNS: readonly Column[] = [
  { key: 'lessonId', sv: 'Lektions-id', en: 'Lesson id', aliases: [] },
  { key: 'group', sv: 'Klass/grupp', en: 'Class/group', aliases: [] },
  { key: 'groupId', sv: 'Grupp-id', en: 'Group id', aliases: [] },
  { key: 'extraGroups', sv: 'Ytterligare klasser', en: 'Additional classes', aliases: [] },
  { key: 'extraGroupIds', sv: 'Ytterligare klass-id', en: 'Additional class ids', aliases: [] },
  { key: 'subject', sv: 'Ämne', en: 'Subject', aliases: [] },
  { key: 'subjectCode', sv: 'Ämneskod', en: 'Subject code', aliases: [] },
  { key: 'subjectId', sv: 'Ämnes-id', en: 'Subject id', aliases: [] },
  { key: 'teacher', sv: 'Lärare', en: 'Teacher', aliases: ['Lärare signatur', 'Signatur', 'Teacher signature'] },
  { key: 'teacherName', sv: 'Lärarnamn', en: 'Teacher name', aliases: [] },
  { key: 'teacherEmail', sv: 'Lärare e-post', en: 'Teacher e-mail', aliases: [] },
  { key: 'teacherId', sv: 'Lärar-id', en: 'Teacher id', aliases: [] },
  { key: 'coTeacher', sv: 'Medlärare', en: 'Co-teacher', aliases: ['Medlärare signatur'] },
  { key: 'coTeacherName', sv: 'Medlärarnamn', en: 'Co-teacher name', aliases: [] },
  { key: 'coTeacherEmail', sv: 'Medlärare e-post', en: 'Co-teacher e-mail', aliases: [] },
  { key: 'coTeacherId', sv: 'Medlärar-id', en: 'Co-teacher id', aliases: [] },
  { key: 'room', sv: 'Sal', en: 'Room', aliases: [] },
  { key: 'roomId', sv: 'Sal-id', en: 'Room id', aliases: [] },
  { key: 'day', sv: 'Dag', en: 'Day', aliases: [] },
  { key: 'start', sv: 'Start', en: 'Start', aliases: [] },
  { key: 'end', sv: 'Slut', en: 'End', aliases: [] },
  { key: 'length', sv: 'Längd', en: 'Length (min)', aliases: ['Längd (min)'] },
  { key: 'period', sv: 'Period', en: 'Period', aliases: [] },
  { key: 'from', sv: 'Från', en: 'From', aliases: [] },
  { key: 'to', sv: 'Till', en: 'To', aliases: [] },
  { key: 'weeks', sv: 'Veckomönster', en: 'Week pattern', aliases: ['Vecka', 'Veckor'] },
  { key: 'block', sv: 'Block', en: 'Block', aliases: [] },
  { key: 'locked', sv: 'Låst', en: 'Locked', aliases: [] },
];

/** The Swedish header row, as the writer writes it. */
export const LESSON_TABLE_HEADER: readonly string[] = COLUMNS.map((column) => column.sv);
/** The English header row, accepted by the reader and available for a template. */
export const LESSON_TABLE_HEADER_EN: readonly string[] = COLUMNS.map((column) => column.en);

/** The headers a table cannot be read without. */
const REQUIRED: readonly ColumnKey[] = ['group', 'subject', 'day', 'start', 'end'];

const LABEL = new Map<ColumnKey, string>(COLUMNS.map((column) => [column.key, column.sv]));
const label = (key: ColumnKey): string => LABEL.get(key)!;

/**
 * Header matching that survives humans: case-insensitive, diacritic-free, and
 * blind to spaces and punctuation, the same rule as web/lib/csv-export.ts
 * normalizeHeader, so "Lärare e-post" and "LARARE E-POST" and "lararepost" are
 * one header. (UTF-8 read as Latin-1, "LÃ¤rare", is NOT rescued: its data is
 * just as mangled, and a missing-column refusal is the right answer to it.)
 */
export function normalizeHeader(header: string): string {
  return header
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]/gi, '')
    .toLowerCase();
}

const HEADER_KEY = new Map<string, ColumnKey>();
for (const column of COLUMNS) {
  for (const spelling of [column.sv, column.en, ...column.aliases]) HEADER_KEY.set(normalizeHeader(spelling), column.key);
}

/** Headers of a personal-number column. Exact for the short forms (so "ssn" is not found inside a word), contained for the long. */
const PERSONAL_EXACT = new Set(['pnr', 'personnr', 'ssn']);
const PERSONAL_CONTAINS = ['personnummer', 'samordningsnummer', 'socialsecuritynumber', 'civicnumber', 'personalnumber'];

function isPersonalNumberHeader(normalized: string): boolean {
  return PERSONAL_EXACT.has(normalized) || PERSONAL_CONTAINS.some((word) => normalized.includes(word));
}

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

const DAY_NAMES = ['Mån', 'Tis', 'Ons', 'Tors', 'Fre', 'Lör', 'Sön'];

/** Natural order in Swedish: 7A before 7B before 8A before 10A, Å Ä Ö after Z. */
const COLLATOR = new Intl.Collator('sv', { numeric: true });

const teacherSortKey = (lesson: ExchangeLesson): string => lesson.teachers[0]?.short ?? lesson.teachers[0]?.name ?? '';

function compareLessons(a: ExchangeLesson, b: ExchangeLesson): number {
  return (
    COLLATOR.compare(a.group, b.group) ||
    a.day - b.day ||
    (minutesOfClock(a.start) ?? -1) - (minutesOfClock(b.start) ?? -1) ||
    COLLATOR.compare(a.subject, b.subject) ||
    COLLATOR.compare(teacherSortKey(a), teacherSortKey(b))
  );
}

/** short, name, e-mail, id of one teacher; four empty cells when there is none. */
function teacherCells(teacher: TeacherRef | undefined): string[] {
  return [teacher?.short ?? '', teacher?.name ?? '', teacher?.email ?? '', teacher?.id ?? ''];
}

const LIST_SEPARATOR = ' | ';

function rowOf(lesson: ExchangeLesson): string[] {
  const start = minutesOfClock(lesson.start);
  const end = minutesOfClock(lesson.end);
  // The ids of the extra groups ride along in the same order as their names,
  // an empty slot where a group has none; no cell at all when none has one.
  const extraIds = lesson.extraGroups.map((_name, index) => lesson.ids.extraGroups?.[index] ?? '');
  // Teachers beyond the second have no column; a lesson has at most two (lead, co).
  const [lead, co] = lesson.teachers;
  return [
    lesson.ids.lesson ?? '',
    lesson.group,
    lesson.ids.group ?? '',
    lesson.extraGroups.join(LIST_SEPARATOR),
    extraIds.some((id) => id !== '') ? extraIds.join(LIST_SEPARATOR) : '',
    lesson.subject,
    lesson.subjectCode ?? '',
    lesson.ids.subject ?? '',
    ...teacherCells(lead),
    ...teacherCells(co),
    lesson.room ?? '',
    lesson.ids.room ?? '',
    DAY_NAMES[lesson.day - 1] ?? String(lesson.day),
    lesson.start,
    lesson.end,
    start !== null && end !== null ? String(end - start) : '',
    lesson.from === null && lesson.to === null ? 'Hela läsåret' : `${lesson.from ?? ''}–${lesson.to ?? ''}`,
    lesson.from ?? '',
    lesson.to ?? '',
    weekLetter(lesson.weeks),
    lesson.block ?? '',
    'Ja',
  ];
}

/**
 * The header row and one row per lesson, sorted by group (natural order), day,
 * start, subject, then teacher. Names that contain a vertical bar cannot be
 * told apart from the separator of the extra-groups list; a school that names
 * a class "7A|7B" gets two classes back for the extra-groups cell.
 */
export function lessonsToTable(doc: ExchangeDocument): string[][] {
  return [[...LESSON_TABLE_HEADER], ...[...doc.lessons].sort(compareLessons).map(rowOf)];
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

const DAY_OF = new Map<string, number>();
[
  ['man', 'mandag', 'mon', 'monday'],
  ['tis', 'tisdag', 'tue', 'tues', 'tuesday'],
  ['ons', 'onsdag', 'wed', 'wednesday'],
  ['tor', 'tors', 'torsdag', 'thu', 'thur', 'thurs', 'thursday'],
  ['fre', 'fredag', 'fri', 'friday'],
  ['lor', 'lordag', 'sat', 'saturday'],
  ['son', 'sondag', 'sun', 'sunday'],
].forEach((names, index) => {
  DAY_OF.set(String(index + 1), index + 1);
  for (const name of names) DAY_OF.set(name, index + 1);
});

/** 1-7 or a day's name, Swedish or English, short or long, in any case ("Mån." too); null when it is none. */
function dayOf(text: string): number | null {
  const key = text
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/\.$/, '');
  return DAY_OF.get(key) ?? null;
}

const SEPARATED_TIME = /^(\d{1,2})[:.](\d{2})(?:[:.](\d{2}))?$/;
const COMPACT_TIME = /^(\d{1,2})(\d{2})$/;

/** 'HH:MM' from 8:10, 08:10, 08.10, 0810, 810 and 08:10:00 (seconds must be 00); null when it is not a time of day. */
function clockOf(text: string): string | null {
  const match = SEPARATED_TIME.exec(text) ?? COMPACT_TIME.exec(text);
  if (match === null) return null;
  if (match[3] !== undefined && match[3] !== '00') return null;
  const minutes = minutesOfClock(`${match[1]}:${match[2]}`);
  return minutes === null ? null : clockOfMinutes(minutes);
}

const ISO_DATE = /^(\d{4})-(\d{1,2})-(\d{1,2})$/;
const COMPACT_DATE = /^(\d{4})(\d{2})(\d{2})$/;

function daysInMonth(year: number, month: number): number {
  if (month === 2) return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28;
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

/**
 * 'YYYY-MM-DD' from an ISO date (month and day may be one digit: 2026-8-17) or
 * from YYYYMMDD; null when it is not a real date. 17/8/2026 and 8/17/2026 are
 * NOT accepted: which of the two is the month depends on a locale this file
 * does not carry, and a wrong guess is a lesson on the wrong day.
 */
function isoDateOf(text: string): string | null {
  const match = ISO_DATE.exec(text) ?? COMPACT_DATE.exec(text);
  if (match === null) return null;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  if (year < 1000 || month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month)) return null;
  return `${match[1]}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/** "A", "A och B", "A, B och C". */
function listOf(items: string[]): string {
  return items.length < 2 ? items.join('') : `${items.slice(0, -1).join(', ')} och ${items[items.length - 1]}`;
}

const orNull = (text: string): string | null => (text === '' ? null : text);

interface Recognised {
  columns: Partial<Record<ColumnKey, number>>;
  /** Headers of a personal-number column: dropped unread. */
  personal: string[];
  unknown: string[];
  duplicated: string[];
}

/** Which column is which, by the headers in one row. */
function recognise(cells: string[]): Recognised {
  const result: Recognised = { columns: {}, personal: [], unknown: [], duplicated: [] };
  cells.forEach((cell, index) => {
    const header = cell.trim();
    if (header === '') return;
    const normalized = normalizeHeader(header);
    if (isPersonalNumberHeader(normalized)) {
      result.personal.push(header);
      return;
    }
    const key = HEADER_KEY.get(normalized);
    if (key === undefined) result.unknown.push(header);
    else if (result.columns[key] !== undefined) result.duplicated.push(header);
    else result.columns[key] = index;
  });
  return result;
}

const missingOf = (columns: Recognised['columns']): ColumnKey[] => REQUIRED.filter((key) => columns[key] === undefined);

/** How far down the file the header row is looked for. */
const HEADER_SEARCH_ROWS = 50;

const isEmptyRow = (row: string[] | undefined): boolean => row === undefined || row.every((cell) => cell.trim() === '');

/**
 * The flat table as lessons.
 *
 * `rowNumbers`, when given, holds for each entry of `rows` the row number to
 * show the user (parseCsv's `rowNumbers`); without it row i is "rad i+1",
 * which is right for Excel files and for CSV files without blank lines.
 */
export function tableToLessons(rows: string[][], rowNumbers?: number[]): ParsedExchange {
  const lessons: ExchangeLesson[] = [];
  const problems: ReadProblem[] = [];
  const notes: string[] = [];
  const refOf = (index: number): string => `rad ${rowNumbers?.[index] ?? index + 1}`;

  // 1. The header row.
  let headerIndex = -1;
  let found: Recognised | null = null;
  let best: { index: number; count: number; columns: Recognised['columns'] } = { index: -1, count: 0, columns: {} };
  for (let index = 0; index < Math.min(rows.length, HEADER_SEARCH_ROWS) && found === null; index += 1) {
    const candidate = recognise(rows[index]!);
    const count = REQUIRED.length - missingOf(candidate.columns).length;
    if (count === REQUIRED.length) {
      found = candidate;
      headerIndex = index;
    } else if (count > best.count) {
      best = { index, count, columns: candidate.columns };
    }
  }
  if (found === null) {
    const missing = missingOf(best.columns).map(label);
    const what = missing.length === 1 ? `Kolumnen ${missing[0]} saknas` : `Kolumnerna ${listOf(missing)} saknas`;
    problems.push({
      ref: refOf(Math.max(best.index, 0)),
      code: 'TABLE_MISSING_COLUMN',
      message: `${what} i tabellen. Rubrikraden ska ha ${listOf(REQUIRED.map(label))}.`,
    });
    return { lessons, problems, notes };
  }
  const { columns } = found;

  // What was left unread, said once each.
  for (const header of found.personal) notes.push(`Kolumnen ${header} lästes inte: Rastra tar inte emot personnummer.`);
  if (found.unknown.length > 0) {
    notes.push(
      found.unknown.length === 1
        ? `Kolumnen ${found.unknown[0]} lästes inte: Rastra känner inte igen rubriken.`
        : `Kolumnerna ${listOf(found.unknown)} lästes inte: Rastra känner inte igen rubrikerna.`,
    );
  }
  if (found.duplicated.length > 0) {
    notes.push(
      found.duplicated.length === 1
        ? `Kolumnen ${found.duplicated[0]} finns flera gånger; den första används.`
        : `Kolumnerna ${listOf(found.duplicated)} finns flera gånger; den första av varje används.`,
    );
  }

  // 2. The rows with something in them; too many is refused before any is read.
  const dataRows: number[] = [];
  for (let index = headerIndex + 1; index < rows.length; index += 1) {
    if (!isEmptyRow(rows[index])) dataRows.push(index);
  }
  if (dataRows.length > MAX_EXCHANGE_LESSONS) {
    problems.push({
      ref: refOf(dataRows[MAX_EXCHANGE_LESSONS]!),
      code: 'TABLE_TOO_MANY_ROWS',
      message: `Tabellen har ${dataRows.length} rader med innehåll; högst ${MAX_EXCHANGE_LESSONS} lektioner tas emot åt gången. Dela tabellen i flera filer.`,
    });
    return { lessons, problems, notes };
  }

  // 3. One lesson per row.
  for (const index of dataRows) {
    const row = rows[index]!;
    const ref = refOf(index);
    const cell = (key: ColumnKey): string => {
      const at = columns[key];
      return at === undefined ? '' : (row[at] ?? '').trim();
    };
    const rowProblems: ReadProblem[] = [];
    const bad = (code: string, message: string): void => {
      rowProblems.push({ ref, code, message });
    };

    const group = cell('group');
    const subject = cell('subject');
    const missing = REQUIRED.filter((key) => cell(key) === '').map(label);
    if (missing.length > 0) {
      bad('TABLE_MISSING_VALUE', `Värde saknas i ${missing.length === 1 ? 'kolumnen' : 'kolumnerna'} ${listOf(missing)}.`);
    }

    const dayText = cell('day');
    const day = dayText === '' ? null : dayOf(dayText);
    if (dayText !== '' && day === null) {
      bad('TABLE_BAD_DAY', `Dagen "${dayText}" går inte att läsa. Skriv Mån, Tis, Ons, Tors, Fre, Lör, Sön eller 1–7.`);
    }

    const startText = cell('start');
    const endText = cell('end');
    const start = startText === '' ? null : clockOf(startText);
    const end = endText === '' ? null : clockOf(endText);
    if (startText !== '' && start === null) bad('TABLE_BAD_TIME', `Starttiden "${startText}" går inte att läsa som klockslag (HH:MM).`);
    if (endText !== '' && end === null) bad('TABLE_BAD_TIME', `Sluttiden "${endText}" går inte att läsa som klockslag (HH:MM).`);
    let minutes: number | null = null;
    if (start !== null && end !== null) {
      minutes = minutesOfClock(end)! - minutesOfClock(start)!;
      if (minutes <= 0) {
        bad('TABLE_BAD_TIME', `Sluttiden ${end} är inte efter starttiden ${start}.`);
      } else {
        const lengthText = cell('length');
        const length = Number(lengthText.replace(',', '.'));
        if (lengthText !== '' && length !== minutes) {
          bad(
            'TABLE_LENGTH_MISMATCH',
            `Längden "${lengthText}" stämmer inte med start ${start} och slut ${end}, som är ${minutes} minuter. Rätta längden eller tiderna.`,
          );
        }
      }
    }

    const dates: Record<'from' | 'to', string | null> = { from: null, to: null };
    for (const key of ['from', 'to'] as const) {
      const text = cell(key);
      if (text === '') continue;
      dates[key] = isoDateOf(text);
      if (dates[key] === null) {
        bad('TABLE_BAD_DATE', `Datumet "${text}" i kolumnen ${label(key)} går inte att läsa. Skriv ÅÅÅÅ-MM-DD.`);
      }
    }
    if (dates.from !== null && dates.to !== null && dates.from > dates.to) {
      bad('TABLE_BAD_DATE', `Perioden börjar ${dates.from}, efter att den slutar ${dates.to}.`);
    }

    const weeks = weekPatternOf(cell('weeks'));
    if (weeks === null) {
      bad('TABLE_BAD_WEEKS', `Veckomönstret "${cell('weeks')}" går inte att läsa. Skriv A (udda veckor), B (jämna veckor) eller lämna tomt.`);
    }

    const person = (short: ColumnKey, name: ColumnKey, email: ColumnKey, id: ColumnKey): TeacherRef | null => {
      const teacher: TeacherRef = { short: orNull(cell(short)), name: orNull(cell(name)), email: orNull(cell(email)), id: orNull(cell(id)) };
      return Object.values(teacher).every((value) => value === null) ? null : teacher;
    };
    const lead = person('teacher', 'teacherName', 'teacherEmail', 'teacherId');
    const co = person('coTeacher', 'coTeacherName', 'coTeacherEmail', 'coTeacherId');
    if (co !== null && lead === null) {
      bad('TABLE_CO_WITHOUT_LEAD', 'Det finns en medlärare men ingen lärare. Flytta medläraren till kolumnen Lärare.');
    }

    if (rowProblems.length > 0) {
      problems.push(...rowProblems);
      continue;
    }

    // The extra groups and their ids: both lists split on '|'; the ids are kept
    // at the position of their name, so a name dropped as empty or repeated
    // takes its id with it. A group named like the lesson's own is dropped:
    // the lesson is already that group's.
    const splitList = (text: string): string[] => (text === '' ? [] : text.split('|').map((item) => item.trim()));
    const extraGroups: string[] = [];
    const extraGroupIds: (string | null)[] = [];
    const rawIds = splitList(cell('extraGroupIds'));
    splitList(cell('extraGroups')).forEach((name, position) => {
      if (name === '' || name === group || extraGroups.includes(name)) return;
      extraGroups.push(name);
      extraGroupIds.push(orNull(rawIds[position] ?? ''));
    });

    const ids: ExchangeIds = {};
    const idCells: [keyof Pick<ExchangeIds, 'lesson' | 'group' | 'subject' | 'room'>, ColumnKey][] = [
      ['lesson', 'lessonId'],
      ['group', 'groupId'],
      ['subject', 'subjectId'],
      ['room', 'roomId'],
    ];
    for (const [field, key] of idCells) {
      const id = cell(key);
      if (id !== '') ids[field] = id;
    }
    if (extraGroupIds.some((id) => id !== null)) ids.extraGroups = extraGroupIds;

    lessons.push(
      blankLesson({
        ref,
        group,
        extraGroups,
        subject,
        subjectCode: orNull(cell('subjectCode')),
        teachers: [lead, co].filter((teacher): teacher is TeacherRef => teacher !== null),
        room: orNull(cell('room')),
        day: day!,
        start: start!,
        end: end!,
        weeks: weeks!,
        from: dates.from,
        to: dates.to,
        block: orNull(cell('block')),
        ids,
      }),
    );
  }
  return { lessons, problems, notes };
}
