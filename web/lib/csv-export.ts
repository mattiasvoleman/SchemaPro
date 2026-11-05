/**
 * The export half of the CSV support: templates, the serialiser and every
 * `*ToCsv` builder but the timplan's, which is lib/requirements-csv-export.ts
 * so the lesson-lengths arithmetic it needs reaches only the requirements page.
 *
 * A module of its own so that a page with an export button does not carry the
 * import side. lib/csv.ts holds the parser and the row mappers (and through
 * parseDecimal, lib/staffing-forms) — about 6,6 KB gzipped that the requirements,
 * groups, people, rooms and subjects pages only ever needed inside the lazily
 * loaded import dialog. Everything here stays synchronous, so a download still
 * runs inside the click that asked for it. lib/csv.ts re-exports all of it, so
 * the import dialog and the tests keep importing from one place.
 *
 * Swedish Excel reads a `;`-separated file with a UTF-8 BOM and CRLF line
 * endings; see lib/csv.ts for why.
 */

import type {
  LessonRecurrence,
  TeacherContractKind,
  TeacherQualificationKind,
} from "@/lib/types";

export const BOM = "﻿";

/**
 * Header matching that survives humans: case-insensitive, trimmed, and
 * diacritic-free, so "Förnamn", "FÖRNAMN" and "fornamn" all resolve alike.
 * A mis-encoded header ("FÃ¶rnamn", UTF-8 read as Latin-1) is NOT rescued —
 * the mojibake decomposes to the wrong base letter — and fails loudly with a
 * missing-column message, which is the right outcome: the file's DATA is
 * equally mangled and silently importing it would corrupt names.
 *
 * Here rather than in lib/csv.ts, beside the parser it serves, because the
 * timplan page reads the timplan file's headers with it and must not carry
 * the whole parser and every row mapper for one line of code.
 */
export function normalizeHeader(header: string): string {
  return header
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]/gi, "")
    .toLowerCase();
}


// ---------------------------------------------------------------------------
// Templates
// ---------------------------------------------------------------------------

export type ImportKind =
  | "subjects"
  | "students"
  | "teachers"
  | "classes"
  | "teachingGroups"
  | "roomTypes"
  | "requirements"
  | "teacherQualifications"
  | "teacherDuties"
  | "rooms";

interface CsvFile {
  filename: string;
  /** ASCII-safe headers — diacritics in headers are the #1 encoding casualty. */
  headers: string[];
}

/**
 * Each file's name and header, which the exports write. The example rows of
 * the downloadable templates are lib/csv.ts's CSV_EXAMPLES: only the import
 * dialog, loaded at the click, ever writes them, and here they shipped with
 * every page that has an export button.
 */
export const CSV_TEMPLATES: Record<ImportKind, CsvFile> = {
  subjects: {
    filename: "amnen.csv",
    headers: ["namn", "kod", "farg", "salstyp", "nationell_kod", "undervisningstid"],
  },
  rooms: {
    filename: "salar.csv",
    // The sal as the Salar page has it, the room type by name as amnen.csv
    // names it; the skolområde and "kräver godkännande" are set on the page.
    headers: ["namn", "kod", "salstyp", "kapacitet", "lagsta_arskurs", "hogsta_arskurs", "byggnad", "vaning"],
  },
  roomTypes: {
    filename: "salstyper.csv",
    headers: ["namn"],
  },
  classes: {
    filename: "klasser.csv",
    // The läsår's groups, not only its classes: typ, halvklass_av and
    // ersatter_amne may be left out, and a file of namn and arskurs is the
    // class list it always was.
    headers: ["namn", "arskurs", "typ", "halvklass_av", "ersatter_amne"],
  },
  teachers: {
    filename: "larare.csv",
    // The last four are the teacher's post for the ACTIVE läsår and every one
    // of them is optional: a staff list three columns wide imports exactly as
    // it did before these existed, and a file that states a tjänst writes a
    // TeacherEmployment for the active year — created, or updated when the
    // file says something else. The two percentages take a decimal comma
    // (66,667), avtal is "ferie" or "semester", and a signature is at most
    // eight characters. The second example row has no post on purpose: it
    // shows that the columns may stay empty row by row, not just be absent.
    headers: [
      "fornamn",
      "efternamn",
      "epost",
      "telefon",
      "tjanst_procent",
      "nedsattning_procent",
      "avtal",
      "signatur",
    ],
  },
  teacherQualifications: {
    filename: "behorigheter.csv",
    // One behörighet per row: the teacher by e-mail, the subject by code or
    // name, an inclusive grade span, and which of the three kinds. The kind
    // has no default anywhere — LEGITIMATION is a legal fact about a person
    // and TILLÅTEN a rektor's decision — so the column is required and the
    // template shows all three words.
    headers: ["larare_epost", "amne", "fran_arskurs", "till_arskurs", "behorighet"],
  },
  teacherDuties: {
    filename: "uppdrag.csv",
    // One uppdrag per row, for the läsår the dialog names. Typ is a word
    // ("mentorskap", "apt", "rastvakt"), benämning is what the uppdrag is
    // called and — with the teacher and the typ — how a re-upload finds it
    // again. The last six columns are optional and written only when the
    // file has them; fran and till are the uppdrag's Från and Till, empty for
    // the läsår's own bounds (a mentor change at jul is two rows). No blocked
    // time: the times are set on the uppdrag in the app, where they can be
    // seen against the teacher's week.
    headers: [
      "larare_epost",
      "typ",
      "benamning",
      "minuter_per_vecka",
      "raknas_som_undervisning",
      "amne",
      "grupp",
      "fran",
      "till",
      "anteckning",
    ],
  },
  students: {
    filename: "elever.csv",
    headers: ["fornamn", "efternamn", "epost", "telefon", "klass"],
  },
  teachingGroups: {
    filename: "undervisningsgrupper.csv",
    headers: ["grupp", "epost"],
  },
  requirements: {
    filename: "timplansposter.csv",
    // minuter_fore and minuter_efter, Swedish like every other header. They
    // were the API's field names (minutesBefore) until 2027-01, and the
    // importer still reads those (see REQUIREMENT_COLUMNS), so a file saved
    // from an older export imports as it did.
    //
    // They sit next to minuter_per_lektion, where the three numbers that
    // describe one lesson's shape stand together: the reader sees the pupils'
    // extra time beside the lesson length it lies OUTSIDE of.
    headers: [
      "grupp",
      "amne",
      "lektioner_per_vecka",
      "minuter_per_lektion",
      "minuter_fore",
      "minuter_efter",
      "larare",
      "medlarare",
      "veckor",
      "fran",
      "till",
      // Last, because nearly every school leaves them at 100 and the dialog
      // keeps them under "Avancerat" for the same reason. What each teacher is
      // CHARGED of the row in tjänstefördelningen, 0..200 — not the lesson's
      // length, which the pupils sit through in full either way.
      "larare_procent",
      "medlarare_procent",
    ],
  },
};

/**
 * Quotes a field only when it needs it, per RFC 4180.
 *
 * Export carries a school's real data, where a subject may legitimately be
 * called "Idrott; hälsa" — unquoted, that semicolon would split it into two
 * columns and the file would no longer import back.
 */
function escapeField(value: string): string {
  const guarded = neutralizeFormula(value);
  if (!/[";\r\n]/.test(guarded)) return guarded;
  return `"${guarded.replace(/"/g, '""')}"`;
}

/**
 * A leading =, +, - or @ makes a spreadsheet treat the cell as a formula.
 *
 * The data in these exports is not typed by us: a school's people and subjects
 * arrive by CSV from a municipal system, and a name of
 * `=HYPERLINK("http://…"&A1)` is stored as faithfully as `Andersson`. It does
 * nothing at all inside SchemaPro — and then an administrator opens the export
 * in Excel and it runs, with the sheet's own contents available to send.
 * Quoting does not help: Excel evaluates a quoted field too.
 *
 * An apostrophe is what a spreadsheet reads as "this cell is text"; it is not
 * displayed. Import strips it again (see `readFormulaGuard`), so a value
 * survives export → import → export unchanged.
 *
 * Numbers are left alone, so a legitimate -5 stays a number rather than
 * becoming text that no longer sums — and so does a Swedish decimal, "-12,5"
 * (staffing Fas 3's exports write hours with a decimal comma): JavaScript's
 * Number() refuses the comma, but a run of digits with one comma is never a
 * formula, and Swedish Excel reads it as the number it is. Import is
 * unaffected: readFormulaGuard only strips a leading apostrophe.
 */
function neutralizeFormula(value: string): string {
  // Apostrophes already in front count too: "'=x" looks exactly like a
  // guarded "=x", and unguarded the import would take the value's own
  // apostrophe away. Guarded, "''=x" comes back as "'=x".
  const shape = /^('*)[\s\t]*[=+\-@\t\r]/.exec(value);
  if (shape === null) return value;
  if (shape[1] === "" && value.trim() !== "" && Number.isFinite(Number(value.trim()))) return value;
  if (/^-?\d+(,\d+)?$/.test(value)) return value;
  return `'${value}`;
}

/** Semicolon + CRLF + BOM: exactly what Swedish Excel round-trips cleanly. */
export function serializeCsv(headers: string[], rows: string[][]): string {
  const lines = [headers, ...rows].map((row) => row.map(escapeField).join(";"));
  return BOM + lines.join("\r\n") + "\r\n";
}

/** Hands the browser a finished CSV file under the given name. */
export function downloadCsv(filename: string, content: string): void {
  const blob = new Blob([content], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

/**
 * The people a file may name. Not a deactivated one: the import makes every
 * person it creates active and resolves rows only to active people, so a
 * deactivated pupil's membership came back as "Ingen aktiv elev …" and a
 * deactivated teacher, read into another school, came back active.
 */
export const isActivePerson = (person: { isActive?: boolean }) => person.isActive !== false;

/** Person id → e-mail, for the active people only. */
export const activeEmails = (people: { id: string; email: string; isActive?: boolean }[]) =>
  new Map(people.filter(isActivePerson).map((person) => [person.id, person.email]));

// ---------------------------------------------------------------------------
// The words an export writes for an enum, the inverse of the importer's
// *_BY_WORD tables in lib/csv.ts
// ---------------------------------------------------------------------------

const CONTRACT_WORD: Record<TeacherContractKind, string> = {
  FERIE: "ferie",
  SEMESTER: "semester",
};

const KIND_WORD: Record<TeacherQualificationKind, string> = {
  LEGITIMATION: "legitimation",
  BEHORIG: "behörig",
  TILLATEN: "tillåten",
};

/** What export writes, and the first spelling an error message suggests. */
export const RECURRENCE_WORD: Record<LessonRecurrence, string> = {
  ALL_WEEKS: "alla",
  ODD_WEEKS: "udda",
  EVEN_WEEKS: "jamna",
};

/**
 * A school's subjects as a CSV in exactly the shape the importer accepts.
 *
 * Round-tripping is the point: export, edit in Excel, upload again. That only
 * holds if the columns match the template and the room type is written as its
 * NAME — the same thing the importer resolves — so the two are built from one
 * definition here rather than kept in step by hand.
 */
export function subjectsToCsv(
  subjects: {
    name: string;
    code: string | null;
    color: string | null;
    requiredRoomTypeId: string | null;
    nationalCode: string | null;
    countsTowardTimplan: boolean;
  }[],
  roomTypeName: (id: string | null) => string,
): string {
  return serializeCsv(
    CSV_TEMPLATES.subjects.headers,
    subjects.map((subject) => [
      subject.name,
      subject.code ?? "",
      subject.color ?? "",
      roomTypeName(subject.requiredRoomTypeId),
      subject.nationalCode ?? "",
      // Written as the words the importer reads back, never as true/false:
      // the file is for an administrator in Excel, and the import DTO's
      // boolean is the mapper's business on the way back in.
      subject.countsTowardTimplan ? "ja" : "nej",
    ]),
  );
}

// ---------------------------------------------------------------------------
// Export
//
// Every builder writes the columns of the matching template, so an exported
// file imports straight back — that round trip is what makes export useful
// (pull the list out, fix it in Excel, upload it again) and it is asserted per
// kind in lib/csv.test.ts. Ids never appear: a spreadsheet carries names.
// ---------------------------------------------------------------------------

export function roomTypesToCsv(roomTypes: { name: string }[]): string {
  return serializeCsv(
    CSV_TEMPLATES.roomTypes.headers,
    roomTypes.map((type) => [type.name]),
  );
}

/**
 * ONE läsår's groups — the caller hands in the year the import writes into —
 * with the typ that tells a teaching group from a class, the class a half
 * belongs to and the subject a group replaces, as the importer reads them.
 *
 * Not only the classes: a teaching group nobody is placed in yet is in no
 * membership row, and a timplan naming it failed on re-import. A half whose
 * class, or a group whose subject, the lists cannot name is left out rather
 * than written as something else.
 */
/**
 * The school's salar, the room type by NAME (what the importer resolves), a
 * room whose type the loaded list cannot name left out rather than written
 * as a room of no type.
 */
export function roomsToCsv(
  rooms: {
    name: string;
    code: string | null;
    capacity: number | null;
    roomTypeId: string | null;
    minGradeLevel: number | null;
    maxGradeLevel: number | null;
    building?: string | null;
    floor?: number | null;
  }[],
  roomTypes: { id: string; name: string }[],
): string {
  const typeName = new Map(roomTypes.map((type) => [type.id, type.name]));
  const text = (value: number | string | null | undefined) => (value === null || value === undefined ? "" : String(value));
  const rows: string[][] = [];
  for (const room of rooms) {
    const type = room.roomTypeId ? typeName.get(room.roomTypeId) : "";
    if (type === undefined) continue;
    rows.push([
      room.name,
      text(room.code),
      type,
      text(room.capacity),
      text(room.minGradeLevel),
      text(room.maxGradeLevel),
      text(room.building),
      text(room.floor),
    ]);
  }
  return serializeCsv(CSV_TEMPLATES.rooms.headers, rows);
}

export function classesToCsv(
  groups: {
    id: string;
    name: string;
    kind: string;
    gradeLevel: number | null;
    halfOfId?: string | null;
    replacesSubjectId?: string | null;
  }[],
  subjects: { id: string; name: string; code: string | null }[] = [],
): string {
  const rows: string[][] = [];
  for (const group of groups) {
    const half = group.halfOfId ? groups.find((other) => other.id === group.halfOfId)?.name : "";
    const replaced = subjects.find((subject) => subject.id === group.replacesSubjectId);
    const subject = group.replacesSubjectId ? replaced && (replaced.code?.trim() || replaced.name) : "";
    if (half === undefined || subject === undefined) continue;
    rows.push([
      group.name,
      group.gradeLevel === null ? "" : String(group.gradeLevel),
      group.kind === "CLASS" ? "klass" : "undervisningsgrupp",
      half,
      subject,
    ]);
  }
  return serializeCsv(CSV_TEMPLATES.classes.headers, rows);
}

/**
 * The teachers, with their post for the year the caller hands in.
 *
 * `employmentOf` is optional so a page that has not loaded the posts still
 * exports a list — with the four post columns EMPTY, which the importer reads
 * as "no post stated" and leaves alone. Never "0": a zero in tjanst_procent is
 * a row the API refuses, and a file that cannot import back is not an export.
 * The percentages are written with a decimal comma, 66,667: Swedish Excel
 * reads that as the number and saves it back so, while it may read 12.5 as
 * a date (12 May). The mapper takes both.
 */
export function teachersToCsv(
  people: {
    id?: string;
    role: string;
    firstName: string;
    lastName: string;
    email: string;
    phone?: string | null;
    isActive?: boolean;
  }[],
  employmentOf?: (userId: string) =>
    | {
        /** Null when hidden from this reader (Roller i skolan): the cell is left empty. */
        employmentPercent: number | null;
        reductionPercent: number | null;
        contractKind: TeacherContractKind;
        signature: string | null;
      }
    | undefined,
): string {
  return serializeCsv(
    CSV_TEMPLATES.teachers.headers,
    people
      .filter((person) => person.role === "TEACHER" && isActivePerson(person))
      .map((person) => {
        const found = person.id !== undefined ? employmentOf?.(person.id) : undefined;
        // A reader without HR-läs gets the post with its percentages hidden
        // and its avtal and signatur shown; written so, the row said "avtal
        // without tjanst_procent", which the import refuses. Such a post is
        // written as no post at all, which the import leaves alone.
        const post = found && found.employmentPercent !== null ? found : undefined;
        return [
          person.firstName,
          person.lastName,
          person.email,
          person.phone ?? "",
          post ? decimalComma(post.employmentPercent!) : "",
          post && (post.reductionPercent ?? 0) > 0 ? decimalComma(post.reductionPercent!) : "",
          post ? CONTRACT_WORD[post.contractKind] : "",
          post?.signature ?? "",
        ];
      }),
  );
}

const decimalComma = (value: number) => String(value).replace(".", ",");

/**
 * Behörigheter as the file the importer reads: e-mail, subject code, span,
 * kind as a word. A row whose teacher or subject the loaded lists cannot
 * name is left out rather than written blank, for the reason requirementsToCsv
 * gives: a blank is a row the importer rejects on the way back in.
 */
export function teacherQualificationsToCsv(
  qualifications: {
    userId: string;
    subjectId: string;
    minGradeLevel: number;
    maxGradeLevel: number;
    kind: TeacherQualificationKind;
  }[],
  people: { id: string; email: string; isActive?: boolean }[],
  subjects: { id: string; name: string; code: string | null }[],
): string {
  const email = activeEmails(people);
  const subjectLabel = new Map(
    subjects.map((subject) => [subject.id, subject.code?.trim() || subject.name]),
  );
  const rows: string[][] = [];
  for (const row of qualifications) {
    const address = email.get(row.userId);
    const subject = subjectLabel.get(row.subjectId);
    if (!address || !subject) continue;
    rows.push([
      address,
      subject,
      String(row.minGradeLevel),
      String(row.maxGradeLevel),
      KIND_WORD[row.kind],
    ]);
  }
  return serializeCsv(CSV_TEMPLATES.teacherQualifications.headers, rows);
}

export function studentsToCsv(
  people: {
    role: string;
    firstName: string;
    lastName: string;
    email: string;
    phone?: string | null;
    studentGroupId: string | null;
    isActive?: boolean;
  }[],
  className: (groupId: string | null) => string,
): string {
  return serializeCsv(
    CSV_TEMPLATES.students.headers,
    people
      .filter((person) => person.role === "STUDENT" && isActivePerson(person))
      .map((person) => [
        person.firstName,
        person.lastName,
        person.email,
        person.phone ?? "",
        className(person.studentGroupId),
      ]),
  );
}

/**
 * One row per membership — the same shape the import reads.
 *
 * A membership whose group or student is not in the loaded lists is skipped
 * rather than written with a blank column: a row with an empty group name is
 * one the importer would reject on re-upload, which would make the export a
 * file that cannot round-trip.
 */
export function membershipsToCsv(
  groups: { id: string; name: string }[],
  people: { id: string; email: string; isActive?: boolean }[],
  memberships: { studentGroupId: string; studentId: string }[],
): string {
  const groupName = new Map(groups.map((group) => [group.id, group.name]));
  const email = activeEmails(people);

  const rows: string[][] = [];
  for (const row of memberships) {
    const name = groupName.get(row.studentGroupId);
    const address = email.get(row.studentId);
    if (name && address) rows.push([name, address]);
  }

  return serializeCsv(CSV_TEMPLATES.teachingGroups.headers, rows);
}
