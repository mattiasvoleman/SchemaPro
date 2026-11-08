/**
 * Every place the web hands out a file, and what it does with a person the
 * school has marked as having a protected identity (skyddad identitet,
 * 20270107090000; lib/protected-people.ts).
 *
 * people-files.test.ts reads app/, components/ and lib/ for a download (the
 * primitives in DOWNLOADS) and fails on a source that downloads and is not
 * listed here, on a listed one that no longer downloads, on a HOLDS_OUT or
 * KEEPS_AND_SAYS source that does not read the marks, and on an export
 * button entry of a PEOPLE_KIND whose source builds it without them. A new
 * file is therefore decided here, by name, before it ships. The gateway's
 * own files are the same list's other half: src/common/people-files.ts.
 */

export type PeopleFileRule =
  /** The marked persons, and every row naming one, are not in the file; the page says how many. */
  | "HOLDS_OUT"
  /** The recipient is to have everyone (SCB, payroll, the samverkan): the marked are in it, and the page says how many. */
  | "KEEPS_AND_SAYS"
  /** Names staff (signature, name, e-mail), no pupil and no guardian. Not filtered: see `why`. */
  | "NAMES_STAFF"
  /** Names nobody: a template, a timplan, the school's rooms or subjects. */
  | "NAMES_NOBODY"
  /** About one person, read for that person's own sake (the läslogg of a data subject). */
  | "ONE_PERSON"
  /** The download itself, which the sources listed here call. */
  | "PRIMITIVE"
  /**
   * The gateway built the file and has held the marked out before a byte left it (hela skolans data, 20270114090000;
   * src/common/people-files.ts); the web only hands it over, and the order says how many were held out.
   */
  | "HANDS_OVER";

export interface PeopleFile {
  files: string;
  rule: PeopleFileRule;
  why: string;
}

/**
 * What a download or a print looks like in the source: the app's own
 * primitives, a blob or data: URL handed to a link, a link given a file name,
 * and the browser's print (a page put on paper leaves the system as a file
 * does).
 */
export const DOWNLOADS =
  /\b(downloadCsv|downloadIcs|downloadScbText|downloadScbCsv|saveBase64|downloadTemplate)\(|URL\.createObjectURL\(|\bdoc\.save\(|\.download\s*=|["'`]data:|new Blob\(|window\.print\(/;

/** The export button's kinds that name people: built from the unmarked only. */
export const PEOPLE_KINDS = [
  "teachers",
  "teacherQualifications",
  "teacherDuties",
  "students",
  "guardians",
  "teachingGroups",
  "requirements",
] as const;

/** Paths from web/. */
export const PEOPLE_FILES: Readonly<Record<string, PeopleFile>> = {
  "components/import/csv-export-button.tsx": {
    files: "larare.csv, behorigheter.csv, uppdrag.csv, elever.csv, vardnadshavare.csv, undervisningsgrupper.csv, timplansposter.csv, and the files of no person",
    rule: "HOLDS_OUT",
    why: "Each page builds its people's entries through withoutMarked (vardnadshavare.csv: the gateway holds a link out when either end is marked); the button says how many.",
  },
  "app/[locale]/(app)/admin/reports/attendance-report.tsx": {
    files: "narvaro_<klass>_<från>_<till>.csv",
    rule: "HOLDS_OUT",
    why: "A row per pupil: a marked pupil's row is left out.",
  },
  "app/[locale]/(app)/admin/crisis/protocol-actions.ts": {
    files: "larmprotokoll-<yyyy-mm-dd>-<hhmm>.csv, and the alarm protocol printed (Skriv ut, which is also how a PDF is made)",
    rule: "HOLDS_OUT",
    why: "A row per pupil: a marked pupil's row and every mark that names them are left out, and the page and the file say how many pupils were counted without a name (lib/crisis-protocol.ts).",
  },
  "components/school-day/print-actions.ts": {
    files: "Skolans dag printed (Skriv ut, which is also how a PDF is made): the day or the week, as classes, teachers or rooms",
    rule: "HOLDS_OUT",
    why: "Names teachers beside their lessons and no pupil: a teacher the school has marked as having a protected identity is shown as 'Skyddad identitet' in the row and in every lesson, and the sheet says how many were left out. The marks are read at the click, and a read that fails prints nothing.",
  },
  "components/absence-stats/pupil-print.ts": {
    files: "a pupil's frånvarostatistik printed (Skriv ut on the elevkort, which is also how a PDF is made): one A4 for the development talk",
    rule: "HOLDS_OUT",
    why: "Names one pupil and the pupil's absence: a pupil the school has marked as having a protected identity is never printed, and the card says so. An administrator's marks are read at the click and a read that fails prints nothing; the card of a pupil the gateway flags (isProtected) has no button, and a mentor, who may not read the marks, is never handed a marked pupil.",
  },
  "components/checklists/print-actions.ts": {
    files: "an instruction roster (Instruktionsbevis) and a consent list (Samtycken) printed (Skriv ut, which is also how a PDF is made)",
    rule: "HANDS_OVER",
    why: "A row per pupil, made by the gateway (GET .../roster/print and GET .../consent-lists/:id/print): it holds a pupil with a protected identity out of the rows and the counts and says how many in heldOut, and the sheet is drawn from that answer alone, with the count and that the screen has them. The screen names every pupil the reader may see (they read the register already). The gateway decides, since a teacher cannot read the marks; a read that fails prints nothing.",
  },
  "app/[locale]/(app)/admin/reports/staffing-report.tsx": {
    files: "tjanstefordelning-….csv (samverkan), scb-pedagogisk-personal-….txt and .csv",
    rule: "KEEPS_AND_SAYS",
    why: "SCB is to have every teacher (lärarregistret), and the samverkan on the tjänstefördelning every post; a teacher left out makes both wrong.",
  },
  "app/[locale]/(app)/admin/reports/cover-hours-report.tsx": {
    files: "vikarietimmar-lektioner-….csv, vikarietimmar-summering-….csv",
    rule: "KEEPS_AND_SAYS",
    why: "The payroll pays everyone in it; a vikarie left out goes unpaid.",
  },
  "components/analysis/payroll-panel.tsx": {
    files: "loneunderlag-<från>-<till>.csv (Excels svenska CSV, windows-1252) and .xlsx",
    rule: "HANDS_OVER",
    why: "The gateway builds the file (POST /analysis/payroll-basis/export): payroll pays everyone, so a person with a protected identity is in it and the order says how many (protectedInFile). The web only hands it over; HR data, so only readers of HR data are offered it.",
  },
  "components/analysis/cost-basis-panel.tsx": {
    files: "kostnad-per-elev-<läsår>.csv",
    rule: "NAMES_NOBODY",
    why: "Skoldelar, årskurser, timmar and kronor: the aggregates of the cost basis, no teacher and no pupil.",
  },
  "app/[locale]/(app)/admin/schedule-exchange/page.tsx": {
    files: "the timetable as CSV, Excel, Untis GPU and aSc XML",
    rule: "NAMES_STAFF",
    why: "Names teachers by signature, name and e-mail and no pupil: the lessons are named by group. A teacher left out would leave lessons without their teacher in the other system.",
  },
  "app/[locale]/(app)/admin/timetable/timetable-exports.ts": {
    files: "timetable.ics, timetable.pdf",
    rule: "NAMES_STAFF",
    why: "Names the lesson's teachers; pupils only as a count.",
  },
  "app/[locale]/(app)/admin/timetable/page.tsx": {
    files: "the timetable printed (Skriv ut)",
    rule: "NAMES_STAFF",
    why: "The week on paper: teachers, groups as names, pupils only as a count.",
  },
  "app/[locale]/(app)/admin/publishing/print/page.tsx": {
    files: "the print set (Utskrift)",
    rule: "NAMES_STAFF",
    why: "The gateway's print set (GET /print/timetables), without a teacher hidden from public timetables or with a protected identity; no pupil.",
  },
  "components/lesson-log/class-book-page.tsx": {
    files: "the klassbok printed",
    rule: "NAMES_STAFF",
    why: "Teachers by name, pupils only as a count (GET /lesson-logs/class-book).",
  },
  "components/staffing/uppdragsbeskrivning.tsx": {
    files: "a teacher's uppdragsbeskrivning printed",
    rule: "ONE_PERSON",
    why: "One teacher's own post, printed for that teacher.",
  },
  "components/timetable-sheet/print-week-button.tsx": {
    files: "a week printed",
    rule: "ONE_PERSON",
    why: "The signed-in person's own week, or a guardian's child's.",
  },
  "app/[locale]/(app)/admin/dataskydd/access-log-csv.ts": {
    files: "lasningar-<namn>-<datum>.csv",
    rule: "ONE_PERSON",
    why: "Who has read about one person: dataskydd's answer to that person, whose name is the subject.",
  },
  "app/[locale]/(app)/admin/timplan/page.tsx": {
    files: "lokal_timplan.csv",
    rule: "NAMES_NOBODY",
    why: "Subjects and minutes.",
  },
  "components/import/csv-import-dialog.tsx": { files: "the import templates", rule: "NAMES_NOBODY", why: "Headers only." },
  "components/timplan/timplan-import-dialog.tsx": { files: "the timplan template", rule: "NAMES_NOBODY", why: "Headers only." },
  "lib/csv.ts": { files: "the import templates", rule: "NAMES_NOBODY", why: "Headers only (downloadTemplate)." },
  "app/[locale]/(app)/admin/meals/page.tsx": {
    files: "Måltidskollen printed (Skriv ut, which is also how a PDF is made): the day or the week ahead",
    rule: "NAMES_NOBODY",
    why: "Counts and the names of classes (7A, 8B), never a pupil: the portions of each lunch sitting, the absence taken off as a number and the staff as a number. A protected pupil is a pupil in a count and is named nowhere.",
  },
  "lib/meal-counts-queries.ts": {
    files: "portioner-<yyyy-mm-dd>[-<yyyy-mm-dd>].csv",
    rule: "NAMES_NOBODY",
    why: "The gateway's file of the same counts (windows-1252, ;): a row per day and sitting with the classes' names and numbers, no pupil. This only hands the bytes over (downloadMealCsv).",
  },
  "app/[locale]/(app)/admin/utilisation/page.tsx": {
    files: "Utnyttjande printed (Skriv ut, which is also how a PDF is made): the period, per room and resource",
    rule: "NAMES_NOBODY",
    why: "The names of rooms and resources and shares of time, never a person: how much of each is booked, not by whom or for what.",
  },
  "lib/local-queries.ts": {
    files: "utnyttjande-<yyyy-mm-dd>-<yyyy-mm-dd>.csv",
    rule: "NAMES_NOBODY",
    why: "The gateway's file of the same report (;, a row per room or resource and week): names of rooms and resources and minutes, no person. This only hands the bytes over (downloadUtilisationCsv).",
  },
  "lib/school-export.ts": {
    files: "rastra-skolexport-<skola>-<datum>.zip",
    rule: "HANDS_OVER",
    why: "The gateway's zip of the whole school: it holds out every marked person and every row about one, counts them on the order (heldOut), and records the fetch in the läslogg before the first byte.",
  },
  "app/[locale]/(app)/admin/dataskydd/use-school-exports.ts": {
    files: "registerutdrag-<datum>-<id>.zip",
    rule: "ONE_PERSON",
    why: "One person's own data (GDPR art. 15), built by the gateway: the person is never held out of their own extract, but an extract of a marked person carries no one else, and a marked relative is left out and counted.",
  },
  "lib/csv-export.ts": { files: "—", rule: "PRIMITIVE", why: "downloadCsv." },
  "lib/ics.ts": { files: "—", rule: "PRIMITIVE", why: "downloadIcs." },
  "lib/pdf.ts": { files: "—", rule: "PRIMITIVE", why: "The PDF's save." },
  "lib/scb-csv.ts": { files: "—", rule: "PRIMITIVE", why: "downloadScbCsv." },
  "lib/scb-file.ts": { files: "—", rule: "PRIMITIVE", why: "downloadScbText." },
  "lib/schedule-exchange.ts": { files: "—", rule: "PRIMITIVE", why: "saveBase64." },
};
