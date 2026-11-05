/**
 * aSc Timetables XML, written and read (Schemat som tabell och i öppna format,
 * round 9 / S0). The writer turns an ExchangeDocument into the file aSc's
 * "File > Import > aSc Timetables XML" and the many programs that read aSc's
 * export expect; the reader turns such a file into ExchangeLessons.
 *
 * BUILT ONLY FROM PUBLIC DOCUMENTS (SOURCES below). aSc publishes no schema
 * file; what is public is a column sheet ("aSc Timetables API"), an older
 * edition of the same reference, a handful of help topics and a real export
 * that someone posted. Where those are silent or disagree the choice is made
 * in CHOICES, one place, with the reason, and the reader says so in `notes`
 * when a choice shaped what it returned. Nothing here is taken from a file or
 * a program that cannot be cited.
 *
 * SOURCES (all accessed 2026-11-05):
 *   [S1] "aSc Timetables - Integration with SIS systems", the integration guide
 *        aSc publishes as a Google Doc:
 *        https://docs.google.com/document/d/1zCYlTigQeo1YSz9poZVAj02-08MikJ9sJSZEMgvjicg/pub
 *        File exchange, "XML import/export", the `idprefix` option, and the
 *        link to [S2].
 *   [S2] "aSc Timetables API", the column reference [S1] links to (a public
 *        Google Sheet, read as its CSV export):
 *        https://docs.google.com/spreadsheets/d/1qd_3JZZLNf3uT6dFOJulj5TcAKTckQydd5qgBSR1wDE
 *        Every table, row element and column used below: teachers (email since
 *        2010), classes, classrooms, subjects, groups (entireclass, divisiontag),
 *        lessons (periodspercard deprecated, durationperiods, weeks, days,
 *        terms, daysdefid, weeksdefid, termsdefid), cards (lessonid, period,
 *        durationperiods, terms, weeks, days, day), periods, termsdefs,
 *        weeksdefs, daysdefs ("bitfield list").
 *   [S3] "aSc Timetables import/export datastructures", an older edition of
 *        [S2] (mirrored at https://pdfcoffee.com/download/asc-pdf-free.html):
 *        ID alphabet (0-9 a-z A-Z - _, "*" reserved), `_IDS` columns are
 *        comma lists, time as H:MM, "8-bit code page" file encoding, options
 *        groupstype1/2 and daynumbering0/1, row elements spelled `Class` and
 *        `Lesson`, and the rule that a double lesson is ONE card with
 *        durationperiods=2 if that column is exported and otherwise TWO cards
 *        in periods P and P+1.
 *   [S4] aSc help, "Export to XML" (topic 699):
 *        https://help.edupage.org/?p=u1%2Fu3%2Fu64%2Ft699&lang_id=1
 *        (formerly help.asctimetables.com/text.php?id=699). The default
 *        export is File > Export > "aSc Timetables 2012 XML", with random
 *        internal ids; configured exports use idprefix.
 *   [S5] aSc help, "Import from XML" (topic 690):
 *        https://help.edupage.org/?p=lang_id=1&p=u1/u3/u64/t690&lang_id=1
 *        The `columns` attribute lists a table's columns; `options` carries
 *        canadd etc.; import is File > Import > aSc Timetables XML into a
 *        new timetable.
 *   [S6] aSc help, "ID numbers in import/export" (topic 1052):
 *        https://help.edupage.org/?p=lang_id=1&p=u1/u3/u64/t1052&lang_id=1
 *        idprefix names the custom field an importer stores the sender's ids in.
 *   [S7] aSc help, "Multi term timetables" (topic 761):
 *        https://help.edupage.org/?p=lang_id=1&p=u1/u3/u55/u77/t761&lang_id=1
 *        A term is a numbered slot the school names; the topic mentions no
 *        dates. A lesson is set to one term, several (AND) or "any" (OR).
 *   [S8] aSc help, "How can I define weeks?" (topic 841) and "Two week
 *        timetable" (topic 225), same path /u55/u77/t841 and /t225. Odd and
 *        even weeks ("week A and week B") are two weeks; a lesson defaults to
 *        "All weeks" or can be "Any week". The help index also lists a topic
 *        titled "Our published timetable should start with Week B" (path
 *        /u343/u3227): only its title was read; it is why CHOICE 7 treats
 *        "first week = A = odd ISO week" as an assumption to be noted, not a fact.
 *   [S9] aSc help, "How to create a timetable for more than 5 days?" (topic
 *        211) and "We also teach on Saturdays" (topic 568), same path. The
 *        number of days is a school setting (6 adds Saturday; 10 is two
 *        weeks in one); the topics give no upper bound.
 *   [S10] aSc help, "How can I define Double/Triple etc lessons?" (topic 197,
 *        path /u55/u73/t197), "Count per week - format" (topic 431, path
 *        /u55/u78/t431) and "Extended count of lessons per week" (topic 831,
 *        path /u55/u77/t831). A longer lesson is a longer card over
 *        consecutive periods (at most 8) and by default does not span a
 *        break; a custom day group such as "Day A = Monday, Wednesday, Friday"
 *        puts a lesson at the same period on all of its days.
 *   [S11] aSc help, "How to rename the periods and specify bell times" (topic
 *        815, path /u55/u76/t815). A zero period can exist, so period numbers
 *        may start at 0 or 1.
 *   [S12] A real export posted publicly (an "aSc Timetables 2012 XML" file,
 *        ascttversion 2017.6.10, pastebin.com/xeku8Aug). Read for STRUCTURE
 *        only (no value in it is used or reproduced): the XML declaration
 *        says windows-1252; sections periods, daysdefs, weeksdefs, termsdefs,
 *        subjects, teachers, classrooms, grades, classes, groups, students,
 *        studentsubjects, lessons, cards, in that order, each with `options`
 *        and `columns`; times as H:MM; periods numbered from 1; days="10000"
 *        is Monday; weeks="1" and terms="1" on every card of a one-week,
 *        one-term school; a double lesson is two cards in consecutive periods
 *        with no marker; groups with entireclass="1" for the whole class.
 *   [S13] brainysmurf, "Timetabling-ASC-ManageBac" (a GitHub gist,
 *        https://gist.github.com/brainysmurf/8a5289de680a5272956e819ff1ebf794),
 *        a converter that reads aSc's export: teacherids, classids and groupids
 *        hold comma lists. Consulted for that and nothing else.
 *
 * WHAT THE LEAD GOT RIGHT AND WRONG (the brief listed the elements "as a lead,
 * not a spec"): every element and attribute named in it is in [S2]/[S12]. Three
 * things differ: a double lesson is two cards, not one card with periodspercard
 * (CHOICE 10); `periodspercard` is deprecated in favour of `durationperiods`
 * (CHOICE 10); and `terms`/`weeks`/`days` on a card are bit strings the card
 * carries itself, with the *defs tables* only naming them (CHOICES 6-8).
 *
 * CHOICES. A numbered list, because the spec file has a test for each number.
 *
 *  1. THE ENVELOPE. [S12] shows `<timetable ascttversion importtype options>`,
 *     each section `options="canadd,export:silent" columns="..."`, and [S5]
 *     says `columns` lists a table's columns. The writer reproduces that: root
 *     ascttversion="2012.9.1" (the oldest version [S2] names, the least likely
 *     to be refused by a newer aSc), importtype="database" (the value [S12]
 *     has; no public document says what the other values do), options
 *     "idprefix:Rastra,groupstype1,decimalseparatordot" (idprefix per [S1], so
 *     our ids land in a custom field "Rastra ID"; groupstype1 so a group
 *     belongs to one class as [S12] has it; the dot because periodsperweek is
 *     a number), and every row carries every column named in `columns`, empty
 *     as "" where it has nothing, as [S12] does. A first-line XML comment names
 *     school and year, the only home those two have. What aSc does with
 *     ascttversion and importtype is not public; this is the most
 *     conventional file, and the one risk is that a very old version label
 *     makes aSc apply old conversions (those are designed to work).
 *
 *  2. ENCODING. [S3] says "8-bit code page" and [S12] declares windows-1252,
 *     so aSc itself writes a code page. No public document says whether its
 *     import honours another declaration. The writer returns a JS string whose
 *     declaration says UTF-8 (the caller writes UTF-8 bytes, no BOM): every
 *     XML parser must honour a declaration, å ä ö are two bytes in UTF-8 and
 *     one in windows-1252 so the declaration has to be true, and a code page
 *     cannot hold a name from outside its own range.
 *     decodeAscBytes honours a BOM first (UTF-8, UTF-16 LE/BE), then the
 *     declaration's encoding (anything Node's TextDecoder knows, which covers
 *     every windows-125x), then, with no declaration, strict UTF-8 and, if
 *     the bytes are not valid UTF-8, windows-1252 as [S3] implies. A declared
 *     encoding Node does not know falls back to lenient UTF-8.
 *
 *  3. TOLERANCE. [S3] spells two row elements `Class` and `Lesson`, [S2]/[S12]
 *     `class` and `lesson`: element names are matched without regard to case.
 *     Every section is optional, extra attributes and elements are ignored,
 *     ids are any string (the alphabet in [S3] is advice to senders, not
 *     something a reader should enforce), and two sections of one name merge.
 *
 *  4. THE PERIOD GRID. The writer makes one <period> of every distinct
 *     (start, end) pair in the document, ordered by start then end, numbered
 *     from 1 ([S12]). A lesson is one card at its slot's period and is never
 *     split. Consequence, stated plainly: slots that overlap (08:10-09:10 and
 *     08:10-09:40) are two periods that overlap. No public document says
 *     whether aSc accepts overlapping periods on import ([S11] is silent), and
 *     in its grid they would be two rows; a school that wants a clean bell
 *     schedule sets it in aSc, and if aSc refuses the file for this reason
 *     the fix is a bell schedule in the document, not a change here. The reader looks
 *     a card's `period` up in the <periods> table BY NUMBER, never by position,
 *     because [S11] says the first number can be 0 or 1. A period listed twice
 *     with different times is ambiguous: every card in it is a problem.
 *
 *  5. TIMES. [S3]/[S12] write H:MM without a leading zero ("8:30"). The writer
 *     does the same; the reader takes "8:30" and "08:30". A time it cannot
 *     read, or an end not after the start, makes the period unusable and every
 *     card in it a problem (never a guessed time).
 *
 *  6. DAYS. A card's `days` is a bit string, Monday first ([S12]: "10000" is
 *     Monday, "Lunes"). Its width is the school's number of days ([S9]): the
 *     writer uses max(5, the highest ISO day used), so 5, 6 or 7. The writer
 *     lists one <daysdef> per day plus "Valfri dag", a LIST of one-hot strings
 *     ("10000,01000,..."), which [S2] calls a bitfield list and [S12] shows;
 *     read as aSc's OR (several 1s in ONE string are AND: "the lesson sits at
 *     the same period on all of those days", [S10] topic 831). That reading
 *     of list-versus-string is an inference from [S2], [S10] and [S12]; no
 *     public page states it. A lesson's daysdefid is "Valfri dag", because its
 *     cards are the days, and the same holds for weeksdefid and termsdefid.
 *     The reader: several 1s in one card's string are one lesson per day (that
 *     is what aSc means); no 1, a non-0/1 character, a list, or a 1 beyond the
 *     seventh position (a ten-day cycle has no ISO weekday) is a problem for
 *     that card. A card with only a numeric `day` (an old or configured
 *     export) is read with 0 = Monday unless the root options say
 *     daynumbering1 ([S3]), and a note says which was assumed. "Position 1 =
 *     Monday" is also an assumption (aSc lets a school start the week on
 *     another day, [S9]); the reader checks it against day names it can
 *     recognise (Swedish, English) and notes a disagreement.
 *
 *  7. WEEKS. A card's `weeks` is a bit string over a rotation: "1" a one-week
 *     school, "10" the first week of two, "01" the second, "11" both ([S2],
 *     [S3]). NOT ISO week numbers: week 1 is whichever week the school's
 *     rotation starts with ([S8] has topics on starting the published
 *     timetable with week B). The writer writes "11"/"10"/"01" (ALL/ODD/EVEN)
 *     only when some lesson alternates, "1" otherwise, with the matching
 *     <weeksdef> rows. The reader reads the first position as A = ODD ISO
 *     weeks (exchange-model.ts weekLetter) and the second as B = EVEN, and
 *     says so in a note on every import with a weeksdef that has a 0 in it or
 *     a lesson that alternates. A longer rotation is read only when it is
 *     two-periodic ("1010" is ODD, "0101" EVEN, all ones is ALL); "1100" or a
 *     three-week rotation has no WeekPattern, so its cards are problems.
 *
 *  8. TERMS AND DATES. aSc terms are numbered slots with names and NO dates
 *     ([S7]); the model's from/to are dates. The writer makes every distinct
 *     (from, to) a term whose NAME is the span, "2026-08-17–2026-12-18" (an en
 *     dash; "2026-08-17–" and "–2027-01-08" for a one-sided span), plus
 *     "Hela läsåret" (all bits). Lessons without dates carry all ones, a
 *     dated lesson a single 1. With exactly one distinct span the cycle gets a
 *     second term, "Resten av läsåret", because one bit would be both "this
 *     span" and "all year". Other aSc programs see ordinary named terms. The
 *     reader finds the termsdef whose `terms` equals the card's string, and if
 *     its name parses as a date span (en dash, em dash or hyphen, two ISO
 *     dates, the first not after the second) returns from/to. All ones is the
 *     whole year, silently. Anything else (a name like "Term 1", no matching
 *     def) is read as the whole year WITH a note naming the term: it never
 *     becomes a date.
 *
 *  9. LESSONS AND CARDS. aSc separates what is taught (<lesson>: subject,
 *     classes, groups, teachers, rooms, periodsperweek) from where it sits
 *     (<card>: period, days, weeks, terms, room). The writer merges
 *     ExchangeLessons with the same attendees, subject, teachers, weeks and
 *     term into one <lesson> with one <card> each, periodsperweek the number
 *     of cards, periodspercard 1; rooms are on the cards, and the lesson
 *     lists the distinct ones. The reader makes one ExchangeLesson per
 *     card (a lesson with periodsperweek 3 is three), ignores periodsperweek
 *     (the cards are the truth), prefers what a card says to what its lesson
 *     says (lesson weeks/terms and the defs are fallbacks), and counts
 *     lessons that have no card at all ("not placed") in one note.
 *
 * 10. DOUBLE LESSONS. [S3] and [S12]: without durationperiods on the cards a
 *     double lesson is TWO cards in periods P and P+1 and the lesson has
 *     periodspercard=2 (or durationperiods=2, which [S2] makes the lesson's
 *     current column and periodspercard the deprecated one); with
 *     durationperiods=2 on the card it is one card. The reader
 *     reads both as ONE lesson, from the first period's start to the last
 *     period's end (a break between them is inside the lesson, as [S10]
 *     allows). Cards of a lesson with periodspercard k > 1 are grouped by
 *     identical days/weeks/terms/rooms, put in period order, cut into runs of
 *     consecutive periods and the runs into blocks of k from the lowest; a
 *     short block is a problem for its cards (the length cannot be known). A
 *     card's own durationperiods wins over the lesson's. The WRITER never
 *     writes a double lesson: a model lesson is one slot, and a slot longer
 *     than the others is just another period (CHOICE 4).
 *
 * 11. WHICH ATTENDEE IS THE LESSON'S OWN GROUP. aSc has no "own group": a
 *     lesson has classids and groupids. The writer lists the model's group
 *     first, then extraGroups, in classids/groupids in that order; the reader
 *     takes the attendees in the same order and the FIRST is `group`, the rest
 *     `extraGroups`. Attendees are, for each class in classids in order: the
 *     class name if no group of it is selected, otherwise the selected groups
 *     of it in groupids order (an entireclass="1" group is the class's own
 *     name); a selected group in none of the listed classes is appended; a
 *     group that belongs to several classes (groupstype2) is listed once.
 *     The order of extraGroups is kept except that groups of one class are
 *     kept together. This is only a convention: a foreign file with
 *     classids=[7A,7B] is read as 7A with extraGroups [7B].
 *
 * 12. CLASSES AND GROUPS WRITTEN. A CLASS is a <class> with an entire-class
 *     <group> ("Hela klassen", entireclass="1", divisiontag="0"), as [S12]
 *     has for every class; an entire-class lesson refers to it. A TEACHING_GROUP
 *     whose halfOf names a CLASS is a <group> of that class (entireclass="0",
 *     divisiontag="1": all halves of a class go in one division, a hint
 *     [S2] marks import-only; a class with two unrelated divisions has to be
 *     adjusted in aSc). A TEACHING_GROUP with no class (Sp7, Ty7, Fr7) has no
 *     class to belong to in groupstype1, and which classes its pupils come
 *     from is not in the model, so it is written as a <class> of its own: the
 *     alternative is inventing a membership. gradeLevel has no home (the
 *     `grade` column is marked "upcoming" in [S2]) and is not written.
 *
 * 13. GROUP NAMES ON READ. aSc names a division's groups "Group 1", "Group 2"
 *     in every class. A non-entire group whose name occurs more than once in
 *     the file is read as "<class name> <group name>" ("7A Group 1") and one
 *     note says so; a unique name is read as it is (all of Rastra's are).
 *
 * 14. SUBJECTS. aSc has name and short. The writer writes name and
 *     short = subjectCode, or the name when there is no code (no code is
 *     invented; [S12]'s own rows have short = name). The reader returns name
 *     as `subject` and the short as `subjectCode` unless it equals the name.
 *
 * 15. TEACHERS. id, name, short, email ([S2]: email since 2010) are written;
 *     the lead teacher is first in teacherids; short is the key everything is
 *     matched by. The reader returns TeacherRef {short, name (or first +
 *     last), email, id: null}. aSc allows any number of teachers on a lesson
 *     and the model two: the first two are kept and a note counts the lessons
 *     that lost one.
 *
 * 16. ROOMS. A card's `classroomids` is the room it sits in; the lesson's is
 *     the rooms it MAY use ([S3]). The reader takes the card's first id; a
 *     card with several is read with the first and counted in a note; a card
 *     without the attribute takes the lesson's room if it lists exactly one
 *     and otherwise none (counted in a note). `short` of a room is its name.
 *
 * 17. WHAT THE FORMAT CANNOT CARRY. The parallel block (no column in [S2];
 *     the `seminargroup`/`seminartag` columns have no public meaning to build
 *     on), the school's name and the year as data, a group's gradeLevel and
 *     kind, and a teacher's ids. The writer still writes a valid file; the
 *     reader returns block null and says so in a note whenever it read a
 *     lesson, because the file cannot tell it whether a block was lost.
 *
 * 18. NEVER GUESS. A card with no lesson, a lesson with no subject, no
 *     group or a reference to an id that is not in the file, a card with no
 *     period or a period not in <periods>, a day, week or term string the
 *     model cannot hold: a ReadProblem on the card ("kort 4") or lesson
 *     ("lektion 17") with a stable code, the rest of the file read. The
 *     numbers count elements in the file, from 1.
 *
 * 19. NO PERSONNUMMER. No field of the format is one. An attribute or element
 *     named like one (personnummer, personnr, pnr, ssn, civic number,
 *     samordningsnummer, national id) with a value is never read and never
 *     copied; one note names the attribute (not the value).
 *
 * 20. LIMITS. A source over MAX_EXCHANGE_BYTES, or more lessons than
 *     MAX_EXCHANGE_LESSONS, is refused whole with one problem; invalid XML
 *     (xml.ts: DOCTYPE, ENTITY, unclosed tags, depth, size) is one problem,
 *     ASC_XML_INVALID; a root that is not <timetable> is ASC_NOT_TIMETABLE.
 *
 * THE ONE THING THIS FILE CANNOT VERIFY: that aSc's own import accepts the
 * cards. [S3] says of the cards table "mostly export only; limited import".
 * The file is written to the column sheet and to a real export, and should be
 * tried on a licensed aSc before a school is told it places lessons.
 */

import {
  MAX_EXCHANGE_BYTES,
  MAX_EXCHANGE_LESSONS,
  blankLesson,
  clockOfMinutes,
  minutesOfClock,
  type ExchangeDocument,
  type ExchangeLesson,
  type ParsedExchange,
  type ReadProblem,
  type TeacherRef,
  type WeekPattern,
} from './exchange-model';
import { XmlError, element, parseXml, type XmlNode } from './xml';

// ---------------------------------------------------------------------------
// Constants of the writer (CHOICE 1, 6, 8, 12)
// ---------------------------------------------------------------------------

const ASC_VERSION = '2012.9.1';
const ASC_IMPORT_TYPE = 'database';
const ROOT_OPTIONS = 'idprefix:Rastra,groupstype1,decimalseparatordot';
const SECTION_OPTIONS = 'canadd,export:silent';
const WHOLE_YEAR_NAME = 'Hela läsåret';
const REST_OF_YEAR_NAME = 'Resten av läsåret';
const ENTIRE_CLASS_NAME = 'Hela klassen';
const ANY_DAY_NAME = 'Valfri dag';
const DAY_NAMES: ReadonlyArray<readonly [string, string]> = [
  ['Måndag', 'Mån'],
  ['Tisdag', 'Tis'],
  ['Onsdag', 'Ons'],
  ['Torsdag', 'Tor'],
  ['Fredag', 'Fre'],
  ['Lördag', 'Lör'],
  ['Söndag', 'Sön'],
];

const COLUMNS = {
  periods: ['period', 'name', 'short', 'starttime', 'endtime'],
  daysdefs: ['id', 'name', 'short', 'days'],
  weeksdefs: ['id', 'name', 'short', 'weeks'],
  termsdefs: ['id', 'name', 'short', 'terms'],
  subjects: ['id', 'name', 'short'],
  classrooms: ['id', 'name', 'short'],
  teachers: ['id', 'name', 'short', 'email'],
  classes: ['id', 'name', 'short'],
  groups: ['id', 'classid', 'name', 'entireclass', 'divisiontag'],
  lessons: [
    'id',
    'subjectid',
    'classids',
    'groupids',
    'teacherids',
    'classroomids',
    'periodspercard',
    'periodsperweek',
    'daysdefid',
    'weeksdefid',
    'termsdefid',
  ],
  cards: ['lessonid', 'classroomids', 'period', 'weeks', 'terms', 'days'],
} as const;

// ---------------------------------------------------------------------------
// Small helpers shared by both directions
// ---------------------------------------------------------------------------

/** 510 minutes to "8:30": aSc writes H:MM without a leading zero (CHOICE 5). */
function ascClock(minutes: number): string {
  return `${Math.floor(minutes / 60)}:${String(minutes % 60).padStart(2, '0')}`;
}

/** A bit string of `width` zeros with a single 1 at `index`. */
function oneHot(index: number, width: number): string {
  return '0'.repeat(index) + '1' + '0'.repeat(width - index - 1);
}

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** A real calendar date in YYYY-MM-DD. */
function isIsoDate(value: string): boolean {
  const m = ISO_DATE.exec(value);
  if (!m) return false;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  const date = new Date(Date.UTC(y, mo - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === mo - 1 && date.getUTCDate() === d;
}

/** The name a term carries when it stands for dates (CHOICE 8). */
function spanName(from: string | null, to: string | null): string {
  return `${from ?? ''}–${to ?? ''}`;
}

/** The inverse of spanName, tolerant of the dash (en, em, hyphen) and of spaces; null when the text is not a span. */
function parseSpan(text: string): { from: string | null; to: string | null } | null {
  const m = /^\s*(\d{4}-\d{2}-\d{2})?\s*[–—-]\s*(\d{4}-\d{2}-\d{2})?\s*$/.exec(text);
  if (!m) return null;
  const from = m[1] ?? null;
  const to = m[2] ?? null;
  if (from === null && to === null) return null;
  if ((from !== null && !isIsoDate(from)) || (to !== null && !isIsoDate(to))) return null;
  if (from !== null && to !== null && from > to) return null;
  return { from, to };
}

function sequence(prefix: string): () => string {
  let n = 0;
  return () => {
    n += 1;
    return `${prefix}${n}`;
  };
}

function pushUnique<T>(list: T[], value: T): void {
  if (!list.includes(value)) list.push(value);
}

function unique<T>(values: readonly T[]): T[] {
  return [...new Set(values)];
}

// ---------------------------------------------------------------------------
// The writer
// ---------------------------------------------------------------------------

interface SubjectRow {
  id: string;
  name: string;
  short: string;
}
interface TeacherRow {
  id: string;
  name: string;
  short: string;
  email: string;
}
interface ClassRow {
  id: string;
  name: string;
  entireGroupId: string;
}
interface HalfRow {
  id: string;
  classId: string;
  className: string;
  name: string;
}
interface AscCard {
  roomId: string;
  period: number;
  weeks: string;
  terms: string;
  days: string;
}
interface AscLesson {
  id: string;
  subjectId: string;
  classIds: string[];
  groupIds: string[];
  teacherIds: string[];
  roomIds: string[];
  weeks: string;
  terms: string;
  cards: AscCard[];
}

function teacherKey(t: TeacherRef): string {
  const key = (t.short ?? '').trim() || (t.email ?? '').trim().toLowerCase() || (t.name ?? '').trim();
  if (key === '') throw new RangeError('En lärare saknar både signatur, e-postadress och namn och går inte att skriva.');
  return key;
}

/** The signature a teacher is written with: theirs, or (the service makes one up in practice) initials, or the key. */
function teacherShort(t: TeacherRef, key: string): string {
  const own = (t.short ?? '').trim();
  if (own !== '') return own;
  const initials = (t.name ?? '')
    .split(/\s+/)
    .filter((part) => part !== '')
    .map((part) => part.charAt(0).toUpperCase())
    .join('');
  return initials !== '' ? initials : key;
}

/**
 * Writes the document as one aSc Timetables XML string. Pure and
 * deterministic: ids are assigned in order of first use (the document's lists
 * first), lessons and cards keep the document's order, there is no clock.
 * Throws RangeError for a document that no codec could write (a day outside
 * 1-7, a time that is not HH:MM or an end not after the start, a date that is
 * not YYYY-MM-DD, a teacher with nothing to identify them): that is a caller
 * bug, never file content.
 */
export function writeAscXml(doc: ExchangeDocument): string {
  // ---- 1. The lessons, checked --------------------------------------------
  const items = doc.lessons.map((lesson, index) => {
    const start = minutesOfClock(lesson.start);
    const end = minutesOfClock(lesson.end);
    if (start === null || end === null || end <= start) {
      throw new RangeError(`Lektion ${index + 1}: tiden ${lesson.start}–${lesson.end} är ingen tid på dagen.`);
    }
    if (!Number.isInteger(lesson.day) || lesson.day < 1 || lesson.day > 7) {
      throw new RangeError(`Lektion ${index + 1}: veckodagen ${String(lesson.day)} är inte 1–7.`);
    }
    for (const date of [lesson.from, lesson.to]) {
      if (date !== null && !isIsoDate(date)) throw new RangeError(`Lektion ${index + 1}: datumet ${date} är inte ÅÅÅÅ-MM-DD.`);
    }
    return { lesson, start, end };
  });

  // ---- 2. The period grid (CHOICE 4) --------------------------------------
  const slotByKey = new Map<string, { start: number; end: number }>();
  for (const { start, end } of items) slotByKey.set(`${start}-${end}`, { start, end });
  const slots = [...slotByKey.values()].sort((a, b) => a.start - b.start || a.end - b.end);
  const periodOfSlot = new Map<string, number>(slots.map((slot, i): [string, number] => [`${slot.start}-${slot.end}`, i + 1]));

  // ---- 3. Days, weeks, terms (CHOICES 6-8) --------------------------------
  const dayWidth = Math.max(5, ...items.map(({ lesson }) => lesson.day));
  const alternates = items.some(({ lesson }) => lesson.weeks !== 'ALL');
  const weekBits: Record<WeekPattern, string> = alternates ? { ALL: '11', ODD: '10', EVEN: '01' } : { ALL: '1', ODD: '1', EVEN: '1' };
  const spanKeys = new Map<string, { from: string | null; to: string | null }>();
  for (const { lesson } of items) {
    if (lesson.from !== null || lesson.to !== null) spanKeys.set(`${lesson.from ?? ''}|${lesson.to ?? ''}`, { from: lesson.from, to: lesson.to });
  }
  const spans = [...spanKeys.values()].sort((a, b) => (a.from ?? '').localeCompare(b.from ?? '') || (a.to ?? '').localeCompare(b.to ?? ''));
  const termWidth = spans.length === 0 ? 1 : Math.max(2, spans.length);
  const allTerms = '1'.repeat(termWidth);
  const termBitsOf = (from: string | null, to: string | null): string => {
    if (from === null && to === null) return allTerms;
    const at = spans.findIndex((s) => s.from === from && s.to === to);
    return oneHot(at, termWidth);
  };

  // ---- 4. Names the lessons use ------------------------------------------
  const subjects = new Map<string, SubjectRow>();
  const nextSubject = sequence('S');
  const subjectFor = (name: string, code: string | null): SubjectRow => {
    let row = subjects.get(name);
    const short = (code ?? '').trim();
    if (!row) {
      row = { id: nextSubject(), name, short: short !== '' ? short : name };
      subjects.set(name, row);
    } else if (row.short === row.name && short !== '') {
      row.short = short;
    }
    return row;
  };
  for (const s of doc.subjects) subjectFor(s.name, s.code);

  const rooms = new Map<string, string>();
  const nextRoom = sequence('R');
  const roomFor = (name: string): string => {
    let id = rooms.get(name);
    if (id === undefined) {
      id = nextRoom();
      rooms.set(name, id);
    }
    return id;
  };
  for (const r of doc.rooms) roomFor(r);

  const teachers = new Map<string, TeacherRow>();
  const nextTeacher = sequence('T');
  const teacherFor = (t: TeacherRef): TeacherRow => {
    const key = teacherKey(t);
    let row = teachers.get(key);
    if (!row) {
      const short = teacherShort(t, key);
      row = { id: nextTeacher(), name: (t.name ?? '').trim() || short, short, email: (t.email ?? '').trim() };
      teachers.set(key, row);
    } else if (row.email === '' && (t.email ?? '').trim() !== '') {
      row.email = (t.email ?? '').trim();
    }
    return row;
  };
  for (const t of doc.teachers) teacherFor(t);
  for (const { lesson } of items) for (const t of lesson.teachers) teacherFor(t);

  // ---- 5. Classes and groups (CHOICE 12) ----------------------------------
  // A name is a class, or a half of a class that is a class in this document,
  // or (a teaching group with no class, or a name only a lesson mentions) a
  // class of its own. Ids: classes in order of appearance; then, class by
  // class, its entire-class group and its halves.
  const classNames = new Set(doc.groups.filter((g) => g.kind === 'CLASS').map((g) => g.name));
  const classOrder: string[] = [];
  const halfParent = new Map<string, string>();
  for (const g of doc.groups) {
    if (classOrder.includes(g.name) || halfParent.has(g.name)) continue;
    if (g.kind === 'TEACHING_GROUP' && g.halfOf !== null && classNames.has(g.halfOf)) halfParent.set(g.name, g.halfOf);
    else classOrder.push(g.name);
  }
  for (const { lesson } of items) {
    for (const name of [lesson.group, ...lesson.extraGroups]) {
      if (!classOrder.includes(name) && !halfParent.has(name)) classOrder.push(name);
    }
  }
  const nextClass = sequence('C');
  const nextGroup = sequence('G');
  const classByName = new Map<string, ClassRow>();
  const halfByName = new Map<string, HalfRow>();
  for (const name of classOrder) classByName.set(name, { id: nextClass(), name, entireGroupId: '' });
  for (const name of classOrder) {
    const cls = classByName.get(name)!;
    cls.entireGroupId = nextGroup();
    for (const [half, parent] of halfParent) {
      if (parent === name) halfByName.set(half, { id: nextGroup(), classId: cls.id, className: name, name: half });
    }
  }

  // ---- 6. Lessons and cards (CHOICE 9) ------------------------------------
  const ascLessons = new Map<string, AscLesson>();
  const nextLesson = sequence('L');
  for (const { lesson, start, end } of items) {
    const classIds: string[] = [];
    const groupIds: string[] = [];
    for (const name of unique([lesson.group, ...lesson.extraGroups])) {
      const half = halfByName.get(name);
      if (half) {
        pushUnique(classIds, half.classId);
        groupIds.push(half.id);
      } else {
        const cls = classByName.get(name)!;
        pushUnique(classIds, cls.id);
        groupIds.push(cls.entireGroupId);
      }
    }
    const subject = subjectFor(lesson.subject, lesson.subjectCode);
    const teacherIds = unique(lesson.teachers.map((t) => teacherFor(t).id));
    const weeks = weekBits[lesson.weeks];
    const terms = termBitsOf(lesson.from, lesson.to);
    const key = JSON.stringify([classIds, groupIds, subject.id, teacherIds, weeks, terms]);
    let asc = ascLessons.get(key);
    if (!asc) {
      asc = { id: nextLesson(), subjectId: subject.id, classIds, groupIds, teacherIds, roomIds: [], weeks, terms, cards: [] };
      ascLessons.set(key, asc);
    }
    const roomId = lesson.room !== null && lesson.room.trim() !== '' ? roomFor(lesson.room) : '';
    if (roomId !== '') pushUnique(asc.roomIds, roomId);
    asc.cards.push({
      roomId,
      period: periodOfSlot.get(`${start}-${end}`)!,
      weeks,
      terms,
      days: oneHot(lesson.day - 1, dayWidth),
    });
  }

  // ---- 7. The defs the lessons point at -----------------------------------
  const daysdefs: string[][] = DAY_NAMES.slice(0, dayWidth).map(([name, short], i) => [`D${i + 1}`, name, short, oneHot(i, dayWidth)]);
  const anyDayId = `D${dayWidth + 1}`;
  daysdefs.push([anyDayId, ANY_DAY_NAME, 'Valfri', Array.from({ length: dayWidth }, (_, i) => oneHot(i, dayWidth)).join(',')]);

  const weeksdefs: string[][] = [['W1', 'Varje vecka', 'Alla', weekBits.ALL]];
  const weeksDefOf = new Map<string, string>([[weekBits.ALL, 'W1']]);
  if (alternates) {
    weeksdefs.push(['W2', 'A-vecka', 'A', weekBits.ODD], ['W3', 'B-vecka', 'B', weekBits.EVEN]);
    weeksDefOf.set(weekBits.ODD, 'W2');
    weeksDefOf.set(weekBits.EVEN, 'W3');
  }

  const termsdefs: string[][] = [['M1', WHOLE_YEAR_NAME, 'Hela', allTerms]];
  const termsDefOf = new Map<string, string>([[allTerms, 'M1']]);
  spans.forEach((span, i) => {
    const bits = oneHot(i, termWidth);
    termsdefs.push([`M${i + 2}`, spanName(span.from, span.to), `P${i + 1}`, bits]);
    termsDefOf.set(bits, `M${i + 2}`);
  });
  if (spans.length === 1) termsdefs.push([`M${spans.length + 2}`, REST_OF_YEAR_NAME, 'Rest', oneHot(1, termWidth)]);

  // ---- 8. The text --------------------------------------------------------
  const I1 = '  ';
  const I2 = '    ';
  const row = (tag: string, columns: readonly string[], values: Record<string, string | number>): string =>
    element(tag, Object.fromEntries(columns.map((c): [string, string | number] => [c, values[c] ?? ''])), null, I2);
  const section = (name: keyof typeof COLUMNS, rows: string[]): string =>
    element(name, { options: SECTION_OPTIONS, columns: COLUMNS[name].join(',') }, rows, I1);
  const named = (columns: readonly string[], values: string[]): Record<string, string> =>
    Object.fromEntries(columns.map((c, i): [string, string] => [c, values[i] ?? '']));

  const ascLessonList = [...ascLessons.values()];
  const sections = [
    section(
      'periods',
      slots.map((slot, i) =>
        row('period', COLUMNS.periods, { period: i + 1, name: String(i + 1), short: String(i + 1), starttime: ascClock(slot.start), endtime: ascClock(slot.end) }),
      ),
    ),
    section('daysdefs', daysdefs.map((d) => row('daysdef', COLUMNS.daysdefs, named(COLUMNS.daysdefs, d)))),
    section('weeksdefs', weeksdefs.map((d) => row('weeksdef', COLUMNS.weeksdefs, named(COLUMNS.weeksdefs, d)))),
    section('termsdefs', termsdefs.map((d) => row('termsdef', COLUMNS.termsdefs, named(COLUMNS.termsdefs, d)))),
    section(
      'subjects',
      [...subjects.values()].map((s) => row('subject', COLUMNS.subjects, { id: s.id, name: s.name, short: s.short })),
    ),
    section(
      'classrooms',
      [...rooms].map(([name, id]) => row('classroom', COLUMNS.classrooms, { id, name, short: name })),
    ),
    section(
      'teachers',
      [...teachers.values()].map((t) => row('teacher', COLUMNS.teachers, { id: t.id, name: t.name, short: t.short, email: t.email })),
    ),
    section(
      'classes',
      [...classByName.values()].map((c) => row('class', COLUMNS.classes, { id: c.id, name: c.name, short: c.name })),
    ),
    section(
      'groups',
      [...classByName.values()].flatMap((c) => [
        row('group', COLUMNS.groups, { id: c.entireGroupId, classid: c.id, name: ENTIRE_CLASS_NAME, entireclass: '1', divisiontag: '0' }),
        ...[...halfByName.values()]
          .filter((h) => h.classId === c.id)
          .map((h) => row('group', COLUMNS.groups, { id: h.id, classid: h.classId, name: h.name, entireclass: '0', divisiontag: '1' })),
      ]),
    ),
    section(
      'lessons',
      ascLessonList.map((l) =>
        row('lesson', COLUMNS.lessons, {
          id: l.id,
          subjectid: l.subjectId,
          classids: l.classIds.join(','),
          groupids: l.groupIds.join(','),
          teacherids: l.teacherIds.join(','),
          classroomids: l.roomIds.join(','),
          periodspercard: 1,
          periodsperweek: l.cards.length,
          daysdefid: anyDayId,
          weeksdefid: weeksDefOf.get(l.weeks)!,
          termsdefid: termsDefOf.get(l.terms)!,
        }),
      ),
    ),
    section(
      'cards',
      ascLessonList.flatMap((l) =>
        l.cards.map((c) => row('card', COLUMNS.cards, { lessonid: l.id, classroomids: c.roomId, period: c.period, weeks: c.weeks, terms: c.terms, days: c.days })),
      ),
    ),
  ];

  const root = element('timetable', { ascttversion: ASC_VERSION, importtype: ASC_IMPORT_TYPE, options: ROOT_OPTIONS }, sections, '');
  const label = `Rastra: ${doc.school}, läsår ${doc.year.name}`
    .replace(/[\u0000-\u001f]/g, ' ')
    .replace(/-{2,}/g, '-')
    .replace(/-$/, '');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<!-- ${label} -->\n${root}\n`;
}

// ---------------------------------------------------------------------------
// Bytes to text (CHOICE 2)
// ---------------------------------------------------------------------------

/**
 * The text of an aSc file's bytes. A byte order mark decides first, then the
 * XML declaration's encoding, then (no declaration) UTF-8 if the bytes are
 * valid UTF-8 and windows-1252 if not. A declared encoding Node does not know
 * is read as lenient UTF-8; the reader then reports whatever is garbled.
 */
export function decodeAscBytes(buf: Buffer): string {
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) return new TextDecoder('utf-8').decode(buf);
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) return new TextDecoder('utf-16le').decode(buf);
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) return new TextDecoder('utf-16be').decode(buf);
  const head = buf.subarray(0, 256).toString('latin1');
  const declared = /^\s*<\?xml[^>]*?\sencoding\s*=\s*["']([A-Za-z0-9._:-]+)["']/.exec(head)?.[1];
  if (declared !== undefined) {
    try {
      return new TextDecoder(declared.toLowerCase()).decode(buf);
    } catch {
      return new TextDecoder('utf-8').decode(buf);
    }
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buf);
  } catch {
    return new TextDecoder('windows-1252').decode(buf);
  }
}

// ---------------------------------------------------------------------------
// The reader
// ---------------------------------------------------------------------------

const NOTE_WEEKS =
  'Veckorna i aSc är lägen i en rotation, inte veckonummer. Första veckan (till exempel "10") läses som A-vecka, alltså udda ISO-veckor, och andra veckan som B-vecka, alltså jämna. Börjar skolans rotation med en jämn vecka byter A och B plats efter importen.';
const NOTE_BLOCK =
  'aSc XML har ingen plats för parallella block (till exempel språkval): blocknamnen läses som tomma och får läggas in i Rastra efter importen.';
const NOTE_QUALIFIED_GROUPS =
  'Grupper med samma namn i flera klasser har fått klassens namn framför (till exempel "7A Grupp 1") så att de går att skilja åt.';
const NOTE_NUMERIC_DAY_ZERO =
  'Kort som anger dagen med ett tal läses med 0 som måndag, eftersom filen inte sätter daynumbering1 (aSc:s standard).';
const NOTE_NO_CARDS = 'Filen innehåller inga placerade kort, så det finns inget schema att läsa.';

const PERSONNUMMER_LIKE = /personnummer|personnr|pnr|ssn|civic|national[-_ ]?id|samordningsnummer|personal[-_ ]?(?:id|number)/i;

const WEEKDAY_PREFIXES: ReadonlyArray<RegExp> = [/^(mån|mon)/i, /^(tis|tue)/i, /^(ons|wed)/i, /^(tor|thu)/i, /^(fre|fri)/i, /^(lör|sat)/i, /^(sön|sun)/i];

interface PeriodEntry {
  ok: boolean;
  why: 'time' | 'ambiguous' | null;
  start: number;
  end: number;
}
interface Def {
  name: string;
  short: string | null;
  fields: string[];
}
interface GroupInfo {
  id: string;
  name: string;
  classIds: string[];
  entire: boolean;
  qualified: boolean;
}
interface LessonInfo {
  ordinal: number;
  node: XmlNode;
}
interface Issue {
  code: string;
  text: string;
}
interface ResolvedLesson {
  attendees: string[];
  subject: string;
  subjectCode: string | null;
  teachers: TeacherRef[];
  rooms: string[];
  perCard: number;
}
interface CardRow {
  ordinal: number;
  node: XmlNode;
  period: number;
}
interface Placement {
  rows: CardRow[];
  length: number;
}

/** Elements by name without regard to case, across sections of the same name (CHOICE 3). */
function rowsOf(root: XmlNode, table: string, rowName: string): XmlNode[] {
  const out: XmlNode[] = [];
  for (const section of root.children) {
    if (section.name.toLowerCase() !== table) continue;
    for (const child of section.children) if (child.name.toLowerCase() === rowName) out.push(child);
  }
  return out;
}

/** A trimmed attribute, or null when it is absent or empty. */
function attr(node: XmlNode, name: string): string | null {
  const value = node.attrs[name];
  if (value === undefined) return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

function splitIds(value: string | undefined): string[] {
  if (value === undefined) return [];
  return value
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part !== '');
}

/** The ids of a plural column and its singular twin together (the sheet has both for most links). */
function idsOf(node: XmlNode, plural: string, singular: string): string[] {
  return unique([...splitIds(node.attrs[plural]), ...splitIds(node.attrs[singular])]);
}

function wholeNumber(value: string | null): number | null {
  return value !== null && /^\d+(?:[.,]0+)?$/.test(value) ? Math.trunc(Number(value.replace(',', '.'))) : null;
}

function plural(n: number, one: string, many: string): string {
  return n === 1 ? one : many;
}

/** The week pattern a bit string over a rotation means, or null when the model has none (CHOICE 7). */
function weekPatternOfBits(bits: string): WeekPattern | null {
  if (!/^[01]+$/.test(bits) || !bits.includes('1')) return null;
  if (!bits.includes('0')) return 'ALL';
  if (bits.length % 2 !== 0) return null;
  const everyOther = (parity: number): boolean => [...bits].every((bit, i) => (i % 2 === parity ? bit === '1' : bit === '0'));
  if (everyOther(0)) return 'ODD';
  if (everyOther(1)) return 'EVEN';
  return null;
}

/**
 * Reads aSc XML into lessons. Never throws on content problems: a thing the
 * model cannot hold becomes a ReadProblem on the card or lesson it sits in
 * and only that card or lesson is skipped (CHOICE 18).
 */
export function readAscXml(xml: string): ParsedExchange {
  const refuse = (ref: string, code: string, message: string): ParsedExchange => ({ lessons: [], problems: [{ ref, code, message }], notes: [] });

  if (Buffer.byteLength(xml, 'utf8') > MAX_EXCHANGE_BYTES) {
    return refuse('fil', 'ASC_TOO_LARGE', `Filen är större än ${MAX_EXCHANGE_BYTES / (1024 * 1024)} MB och läses inte.`);
  }
  let root: XmlNode;
  try {
    root = parseXml(xml);
  } catch (e) {
    if (e instanceof XmlError) return refuse('fil', 'ASC_XML_INVALID', `Filen kunde inte läsas som XML: ${e.message}`);
    throw e;
  }
  if (root.name.toLowerCase() !== 'timetable') {
    return refuse('fil', 'ASC_NOT_TIMETABLE', `Filen är ingen aSc Timetables XML: rotelementet är <${root.name}>, inte <timetable>.`);
  }

  // Problems are found in passes (lessons, cards, blocks, times) but read in
  // the order of the file: each is keyed to the card being worked on.
  const found: Array<{ at: number; problem: ReadProblem }> = [];
  let cursor = 0;
  const noteList: string[] = [];
  const note = (text: string): void => {
    if (!noteList.includes(text)) noteList.push(text);
  };
  const problem = (ref: string, code: string, message: string): void => {
    found.push({ at: cursor, problem: { ref, code, message } });
  };

  // ---- Fields that look like a personnummer: never read (CHOICE 19) --------
  const personal = new Set<string>();
  const stack: XmlNode[] = [root];
  for (let node = stack.pop(); node !== undefined; node = stack.pop()) {
    for (const [name, value] of Object.entries(node.attrs)) if (PERSONNUMMER_LIKE.test(name) && value.trim() !== '') personal.add(name);
    if (PERSONNUMMER_LIKE.test(node.name) && node.text.trim() !== '') personal.add(node.name);
    stack.push(...node.children);
  }
  if (personal.size > 0) {
    note(`Filen har fält som liknar personnummer (${[...personal].sort().join(', ')}). De läses aldrig och sparas inte.`);
  }

  // ---- The tables ----------------------------------------------------------
  const periods = new Map<number, PeriodEntry>();
  for (const p of rowsOf(root, 'periods', 'period')) {
    const numberText = attr(p, 'period');
    if (numberText === null || !/^-?\d+$/.test(numberText)) continue;
    const number = Number(numberText);
    const start = minutesOfClock(attr(p, 'starttime') ?? '');
    const end = minutesOfClock(attr(p, 'endtime') ?? '');
    const entry: PeriodEntry =
      start !== null && end !== null && end > start ? { ok: true, why: null, start, end } : { ok: false, why: 'time', start: 0, end: 0 };
    const earlier = periods.get(number);
    if (earlier === undefined) periods.set(number, entry);
    else if (!(earlier.ok && entry.ok && earlier.start === entry.start && earlier.end === entry.end)) {
      periods.set(number, { ok: false, why: 'ambiguous', start: 0, end: 0 });
    }
  }

  const subjects = new Map<string, { name: string; short: string | null }>();
  for (const s of rowsOf(root, 'subjects', 'subject')) {
    const id = attr(s, 'id');
    const name = attr(s, 'name') ?? attr(s, 'short');
    if (id !== null && name !== null && !subjects.has(id)) subjects.set(id, { name, short: attr(s, 'short') });
  }
  const rooms = new Map<string, string>();
  for (const r of rowsOf(root, 'classrooms', 'classroom')) {
    const id = attr(r, 'id');
    const name = attr(r, 'name') ?? attr(r, 'short');
    if (id !== null && name !== null && !rooms.has(id)) rooms.set(id, name);
  }
  const teachers = new Map<string, TeacherRef>();
  for (const t of rowsOf(root, 'teachers', 'teacher')) {
    const id = attr(t, 'id');
    if (id === null || teachers.has(id)) continue;
    const full = [attr(t, 'firstname'), attr(t, 'lastname')].filter((part): part is string => part !== null).join(' ');
    teachers.set(id, { short: attr(t, 'short'), name: attr(t, 'name') ?? (full !== '' ? full : null), email: attr(t, 'email'), id: null });
  }
  const classes = new Map<string, string>();
  for (const c of rowsOf(root, 'classes', 'class')) {
    const id = attr(c, 'id');
    const name = attr(c, 'name') ?? attr(c, 'short');
    if (id !== null && name !== null && !classes.has(id)) classes.set(id, name);
  }
  const groups = new Map<string, GroupInfo>();
  const groupNameCount = new Map<string, number>();
  for (const g of rowsOf(root, 'groups', 'group')) {
    const id = attr(g, 'id');
    if (id === null || groups.has(id)) continue;
    const entire = attr(g, 'entireclass') === '1';
    const name = attr(g, 'name') ?? id;
    groups.set(id, { id, name, classIds: idsOf(g, 'classids', 'classid'), entire, qualified: false });
    if (!entire) groupNameCount.set(name, (groupNameCount.get(name) ?? 0) + 1);
  }
  for (const g of groups.values()) g.qualified = !g.entire && (groupNameCount.get(g.name) ?? 0) > 1;

  const readDefs = (table: string, rowName: string, field: string): Map<string, Def> => {
    const out = new Map<string, Def>();
    for (const d of rowsOf(root, table, rowName)) {
      const id = attr(d, 'id');
      if (id === null || out.has(id)) continue;
      out.set(id, { name: attr(d, 'name') ?? attr(d, 'short') ?? id, short: attr(d, 'short'), fields: splitIds(d.attrs[field]) });
    }
    return out;
  };
  const daysDefs = readDefs('daysdefs', 'daysdef', 'days');
  const weeksDefs = readDefs('weeksdefs', 'weeksdef', 'weeks');
  const termsDefs = readDefs('termsdefs', 'termsdef', 'terms');

  // ---- Assumptions made visible ------------------------------------------------
  for (const def of daysDefs.values()) {
    if (def.fields.length !== 1 || !/^[01]+$/.test(def.fields[0]!) || def.fields[0]!.split('1').length !== 2) continue;
    const at = def.fields[0]!.indexOf('1');
    const hit = WEEKDAY_PREFIXES.findIndex((re) => re.test(def.name) || (def.short !== null && re.test(def.short)));
    if (hit >= 0 && hit !== at) note(`Dagarna i filen läses med position 1 som måndag, men dagen "${def.name}" står på position ${at + 1}.`);
  }
  const multiWeeks = [...weeksDefs.values()].some((d) => d.fields.some((f) => f.length > 1));
  const weeksNonTrivial = [...weeksDefs.values()].some((d) => d.fields.some((f) => f.includes('0')));

  // ---- Lessons (what is taught) ---------------------------------------------
  const lessonById = new Map<string, LessonInfo>();
  rowsOf(root, 'lessons', 'lesson').forEach((node, i) => {
    const id = attr(node, 'id');
    if (id !== null && !lessonById.has(id)) lessonById.set(id, { ordinal: i + 1, node });
  });

  let qualifiedUsed = false;
  const groupName = (g: GroupInfo, classId: string | null): string => {
    if (g.entire) return classes.get(classId ?? g.classIds[0] ?? '') ?? g.name;
    if (g.qualified && g.classIds.length > 0) {
      qualifiedUsed = true;
      return `${classes.get(g.classIds[0]!) ?? g.classIds[0]!} ${g.name}`;
    }
    return g.name;
  };

  let tooManyTeachers = 0;
  const resolved = new Map<string, ResolvedLesson | null>();
  const resolveLesson = (id: string, info: LessonInfo): ResolvedLesson | null => {
    if (resolved.has(id)) return resolved.get(id) ?? null;
    const issues: Issue[] = [];
    const node = info.node;

    const subjectId = attr(node, 'subjectid');
    const subject = subjectId !== null ? subjects.get(subjectId) : undefined;
    if (subjectId === null) issues.push({ code: 'ASC_LESSON_NO_SUBJECT', text: 'lektionen saknar ämne.' });
    else if (!subject) issues.push({ code: 'ASC_LESSON_NO_SUBJECT', text: `ämnet "${subjectId}" finns inte i filen.` });

    const selected: GroupInfo[] = [];
    for (const gid of idsOf(node, 'groupids', 'groupid')) {
      const g = groups.get(gid);
      if (g) selected.push(g);
      else issues.push({ code: 'ASC_LESSON_REF_UNKNOWN', text: `gruppen "${gid}" finns inte i filen.` });
    }
    const attendees: string[] = [];
    const emitted = new Set<string>();
    const classIds = idsOf(node, 'classids', 'classid');
    for (const cid of classIds) {
      const className = classes.get(cid);
      if (className === undefined) {
        issues.push({ code: 'ASC_LESSON_REF_UNKNOWN', text: `klassen "${cid}" finns inte i filen.` });
        continue;
      }
      const covering = selected.filter((g) => g.classIds.includes(cid));
      if (covering.length === 0) attendees.push(className);
      for (const g of covering) {
        if (emitted.has(g.id)) continue;
        emitted.add(g.id);
        attendees.push(groupName(g, cid));
      }
    }
    for (const g of selected) {
      if (emitted.has(g.id)) continue;
      emitted.add(g.id);
      attendees.push(groupName(g, null));
    }
    const named = unique(attendees);
    if (named.length === 0 && issues.length === 0) issues.push({ code: 'ASC_LESSON_NO_GROUP', text: 'lektionen har varken klass eller grupp.' });

    const teacherRefs: TeacherRef[] = [];
    for (const tid of idsOf(node, 'teacherids', 'teacherid')) {
      const t = teachers.get(tid);
      if (t) teacherRefs.push({ ...t });
      else issues.push({ code: 'ASC_LESSON_REF_UNKNOWN', text: `läraren "${tid}" finns inte i filen.` });
    }
    const roomNames: string[] = [];
    for (const rid of idsOf(node, 'classroomids', 'classroomid')) {
      const r = rooms.get(rid);
      if (r !== undefined) roomNames.push(r);
      else issues.push({ code: 'ASC_LESSON_REF_UNKNOWN', text: `salen "${rid}" finns inte i filen.` });
    }

    if (issues.length > 0 || !subject) {
      problem(`lektion ${info.ordinal}`, issues[0]!.code, `Lektion ${info.ordinal} hoppas över: ${issues.map((i) => i.text).join(' ')}`);
      resolved.set(id, null);
      return null;
    }
    if (teacherRefs.length > 2) tooManyTeachers += 1;
    const out: ResolvedLesson = {
      attendees: named,
      subject: subject.name,
      subjectCode: subject.short !== null && subject.short !== subject.name ? subject.short : null,
      teachers: teacherRefs.slice(0, 2),
      rooms: roomNames,
      // durationperiods supersedes the deprecated periodspercard ([S2]).
      perCard: Math.max(1, wholeNumber(attr(node, 'durationperiods')) ?? wholeNumber(attr(node, 'periodspercard')) ?? 1),
    };
    resolved.set(id, out);
    return out;
  };

  // ---- Cards (where it sits) ----------------------------------------------------
  const cardNodes = rowsOf(root, 'cards', 'card');
  const placedLessons = new Set<string>();
  const rowsByLesson = new Map<string, CardRow[]>();
  cardNodes.forEach((node, i) => {
    const ordinal = i + 1;
    cursor = ordinal;
    const lessonId = attr(node, 'lessonid');
    if (lessonId !== null) placedLessons.add(lessonId);
    const info = lessonId !== null ? lessonById.get(lessonId) : undefined;
    if (lessonId === null || !info) {
      problem(`kort ${ordinal}`, 'ASC_CARD_NO_LESSON', `Kort ${ordinal} hoppas över: ${lessonId === null ? 'kortet pekar inte ut någon lektion' : `lektionen "${lessonId}" finns inte i filen`}.`);
      return;
    }
    if (resolveLesson(lessonId, info) === null) return;
    const periodText = attr(node, 'period');
    if (periodText === null || !/^-?\d+$/.test(periodText)) {
      problem(`kort ${ordinal}`, 'ASC_CARD_NO_PERIOD', `Kort ${ordinal} hoppas över: kortet saknar period, och en tid gissas aldrig.`);
      return;
    }
    const rows = rowsByLesson.get(lessonId) ?? [];
    rows.push({ ordinal, node, period: Number(periodText) });
    rowsByLesson.set(lessonId, rows);
  });

  // Cut each lesson's cards into placements: one card, or the cards of a
  // double lesson (CHOICE 10).
  const placements: Array<{ lessonId: string; placement: Placement }> = [];
  for (const [lessonId, rows] of rowsByLesson) {
    const lesson = resolved.get(lessonId)!;
    const loose: CardRow[] = [];
    for (const row of rows) {
      const own = wholeNumber(attr(row.node, 'durationperiods'));
      if (own !== null && own >= 1) placements.push({ lessonId, placement: { rows: [row], length: own } });
      else if (lesson!.perCard <= 1) placements.push({ lessonId, placement: { rows: [row], length: 1 } });
      else loose.push(row);
    }
    const sameSitting = new Map<string, CardRow[]>();
    for (const row of loose) {
      const key = ['days', 'day', 'weeks', 'terms', 'classroomids', 'classroomid'].map((a) => attr(row.node, a) ?? '').join('|');
      sameSitting.set(key, [...(sameSitting.get(key) ?? []), row]);
    }
    const k = lesson!.perCard;
    for (const group of sameSitting.values()) {
      const ordered = [...group].sort((a, b) => a.period - b.period || a.ordinal - b.ordinal);
      const runs: CardRow[][] = [];
      for (const row of ordered) {
        const run = runs[runs.length - 1];
        if (run !== undefined && row.period === run[run.length - 1]!.period + 1) run.push(row);
        else runs.push([row]);
      }
      for (const run of runs) {
        const whole = Math.floor(run.length / k) * k;
        for (let at = 0; at < whole; at += k) placements.push({ lessonId, placement: { rows: run.slice(at, at + k), length: k } });
        for (const row of run.slice(whole)) {
          cursor = row.ordinal;
          problem(
            `kort ${row.ordinal}`,
            'ASC_CARD_BLOCK_INCOMPLETE',
            `Kort ${row.ordinal} hoppas över: lektionen har ${k} perioder per kort men kortet har bara ${run.length - whole} på rad, så längden går inte att avgöra.`,
          );
        }
      }
    }
  }
  placements.sort((a, b) => a.placement.rows[0]!.ordinal - b.placement.rows[0]!.ordinal);

  // ---- Placements to lessons -----------------------------------------------------
  const lessons: ExchangeLesson[] = [];
  const termNotes = new Set<string>();
  let dayDefault = false;
  let roomsSeveral = 0;
  let roomsUnchosen = 0;
  const day0 = !/daynumbering1/.test(root.attrs.options ?? '');

  const termsOf = (bits: string): { from: string | null; to: string | null } => {
    if (/^1+$/.test(bits)) return { from: null, to: null };
    const def = [...termsDefs.values()].find((d) => d.fields.includes(bits));
    const span = def !== undefined ? parseSpan(def.name) : null;
    if (span !== null) return span;
    const label = def?.name ?? `period ${[...bits].flatMap((b, i) => (b === '1' ? [i + 1] : [])).join('+')}`;
    termNotes.add(label);
    return { from: null, to: null };
  };

  // The card's own bit string, else its lesson's, else the lesson's def when
  // that is one plain string (a list is "any of", which places nothing).
  const bitsFor = (kind: 'weeks' | 'terms', card: XmlNode, lesson: XmlNode): string | null => {
    const own = attr(card, kind) ?? attr(lesson, kind);
    if (own !== null) return own;
    const def = (kind === 'weeks' ? weeksDefs : termsDefs).get(attr(lesson, `${kind}defid`) ?? '');
    return def !== undefined && def.fields.length === 1 ? def.fields[0]! : null;
  };

  for (const { lessonId, placement } of placements) {
    if (lessons.length >= MAX_EXCHANGE_LESSONS) {
      return refuse('fil', 'ASC_TOO_MANY_LESSONS', `Filen har fler än ${MAX_EXCHANGE_LESSONS} lektioner och läses inte.`);
    }
    const lesson = resolved.get(lessonId)!;
    const lessonNode = lessonById.get(lessonId)!.node;
    const first = placement.rows[0]!;
    const last = placement.rows[placement.rows.length - 1]!;
    cursor = first.ordinal;
    const ref = placement.rows.length > 1 ? `kort ${first.ordinal}–${last.ordinal}` : `kort ${first.ordinal}`;
    const skip = (code: string, why: string): void => problem(ref, code, `${ref.charAt(0).toUpperCase()}${ref.slice(1)} hoppas över: ${why}`);
    const card = first.node;

    // The time: the first period's start to the last period's end.
    let start = 0;
    let end = 0;
    let timeProblem: { code: string; why: string } | null = null;
    for (let step = 0; step < placement.length && timeProblem === null; step += 1) {
      const number = first.period + step;
      const p = periods.get(number);
      if (p === undefined) timeProblem = { code: 'ASC_PERIOD_UNKNOWN', why: `perioden ${number} finns inte i filens perioder, och en tid gissas aldrig.` };
      else if (!p.ok) {
        timeProblem =
          p.why === 'ambiguous'
            ? { code: 'ASC_PERIOD_AMBIGUOUS', why: `perioden ${number} har olika tider på olika rader.` }
            : { code: 'ASC_PERIOD_TIME_INVALID', why: `perioden ${number} har ingen tid som går att läsa (start före slut, som H:MM).` };
      } else {
        if (step === 0) start = p.start;
        end = p.end;
      }
    }
    if (timeProblem !== null) {
      skip(timeProblem.code, timeProblem.why);
      continue;
    }

    // The days (CHOICE 6).
    let days: number[] = [];
    const daysText = attr(card, 'days');
    if (daysText !== null) {
      if (!/^[01]+$/.test(daysText) || !daysText.includes('1')) {
        skip('ASC_DAY_INVALID', `dagarna "${daysText}" pekar inte ut någon dag.`);
        continue;
      }
      if (daysText.lastIndexOf('1') >= 7) {
        skip('ASC_DAY_CYCLE', 'tidscykeln har fler än sju dagar och går inte att läsa som veckodagar.');
        continue;
      }
      days = [...daysText].flatMap((bit, i) => (bit === '1' ? [i + 1] : []));
    } else {
      const numeric = wholeNumber(attr(card, 'day'));
      const iso = numeric === null ? null : day0 ? numeric + 1 : numeric;
      if (iso === null || iso < 1 || iso > 7) {
        skip('ASC_DAY_INVALID', 'kortet anger ingen dag som går att läsa.');
        continue;
      }
      if (day0) dayDefault = true;
      days = [iso];
    }

    // The weeks (CHOICE 7).
    const weeksText = bitsFor('weeks', card, lessonNode);
    let weeks: WeekPattern;
    if (weeksText === null) {
      if (multiWeeks) {
        skip('ASC_WEEKS_UNKNOWN', 'filen har flera veckor men varken kortet eller lektionen säger vilken vecka det gäller.');
        continue;
      }
      weeks = 'ALL';
    } else {
      const pattern = weekPatternOfBits(weeksText);
      if (pattern === null) {
        skip('ASC_WEEKS_UNSUPPORTED', `veckorna "${weeksText}" går inte att uttrycka som varje, udda eller jämn vecka.`);
        continue;
      }
      weeks = pattern;
    }

    // The terms (CHOICE 8).
    const termsText = bitsFor('terms', card, lessonNode);
    if (termsText !== null && !/^[01]+$/.test(termsText)) {
      skip('ASC_TERMS_INVALID', `perioderna "${termsText}" går inte att läsa.`);
      continue;
    }
    const span = termsText === null ? { from: null, to: null } : termsOf(termsText);

    // The room (CHOICE 16).
    let room: string | null = null;
    const cardRooms = card.attrs.classroomids ?? card.attrs.classroomid;
    if (cardRooms !== undefined) {
      const ids = splitIds(cardRooms);
      if (ids.length > 1) roomsSeveral += 1;
      if (ids.length > 0) {
        room = rooms.get(ids[0]!) ?? null;
        if (room === null) {
          skip('ASC_CARD_REF_UNKNOWN', `salen "${ids[0]!}" finns inte i filen.`);
          continue;
        }
      }
    } else if (lesson.rooms.length === 1) {
      room = lesson.rooms[0]!;
    } else if (lesson.rooms.length > 1) {
      roomsUnchosen += 1;
    }

    for (const day of days) {
      lessons.push(
        blankLesson({
          ref,
          group: lesson.attendees[0]!,
          extraGroups: lesson.attendees.slice(1),
          subject: lesson.subject,
          subjectCode: lesson.subjectCode,
          teachers: lesson.teachers.map((t) => ({ ...t })),
          room,
          day,
          start: clockOfMinutes(start),
          end: clockOfMinutes(end),
          weeks,
          from: span.from,
          to: span.to,
        }),
      );
    }
  }

  // ---- The notes, in a fixed order -----------------------------------------------
  if (cardNodes.length === 0) note(NOTE_NO_CARDS);
  const unplaced = [...lessonById.keys()].filter((id) => !placedLessons.has(id)).length;
  if (unplaced > 0 && cardNodes.length > 0) {
    note(`${unplaced} ${plural(unplaced, 'lektion', 'lektioner')} i filen har inga kort (är inte placerade) och hoppas över.`);
  }
  if (weeksNonTrivial || lessons.some((l) => l.weeks !== 'ALL')) note(NOTE_WEEKS);
  for (const label of termNotes) {
    note(`Perioden "${label}" i aSc har inga datum och läses som hela läsåret; sätt datum på lektionerna efter importen om de bara ska gälla en del av året.`);
  }
  if (dayDefault) note(NOTE_NUMERIC_DAY_ZERO);
  if (qualifiedUsed) note(NOTE_QUALIFIED_GROUPS);
  if (tooManyTeachers > 0) {
    note(`${tooManyTeachers} ${plural(tooManyTeachers, 'lektion har', 'lektioner har')} fler än två lärare i aSc; de två första följer med.`);
  }
  if (roomsSeveral > 0) note(`${roomsSeveral} kort har flera salar; den första följer med.`);
  if (roomsUnchosen > 0) note(`${roomsUnchosen} kort saknar vald sal i en lektion med flera möjliga salar och får ingen sal.`);
  if (lessons.length > 0) note(NOTE_BLOCK);

  // A card on several days adds several lessons at once, so the check at the
  // top of the loop can be passed by up to six: the limit is checked again here.
  if (lessons.length > MAX_EXCHANGE_LESSONS) {
    return refuse('fil', 'ASC_TOO_MANY_LESSONS', `Filen har fler än ${MAX_EXCHANGE_LESSONS} lektioner och läses inte.`);
  }
  return { lessons, problems: found.sort((a, b) => a.at - b.at).map((f) => f.problem), notes: noteList };
}
