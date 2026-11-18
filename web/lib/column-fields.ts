/**
 * The fields a column of a school's file can be pointed at, per kind of import (Kolumnmappning, X2).
 *
 * THE CATALOGUE IS THE IMPORTERS' OWN. A kind's fields are what its mapper in lib/csv.ts already reads (their ids are the
 * mappers' row field names), under the header the template writes, and the spellings each already accepts come from
 * lib/csv-aliases.ts, the one list the mappers and this share. Nothing here is a guess about any other program's columns:
 * a column that is none of these is the user's to place or to leave out.
 *
 * Why the header matters: the mapping rewrites a file's header row to `header` for every column the user placed, and the
 * mapper that runs after it finds the column as it always has. So a file whose headers the mappers already knew is read
 * as before (its columns are placed by these same spellings), and a file whose headers they did not is read as the user
 * said. The mappers' own checks (lengths, e-mail form, the five-minute grid) are the rules, and are not repeated.
 *
 * Held to three things: the importers (web/lib/column-fields.test.ts runs every kind's mapper over a file written
 * with these headers and reads each field back), the gateway's list of the same ids (src/import-templates/import-fields.ts,
 * by a shared fixture), and the flat table's own columns (src/schedule-exchange/lesson-table.ts, by another).
 */

import { CSV_ALIASES } from "@/lib/csv-aliases";
import { normalizeHeader } from "@/lib/csv-export";

export const CSV_KINDS = [
  "students",
  "guardians",
  "teachers",
  "classes",
  "teachingGroups",
  "roomTypes",
  "rooms",
  "subjects",
  "requirements",
  "teacherQualifications",
  "teacherDuties",
] as const;
export type CsvKind = (typeof CSV_KINDS)[number];

/** The thirteen kinds a template is for: the eleven CSV imports, the lokal timplan's and the schedule exchange's table. */
export const TEMPLATE_KINDS = [...CSV_KINDS, "timplan", "scheduleLessons"] as const;
export type TemplateKind = (typeof TEMPLATE_KINDS)[number];

/** Two fields that split one cell into the columns the reader expects. */
export type CombinedField = "timeRange" | "teacherList";

export interface FieldSpec {
  /** Stable, stored in templates, and the gateway's list (import-fields.ts) holds the same. */
  id: string;
  /** What a placed column is written back under, which the kind's reader finds: the template's header, or the Swedish header of the flat table. */
  header: string;
  /** The normalised spellings of a header the reader takes for this field (lib/csv-aliases.ts). */
  aliases: readonly string[];
  /** The kind cannot be imported without the field. */
  required: boolean;
  /** Required unless the combined field is placed: start and end are what a time range stands for. */
  requiredUnless?: CombinedField;
  /** A field that splits one cell in two: what it writes is not under `header`. */
  combined?: CombinedField;
  /** Not yet read by the kind's mapper: its catalogue entry is ahead of it (the signature fields of the timplan, until part 3). */
  pendingInMapper?: true;
}

type Row = readonly [id: string, header: string, required?: true];

/** For the eleven CSV kinds, in the template's column order: id, the template's header, and whether the importer needs it. */
const CSV_ROWS: Record<CsvKind, readonly Row[]> = {
  students: [["firstName", "fornamn", true], ["lastName", "efternamn", true], ["email", "epost", true], ["phone", "telefon"], ["className", "klass", true]],
  guardians: [["firstName", "fornamn", true], ["lastName", "efternamn", true], ["email", "epost", true], ["phone", "telefon"], ["studentEmail", "elev_epost", true]],
  teachers: [
    ["firstName", "fornamn", true],
    ["lastName", "efternamn", true],
    ["email", "epost", true],
    ["phone", "telefon"],
    ["employmentPercent", "tjanst_procent"],
    ["reductionPercent", "nedsattning_procent"],
    ["contractKind", "avtal"],
    ["signature", "signatur"],
  ],
  classes: [["name", "namn", true], ["gradeLevel", "arskurs"], ["kind", "typ"], ["halfOf", "halvklass_av"], ["replacesSubject", "ersatter_amne"]],
  teachingGroups: [["groupName", "grupp", true], ["email", "epost", true]],
  roomTypes: [["name", "namn", true]],
  rooms: [
    ["name", "namn", true],
    ["code", "kod"],
    ["roomType", "salstyp"],
    ["capacity", "kapacitet"],
    ["minGradeLevel", "lagsta_arskurs"],
    ["maxGradeLevel", "hogsta_arskurs"],
    ["building", "byggnad"],
    ["floor", "vaning"],
  ],
  subjects: [["name", "namn", true], ["code", "kod"], ["color", "farg"], ["roomType", "salstyp"], ["nationalCode", "nationell_kod"], ["countsTowardTimplan", "undervisningstid"]],
  requirements: [
    ["groupName", "grupp", true],
    ["subject", "amne", true],
    ["lessonsPerWeek", "lektioner_per_vecka", true],
    ["minutesPerLesson", "minuter_per_lektion", true],
    ["lessonLengths", "lektionslangder"],
    ["minutesBefore", "minuter_fore"],
    ["minutesAfter", "minuter_efter"],
    ["teacherEmail", "larare"],
    ["coTeacherEmail", "medlarare"],
    ["teacherLoadPercent", "larare_procent"],
    ["coTeacherLoadPercent", "medlarare_procent"],
    ["recurrence", "veckor"],
    ["startDate", "fran"],
    ["endDate", "till"],
  ],
  teacherQualifications: [
    ["teacherEmail", "larare_epost", true],
    ["subject", "amne", true],
    ["minGrade", "fran_arskurs", true],
    ["maxGrade", "till_arskurs", true],
    ["kind", "behorighet", true],
  ],
  teacherDuties: [
    ["teacherEmail", "larare_epost", true],
    ["kind", "typ", true],
    ["label", "benamning", true],
    ["minutesPerWeek", "minuter_per_vecka", true],
    ["countsAsTeaching", "raknas_som_undervisning"],
    ["subject", "amne"],
    ["groupName", "grupp"],
    ["validFrom", "fran"],
    ["validTo", "till"],
    ["note", "anteckning"],
  ],
};

/**
 * The lokal timplan's (lib/timplan-csv.ts COLUMNS, copied: that module is a page's static import and this one is not to
 * be pulled into it; web/lib/column-fields.test.ts runs its mapper over these to keep the two equal).
 */
const TIMPLAN_ROWS: readonly Row[] = [["subject", "amne", true], ["gradeLevel", "arskurs", true], ["minutesPerWeek", "minuter_per_vecka", true], ["note", "notering"]];
const TIMPLAN_ALIASES: Record<string, readonly string[]> = {
  subject: ["amne", "subject", "amneskod"],
  gradeLevel: ["arskurs", "ak", "grade", "gradelevel"],
  minutesPerWeek: ["minuterpervecka", "minpervecka", "minuter", "minutesperweek"],
  note: ["notering", "anteckning", "note", "kommentar"],
};

/**
 * The flat timetable's fields (src/schedule-exchange/lesson-table.ts COLUMNS, copied for the ones a foreign table can fill:
 * not Rastra's own ids, nor the derived length, period and locked). Each: id, Swedish header, English header, other
 * spellings, and whether the reader needs it. web/lib/column-fields.test.ts holds them to the gateway's fixture.
 */
const LESSON_ROWS: readonly (readonly [id: string, sv: string, en: string, aliases: readonly string[], required?: true, requiredUnless?: CombinedField])[] = [
  ["group", "Klass/grupp", "Class/group", [], true],
  ["extraGroups", "Ytterligare klasser", "Additional classes", []],
  ["subject", "Ämne", "Subject", [], true],
  ["subjectCode", "Ämneskod", "Subject code", []],
  ["teacher", "Lärare", "Teacher", ["Lärare signatur", "Signatur", "Teacher signature"]],
  ["teacherName", "Lärarnamn", "Teacher name", []],
  ["teacherEmail", "Lärare e-post", "Teacher e-mail", []],
  ["coTeacher", "Medlärare", "Co-teacher", ["Medlärare signatur"]],
  ["coTeacherName", "Medlärarnamn", "Co-teacher name", []],
  ["coTeacherEmail", "Medlärare e-post", "Co-teacher e-mail", []],
  ["room", "Sal", "Room", []],
  ["day", "Dag", "Day", [], true],
  ["start", "Start", "Start", [], true, "timeRange"],
  ["end", "Slut", "End", [], true, "timeRange"],
  ["weeks", "Veckomönster", "Week pattern", ["Vecka", "Veckor"]],
  ["from", "Från", "From", []],
  ["to", "Till", "To", []],
  ["block", "Block", "Block", []],
];

function csvFields(kind: CsvKind): FieldSpec[] {
  const aliases = CSV_ALIASES[kind] as Record<string, readonly string[]>;
  const fields = CSV_ROWS[kind].map(
    ([id, header, required]): FieldSpec => ({ id, header, aliases: aliases[id] ?? [], required: required === true }),
  );
  if (kind !== "requirements") return fields;
  // Ahead of the mapper (lib/csv.ts reads them in part 3): a teacher by signature instead of by e-mail. The gateway takes them already.
  return [
    ...fields,
    { id: "teacherSignature", header: "larare_signatur", aliases: ["lararesignatur", "lararsignatur", "teachersignature"], required: false, pendingInMapper: true },
    { id: "coTeacherSignature", header: "medlarare_signatur", aliases: ["medlararesignatur", "medlarsignatur", "coteachersignature"], required: false, pendingInMapper: true },
  ];
}

function lessonFields(): FieldSpec[] {
  const plain = LESSON_ROWS.map(
    ([id, sv, en, aliases, required, requiredUnless]): FieldSpec => ({
      id,
      header: sv,
      aliases: [sv, en, ...aliases].map(normalizeHeader),
      required: required === true,
      ...(requiredUnless ? { requiredUnless } : {}),
    }),
  );
  return [
    ...plain,
    // One cell, "08:10-09:00": the start and the end the reader wants in two. No spelling places it by itself: the user chooses it.
    { id: "timeRange", header: "", aliases: [], required: false, combined: "timeRange" },
    // One cell, "ABC, DEF": the lead teacher and the co-teacher in two. Chosen by the user, like the time range.
    { id: "teacherList", header: "", aliases: [], required: false, combined: "teacherList" },
  ];
}

export const FIELDS: Readonly<Record<TemplateKind, readonly FieldSpec[]>> = {
  ...(Object.fromEntries(CSV_KINDS.map((kind) => [kind, csvFields(kind)])) as Record<CsvKind, FieldSpec[]>),
  timplan: TIMPLAN_ROWS.map(([id, header, required]): FieldSpec => ({ id, header, aliases: TIMPLAN_ALIASES[id]!, required: required === true })),
  scheduleLessons: lessonFields(),
};

/** What a combined field writes, in the order of the reader's columns: the ids of the plain fields whose headers it fills. */
export const COMBINED_OUTPUT: Readonly<Record<CombinedField, readonly [first: string, second: string]>> = {
  timeRange: ["start", "end"],
  teacherList: ["teacher", "coTeacher"],
};

/** Pairs of fields that read the same cells, so that a template places at most one of each pair (the gateway's IMPORT_TEMPLATE_CONFLICTS). */
export const FIELD_CONFLICTS: Readonly<Partial<Record<TemplateKind, readonly (readonly [string, string])[]>>> = {
  scheduleLessons: [
    ["timeRange", "start"],
    ["timeRange", "end"],
    ["teacherList", "teacher"],
    ["teacherList", "coTeacher"],
  ],
};

/** The field of a kind by id, or undefined. */
export function fieldOf(kind: TemplateKind, id: string): FieldSpec | undefined {
  return FIELDS[kind].find((field) => field.id === id);
}
