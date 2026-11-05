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
 *     becomes a date. The name is cut apart in code, not matched with a
 *     pattern (a pattern with consecutive optional blanks backtracked
 *     quadratically: a name of a dash, 32 000 blanks and an x held the process
 *     for 4 s, once per card), a name over MAX_SPAN_NAME characters is never
 *     tried (a note says so without quoting it), and a term is resolved once
 *     per distinct bit string, not once per card.
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
 *     numbers count elements in the file, from 1. A reference to a row that
 *     holds a personnummer-shaped value is such a problem too (CHOICE 19).
 *
 * 19. NO PERSONNUMMER (the user's decision of 2026-11-05: none is read, stored
 *     or echoed). No field of the format is one, and the shape is looked for
 *     in VALUES (file-safety.ts, hasPersonalNumber), not only in the NAME of a
 *     field: a school's program calls a column what it likes. It is done once,
 *     to the parsed tree, before any table is read (quarantine()), so that no
 *     later read of an attribute, now or added in a year, can get at one.
 *     a. A field NAMED like one (personnummer, personnr, pnr, ssn, civic number,
 *        samordningsnummer, national id), attribute or element, is deleted from
 *        the tree unread; its value taints nothing and is never echoed. One
 *        note names the fields (at most ten; a name that itself has the shape
 *        is not listed but counted as "ett fält vars namn liknar ett
 *        personnummer").
 *     b. Every attribute of a ROW (an element two levels down: teacher, class,
 *        subject, classroom, group, period, week, day or term definition,
 *        lesson, card) is one of three kinds (ROWS names them):
 *        - COPIED: what the reader copies into a lesson, a label or a note:
 *          name, short, e-mail, first and last name, start and end time, and
 *          the name of a definition (which is read as a date span). A value
 *          with the shape in one of these makes the ROW unreadable (TAINTED):
 *          everything but its id and period is deleted from the tree, so a
 *          name, a short or an e-mail can never be copied out of it. Whatever
 *          points at a tainted row by id is not read either: a lesson whose
 *          subject, class, group, teacher, room or week, day or term
 *          definition is tainted is ONE problem (ASC_LESSON_PERSONAL_NUMBER,
 *          "lektion 17") that names the KIND of row and never its content; a
 *          card whose room is tainted, or whose term only a tainted
 *          definition could name, is ASC_CARD_PERSONAL_NUMBER, a card in a
 *          tainted period ASC_PERIOD_PERSONAL_NUMBER.
 *        - LINK: id, period, lessonid, classid(s), groupid(s), subjectid,
 *          teacherid(s), classroomid(s), the definition ids of a lesson, the
 *          bit strings days, weeks and terms and the numbers (day,
 *          periodspercard, durationperiods): lookup keys, matched and
 *          interpreted, never stored and never shown. A LINK with the shape
 *          does NOT make its row unreadable (an aSc id is random, a random
 *          16-digit hex id has the shape 0.12 % of the time, and the user
 *          cannot change an id in a foreign export). It is only never copied:
 *          a message that has to name it says what is missing (the teacher a
 *          lesson points at) and leaves the value out, and where the reader
 *          would have used an id as a name (a group or a definition with no
 *          name) it does not.
 *        - UNREAD: every other attribute (a teacher's mobile number or birth
 *          date, any extra column), the text of a row, and anything outside
 *          the tables. A value with the shape there is deleted from the tree
 *          unread and counted in the one note; the row stays, and so do the
 *          lessons that use it.
 *     c. A tainted row nothing points at is not silent: the one note counts the
 *        tainted rows by kind and the unread values. The shape errs towards
 *        refusing (see file-safety.ts): ten digits that read as a date, and
 *        four more, in a COPIED field make a row unreadable with a plain
 *        message.
 *     d. What of the file still reaches a message or a note is quoted through
 *        excerpt() (redacted, one line, 40 characters) and every message and
 *        note is redacted once more as it is stored.
 *
 * 20. LIMITS. A source over MAX_EXCHANGE_BYTES, or more lessons than
 *     MAX_EXCHANGE_LESSONS, is refused whole with one problem; invalid XML
 *     (xml.ts: DOCTYPE, ENTITY, unclosed tags, depth, size) is one problem,
 *     ASC_XML_INVALID; a root that is not <timetable> is ASC_NOT_TIMETABLE.
 *     An ANSWER stays small however many cards share one long value (a lesson
 *     of 5 000 cards and a 30 000-character `terms` made 150 MB of messages):
 *     a value is quoted at most 40 characters; the problems are the first
 *     MAX_PROBLEMS in file order and one closing line that counts the rest
 *     (ProblemLog, ASC_TOO_MANY_PROBLEMS); a lesson's problem names at most
 *     five reasons; the notes list at most ten of a kind and count the rest;
 *     a bit string (days, weeks, terms) of more than MAX_BITS characters is
 *     not one, because a lesson's own `weeks` is shared by all its cards and
 *     was scanned once per card; and a name over MAX_SPAN_NAME characters is
 *     not a date span (CHOICE 8).
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
import { MAX_QUOTE, ProblemLog, excerpt, hasPersonalNumber, redactPersonalNumbers } from './file-safety';
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

/**
 * The longest name of a term that is tried as a date span (CHOICE 8). The span
 * the writer makes is 21 characters and a school's own prefix ("Termin 1:
 * 2026-08-17 – 2026-12-18") is not much more; the name is the file's, so a
 * name of any length must not cost more than a comparison of its length.
 */
const MAX_SPAN_NAME = 120;

const SPAN_DASHES = '–—-';

/**
 * The inverse of spanName, tolerant of the dash (en, em, hyphen) and of spaces;
 * null when the text is not a span.
 *
 * Cut apart in code, with no pattern over the whole text. The first version was
 * one pattern, /^\s*(date)?\s*[–—-]\s*(date)?\s*$/, whose optional date between
 * two runs of blanks lets the engine try every split of a long run of blanks
 * between the two: quadratic, and a name of a dash, 32 000 blanks and an "x"
 * (a 42 kB file) held the process for 4 s, once per card. Here the text is
 * trimmed once, an ISO date is exactly ten characters (checked by the anchored,
 * fixed-width ISO_DATE), and each step moves forward over the text once.
 */
function parseSpan(text: string): { from: string | null; to: string | null } | null {
  if (text.length > MAX_SPAN_NAME) return null;
  let rest = text.trim();
  let from: string | null = null;
  const head = rest.slice(0, 10);
  if (ISO_DATE.test(head)) {
    if (!isIsoDate(head)) return null;
    from = head;
    rest = rest.slice(10).trimStart();
  }
  const dash = rest.charAt(0);
  if (dash === '' || !SPAN_DASHES.includes(dash)) return null;
  rest = rest.slice(1).trimStart();
  let to: string | null = null;
  if (rest !== '') {
    if (!isIsoDate(rest)) return null;
    to = rest;
  }
  if (from === null && to === null) return null;
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
  // At most 256 characters reach the pattern, however large the file is, so
  // its lazy `[^>]*?` beside `\s` cannot cost more than a few thousand steps.
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
const NOTE_LONG_TERM_NAME = `Namnet på en termin i filen är längre än ${MAX_SPAN_NAME} tecken, så det läses inte som datum; terminen läses som hela läsåret.`;
const NO_PERSONNUMMER = 'Rastra tar inte emot personnummer.';

/** A field named like a personnummer: dropped unread (CHOICE 19 a). */
const PERSONNUMMER_LIKE = /personnummer|personnr|pnr|ssn|civic|national[-_ ]?id|samordningsnummer|personal[-_ ]?(?:id|number)/i;

const WEEKDAY_PREFIXES: ReadonlyArray<RegExp> = [/^(mån|mon)/i, /^(tis|tue)/i, /^(ons|wed)/i, /^(tor|thu)/i, /^(fre|fri)/i, /^(lör|sat)/i, /^(sön|sun)/i];

/**
 * The longest string of days, weeks or terms that is read as bits (CHOICE 20).
 * A week rotation has two positions, a ten-day cycle ten, a school a handful of
 * terms. A lesson's own `weeks` or `terms` is shared by all its cards and is
 * looked at once per card, so a megabyte of ones there was a megabyte of work
 * (and an array of a million characters) per card.
 */
const MAX_BITS = 64;
/** The most things of one kind a note spells out; the rest are counted (CHOICE 20). */
const MAX_LISTED = 10;
/** The most reasons one lesson's problem spells out; the rest are counted (CHOICE 20). */
const MAX_REASONS = 5;
/**
 * A value is cut this long before it is quoted. An excerpt shows MAX_QUOTE
 * characters; a value that a lesson shares with thousands of cards is quoted
 * thousands of times, and each quote must cost the cut and not the value.
 */
const CLIP = MAX_QUOTE * 10;

/** The rows that can be tainted, as a sentence names them (CHOICE 19). */
const KINDS = {
  teacher: { the: 'läraren', one: 'lärare', many: 'lärare' },
  class: { the: 'klassen', one: 'klass', many: 'klasser' },
  group: { the: 'gruppen', one: 'grupp', many: 'grupper' },
  subject: { the: 'ämnet', one: 'ämne', many: 'ämnen' },
  room: { the: 'salen', one: 'sal', many: 'salar' },
  period: { the: 'perioden', one: 'period', many: 'perioder' },
  term: { the: 'terminen', one: 'termin', many: 'terminer' },
  week: { the: 'veckodefinitionen', one: 'veckodefinition', many: 'veckodefinitioner' },
  day: { the: 'dagdefinitionen', one: 'dagdefinition', many: 'dagdefinitioner' },
} as const;
type Kind = keyof typeof KINDS;
const KIND_ORDER = Object.keys(KINDS) as Kind[];

interface PeriodEntry {
  ok: boolean;
  why: 'time' | 'ambiguous' | 'personal' | null;
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
interface TermSpan {
  from: string | null;
  to: string | null;
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

/** "a, b och c". */
function listOf(items: readonly string[]): string {
  return items.length < 2 ? items.join('') : `${items.slice(0, -1).join(', ')} och ${items[items.length - 1]}`;
}

/** A value of the file as a message quotes it: cut, then redacted, one line, MAX_QUOTE characters, in quotation marks (CHOICE 20). */
function quote(value: string): string {
  return excerpt(value.length > CLIP ? value.slice(0, CLIP) : value);
}

/** The same without the marks, for a name a message puts in marks of its own (<...>) and for a parser's reason. */
function shown(value: string, max: number): string {
  const flat = redactPersonalNumbers(value.length > max * 10 ? value.slice(0, max * 10) : value)
    .replace(/\s+/g, ' ')
    .trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

/**
 * A LINK value (an id, a bit string; CHOICE 19) as a message may quote it, or
 * null when it has the shape of a personnummer. Such a value is matched and
 * never shown: the message leaves it out and says what it can without it.
 */
function quoteLink(value: string): string | null {
  const cut = value.length > CLIP ? value.slice(0, CLIP) : value;
  return hasPersonalNumber(cut) ? null : excerpt(cut);
}

/** "läraren ”T404” finns inte i filen", or, with the id left out, "läraren som lektionen hänvisar till finns inte i filen". */
function missing(the: string, id: string, from: 'lektionen' | 'kortet'): string {
  const quoted = quoteLink(id);
  return quoted === null ? `${the} som ${from} hänvisar till finns inte i filen.` : `${the} ${quoted} finns inte i filen.`;
}

/** The value of a bit string for a sentence that says it cannot be read: ` ”101”`, or nothing when it has the shape. */
function bitsPart(bits: string): string {
  const quoted = quoteLink(bits);
  return quoted === null ? '' : ` ${quoted}`;
}

/** "perioden 3", or "kortets period" when the number the card gives is itself shaped like a personnummer. */
function periodRef(number: number): string {
  return hasPersonalNumber(String(number)) ? 'kortets period' : `perioden ${number}`;
}

/** A count from the file for a sentence: the number, or words when the number has the shape of a personnummer. */
function countText(n: number): string {
  return hasPersonalNumber(String(n)) ? 'ett orimligt antal' : String(n);
}

/** The position label of a term that has no def: "period 2+3". The string is at most MAX_BITS long. */
function positionsLabel(bits: string): string {
  return `period ${[...bits].flatMap((b, i) => (b === '1' ? [i + 1] : [])).join('+')}`;
}

/** The week pattern a bit string over a rotation means, or null when the model has none (CHOICE 7). */
function weekPatternOfBits(bits: string): WeekPattern | null {
  if (bits.length > MAX_BITS || !/^[01]+$/.test(bits) || !bits.includes('1')) return null;
  if (!bits.includes('0')) return 'ALL';
  if (bits.length % 2 !== 0) return null;
  const everyOther = (parity: number): boolean => [...bits].every((bit, i) => (i % 2 === parity ? bit === '1' : bit === '0'));
  if (everyOther(0)) return 'ODD';
  if (everyOther(1)) return 'EVEN';
  return null;
}

/** What the file's own values are taken for, once, before any table is read. */
interface Quarantine {
  /** The rows (elements two levels down) with a personnummer-shaped value in a COPIED field; their fields are already gone. */
  tainted: Set<XmlNode>;
  /** The names of the fields that say personnummer, which were dropped unread. */
  names: Set<string>;
  /** Values with the shape in UNREAD places (CHOICE 19): deleted from the tree, counted. */
  unread: number;
}

interface RowFields {
  /** Copied into a lesson, a label or a note: a value with the shape makes the row tainted. */
  copied: readonly string[];
  /** Matched and interpreted, never stored or shown: a value with the shape is left alone and never copied. */
  link: readonly string[];
}

/**
 * Which attributes of each row the reader READS, and how (CHOICE 19). Keyed by
 * the section and the row, in lower case like rowsOf. An attribute that is
 * not here is unread: if the reader is changed to read one, it goes here
 * first, and until then a value with the shape in it is gone from the tree
 * (a read of it gets nothing: that fails closed).
 */
const ROWS: Readonly<Record<string, RowFields>> = {
  'periods/period': { copied: ['starttime', 'endtime'], link: ['period'] },
  'subjects/subject': { copied: ['name', 'short'], link: ['id'] },
  'classrooms/classroom': { copied: ['name', 'short'], link: ['id'] },
  'teachers/teacher': { copied: ['name', 'short', 'email', 'firstname', 'lastname'], link: ['id'] },
  'classes/class': { copied: ['name', 'short'], link: ['id'] },
  'groups/group': { copied: ['name'], link: ['id', 'entireclass', 'classids', 'classid'] },
  'daysdefs/daysdef': { copied: ['name', 'short'], link: ['id', 'days'] },
  'weeksdefs/weeksdef': { copied: ['name', 'short'], link: ['id', 'weeks'] },
  'termsdefs/termsdef': { copied: ['name', 'short'], link: ['id', 'terms'] },
  'lessons/lesson': {
    copied: [],
    link: [
      'id',
      'subjectid',
      'classids',
      'classid',
      'groupids',
      'groupid',
      'teacherids',
      'teacherid',
      'classroomids',
      'classroomid',
      'daysdefid',
      'weeksdefid',
      'termsdefid',
      'periodspercard',
      'durationperiods',
      'weeks',
      'terms',
    ],
  },
  'cards/card': { copied: [], link: ['lessonid', 'classroomids', 'classroomid', 'period', 'days', 'day', 'weeks', 'terms', 'durationperiods'] },
};
/** The root is read for its options (daynumbering1) and for nothing else. */
const ROOT_FIELDS: RowFields = { copied: [], link: ['options'] };
/** What a tainted row keeps: the keys the reader matches it by, for the set of ids a lesson may not point at. */
const KEPT_BY_A_TAINTED_ROW = ['id', 'period'] as const;

/**
 * CHOICE 19, in the one place. Walks the parsed tree once and takes out of it
 * everything the reader must never read, so that no attribute read anywhere
 * below (today's, or one added next year) can get hold of it:
 *
 *  a. a field NAMED like a personnummer, attribute or element: deleted, and its
 *     name remembered for the note. Its value taints nothing: it is not looked
 *     at, so it cannot be echoed.
 *  b. a field whose VALUE has the shape (hasPersonalNumber), by what the field
 *     is to the reader (ROWS): COPIED, and the row is TAINTED and loses all
 *     but the keys it is matched by; LINK, and it stays, to be matched and
 *     never copied; or UNREAD (anything else, the text of an element, the
 *     root's and the tables' own fields), and the value is deleted and counted.
 *
 * Iterative, like the walk it replaces: no recursion depth to reason about.
 */
function quarantine(root: XmlNode): Quarantine {
  const tainted = new Set<XmlNode>();
  const names = new Set<string>();
  let unread = 0;
  // Each node with its depth (the root is 0, a table 1, a row 2) and, for a row, the table it is in.
  const stack: Array<[XmlNode, number, string]> = [[root, 0, '']];
  for (let item = stack.pop(); item !== undefined; item = stack.pop()) {
    const [node, depth, table] = item;

    for (const [name, value] of Object.entries(node.attrs)) {
      if (!PERSONNUMMER_LIKE.test(name)) continue;
      if (value.trim() !== '') names.add(name);
      delete node.attrs[name];
    }
    if (node.children.some((child) => PERSONNUMMER_LIKE.test(child.name))) {
      node.children = node.children.filter((child) => {
        if (!PERSONNUMMER_LIKE.test(child.name)) return true;
        if (child.text.trim() !== '') names.add(child.name);
        return false;
      });
    }

    const fields = depth === 0 ? ROOT_FIELDS : depth === 2 ? ROWS[`${table}/${node.name.toLowerCase()}`] : undefined;
    let copiedDirty = false;
    for (const [key, value] of Object.entries(node.attrs)) {
      if (!hasPersonalNumber(value)) continue;
      if (fields?.copied.includes(key)) copiedDirty = true;
      else if (!fields?.link.includes(key)) {
        delete node.attrs[key];
        unread += 1;
      }
    }
    if (hasPersonalNumber(node.text)) {
      node.text = '';
      unread += 1;
    }
    if (copiedDirty) {
      const kept: Record<string, string> = {};
      for (const key of KEPT_BY_A_TAINTED_ROW) if (node.attrs[key] !== undefined) kept[key] = node.attrs[key];
      node.attrs = kept;
      tainted.add(node);
    }

    const childTable = depth === 1 ? node.name.toLowerCase() : table;
    for (const child of node.children) stack.push([child, depth + 1, childTable]);
  }
  return { tainted, names, unread };
}

/** The names of fields that say personnummer, as a note lists them: sorted, at most MAX_LISTED, a name that is itself a number only counted. */
function listedNames(names: ReadonlySet<string>): string {
  const own = [...names].filter((name) => !hasPersonalNumber(name)).sort();
  const numbered = names.size - own.length;
  const out = own.slice(0, MAX_LISTED).map((name) => shown(name, MAX_QUOTE));
  if (own.length > MAX_LISTED) out.push(`${own.length - MAX_LISTED} till`);
  if (numbered > 0) out.push(numbered === 1 ? 'ett fält vars namn liknar ett personnummer' : `${numbered} fält vars namn liknar ett personnummer`);
  return out.join(', ');
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
    // The parser names a tag or an entity of the file in its message, and the file may have made that name any length.
    if (e instanceof XmlError) return refuse('fil', 'ASC_XML_INVALID', `Filen kunde inte läsas som XML: ${shown(e.message, 160)}`);
    throw e;
  }
  if (root.name.toLowerCase() !== 'timetable') {
    return refuse('fil', 'ASC_NOT_TIMETABLE', `Filen är ingen aSc Timetables XML: rotelementet är <${shown(root.name, MAX_QUOTE)}>, inte <timetable>.`);
  }

  // Problems are found in passes (lessons, cards, blocks, times) but read in
  // the order of the file: each is keyed to the card being worked on, and the
  // ProblemLog (the first MAX_PROBLEMS, then a count) is fed in that order.
  const found: Array<{ at: number; problem: ReadProblem }> = [];
  let cursor = 0;
  const noteList: string[] = [];
  const note = (text: string): void => {
    const safe = redactPersonalNumbers(text);
    if (!noteList.includes(safe)) noteList.push(safe);
  };
  /** One note for each of the first MAX_LISTED things, and one that counts the rest (CHOICE 20). */
  const noteEach = (things: readonly string[], one: (thing: string) => string, rest: (n: number) => string): void => {
    for (const thing of things.slice(0, MAX_LISTED)) note(one(thing));
    if (things.length > MAX_LISTED) note(rest(things.length - MAX_LISTED));
  };
  const problem = (ref: string, code: string, message: string): void => {
    found.push({ at: cursor, problem: { ref, code, message: redactPersonalNumbers(message) } });
  };

  // ---- Nothing that looks like a personnummer is read (CHOICE 19) ------------
  const { tainted, names, unread } = quarantine(root);
  if (names.size > 0) note(`Filen har fält som liknar personnummer (${listedNames(names)}). De läses aldrig och sparas inte.`);

  const taintedRows = Object.fromEntries(KIND_ORDER.map((kind) => [kind, 0])) as Record<Kind, number>;
  /** The ids of the tainted rows of each kind: a lesson that points at one is not read. */
  const poisoned = Object.fromEntries(KIND_ORDER.map((kind) => [kind, new Set<string>()])) as Record<Kind, Set<string>>;
  /** The rows of a table that are fit to read; a tainted one is counted and its id set aside. */
  const readable = (table: string, rowName: string, kind: Kind): XmlNode[] => {
    const out: XmlNode[] = [];
    for (const node of rowsOf(root, table, rowName)) {
      if (!tainted.has(node)) {
        out.push(node);
        continue;
      }
      taintedRows[kind] += 1;
      const id = attr(node, 'id');
      if (id !== null) poisoned[kind].add(id);
    }
    return out;
  };

  // ---- The tables ----------------------------------------------------------
  const periods = new Map<number, PeriodEntry>();
  for (const p of rowsOf(root, 'periods', 'period')) {
    const isTainted = tainted.has(p);
    if (isTainted) taintedRows.period += 1;
    const numberText = attr(p, 'period');
    if (numberText === null || !/^-?\d+$/.test(numberText)) continue;
    const number = Number(numberText);
    if (isTainted) {
      // Every card in it is a problem, and it stays one if the number is listed again.
      periods.set(number, { ok: false, why: 'personal', start: 0, end: 0 });
      continue;
    }
    const start = minutesOfClock(attr(p, 'starttime') ?? '');
    const end = minutesOfClock(attr(p, 'endtime') ?? '');
    const entry: PeriodEntry =
      start !== null && end !== null && end > start ? { ok: true, why: null, start, end } : { ok: false, why: 'time', start: 0, end: 0 };
    const earlier = periods.get(number);
    if (earlier === undefined) periods.set(number, entry);
    else if (earlier.why !== 'personal' && !(earlier.ok && entry.ok && earlier.start === entry.start && earlier.end === entry.end)) {
      periods.set(number, { ok: false, why: 'ambiguous', start: 0, end: 0 });
    }
  }

  const subjects = new Map<string, { name: string; short: string | null }>();
  for (const s of readable('subjects', 'subject', 'subject')) {
    const id = attr(s, 'id');
    const name = attr(s, 'name') ?? attr(s, 'short');
    if (id !== null && name !== null && !subjects.has(id)) subjects.set(id, { name, short: attr(s, 'short') });
  }
  const rooms = new Map<string, string>();
  for (const r of readable('classrooms', 'classroom', 'room')) {
    const id = attr(r, 'id');
    const name = attr(r, 'name') ?? attr(r, 'short');
    if (id !== null && name !== null && !rooms.has(id)) rooms.set(id, name);
  }
  const teachers = new Map<string, TeacherRef>();
  for (const t of readable('teachers', 'teacher', 'teacher')) {
    const id = attr(t, 'id');
    if (id === null || teachers.has(id)) continue;
    const full = [attr(t, 'firstname'), attr(t, 'lastname')].filter((part): part is string => part !== null).join(' ');
    teachers.set(id, { short: attr(t, 'short'), name: attr(t, 'name') ?? (full !== '' ? full : null), email: attr(t, 'email'), id: null });
  }
  const classes = new Map<string, string>();
  for (const c of readable('classes', 'class', 'class')) {
    const id = attr(c, 'id');
    const name = attr(c, 'name') ?? attr(c, 'short');
    if (id !== null && name !== null && !classes.has(id)) classes.set(id, name);
  }
  const groups = new Map<string, GroupInfo>();
  const groupNameCount = new Map<string, number>();
  for (const g of readable('groups', 'group', 'group')) {
    const id = attr(g, 'id');
    if (id === null || groups.has(id)) continue;
    const entire = attr(g, 'entireclass') === '1';
    // A group with no name is called by its id, unless the id has the shape of a
    // personnummer: an id is a key and is never copied into a name (CHOICE 19).
    const name = attr(g, 'name') ?? (hasPersonalNumber(id) ? null : id);
    if (name === null) {
      taintedRows.group += 1;
      poisoned.group.add(id);
      continue;
    }
    groups.set(id, { id, name, classIds: idsOf(g, 'classids', 'classid'), entire, qualified: false });
    if (!entire) groupNameCount.set(name, (groupNameCount.get(name) ?? 0) + 1);
  }
  for (const g of groups.values()) g.qualified = !g.entire && (groupNameCount.get(g.name) ?? 0) > 1;

  const readDefs = (table: string, rowName: string, field: string, kind: Kind): Map<string, Def> => {
    const out = new Map<string, Def>();
    for (const d of readable(table, rowName, kind)) {
      const id = attr(d, 'id');
      if (id === null || out.has(id)) continue;
      // Called by its id when it has no name, unless the id is shaped like a personnummer (CHOICE 19).
      const name = attr(d, 'name') ?? attr(d, 'short') ?? (hasPersonalNumber(id) ? 'utan namn' : id);
      out.set(id, { name, short: attr(d, 'short'), fields: splitIds(d.attrs[field]) });
    }
    return out;
  };
  const daysDefs = readDefs('daysdefs', 'daysdef', 'days', 'day');
  const weeksDefs = readDefs('weeksdefs', 'weeksdef', 'weeks', 'week');
  const termsDefs = readDefs('termsdefs', 'termsdef', 'terms', 'term');

  // ---- Lessons (what is taught) and cards (where it sits), as elements -------
  const lessonNodes = rowsOf(root, 'lessons', 'lesson');
  const cardNodes = rowsOf(root, 'cards', 'card');
  const lessonById = new Map<string, LessonInfo>();
  lessonNodes.forEach((node, i) => {
    const id = attr(node, 'id');
    if (id !== null && !lessonById.has(id)) lessonById.set(id, { ordinal: i + 1, node });
  });

  // A tainted row nothing points at is not silent either: one note, with the values that were deleted unread.
  const taintedParts = KIND_ORDER.filter((kind) => taintedRows[kind] > 0).map(
    (kind) => `${taintedRows[kind]} ${plural(taintedRows[kind], KINDS[kind].one, KINDS[kind].many)}`,
  );
  const unreadPart = `${unread} ${plural(unread, 'värde', 'värden')} som liknar personnummer i ${plural(unread, 'ett fält', 'fält')} som inte läses; ${plural(unread, 'det', 'de')} sparas inte.`;
  if (taintedParts.length > 0) {
    note(
      [
        `Filen har värden som liknar personnummer i ${listOf(taintedParts)}. De läses aldrig och sparas inte, och en lektion som hänvisar till dem läses inte heller.`,
        ...(unread > 0 ? [`Dessutom finns ${unreadPart}`] : []),
        NO_PERSONNUMMER,
      ].join(' '),
    );
  } else if (unread > 0) {
    note(`Filen har ${unreadPart} ${NO_PERSONNUMMER}`);
  }

  // ---- Assumptions made visible ------------------------------------------------
  const dayMismatches: string[] = [];
  for (const def of daysDefs.values()) {
    if (def.fields.length !== 1 || !/^[01]+$/.test(def.fields[0]!) || def.fields[0]!.split('1').length !== 2) continue;
    const at = def.fields[0]!.indexOf('1');
    const hit = WEEKDAY_PREFIXES.findIndex((re) => re.test(def.name) || (def.short !== null && re.test(def.short)));
    if (hit >= 0 && hit !== at) dayMismatches.push(`Dagarna i filen läses med position 1 som måndag, men dagen ${quote(def.name)} står på position ${at + 1}.`);
  }
  noteEach(
    dayMismatches,
    (text) => text,
    (n) => `Ytterligare ${n} ${plural(n, 'dag', 'dagar')} i filen står på en annan position än den som läses som ${plural(n, 'dess', 'deras')} veckodag.`,
  );
  // A week definition that was not read might hold a rotation: no card is guessed to be "every week" then.
  const multiWeeks = taintedRows.week > 0 || [...weeksDefs.values()].some((d) => d.fields.some((f) => f.length > 1));
  const weeksNonTrivial = [...weeksDefs.values()].some((d) => d.fields.some((f) => f.includes('0')));

  // ---- Lessons (what is taught) ---------------------------------------------
  let qualifiedUsed = false;
  const groupName = (g: GroupInfo, classId: string | null): string => {
    if (g.entire) return classes.get(classId ?? g.classIds[0] ?? '') ?? g.name;
    if (g.qualified && g.classIds.length > 0) {
      qualifiedUsed = true;
      // The class's name, or its id when the file has no such class (never an id shaped like a personnummer).
      const classLabel = classes.get(g.classIds[0]!) ?? (hasPersonalNumber(g.classIds[0]!) ? null : g.classIds[0]!);
      return classLabel === null ? g.name : `${classLabel} ${g.name}`;
    }
    return g.name;
  };

  let tooManyTeachers = 0;
  const resolved = new Map<string, ResolvedLesson | null>();
  const resolveLesson = (id: string, info: LessonInfo): ResolvedLesson | null => {
    if (resolved.has(id)) return resolved.get(id) ?? null;
    const ref = `lektion ${info.ordinal}`;
    // At most MAX_REASONS are spelled out: a lesson may name a million ids, and
    // every one that is not in the file is a reason.
    const issues: Issue[] = [];
    let moreIssues = 0;
    const issue = (code: string, text: string): void => {
      if (issues.length < MAX_REASONS) issues.push({ code, text });
      else moreIssues += 1;
    };
    // A reference to a row that was not read, said once for each kind of row.
    const personal = new Set<Kind>();
    const pointsAtTainted = (kind: Kind): void => {
      if (personal.has(kind)) return;
      personal.add(kind);
      issue('ASC_LESSON_PERSONAL_NUMBER', `${KINDS[kind].the} som lektionen hänvisar till har ett värde som liknar ett personnummer.`);
    };
    const node = info.node;

    const subjectId = attr(node, 'subjectid');
    const subject = subjectId !== null ? subjects.get(subjectId) : undefined;
    if (subjectId === null) issue('ASC_LESSON_NO_SUBJECT', 'lektionen saknar ämne.');
    else if (poisoned.subject.has(subjectId)) pointsAtTainted('subject');
    else if (!subject) issue('ASC_LESSON_NO_SUBJECT', missing(KINDS.subject.the, subjectId, 'lektionen'));

    const selected: GroupInfo[] = [];
    for (const gid of idsOf(node, 'groupids', 'groupid')) {
      const g = groups.get(gid);
      if (poisoned.group.has(gid)) pointsAtTainted('group');
      else if (g) {
        selected.push(g);
        // A group of a class that was not read is not read either.
        if (g.classIds.some((cid) => poisoned.class.has(cid))) pointsAtTainted('class');
      } else issue('ASC_LESSON_REF_UNKNOWN', missing(KINDS.group.the, gid, 'lektionen'));
    }
    // Which selected groups belong to which class, once: finding them class by
    // class was one pass over all selected groups for every class.
    const selectedOfClass = new Map<string, GroupInfo[]>();
    for (const g of selected) {
      for (const cid of g.classIds) {
        const ofClass = selectedOfClass.get(cid);
        if (ofClass === undefined) selectedOfClass.set(cid, [g]);
        else ofClass.push(g);
      }
    }
    const attendees: string[] = [];
    const emitted = new Set<string>();
    const classIds = idsOf(node, 'classids', 'classid');
    for (const cid of classIds) {
      if (poisoned.class.has(cid)) {
        pointsAtTainted('class');
        continue;
      }
      const className = classes.get(cid);
      if (className === undefined) {
        issue('ASC_LESSON_REF_UNKNOWN', missing(KINDS.class.the, cid, 'lektionen'));
        continue;
      }
      const covering = selectedOfClass.get(cid) ?? [];
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
    if (named.length === 0 && issues.length === 0) issue('ASC_LESSON_NO_GROUP', 'lektionen har varken klass eller grupp.');

    const teacherRefs: TeacherRef[] = [];
    for (const tid of idsOf(node, 'teacherids', 'teacherid')) {
      const t = teachers.get(tid);
      if (poisoned.teacher.has(tid)) pointsAtTainted('teacher');
      else if (t) teacherRefs.push({ ...t });
      else issue('ASC_LESSON_REF_UNKNOWN', missing(KINDS.teacher.the, tid, 'lektionen'));
    }
    const roomNames: string[] = [];
    for (const rid of idsOf(node, 'classroomids', 'classroomid')) {
      const r = rooms.get(rid);
      if (poisoned.room.has(rid)) pointsAtTainted('room');
      else if (r !== undefined) roomNames.push(r);
      else issue('ASC_LESSON_REF_UNKNOWN', missing(KINDS.room.the, rid, 'lektionen'));
    }
    // The lesson's own days, weeks and terms definitions: read only when the
    // card has nothing of its own, but a lesson that points at one that was not
    // read is not read, whatever the card says.
    for (const [column, kind] of [['daysdefid', 'day'], ['weeksdefid', 'week'], ['termsdefid', 'term']] as const) {
      const defId = attr(node, column);
      if (defId !== null && poisoned[kind].has(defId)) pointsAtTainted(kind);
    }

    if (issues.length > 0 || !subject) {
      const reasons = `${issues.map((i) => i.text).join(' ')}${moreIssues > 0 ? ` Ytterligare ${moreIssues} ${plural(moreIssues, 'orsak', 'orsaker')} visas inte.` : ''}`;
      const code = personal.size > 0 ? 'ASC_LESSON_PERSONAL_NUMBER' : issues[0]!.code;
      problem(ref, code, `Lektion ${info.ordinal} hoppas över: ${reasons}${personal.size > 0 ? ` ${NO_PERSONNUMMER}` : ''}`);
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
  const placedLessons = new Set<string>();
  const rowsByLesson = new Map<string, CardRow[]>();
  cardNodes.forEach((node, i) => {
    const ordinal = i + 1;
    cursor = ordinal;
    const lessonId = attr(node, 'lessonid');
    if (lessonId !== null) placedLessons.add(lessonId);
    const info = lessonId !== null ? lessonById.get(lessonId) : undefined;
    if (lessonId === null || !info) {
      problem(
        `kort ${ordinal}`,
        'ASC_CARD_NO_LESSON',
        `Kort ${ordinal} hoppas över: ${lessonId === null ? 'kortet pekar inte ut någon lektion.' : missing('lektionen', lessonId, 'kortet')}`,
      );
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
      const sitting = sameSitting.get(key);
      if (sitting === undefined) sameSitting.set(key, [row]);
      else sitting.push(row);
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
            `Kort ${row.ordinal} hoppas över: lektionen har ${countText(k)} perioder per kort men kortet har bara ${run.length - whole} på rad, så längden går inte att avgöra.`,
          );
        }
      }
    }
  }
  placements.sort((a, b) => a.placement.rows[0]!.ordinal - b.placement.rows[0]!.ordinal);

  // ---- Placements to lessons -----------------------------------------------------
  const lessons: ExchangeLesson[] = [];
  const termNotes = new Set<string>();
  let longTermName = false;
  let dayDefault = false;
  let roomsSeveral = 0;
  let roomsUnchosen = 0;
  const day0 = !/daynumbering1/.test(root.attrs.options ?? '');

  // A term is told once per distinct bit string, however many cards carry it
  // (CHOICE 8): the first def whose string it is, then its name as a span.
  // null: the string could only be named by a def that was not read.
  const wholeYear: TermSpan = { from: null, to: null };
  const defByBits = new Map<string, Def>();
  for (const d of termsDefs.values()) for (const field of d.fields) if (!defByBits.has(field)) defByBits.set(field, d);
  const termCache = new Map<string, TermSpan | null>();
  const termsOf = (bits: string): TermSpan | null => {
    if (/^1+$/.test(bits)) return wholeYear;
    const cached = termCache.get(bits);
    if (cached !== undefined) return cached;
    const def = defByBits.get(bits);
    const span = def !== undefined ? parseSpan(def.name) : null;
    let result: TermSpan | null = span ?? wholeYear;
    if (span === null) {
      if (def === undefined && taintedRows.term > 0) result = null;
      else if (def !== undefined && def.name.length > MAX_SPAN_NAME) longTermName = true;
      else termNotes.add(quote(def?.name ?? positionsLabel(bits)));
    }
    termCache.set(bits, result);
    return result;
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
      if (p === undefined) timeProblem = { code: 'ASC_PERIOD_UNKNOWN', why: `${periodRef(number)} finns inte i filens perioder, och en tid gissas aldrig.` };
      else if (!p.ok) {
        timeProblem =
          p.why === 'personal'
            ? { code: 'ASC_PERIOD_PERSONAL_NUMBER', why: `${periodRef(number)} har ett värde som liknar ett personnummer. ${NO_PERSONNUMMER}` }
            : p.why === 'ambiguous'
              ? { code: 'ASC_PERIOD_AMBIGUOUS', why: `${periodRef(number)} har olika tider på olika rader.` }
              : { code: 'ASC_PERIOD_TIME_INVALID', why: `${periodRef(number)} har ingen tid som går att läsa (start före slut, som H:MM).` };
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
      if (daysText.length > MAX_BITS || !/^[01]+$/.test(daysText) || !daysText.includes('1')) {
        skip('ASC_DAY_INVALID', `dagarna${bitsPart(daysText)} pekar inte ut någon dag.`);
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
        skip('ASC_WEEKS_UNSUPPORTED', `veckorna${bitsPart(weeksText)} går inte att uttrycka som varje, udda eller jämn vecka.`);
        continue;
      }
      weeks = pattern;
    }

    // The terms (CHOICE 8).
    const termsText = bitsFor('terms', card, lessonNode);
    if (termsText !== null && (termsText.length > MAX_BITS || !/^[01]+$/.test(termsText))) {
      skip('ASC_TERMS_INVALID', `perioderna${bitsPart(termsText)} går inte att läsa.`);
      continue;
    }
    const span = termsText === null ? wholeYear : termsOf(termsText);
    if (span === null) {
      skip(
        'ASC_CARD_PERSONAL_NUMBER',
        `kortets termin går inte att avgöra, eftersom en terminsdefinition i filen har ett värde som liknar ett personnummer. ${NO_PERSONNUMMER}`,
      );
      continue;
    }

    // The room (CHOICE 16).
    let room: string | null = null;
    const cardRooms = card.attrs.classroomids ?? card.attrs.classroomid;
    if (cardRooms !== undefined) {
      const ids = splitIds(cardRooms);
      if (ids.length > 1) roomsSeveral += 1;
      if (ids.length > 0) {
        if (poisoned.room.has(ids[0]!)) {
          skip('ASC_CARD_PERSONAL_NUMBER', `salen som kortet hänvisar till har ett värde som liknar ett personnummer. ${NO_PERSONNUMMER}`);
          continue;
        }
        room = rooms.get(ids[0]!) ?? null;
        if (room === null) {
          skip('ASC_CARD_REF_UNKNOWN', missing(KINDS.room.the, ids[0]!, 'kortet'));
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
  noteEach(
    [...termNotes],
    (label) => `Perioden ${label} i aSc har inga datum och läses som hela läsåret; sätt datum på lektionerna efter importen om de bara ska gälla en del av året.`,
    (n) => `${n} ${plural(n, 'period', 'perioder')} till i aSc har inga datum och läses som hela läsåret.`,
  );
  if (longTermName) note(NOTE_LONG_TERM_NAME);
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
  const log = new ProblemLog('ASC_TOO_MANY_PROBLEMS');
  for (const f of found.sort((a, b) => a.at - b.at)) log.add(f.problem.ref, f.problem.code, f.problem.message);
  return { lessons, problems: log.close(), notes: noteList };
}
