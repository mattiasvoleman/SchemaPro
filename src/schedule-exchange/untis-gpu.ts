/**
 * Untis GPU001 / GPU002 ("DIF files"), written and read from PUBLIC sources
 * only (Schemat som tabell och i öppna format, round 9 / S0).
 *
 * gp-Untis exports a laid timetable as plain-text DIF files named GPU001.TXT
 * (the timetable: one line per placed lesson line) and GPU002.TXT (the lessons:
 * what the timetable cannot say). GPU001 is export-only in Untis; GPU002 can be
 * imported again. Both are read by many third-party tools, which is why this
 * codec exists: a school moving to or from Untis should not retype its week.
 *
 * ──────────────────────────────────────────────────────────────────────────
 * THE ONE FINDING THAT CHANGES THE DESIGN: GPU011 IS NOT A TIME GRID
 * ──────────────────────────────────────────────────────────────────────────
 * The brief this module was written from assumed that GPU001 carries only a
 * period NUMBER and that the clock times of the periods live in GPU011 ("the
 * periods table"). That is wrong, and four independent public sources say so:
 * the Untis manual's own German title for GPU011 is "Stundentafel" (a
 * curriculum: Name, Langname, Fach, Stundenzahl minimal, Stundenzahl max.), the
 * MIT-licensed enbrea reader calls the record GpuLessonTable with exactly those
 * five fields, and Bildena's import guide says outright that DIF files hold no
 * times and the grid must be set in the importing tool. The English help calls
 * the same file "Periods Table", which is the trap. No DIF file carries a time
 * grid.
 * What the public spec DOES offer is the minute-based form of GPU001 (CHOICE 2).
 * So this codec writes NO GPU011 (writing a time grid into a file Untis reads
 * as a curriculum would corrupt a school's Stundentafeln on import), and
 * `UntisFiles` has two members, not three.
 *
 * ──────────────────────────────────────────────────────────────────────────
 * SOURCES (all read 2026-11-05)
 * ──────────────────────────────────────────────────────────────────────────
 *  S1  Untis WebHelp (uk), "Export/Import DIF files"
 *      https://webhelp.untis.at/HTML/WebHelp/uk/untis/hid_export.htm
 *      Index GPU001..GPU021; fields comma separated, text fields additionally
 *      delimited by quotation marks, dates as eight characters YYYYMMDD, files
 *      plain ASCII, field and line separators changeable.
 *  S2  Untis WebHelp (uk), "DIF settings"
 *      https://webhelp.untis.at/HTML/WebHelp/uk/untis/hidd_difsettings_dlg.htm
 *      Choice of field separator and of a text delimiter; silent on encoding.
 *  S3  Untis manual (de), "Export/Import DIF-Dateien"
 *      https://www.untis.at/manual/hid_export.htm
 *      Separator: comma, semicolon, tab, space or any character; text
 *      delimiter normally "; numbers marked Num; dates eight digits YYYYMMDD.
 *  S4  Untis manual (de), "Export Stundenplan (GPU001.TXT)"
 *      https://www.untis.at/manual/hid_export_stp.htm  (16 fields: Unterr.-Nr.,
 *      Klasse, Lehrer, Fach, Raum, Tag, Stunde "Num (Zeit (hh:mm) in Minuten)",
 *      Stundenlänge "(hh:mm) (nur in Minute, sonst leer)", Zeilentext 1/2,
 *      WebUntis Zeit Von/Bis, Oasis x3, Pedav Unterrichtsgruppe). Older
 *      revisions of the same page list 8 fields
 *      (https://webhelp.untis.at/HTML/WebHelp/de/untis/hid_export_stp.htm) and 7
 *      (https://webhelp.untis.at/HTML/WebHelp/uk/untis/hid_export_stp.htm): the
 *      layout only ever grows at the end, so a reader takes what is there.
 *  S5  Untis WebHelp (de), "Export Unterricht (GPU002.TXT)"
 *      https://webhelp.untis.at/HTML/WebHelp/de/untis/hid_export_unt.htm
 *      45 numbered fields (the uk revision, .../uk/untis/hid_export_unt.htm, has
 *      43; positions 1-42 are identical) and footnote *1: where one class
 *      appears on several lines of the same lesson (several teachers in that
 *      class), its weekly-periods figure is non-zero on the first line only.
 *  S6  Untis WebHelp (de), "Export/Import Stundentafel" (GPU011)
 *      https://webhelp.untis.at/HTML/WebHelp/de/untis/hid_export_stundentafel.htm
 *      and (uk) .../uk/untis/hid_export_stundentafel.htm "Exp/Imp Periods Table":
 *      Name, Langname, Fach, Stundenzahl minimal, Stundenzahl max.
 *  S7  enbrea/enbrea.untis.gpu (MIT), https://github.com/enbrea/enbrea.untis.gpu
 *      src/Entities/GpuLessonTime.cs (GPU001: 0-based indexes 0..7, Duration
 *      "hh:mm" or plain minutes), GpuLesson.cs (GPU002: Class 4, Teacher 5,
 *      Subject 6, Rooms 7 split on '~', Group 11, ValidFrom 14, ValidTo 15),
 *      GpuLessonTable.cs (GPU011 = Stundentafel), GpuRecord.cs (Tag "1" =
 *      Monday ... "6" = Saturday, dates yyyyMMdd), test/Xunit/TestGpuLessonTime.cs
 *      and TestGpuLesson.cs (comma separated, text fields in double quotes,
 *      numbers and dates unquoted).
 *  S8  hengeb/schedule README, https://github.com/hengeb/schedule
 *      GPU001 "id;Klasse;Lehrer;Fach;Raum;Tag (1=Montag, ...);Stunde;;" and
 *      GPU002 with its twelfth field read as "Woche".
 *  S9  HerrEich/Teams-Scanner README, https://github.com/HerrEich/Teams-Scanner
 *      GPU001 read as ISO-8859-1; co-taught lessons are separate lines merged on
 *      period, subject and lesson number or room.
 *  S10 Bildena, "Untis exportieren: XML oder DIF-Dateien"
 *      https://bildena.com/de/blog/untis-export-xml-dif/
 *      DIF files contain no times; A/B weeks are only recognised from group
 *      names ("A-Woche"/"B-Woche", "ungerade"/"gerade"); partial-year lessons are
 *      applied to the whole year; separators ; , and tab and UTF-8 detected.
 *  S11 IServ, "Den Stundenplan ... ins IServ-Klassenbuch importieren"
 *      https://hilfe.iserv.de/den-stundenplan-als-datei-ins-iserv-klassenbuch-importieren
 *      Comma, double quote, UTF-8; GPU001 suffices for the timetable, GPU002 adds
 *      student groups and block weeks; the time grid is created in IServ first.
 *  S12 DieSchulApp, "Stundenplan aus Untis importieren"
 *      https://www.dieschulapp.de/knowledge-base/stundenplan-aus-untis-importieren
 *      GPU001 columns incl. "Day (1 = Monday through 5 = Friday)" and period
 *      length "hh:mm, filled only for minute-based lengths, otherwise empty".
 *  S13 Schulportal Hessen, "Import des Stundenplans aus Untis"
 *      https://support.schulportal.hessen.de/knowledgebase.php?article=643
 *      Untis TXT export with UTF-8 and the semicolon as separator.
 *  S14 Schulverwaltungsinfos NRW forum (Kurs42), thread t=4656
 *      https://schulverwaltungsinfos.nrw.de/svws/forum/viewtopic.php?t=4656
 *      User report, 2022-06-18: the GPU files Untis writes are UTF-8 without a
 *      BOM (the importer then needed one added); the files have no header row.
 *  S15 UNTIS GmbH (Stockerau), "Stand: September 2018", section 1.2 Unterrichte
 *      https://help.untis.at/hc/de/article_attachments/360004696740
 *      A lesson for a whole class made of parts (5aH, 5aN) is entered with the
 *      parts separated by a comma (checked in the PDF text). That is how Untis
 *      takes several classes in the lesson window; the DIF pages do not repeat it.
 *  S16 UNTIS GmbH, guide on lessons and student groups
 *      https://help.untis.at/hc/de/article_attachments/360004481760
 *      A Schülergruppe is a defined group of pupils within a class who attend a
 *      lesson; it is needed only where not all pupils of one or more classes
 *      take part, and its name is free but unique (checked in the PDF text).
 *  S17 Untis Niedersachsen GmbH, "Leitfaden zum Abbilden der
 *      Unterrichtsorganisation in Corona-Zeiten", p. 5
 *      https://help.untis.at/hc/de/article_attachments/360011545680
 *      A- and B-week rhythms are built in Untis with lesson groups (Unterrichts-
 *      gruppen), which is GPU002 field 12 "Gruppe" (checked in the PDF text).
 *  What the pages do NOT say (and so is a CHOICE below, never a fact): how
 *  several classes are written in a DIF field, whether Stunde in a minute-based
 *  file is minutes or hh:mm, what the WebUntis time fields look like, how an A/B
 *  week or a term limit appears in GPU001, how decimals are printed.
 *
 * ──────────────────────────────────────────────────────────────────────────
 * CHOICES (each: what the spec says / what was found / chosen / why / what a
 * school's other Untis tooling does with it)
 * ──────────────────────────────────────────────────────────────────────────
 *  1. GPU011.  Spec (S6): a curriculum, not a grid. Found: S7 and S10 agree.
 *     Chosen: the writer writes no GPU011; the reader accepts a `gpu011` text
 *     only to say in a note that it is a Stundentafel and is not used. Why: a
 *     file named GPU011.TXT that held clock times would be imported by Untis as
 *     curricula named after periods. Other tooling: Untis, Bildena and enbrea
 *     all read GPU011 as Stundentafel or skip it.
 *  2. Times.  Spec (S4, S12): Stunde is "Zeit (hh:mm) in Minuten"; Stundenlänge
 *     is "(hh:mm) (nur in Minute, sonst leer)" - filled only in the minute-based
 *     form. Found: no source prints a sample of that form, so "Zeit (hh:mm) in
 *     Minuten" is read as "the time of day, counted in minutes after midnight"
 *     (08:30 -> 510). Chosen: the writer ALWAYS writes the minute-based form:
 *     Stunde = start minute, Stundenlänge = length as hh:mm; a lesson then
 *     carries its own start and end and the file needs no time grid. The reader
 *     takes a line with a Stundenlänge as minute-based (and also accepts a
 *     start written hh:mm), and a line without one as period-based: Stunde is a
 *     period number, resolved ONLY against `options.periods` (the school's own
 *     grid, which the import service must ask for); a period with no grid entry
 *     is a GPU_UNKNOWN_PERIOD problem on every affected line, never a guessed
 *     time. Why: a Rastra lesson has its own start and end, not a period; the
 *     minute form is the one in-spec way to say so. Other tooling: importers
 *     that expect period numbers (IServ, DieSchulApp, Bildena - S10..S12) will
 *     not understand 510; a school feeding those tools exports from its own
 *     Untis, where Stunde is a period number.
 *  3. Day.  Spec: "Tag, Num". Found: 1 = Monday (S7, S8, S12); S7 maps 6 to
 *     Saturday and anything else to Sunday. Chosen: ISO, 1 = Monday ... 7 =
 *     Sunday; the reader refuses 0, 8 and non-numbers with GPU_BAD_DAY. Other
 *     tooling: identical for Monday-Friday, which is all most schools use.
 *  4. Separator, quoting, encoding, line end.  Spec (S1-S3): comma by default,
 *     but the dialog allows semicolon, tab, space or any character; text fields
 *     in double quotes; dates YYYYMMDD; encoding unstated by Untis (S13: UTF-8
 *     and semicolon, S11/S12: comma, double quote, UTF-8, S9: ISO-8859-1, S14:
 *     UTF-8 without BOM). Chosen for the writer: comma, text fields (class,
 *     teacher, subject, room, group, student group) always in double quotes
 *     with "" for a quote, numbers and dates bare, CRLF after every line (Untis
 *     is a Windows program), no header, no BOM, and the string is UTF-8 once
 *     the service encodes it. The reader detects comma, semicolon or tab from
 *     the first lines, takes quoted or bare fields, CR, LF or CRLF, a BOM and
 *     trailing empty fields. `decodeUntisBytes`: BOM -> UTF-8 (or UTF-16 when
 *     that BOM is there, which Excel's "Unicode text" produces), else strict
 *     UTF-8, else windows-1252 (a superset of ISO-8859-1 for printable text).
 *  5. Lesson number.  Spec: "Unterr.-Nr., Num"; lines of one lesson share it.
 *     Chosen: the writer gives one number to every placement of "the same
 *     lesson" = same groups, subject, teachers, weeks, from and to (the way a
 *     school enters "Matematik 7A, 2 periods"), numbers 1..K in sorted order of
 *     that key, and one GPU001 line per placement and teacher. Rooms are per
 *     placement. The reader keys on the number only together with the slot (see
 *     6 and 7), so a foreign file that reuses a number for a coupled block of
 *     different classes, subjects and teachers is NOT collapsed into one lesson.
 *  6. Several teachers.  Spec: only footnote *1 of S5 (a class "in several
 *     lines of the same lesson (several teachers)"), and S9. Chosen: one line
 *     per teacher, lead first, same number, class, subject, room and slot. The
 *     reader merges such lines back (max two teachers; a third is
 *     GPU_TOO_MANY_TEACHERS and the lesson is skipped) and also splits a Teacher
 *     field on ',' and '~'. GPU002 follows footnote *1: field 3 is the weekly
 *     periods on the first line of a class and 0 on the others.
 *  7. Several classes.  Spec: silent for DIF; S15 shows Untis typing them
 *     comma-separated. Chosen: Class holds "8A,8B" (inside the quotes). The
 *     reader splits on ',' and '~' (the list separator S7 shows for rooms), and
 *     merges lines that differ only in class (same number, slot, subject, room
 *     and teachers) into one lesson with extraGroups, saying so in a note.
 *     Limit: an UNQUOTED comma-separated file cannot carry a class list; that
 *     line has the wrong field count or day and is reported, not guessed.
 *  8. Half classes and teaching groups.  Spec (S5 field 42, S16): the
 *     Schülergruppe is a group of pupils within one or more classes. Chosen: for
 *     a group the document says is `halfOf` a class, Class holds the class and
 *     field 42 holds the group names ("7A" + "7A-1"); every other group is
 *     written as a class name and field 42 stays empty. The reader uses field 42
 *     as the lesson's groups when the matching GPU002 line has it, else the
 *     Class names (so GPU001 alone reads a half as its whole class, which the
 *     GPU002-missing note says). A name containing ',' or '~' cannot be told
 *     from a list; the writer replaces that character with a space. The same goes
 *     for a teacher signature and for a room in GPU002's Fachraum (CHOICES 6, 13).
 *     The writer's return value is only the two files, so the change is said by a
 *     separate pure function, `listSafeChanges(doc)`, one sentence per name changed,
 *     for the export's notes: a school should not find "A,B" renamed "A B" by
 *     diffing files.
 *  9. A/B weeks.  Spec: no week field in GPU001; S17 realises A/B weeks with
 *     lesson groups, S10 recognises them from group names, S8 reads GPU002
 *     field 12 as "Woche". Chosen: GPU002 field 12 (Gruppe) holds "A-vecka"
 *     for ODD and "B-vecka" for EVEN and stays empty for ALL (A = odd ISO weeks,
 *     exchange-model.ts). The reader takes A, B, udda, jämn, odd, even, ungerade,
 *     gerade, with or without vecka/Woche/week, and leaves other group texts
 *     alone with a note. A school whose Gruppe means something else but is
 *     spelled "A" will see its rows read as odd weeks; the note counts them.
 *     The text is cut at blanks and hyphens and compared word by word (no
 *     pattern is run on it), and only up to 200 characters: a pattern is a few
 *     words, and a longer text is a group name that is left alone, like any other.
 * 10. Term and date limits.  Spec: GPU002 fields 15 and 16, Date, YYYYMMDD;
 *     nothing on inclusivity. Chosen: first and last day of the lesson, both
 *     inclusive (MasterLesson.startDate/endDate); empty = open. The reader also
 *     takes YYYY-MM-DD, checks the calendar, and refuses from > to.
 *     GPU001 has no dates, so without GPU002 every lesson runs all year.
 * 11. Subject.  Spec: Fach, the Untis short name; the long name is GPU006.
 *     Chosen: Fach holds the subject NAME; the code cannot travel (no GPU006
 *     here), so the reader returns subjectCode = null and says so. The import
 *     can still match Fach against codes as well as names.
 * 12. Weekly periods (GPU002 fields 2-4).  Spec: Num. Chosen: the number of
 *     placements in the file (alternating-week lessons are not halved - how
 *     Untis prints 0.5 is not public). The reader ignores fields 2-4 (they are
 *     derived). A school importing GPU002 back into Untis should check them.
 * 13. What the files cannot carry: the parallel block and its name, the
 *     teacher's full name and e-mail, the subject code; the reader says each
 *     once in `notes`. Rooms: GPU001 Room verbatim, GPU002 Fachraum the distinct
 *     rooms joined with '~' (S7).
 * 14. Joining GPU002 to GPU001.  Chosen: by lesson number, then narrowed by
 *     class set, subject and teacher; if rows still disagree on weeks, dates or
 *     groups the first is used and GPU_AMBIGUOUS_ROW says so; a number with no
 *     GPU002 row keeps its lesson as "every week, all year" and says so
 *     (GPU_NO_GPU002_ROW). At most 500 GPU002 rows are read for one number; the
 *     rest are not, and the number is named once (GPU_TOO_MANY_ROWS).
 *
 * LIMITS. The reader refuses input over MAX_EXCHANGE_BYTES (GPU_TOO_LARGE), a
 * file of more than 8 x MAX_EXCHANGE_LESSONS physical lines before tokenising it
 * (GPU_TOO_MANY_LESSONS: a lesson is a line per teacher, a foreign file may add a
 * line per class), a result of more than MAX_EXCHANGE_LESSONS lessons
 * (GPU_TOO_MANY_LESSONS, counted before GPU002 is joined), a line with a field
 * over 2000 characters (GPU_FIELD_TOO_LONG), more than 500 GPU002 rows of one
 * lesson number (GPU_TOO_MANY_ROWS) and keeps at most 500 problems
 * (GPU_TOO_MANY_PROBLEMS).
 * Measured 2026-11-05 on a developer laptop: 8 MB of hostile input (short lines, one
 * giant field, quotes, bare separators) takes at most half a second to refuse; a
 * 5000-lesson file takes about 30 ms.
 *
 * WHAT A STRANGER'S FILE MAY COST (the review of PR #256). The reader's cost must
 * not depend on what is in a field or on how the lines relate, only on how many
 * there are. Three things were found that did, and each is closed:
 *  - No regular expression sees file text unless it is anchored and bounded, or
 *    is one character class with one repeat (nothing to backtrack into). The
 *    Gruppe field was the exception: removing "vecka" and its separators with
 *    `[-\s]*\bvecka\b` is quadratic on a field of hyphens or blanks, and 300 rows
 *    of 2 000 characters held the process for 2 to 3 seconds (CPU, a loaded
 *    host). It is read in code instead and the same rows take milliseconds.
 *  - Lines of one lesson are merged through a Set, not `includes` on the list
 *    built so far: 39 000 lines that differ only in the teacher (or the class)
 *    were 2.2 seconds of CPU and are 0.3.
 *  - The join to GPU002 narrows a number's rows once per lesson, so 5 000
 *    lessons against 35 000 rows of one number took 24 to 44 seconds of wall
 *    time. The rows per number are capped (above) and the lessons are counted
 *    first; the same file is 0.3 seconds of CPU.
 *
 * NO PERSONNUMMER. No field of these files is one. Still, every field of every
 * line is checked (file-safety `hasPersonalNumber`): one that holds a
 * personnummer or samordningsnummer ANYWHERE in it, alone or inside longer text
 * ("Anna Berg 19800101-1234", "(800101-1234)", "19800101 - 1234"), is blanked
 * before anything reads it, never echoed, counted in a note, and a line whose
 * READ field it was is skipped with GPU_PERSONNUMMER_DROPPED. A field the reader
 * does not read is blanked too and does not skip the line. What a message quotes
 * of the file goes through `excerpt` (redacted, at most 40 characters) and a
 * value with ten digits or more, however they are separated, is not quoted at
 * all, so a number written in a shape the filter does not know is still not
 * repeated.
 */

import { TextDecoder } from 'node:util';
import {
  blankLesson,
  clockOfMinutes,
  MAX_EXCHANGE_BYTES,
  MAX_EXCHANGE_LESSONS,
  minutesOfClock,
  weekLetter,
  weekPatternOf,
  type ExchangeDocument,
  type ExchangeLesson,
  type ParsedExchange,
  type TeacherRef,
  type WeekPattern,
} from './exchange-model';
import { excerpt, hasPersonalNumber, MAX_QUOTE, ProblemLog } from './file-safety';

/** The two DIF files the writer produces; there is deliberately no GPU011 (CHOICE 1). */
export interface UntisFiles {
  gpu001: string;
  gpu002: string;
}

/** One period of the school's own time grid, for reading a period-numbered GPU001 (CHOICE 2). */
export interface UntisPeriod {
  number: number;
  /** 'HH:MM' */
  start: string;
  /** 'HH:MM', after start */
  end: string;
}

export interface UntisReadOptions {
  /**
   * The school's period times. GPU001 of a normal Untis export carries only the
   * period number; without this a line's period is unknown and the line is a
   * GPU_UNKNOWN_PERIOD problem.
   */
  periods?: readonly UntisPeriod[];
}

// ─── Layout constants ────────────────────────────────────────────────────────

/** GPU001 fields written: Unterr.-Nr. .. Stundenlänge (S4 fields 1-8). */
const GPU001_WIDTH = 8;
/** GPU001 fields a line must have to be read at all: through Stunde (S4 field 7). */
const GPU001_MIN_FIELDS = 7;
/** GPU002 fields written: the current German revision (S5). */
const GPU002_WIDTH = 45;
/** GPU002 fields a row must have to be read: through Fach (S5 field 7). */
const GPU002_MIN_FIELDS = 7;

/** GPU002 field numbers (1-based, S5) this codec writes or reads. */
const F2 = {
  lessonNo: 1,
  weeklyPeriods: 2,
  classPeriods: 3,
  teacherPeriods: 4,
  klass: 5,
  teacher: 6,
  subject: 7,
  room: 8,
  group: 12,
  from: 15,
  to: 16,
  studentGroup: 42,
} as const;

/** GPU002 fields (0-based) the reader depends on; a personnummer-like value in one skips the row. */
const GPU002_READ_INDEXES = [0, 4, 5, 6, 7, 11, 14, 15, 41];

/** The notes the reader writes once per read (the spec asserts on fragments of their wording, so a rewording shows up there). */
const NOTE_BLOCK =
  'Untis-filerna GPU001 och GPU002 har inget fält för parallella block eller blocknamn: lektioner som ligger samtidigt i ett block läses som vanliga lektioner, utan blocknamn.';
const NOTE_TEACHER =
  'GPU001 och GPU002 bär bara lärarens signatur: lärarens fullständiga namn och e-postadress finns inte i filerna och blir tomma.';
const NOTE_SUBJECT =
  'Fältet Fach läses som ämnets namn: filerna skiljer inte på ämnesnamn och ämneskod, så ämneskoden blir tom och Fach får matchas mot både namn och kod.';
const NOTE_NO_GPU002 =
  'GPU002 saknas: veckomönster (A-vecka/B-vecka), start- och slutdatum (till exempel terminsindelning) och elevgrupper (till exempel halvklasser) kan inte läsas. Alla lektioner läses som varje vecka hela läsåret, och en halvklass läses som hela klassen.';
const NOTE_GPU011 =
  'GPU011 är i Untis en stundentafel (läroplan med ämnen och minsta/största timantal), inte ett tidsraster, och används inte. Inga av Untis DIF-filer bär klockslag för perioder.';

/**
 * The most GPU002 rows read for one lesson number. A lesson is a handful of rows
 * (a line per class and teacher); a coupled block that shares one number may be
 * dozens. Each GPU001 lesson is joined to the rows of its number by narrowing
 * them three times (CHOICE 14), so the cost of the join is lessons x rows per
 * number, and a file may make both large at once: 5 000 lessons and 35 000 rows
 * of the same number held the process for 24 to 44 seconds. With the cap the
 * product is at most 5 000 x 500, however the file is built. Rows beyond it are
 * not read and the number is named once (GPU_TOO_MANY_ROWS).
 */
const MAX_ROWS_PER_NUMBER = 500;

/**
 * The longest Gruppe text (GPU002 field 12) that is looked at as a week pattern.
 * A pattern is a few words ("Udda vecka", "B-Woche"); a longer text is a group
 * NAME that happens to be long, never a pattern, so it is not interpreted at all
 * (it is named in the note about group texts that are left alone). The cap is
 * what keeps the cost of the field independent of what a stranger put in it.
 */
const MAX_WEEK_FIELD_CHARS = 200;

// ─── Writer ──────────────────────────────────────────────────────────────────

/** Control characters out, edges trimmed: a DIF field is one line of text. */
function cleanText(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim();
}

/** A text field: double quotes around it, an inner quote doubled. */
function quote(value: string): string {
  return `"${cleanText(value).replace(/"/g, '""')}"`;
}

/** A name that will sit in a list field: ',' and '~' are the separators, so they cannot be part of it (CHOICE 8). */
function listSafe(value: string): string {
  return cleanText(value).replace(/[,~]/g, ' ');
}

/** The text a teacher is written as, before it is made list-safe: the signature, the name as the fallback. */
function teacherText(teacher: TeacherRef): string {
  return teacher.short ?? teacher.name ?? '';
}

/** The signature a teacher is written as; the document gives every teacher one, the name is the fallback. */
function teacherCode(teacher: TeacherRef): string {
  return listSafe(teacherText(teacher));
}

/** How many renamed names `listSafeChanges` spells out; the rest are counted in one closing sentence. */
const MAX_LISTED_RENAMES = 5;

/**
 * The names `writeUntisGpu` has to change, as one Swedish sentence each, for the
 * notes of an export (CHOICE 8). ',' and '~' separate the names in a DIF list
 * field (classes, teachers, rooms), so a name that holds one cannot be written
 * as it is; the writer replaces the character with a space. That is the right
 * thing to write but a thing to say: a signature "A,B" comes back from Untis as
 * "A B", and a school that finds a teacher renamed in its import should not have
 * to diff the files to learn why. Nothing is said about a name that is written
 * as it is, and the same name is said once however many lessons carry it.
 *
 * Pure, and deliberately NOT part of the writer's return value (callers destructure
 * `{ gpu001, gpu002 }`): a caller that wants the notes asks for them with the same
 * document. It never throws: a lesson the writer would refuse is simply read for
 * its names. The order is the same for the same document, whatever the order of
 * the lessons, as the writer's own output is.
 */
export function listSafeChanges(doc: ExchangeDocument): string[] {
  type Kind = 'class' | 'teacher' | 'room';
  const found: Record<Kind, Map<string, string>> = { class: new Map(), teacher: new Map(), room: new Map() };
  const note = (kind: Kind, value: string): void => {
    const written = listSafe(value);
    if (written !== cleanText(value)) found[kind].set(cleanText(value), written);
  };
  for (const lesson of doc.lessons) {
    for (const name of [lesson.group, ...lesson.extraGroups]) note('class', name);
    for (const t of lesson.teachers) note('teacher', teacherText(t));
    // GPU001 keeps a room as it is (it is a quoted text, not a list); only GPU002's Fachraum is a '~' list.
    note('room', lesson.room ?? '');
  }

  const sentences: string[] = [];
  const say = (kind: Kind, label: string, where: string): void => {
    for (const [from, to] of [...found[kind]].sort((a, b) => compareText(a[0], b[0]))) {
      sentences.push(
        `${label} ${excerpt(from)} skrevs som ${excerpt(to)} i ${where}, eftersom komma och tilde skiljer namnen åt i Untis fält med flera värden.`,
      );
    }
  };
  say('class', 'Gruppen', 'GPU001 och GPU002');
  say('teacher', 'Signaturen', 'GPU001 och GPU002');
  say('room', 'Rummet', 'GPU002 (Fachraum)');
  if (sentences.length <= MAX_LISTED_RENAMES) return sentences;
  const rest = sentences.length - MAX_LISTED_RENAMES;
  return [...sentences.slice(0, MAX_LISTED_RENAMES), `Ytterligare ${rest} namn med komma eller tilde skrevs om på samma sätt.`];
}

/** 'YYYY-MM-DD' to 'YYYYMMDD'; anything else (including null) to an empty field. */
function difDate(iso: string | null): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso ?? '');
  return m ? `${m[1]}${m[2]}${m[3]}` : '';
}

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

interface Placement {
  day: number;
  start: number;
  end: number;
  room: string;
}

/** The lessons of the document that are one Untis lesson (CHOICE 5). */
interface UntisLesson {
  key: string;
  classes: string[];
  studentGroups: string[];
  subject: string;
  teachers: string[];
  weeks: WeekPattern;
  from: string;
  to: string;
  placements: Placement[];
}

function lineOf(fields: string[]): string {
  return `${fields.join(',')}\r\n`;
}

/**
 * Writes the document as GPU001 and GPU002 text. Pure and deterministic: lesson
 * numbers and line order depend only on the lessons' content, never on their
 * order in the document or on a clock. Throws RangeError for a lesson whose day
 * or times are not valid (a caller bug, not something the format limits).
 */
export function writeUntisGpu(doc: ExchangeDocument): UntisFiles {
  const halfOf = new Map<string, string>();
  for (const group of doc.groups) {
    if (group.halfOf) halfOf.set(group.name, group.halfOf);
  }

  const byKey = new Map<string, UntisLesson>();
  for (const lesson of doc.lessons) {
    const start = minutesOfClock(lesson.start);
    const end = minutesOfClock(lesson.end);
    if (start === null || end === null || end <= start) {
      throw new RangeError(`Lektionen ${lesson.group} ${lesson.subject} har ogiltig tid ${lesson.start}-${lesson.end}.`);
    }
    if (!Number.isInteger(lesson.day) || lesson.day < 1 || lesson.day > 7) {
      throw new RangeError(`Lektionen ${lesson.group} ${lesson.subject} har ogiltig veckodag ${String(lesson.day)}.`);
    }
    const groups = [lesson.group, ...lesson.extraGroups].map(listSafe);
    const classes = [...new Set(groups.map((name) => halfOf.get(name) ?? name))];
    const studentGroups = groups.some((name) => halfOf.has(name)) ? groups : [];
    const teachers = lesson.teachers.map(teacherCode).filter((code) => code !== '');
    const from = difDate(lesson.from);
    const to = difDate(lesson.to);
    const subject = cleanText(lesson.subject);
    const key = [groups.join('\u0001'), subject, teachers.join('\u0001'), lesson.weeks, from, to].join('\u0000');
    let untis = byKey.get(key);
    if (!untis) {
      untis = { key, classes, studentGroups, subject, teachers, weeks: lesson.weeks, from, to, placements: [] };
      byKey.set(key, untis);
    }
    untis.placements.push({ day: lesson.day, start, end, room: cleanText(lesson.room ?? '') });
  }

  const ordered = [...byKey.values()].sort((a, b) => compareText(a.key, b.key));
  const gpu001: string[] = [];
  const gpu002: string[] = [];
  ordered.forEach((untis, index) => {
    const number = index + 1;
    const placements = [...untis.placements].sort(
      (a, b) => a.day - b.day || a.start - b.start || a.end - b.end || compareText(a.room, b.room),
    );
    const classText = untis.classes.join(',');
    // One line per teacher, or one teacherless line (CHOICE 6).
    const teacherSlots = untis.teachers.length > 0 ? untis.teachers : [''];

    for (const p of placements) {
      for (const teacher of teacherSlots) {
        gpu001.push(
          lineOf([
            String(number),
            quote(classText),
            quote(teacher),
            quote(untis.subject),
            quote(p.room),
            String(p.day),
            String(p.start),
            clockOfMinutes(p.end - p.start),
          ]),
        );
      }
    }

    const rooms = [...new Set(placements.map((p) => listSafe(p.room)).filter((room) => room !== ''))].join('~');
    const group = untis.weeks === 'ALL' ? '' : `${weekLetter(untis.weeks)}-vecka`;
    teacherSlots.forEach((teacher, teacherIndex) => {
      const row: string[] = new Array<string>(GPU002_WIDTH).fill('');
      const set = (field: number, value: string): void => {
        row[field - 1] = value;
      };
      set(F2.lessonNo, String(number));
      set(F2.weeklyPeriods, String(placements.length));
      set(F2.classPeriods, String(teacherIndex === 0 ? placements.length : 0));
      set(F2.teacherPeriods, String(teacher === '' ? 0 : placements.length));
      set(F2.klass, quote(classText));
      set(F2.teacher, quote(teacher));
      set(F2.subject, quote(untis.subject));
      set(F2.room, quote(rooms));
      set(F2.group, quote(group));
      set(F2.from, untis.from);
      set(F2.to, untis.to);
      set(F2.studentGroup, quote(untis.studentGroups.join(',')));
      gpu002.push(lineOf(row));
    });
  });

  return { gpu001: gpu001.join(''), gpu002: gpu002.join('') };
}

// ─── Decoding ────────────────────────────────────────────────────────────────

/**
 * Bytes to text for a DIF file (CHOICE 4). A UTF-8 BOM means UTF-8, a UTF-16 BOM
 * means UTF-16 (what Excel's "Unicode text" saves). Without a BOM the bytes are
 * UTF-8 if they are valid UTF-8 and windows-1252 if not: Untis writes either,
 * depending on the DIF setting and version, and a Latin-1 "ä" (0xE4) is never
 * valid UTF-8, so the test cannot take one for the other. windows-1252 rather
 * than ISO-8859-1 because it also maps 0x80-0x9F (the euro sign, curly quotes)
 * to what Windows programs meant.
 */
export function decodeUntisBytes(buf: Buffer): string {
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
    return new TextDecoder('utf-8').decode(buf.subarray(3));
  }
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) return new TextDecoder('utf-16le').decode(buf.subarray(2));
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) return new TextDecoder('utf-16be').decode(buf.subarray(2));
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buf);
  } catch {
    return new TextDecoder('windows-1252').decode(buf);
  }
}

// ─── Tokenising ──────────────────────────────────────────────────────────────

interface RawRecord {
  /** Physical line number in the file where the record starts (what an editor shows). */
  line: number;
  fields: string[];
  /** A field was longer than MAX_FIELD_CHARS; it is read as empty and the line is refused. */
  tooLong: boolean;
}

interface DifRecord extends RawRecord {
  /** 0-based indexes of fields blanked because they looked like a personnummer. */
  dropped: number[];
}

/**
 * The longest field kept. No name, room or date in a timetable is anywhere near
 * it; the limit exists so that a hostile 8 MB file with one giant field costs a
 * scan, not seconds of string building.
 */
const MAX_FIELD_CHARS = 2000;

/**
 * The most physical lines a file may have: eight per lesson the model accepts
 * (a lesson is a line per teacher, and a foreign file may add a line per class).
 * Checked before tokenising, so that 8 MB of short lines is refused in
 * milliseconds rather than parsed for seconds.
 */
const MAX_DIF_LINES = MAX_EXCHANGE_LESSONS * 8;

/** Physical lines of a text, counting LF or CR as a line end, whichever there are more of. */
function physicalLines(text: string): number {
  let lf = 0;
  for (let i = text.indexOf('\n'); i >= 0; i = text.indexOf('\n', i + 1)) lf += 1;
  let cr = 0;
  for (let i = text.indexOf('\r'); i >= 0; i = text.indexOf('\r', i + 1)) cr += 1;
  return Math.max(lf, cr) + 1;
}

function newlinesIn(text: string): number {
  let n = 0;
  for (let i = text.indexOf('\n'); i >= 0; i = text.indexOf('\n', i + 1)) n += 1;
  return n;
}

/** Comma, semicolon or tab, whichever is most frequent outside quotes in the first lines; comma on a tie (Untis' default, S1). */
function detectSeparator(text: string): string {
  const counts: Record<string, number> = { ',': 0, ';': 0, '\t': 0 };
  let inQuotes = false;
  let lines = 0;
  for (let i = text.charCodeAt(0) === 0xfeff ? 1 : 0; i < text.length && lines < 30; i += 1) {
    const c = text[i]!;
    if (c === '"') {
      inQuotes = !inQuotes;
    } else if (!inQuotes) {
      if (c === '\n') lines += 1;
      else if (c in counts) counts[c]! += 1;
    }
  }
  let best = ',';
  for (const candidate of [';', '\t']) {
    if (counts[candidate]! > counts[best]!) best = candidate;
  }
  return best;
}

/**
 * Splits DIF text into records, field by field, cutting slices out of the text
 * rather than appending characters. A quote opens a quoted field only at the
 * start of a field (after blanks); inside one, a doubled quote is a quote and a
 * line break is kept as a space (Untis does not write one, a hand-edited file
 * might); whatever follows the closing quote up to the next separator belongs to
 * the field. Fields are trimmed. A line with only blanks and separators is not
 * a record.
 */
function tokenise(text: string, separator: string): RawRecord[] {
  const records: RawRecord[] = [];
  const n = text.length;
  const sep = separator.charCodeAt(0);
  const tabIsSeparator = separator === '\t';
  let i = text.charCodeAt(0) === 0xfeff ? 1 : 0;
  let line = 1;
  let recordLine = 1;
  let fields: string[] = [];
  let tooLong = false;

  const keep = (value: string): void => {
    const trimmed = value.trim();
    if (trimmed.length > MAX_FIELD_CHARS) {
      tooLong = true;
      fields.push('');
    } else {
      fields.push(trimmed);
    }
  };
  const endRecord = (): void => {
    if (tooLong || fields.some((f) => f !== '')) records.push({ line: recordLine, fields, tooLong });
    fields = [];
    tooLong = false;
  };
  /** The end of the unquoted run that starts at `from`: the next separator, line end or the end of the text. */
  const runEnd = (from: number): number => {
    let j = from;
    while (j < n) {
      const c = text.charCodeAt(j);
      if (c === sep || c === 10 || c === 13) break;
      j += 1;
    }
    return j;
  };

  while (i < n) {
    // Blanks before a field (a tab is a blank unless it is the separator).
    while (i < n) {
      const c = text.charCodeAt(i);
      if (c === 32 || (c === 9 && !tabIsSeparator)) i += 1;
      else break;
    }
    let value = '';
    if (text.charCodeAt(i) === 34) {
      i += 1;
      for (;;) {
        const q = text.indexOf('"', i);
        const chunk = text.slice(i, q < 0 ? n : q);
        line += newlinesIn(chunk);
        if (value.length <= MAX_FIELD_CHARS) value += chunk;
        if (q < 0) {
          i = n;
          break;
        }
        if (text.charCodeAt(q + 1) === 34) {
          if (value.length <= MAX_FIELD_CHARS) value += '"';
          i = q + 2;
        } else {
          i = q + 1;
          break;
        }
      }
      value = value.replace(/[\r\n]+/g, ' ');
      const end = runEnd(i);
      if (end - i <= MAX_FIELD_CHARS) value += text.slice(i, end);
      else value += 'x'.repeat(MAX_FIELD_CHARS + 1);
      i = end;
    } else {
      const end = runEnd(i);
      value = text.slice(i, end);
      i = end;
    }
    keep(value);

    if (i >= n) break;
    const c = text.charCodeAt(i);
    if (c === sep) {
      i += 1;
      // A separator that ends the text ends an empty last field.
      if (i >= n) keep('');
      continue;
    }
    if (c === 13 && text.charCodeAt(i + 1) === 10) i += 1;
    i += 1;
    endRecord();
    line += 1;
    recordLine = line;
  }
  endRecord();
  return records;
}

/**
 * Every field of every record, tested for a personnummer or samordningsnummer
 * anywhere in it (file-safety `hasPersonalNumber`: whole or inside longer text,
 * with or without hyphen and spaces). A field that has one is replaced by an
 * empty one and its index is recorded, so that nothing downstream can read,
 * keep or quote it, and the reader decides per index whether the line is
 * skipped (a field it reads) or only counted (a field it does not).
 */
function tableOf(text: string): { records: DifRecord[]; dropped: number } {
  const records: DifRecord[] = [];
  let droppedTotal = 0;
  for (const raw of tokenise(text, detectSeparator(text))) {
    const dropped: number[] = [];
    const fields = raw.fields.map((value, index) => {
      if (!hasPersonalNumber(value)) return value;
      dropped.push(index);
      droppedTotal += 1;
      return '';
    });
    records.push({ line: raw.line, fields, tooLong: raw.tooLong, dropped });
  }
  return { records, dropped: droppedTotal };
}

// ─── Field parsers ───────────────────────────────────────────────────────────

const at = (fields: string[], index: number): string => fields[index] ?? '';

/**
 * A value of the file as a message may show it: file-safety `excerpt` (redacted,
 * one line, at most 40 characters, in quotation marks). One more door on top of
 * that: a value with ten digits or more in the part that would be shown, however
 * they are separated, is not quoted at all. `hasPersonalNumber` knows the shapes
 * a personnummer is written in; a stranger can write one in a shape it does not
 * know ("1980.01.01-1234"), and a field that reaches a message is by definition
 * one the reader could not use, so it costs nothing to say "digits left out"
 * instead of repeating them. The part looked at is the one-line text up to 12
 * characters past where the quote is cut, so a number that straddles the cut is
 * seen whole and not shown in half.
 */
function shown(value: string): string {
  const visible = value.replace(/\s+/g, ' ').trim().slice(0, MAX_QUOTE + 12);
  let digits = 0;
  for (let i = 0; i < visible.length; i += 1) {
    const c = visible.charCodeAt(i);
    if (c >= 48 && c <= 57) digits += 1;
  }
  return digits >= 10 ? '”[siffror utelämnade]”' : excerpt(value);
}

function splitList(value: string): string[] {
  return [
    ...new Set(
      value
        .split(/[,~]/)
        .map((part) => part.trim())
        .filter((part) => part !== ''),
    ),
  ];
}

/** 'h:mm' / 'hh:mm' to minutes, without the 24-hour limit minutesOfClock applies (a length may be long). */
function durationMinutes(text: string): number | null {
  const colon = /^(\d{1,3}):(\d{2})$/.exec(text);
  if (colon) {
    const minutes = Number(colon[2]);
    return minutes < 60 ? Number(colon[1]) * 60 + minutes : null;
  }
  return /^\d{1,4}$/.test(text) ? Number(text) : null;
}

type DateResult = { ok: true; value: string | null } | { ok: false };

/** YYYYMMDD (S1) or YYYY-MM-DD to 'YYYY-MM-DD'; empty is open (null); a date that is not on the calendar is refused. */
function isoDate(text: string): DateResult {
  if (text === '') return { ok: true, value: null };
  const m = /^(\d{4})-?(\d{2})-?(\d{2})$/.exec(text);
  if (!m) return { ok: false };
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  const probe = new Date(Date.UTC(y, mo - 1, d));
  if (probe.getUTCFullYear() !== y || probe.getUTCMonth() !== mo - 1 || probe.getUTCDate() !== d) return { ok: false };
  return { ok: true, value: `${m[1]}-${m[2]}-${m[3]}` };
}

/** The words that say "week" and carry no pattern of their own ("A-vecka", "Gerade Woche", "Week A"). */
const WEEK_WORDS: ReadonlySet<string> = new Set(['vecka', 'woche', 'week']);

/**
 * The Gruppe field as a week pattern (CHOICE 9): null when it is some other kind
 * of group text.
 *
 * Read in code, not by pattern matching: the text is cut at blanks and hyphens,
 * the words for "week" are dropped, and what is left must be one of the
 * spellings `weekPatternOf` knows. An earlier version removed the week words
 * with `[-\s]*\bvecka\b` and its mirror image; on a field of hyphens or blanks
 * that is quadratic (the engine tries the run from every position and gives
 * it all back each time), which made 300 rows of 2 000 characters hold the
 * process for seconds. The one pattern left is a single character class with a
 * single repeat, which has nothing to backtrack into, and it only ever sees at
 * most MAX_WEEK_FIELD_CHARS characters: a longer text is not a week pattern.
 */
function weekPatternOfGroup(text: string): WeekPattern | null {
  const trimmed = text.trim();
  if (trimmed === '') return 'ALL';
  if (trimmed.length > MAX_WEEK_FIELD_CHARS) return null;
  const rest = trimmed
    .toLowerCase()
    .split(/[\s-]+/)
    .filter((token) => token !== '' && !WEEK_WORDS.has(token));
  // Nothing but week words (a bare "vecka") or nothing at all (a field of hyphens) says no pattern.
  if (rest.length === 0) return null;
  const stripped = rest.join(' ');
  if (stripped === 'ungerade') return 'ODD';
  if (stripped === 'gerade') return 'EVEN';
  return weekPatternOf(stripped);
}

// ─── Reader ──────────────────────────────────────────────────────────────────

interface Entry001 {
  ref: string;
  lessonNo: number;
  classes: string[];
  teachers: string[];
  subject: string;
  room: string;
  day: number;
  start: string;
  end: string;
}

interface Row002 {
  ref: string;
  lessonNo: number;
  classes: string[];
  teachers: string[];
  subject: string;
  weeks: WeekPattern;
  from: string | null;
  to: string | null;
  studentGroups: string[];
  /** Derived once per row, because the join below asks them once per row per lesson of its number. */
  classKey: string;
  studentKey: string;
  teacherSet: ReadonlySet<string>;
}

function pushUnique(list: string[], value: string): void {
  if (!list.includes(value)) list.push(value);
}

/** Appends the values not yet in `list`; `seen` mirrors `list`, so merging a line is a lookup and not a scan of everything merged so far. */
function addDistinct(list: string[], seen: Set<string>, values: readonly string[]): void {
  for (const value of values) {
    if (!seen.has(value)) {
      seen.add(value);
      list.push(value);
    }
  }
}

/** A set of names as one string, so that two sets are the same set exactly when their keys are equal. */
function setKey(names: readonly string[]): string {
  return JSON.stringify([...names].sort());
}

/**
 * Reads GPU001 (required) and GPU002 (optional) text back into lessons. Never
 * throws on content: every line it cannot use is skipped with a ReadProblem
 * ("GPU001 rad 12"), and what the format could not carry is said once in
 * `notes`. A period-numbered GPU001 needs `options.periods` (CHOICE 2).
 */
export function readUntisGpu(
  files: { gpu001?: string; gpu002?: string; gpu011?: string },
  options: UntisReadOptions = {},
): ParsedExchange {
  // At most MAX_PROBLEMS are kept; a hostile 8 MB file of bad lines must not become 400 000 messages.
  const log = new ProblemLog('GPU_TOO_MANY_PROBLEMS');
  const notes: string[] = [];
  const problem = (ref: string, code: string, message: string): void => log.add(ref, code, message);
  const finish = (lessons: ExchangeLesson[]): ParsedExchange => ({ lessons, problems: log.close(), notes });

  const text001 = files.gpu001 ?? '';
  const text002 = files.gpu002 ?? '';
  const text011 = files.gpu011 ?? '';

  const bytes = Buffer.byteLength(text001, 'utf8') + Buffer.byteLength(text002, 'utf8') + Buffer.byteLength(text011, 'utf8');
  if (bytes > MAX_EXCHANGE_BYTES) {
    problem('GPU001', 'GPU_TOO_LARGE', `Filerna är för stora (${(bytes / 1048576).toFixed(1)} MB): högst ${MAX_EXCHANGE_BYTES / 1048576} MB tas emot.`);
    return finish([]);
  }
  if (files.gpu001 === undefined) {
    problem('GPU001', 'GPU_NO_GPU001', 'GPU001 saknas: utan tidtabellsfilen finns inga lektioner att läsa.');
    return finish([]);
  }
  for (const [name, content] of [
    ['GPU001', text001],
    ['GPU002', text002],
  ] as const) {
    if (physicalLines(content) > MAX_DIF_LINES) {
      problem(name, 'GPU_TOO_MANY_LESSONS', `${name} har fler än ${MAX_DIF_LINES} rader (högst ${MAX_EXCHANGE_LESSONS} lektioner tas emot); ingen lektion har lästs in.`);
      return finish([]);
    }
  }
  const table001 = tableOf(text001);
  if (table001.records.length === 0) {
    problem('GPU001', 'GPU_EMPTY', 'GPU001 är tom: det finns inga rader att läsa.');
    return finish([]);
  }

  if (text011.trim() !== '') notes.push(NOTE_GPU011);

  // The period grid, if the caller gave one.
  const grid = new Map<number, { start: string; end: string }>();
  for (const period of options.periods ?? []) {
    const start = minutesOfClock(period.start);
    const end = minutesOfClock(period.end);
    if (!Number.isInteger(period.number) || period.number < 0 || start === null || end === null || end <= start) {
      problem('tidsraster', 'GPU_BAD_PERIOD_GRID', `Perioden ${String(period.number)} i tidsrastret har ogiltiga tider och används inte.`);
    } else {
      grid.set(period.number, { start: clockOfMinutes(start), end: clockOfMinutes(end) });
    }
  }

  let personnummerDropped = table001.dropped;
  let minuteLines = 0;
  let periodLines = 0;
  let webUntisFieldsSeen = false;

  // ── GPU002 ──
  const rowsByNumber = new Map<number, Row002[]>();
  const crowdedNumbers = new Set<number>();
  const hasGpu002 = text002.trim() !== '';
  const ignoredGroupTexts: string[] = [];
  let weekGroupRows = 0;
  let studentGroupRows = 0;
  if (hasGpu002) {
    const table002 = tableOf(text002);
    personnummerDropped += table002.dropped;
    for (const record of table002.records) {
      const ref = `GPU002 rad ${record.line}`;
      const f = record.fields;
      if (record.tooLong) {
        problem(ref, 'GPU_FIELD_TOO_LONG', `Ett fält på raden är längre än ${MAX_FIELD_CHARS} tecken; raden hoppas över.`);
        continue;
      }
      if (f.length < GPU002_MIN_FIELDS) {
        problem(ref, 'GPU_BAD_FIELD_COUNT', `Raden har ${f.length} fält men minst ${GPU002_MIN_FIELDS} behövs (till och med Fach); raden hoppas över.`);
        continue;
      }
      if (record.dropped.some((index) => GPU002_READ_INDEXES.includes(index))) {
        problem(ref, 'GPU_PERSONNUMMER_DROPPED', 'Ett fält på raden liknar ett personnummer och har tagits bort utan att läsas; raden hoppas över.');
        continue;
      }
      const lessonText = at(f, F2.lessonNo - 1);
      if (!/^\d+$/.test(lessonText)) {
        problem(ref, 'GPU_BAD_LESSON_NUMBER', `Unt-Nummer (fält 1) ska vara ett heltal men är ${shown(lessonText)}; raden hoppas över.`);
        continue;
      }
      const lessonNo = Number(lessonText);
      const known = rowsByNumber.get(lessonNo);
      if (known && known.length >= MAX_ROWS_PER_NUMBER) {
        // Said once per number, on the first row left out; the rest of that number's rows are not looked at.
        if (!crowdedNumbers.has(lessonNo)) {
          crowdedNumbers.add(lessonNo);
          problem(
            ref,
            'GPU_TOO_MANY_ROWS',
            `Lektionsnummer ${lessonNo} har fler än ${MAX_ROWS_PER_NUMBER} rader i GPU002; de första ${MAX_ROWS_PER_NUMBER} används och resten läses inte.`,
          );
        }
        continue;
      }
      const from = isoDate(at(f, F2.from - 1));
      const to = isoDate(at(f, F2.to - 1));
      if (!from.ok || !to.ok) {
        problem(ref, 'GPU_BAD_DATE', 'Datum von/bis (fält 15 och 16) ska vara YYYYMMDD och ett datum som finns; raden hoppas över.');
        continue;
      }
      if (from.value !== null && to.value !== null && from.value > to.value) {
        problem(ref, 'GPU_BAD_DATE_RANGE', 'Datum von ligger efter datum bis; raden hoppas över.');
        continue;
      }
      const groupText = at(f, F2.group - 1);
      let weeks = weekPatternOfGroup(groupText);
      if (weeks === null) {
        weeks = 'ALL';
        if (ignoredGroupTexts.length < 3) pushUnique(ignoredGroupTexts, shown(groupText));
      } else if (weeks !== 'ALL') {
        weekGroupRows += 1;
      }
      const studentGroups = splitList(at(f, F2.studentGroup - 1));
      if (studentGroups.length > 0) studentGroupRows += 1;
      const classes = splitList(at(f, F2.klass - 1));
      const teachers = splitList(at(f, F2.teacher - 1));
      const row: Row002 = {
        ref,
        lessonNo,
        classes,
        teachers,
        subject: at(f, F2.subject - 1),
        weeks,
        from: from.value,
        to: to.value,
        studentGroups,
        classKey: setKey(classes),
        studentKey: studentGroups.join('\u0001'),
        teacherSet: new Set(teachers),
      };
      if (known) known.push(row);
      else rowsByNumber.set(lessonNo, [row]);
    }
  } else {
    notes.push(NOTE_NO_GPU002);
  }

  // ── GPU001: lines to entries ──
  const entries: Entry001[] = [];
  for (const record of table001.records) {
    const ref = `GPU001 rad ${record.line}`;
    const f = record.fields;
    if (record.tooLong) {
      problem(ref, 'GPU_FIELD_TOO_LONG', `Ett fält på raden är längre än ${MAX_FIELD_CHARS} tecken; raden hoppas över.`);
      continue;
    }
    if (f.length < GPU001_MIN_FIELDS) {
      problem(ref, 'GPU_BAD_FIELD_COUNT', `Raden har ${f.length} fält men minst ${GPU001_MIN_FIELDS} behövs (till och med Stunde); raden hoppas över.`);
      continue;
    }
    if (record.dropped.some((index) => index < GPU001_WIDTH)) {
      problem(ref, 'GPU_PERSONNUMMER_DROPPED', 'Ett fält på raden liknar ett personnummer och har tagits bort utan att läsas; raden hoppas över.');
      continue;
    }
    if (f.slice(10, 12).some((value) => value !== '')) webUntisFieldsSeen = true;

    const lessonText = f[0]!;
    if (!/^\d+$/.test(lessonText)) {
      problem(ref, 'GPU_BAD_LESSON_NUMBER', `Unterr.-Nr. (fält 1) ska vara ett heltal men är ${shown(lessonText)}; raden hoppas över.`);
      continue;
    }
    const classes = splitList(f[1]!);
    if (classes.length === 0) {
      problem(ref, 'GPU_NO_CLASS', 'Raden saknar klass (fält 2); raden hoppas över.');
      continue;
    }
    const subject = f[3]!;
    if (subject === '') {
      problem(ref, 'GPU_NO_SUBJECT', 'Raden saknar ämne (fält 4); raden hoppas över.');
      continue;
    }
    const dayText = f[5]!;
    const day = /^\d$/.test(dayText) ? Number(dayText) : 0;
    if (day < 1 || day > 7) {
      problem(ref, 'GPU_BAD_DAY', `Tag (fält 6) ska vara 1-7 med 1 = måndag men är ${shown(dayText)}; raden hoppas över.`);
      continue;
    }

    const stunde = f[6]!;
    const length = at(f, 7);
    let start: string;
    let end: string;
    if (length !== '') {
      // The minute-based form (CHOICE 2): Stunde is the start, Stundenlänge the length.
      const startMinutes = /^\d{1,4}$/.test(stunde) ? Number(stunde) : minutesOfClock(stunde);
      const lengthMinutes = durationMinutes(length);
      if (startMinutes === null || lengthMinutes === null || lengthMinutes <= 0 || startMinutes + lengthMinutes > 1439) {
        problem(
          ref,
          'GPU_BAD_TIME',
          `Stunde ${shown(stunde)} och Stundenlänge ${shown(length)} ger ingen tid inom dygnet (Stunde = minuter efter midnatt, Stundenlänge = hh:mm); raden hoppas över.`,
        );
        continue;
      }
      start = clockOfMinutes(startMinutes);
      end = clockOfMinutes(startMinutes + lengthMinutes);
      minuteLines += 1;
    } else {
      // The period-numbered form: the number means nothing without the school's grid.
      if (!/^\d{1,4}$/.test(stunde)) {
        problem(ref, 'GPU_BAD_PERIOD', `Stunde (fält 7) ska vara ett periodnummer men är ${shown(stunde)} och Stundenlänge saknas; raden hoppas över.`);
        continue;
      }
      const period = grid.get(Number(stunde));
      if (!period) {
        problem(
          ref,
          'GPU_UNKNOWN_PERIOD',
          grid.size === 0
            ? `Period ${Number(stunde)} saknar klockslag: GPU001 bär bara periodens nummer och inget tidsraster har angetts.`
            : `Period ${Number(stunde)} finns inte i det angivna tidsrastret; raden hoppas över.`,
        );
        continue;
      }
      start = period.start;
      end = period.end;
      periodLines += 1;
    }

    entries.push({
      ref,
      lessonNo: Number(lessonText),
      classes,
      teachers: splitList(f[2]!),
      subject,
      room: f[4]!,
      day,
      start,
      end,
    });
  }

  // ── Merge lines of one lesson (CHOICES 6 and 7) ──
  // Each merged entry keeps a Set beside the list it grows: a file of 40 000 lines that differ only in the teacher
  // (or the class) is one lesson with 40 000 names, and `includes` on a list that long, per line, took 2 seconds.
  // First the teachers: lines identical but for the teacher are one lesson.
  const byTeacherless = new Map<string, { entry: Entry001; seen: Set<string> }>();
  for (const e of entries) {
    const key = [e.lessonNo, e.classes.join('\u0001'), e.subject, e.room, e.day, e.start, e.end].join('\u0000');
    const known = byTeacherless.get(key);
    if (known) {
      addDistinct(known.entry.teachers, known.seen, e.teachers);
    } else {
      byTeacherless.set(key, { entry: { ...e, teachers: [...e.teachers] }, seen: new Set(e.teachers) });
    }
  }
  // Then the classes: lines identical but for the class, with the same teachers, are one lesson with several classes.
  let classLinesMerged = false;
  const byClassless = new Map<string, { entry: Entry001; seen: Set<string> }>();
  for (const { entry: e } of byTeacherless.values()) {
    const key = [e.lessonNo, e.subject, e.room, e.day, e.start, e.end, [...e.teachers].sort().join('\u0001')].join('\u0000');
    const known = byClassless.get(key);
    if (known) {
      addDistinct(known.entry.classes, known.seen, e.classes);
      classLinesMerged = true;
    } else {
      byClassless.set(key, { entry: { ...e, classes: [...e.classes] }, seen: new Set(e.classes) });
    }
  }

  // The lessons the file would make, counted BEFORE they are joined to GPU002: the join costs the number of lessons
  // times the number of GPU002 rows that share their number, and a file that is to be refused is not paid for first.
  let buildable = 0;
  for (const { entry } of byClassless.values()) if (entry.teachers.length <= 2) buildable += 1;
  if (buildable > MAX_EXCHANGE_LESSONS) {
    problem('GPU001', 'GPU_TOO_MANY_LESSONS', `Filen innehåller ${buildable} lektioner men högst ${MAX_EXCHANGE_LESSONS} tas emot; ingen av dem har lästs in.`);
    return finish([]);
  }

  // ── Resolve each entry against GPU002 and build the lessons ──
  const lessons: ExchangeLesson[] = [];
  for (const { entry: e } of byClassless.values()) {
    if (e.teachers.length > 2) {
      problem(e.ref, 'GPU_TOO_MANY_TEACHERS', `Lektionen har ${e.teachers.length} lärare men Rastra tar högst två (ledande lärare och en medlärare); lektionen hoppas över.`);
      continue;
    }

    let weeks: WeekPattern = 'ALL';
    let from: string | null = null;
    let to: string | null = null;
    let groups = e.classes;
    if (hasGpu002) {
      let candidates = rowsByNumber.get(e.lessonNo) ?? [];
      if (candidates.length === 0) {
        problem(
          e.ref,
          'GPU_NO_GPU002_ROW',
          `Lektionsnummer ${e.lessonNo} har ingen användbar rad i GPU002 (raden saknas eller hoppades över): veckomönster, datum och elevgrupper kunde inte läsas, så lektionen läses som varje vecka hela läsåret.`,
        );
      } else {
        const narrow = (keep: (row: Row002) => boolean): void => {
          const kept = candidates.filter(keep);
          if (kept.length > 0) candidates = kept;
        };
        const classKey = setKey(e.classes);
        narrow((row) => row.classKey === classKey);
        narrow((row) => row.subject === e.subject);
        narrow((row) => (e.teachers.length === 0 ? row.teachers.length === 0 : e.teachers.some((teacher) => row.teacherSet.has(teacher))));
        const row = candidates[0]!;
        const agree = candidates.every(
          (other) => other.weeks === row.weeks && other.from === row.from && other.to === row.to && other.studentKey === row.studentKey,
        );
        if (!agree) {
          problem(
            e.ref,
            'GPU_AMBIGUOUS_ROW',
            `Lektionsnummer ${e.lessonNo} har flera GPU002-rader med olika veckomönster, datum eller elevgrupper; den första (${row.ref}) används.`,
          );
        }
        weeks = row.weeks;
        from = row.from;
        to = row.to;
        if (row.studentGroups.length > 0) groups = row.studentGroups;
      }
    }

    lessons.push(
      blankLesson({
        ref: e.ref,
        group: groups[0]!,
        extraGroups: groups.slice(1),
        subject: e.subject,
        teachers: e.teachers.map((short) => ({ short, name: null, email: null, id: null })),
        room: e.room === '' ? null : e.room,
        day: e.day,
        start: e.start,
        end: e.end,
        weeks,
        from,
        to,
      }),
    );
  }

  // ── Notes: what was decided and what the format could not carry, once each ──
  notes.push(NOTE_BLOCK, NOTE_TEACHER, NOTE_SUBJECT);
  if (minuteLines > 0) {
    notes.push(
      `${minuteLines} rader i GPU001 anger tiden i minutform: Stunde är starttiden i minuter efter midnatt och Stundenlänge längden (hh:mm), så ingen tidsrastertabell behövs.`,
    );
  }
  if (periodLines > 0) {
    notes.push(`${periodLines} rader i GPU001 anger bara periodnummer; klockslagen kommer från det tidsraster som angavs, inte från filerna.`);
  }
  if (weekGroupRows > 0) {
    notes.push(
      `Fältet Grupp i ${weekGroupRows} rader i GPU002 tolkades som veckomönster (A/B-vecka, udda/jämn); om det i er Untis betyder något annat bör lektionerna kontrolleras.`,
    );
  }
  if (ignoredGroupTexts.length > 0) {
    notes.push(`Fältet Grupp i GPU002 tolkas bara när det är ett veckomönster; andra texter (till exempel ${ignoredGroupTexts.join(', ')}) ignoreras.`);
  }
  if (studentGroupRows > 0) {
    notes.push(
      `Schülergruppe (fält 42) i ${studentGroupRows} rader i GPU002 används som lektionens grupp i stället för klassen i fält 5, eftersom en elevgrupp är en del av en eller flera klasser.`,
    );
  }
  if (classLinesMerged) {
    notes.push('Rader i GPU001 som bara skilde sig åt i klass (samma lektionsnummer, tid, ämne, rum och lärare) slogs ihop till en lektion med flera klasser.');
  }
  if (webUntisFieldsSeen) {
    notes.push('WebUntis Zeit Von/Bis (fält 11-12) i GPU001 läses inte: formatet på dem är inte offentligt beskrivet, så tiderna kommer från Stunde och Stundenlänge.');
  }
  if (personnummerDropped > 0) {
    notes.push(
      `${personnummerDropped} fält i filerna liknade personnummer och har tagits bort utan att läsas; Rastra tar inte emot personnummer i en schemafil.`,
    );
  }
  return finish(lessons);
}
