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
  | "teacherDuties";

interface CsvTemplate {
  filename: string;
  /** ASCII-safe headers — diacritics in headers are the #1 encoding casualty. */
  headers: string[];
  exampleRows: string[][];
}

export const CSV_TEMPLATES: Record<ImportKind, CsvTemplate> = {
  subjects: {
    filename: "amnen.csv",
    headers: ["namn", "kod", "farg", "salstyp", "nationell_kod", "undervisningstid"],
    exampleRows: [
      ["Matematik", "MA", "#4f46e5", "", "MA", "ja"],
      ["Textilslöjd", "SLTX", "#db2777", "Textilslöjd", "SL", "ja"],
      // The row the flag exists for: no national code, and not teaching time.
      ["Mentorstid", "MT", "#64748b", "", "", "nej"],
    ],
  },
  roomTypes: {
    filename: "salstyper.csv",
    headers: ["namn"],
    exampleRows: [["Hemkunskapssal"], ["Trä- och metallslöjd"], ["Textilslöjd"]],
  },
  classes: {
    filename: "klasser.csv",
    headers: ["namn", "arskurs"],
    exampleRows: [
      ["7A", "7"],
      ["7B", "7"],
    ],
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
      "tjanst_procent",
      "nedsattning_procent",
      "avtal",
      "signatur",
    ],
    exampleRows: [
      ["Karin", "Ek", "karin.ek@example.com", "100", "", "ferie", "KEK"],
      ["Bo", "Alm", "bo.alm@example.com", "", "", "", ""],
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
    exampleRows: [
      ["karin.ek@example.com", "MA", "7", "9", "legitimation"],
      ["karin.ek@example.com", "NO", "7", "9", "behörig"],
      ["bo.alm@example.com", "SLTX", "1", "9", "tillåten"],
    ],
  },
  teacherDuties: {
    filename: "uppdrag.csv",
    // One uppdrag per row, for the läsår the dialog names. Typ is a word
    // ("mentorskap", "apt", "rastvakt"), benämning is what the uppdrag is
    // called and — with the teacher and the typ — how a re-upload finds it
    // again. The last four columns are optional and written only when the
    // file has them. No blocked time: a slot is set on the uppdrag in the app,
    // where it can be seen against the teacher's week.
    headers: [
      "larare_epost",
      "typ",
      "benamning",
      "minuter_per_vecka",
      "raknas_som_undervisning",
      "amne",
      "grupp",
      "anteckning",
    ],
    exampleRows: [
      ["karin.ek@example.com", "mentorskap", "Mentor 7B", "90", "nej", "", "7B", ""],
      ["karin.ek@example.com", "apt", "APT", "120", "nej", "", "", ""],
      ["bo.alm@example.com", "ämnesansvar", "Ämnesansvar slöjd", "60", "ja", "SLTX", "", ""],
    ],
  },
  students: {
    filename: "elever.csv",
    headers: ["fornamn", "efternamn", "epost", "klass"],
    exampleRows: [["Alma", "Berg", "alma.berg@example.com", "7A"]],
  },
  teachingGroups: {
    filename: "undervisningsgrupper.csv",
    headers: ["grupp", "epost"],
    exampleRows: [
      ["Ma71", "alma.berg@example.com"],
      ["Sv73", "alma.berg@example.com"],
    ],
  },
  requirements: {
    filename: "timplansposter.csv",
    // minutesBefore and minutesAfter are the API's own field names rather than
    // Swedish like their neighbours, because the two are read back by name in
    // the payload the dialog posts and one spelling of a rule is enough. The
    // importer takes Swedish spellings too (see REQUIREMENT_COLUMNS) — a hand
    // that adds the column to its own file writes ombyte, not minutesBefore.
    //
    // They sit next to minuter_per_lektion, where the three numbers that
    // describe one lesson's shape stand together: the reader sees the pupils'
    // extra time beside the lesson length it lies OUTSIDE of.
    headers: [
      "grupp",
      "amne",
      "lektioner_per_vecka",
      "minuter_per_lektion",
      "minutesBefore",
      "minutesAfter",
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
    // The examples exist to show the columns nobody guesses right. Row two is
    // 120 minutes on ODD weeks with a second teacher — the slöjd/hemkunskap
    // shape, where a group reads a long pass every other week; row three is a
    // subject read for one term only, which is what the date pair is for; row
    // four is the idrott the minute pair exists for, ten minutes of ombyte
    // before and twenty of dusch after, which are minutes OUTSIDE the 60 the
    // same row teaches in. A template of identical "alla veckor, hela läsåret,
    // noll minuter" rows would teach an administrator that the last five
    // columns are decoration. Row two is also the one row whose medlärare is
    // charged half: two teachers in one slöjdsal, counted as one and a half.
    exampleRows: [
      ["7A", "MA", "3", "60", "0", "0", "karin.ek@example.com", "", "alla", "", "", "100", "100"],
      [
        "Sl71",
        "SLTX",
        "1",
        "120",
        "0",
        "0",
        "karin.ek@example.com",
        "bo.alm@example.com",
        "udda",
        "",
        "",
        "100",
        "50",
      ],
      ["7A", "SV", "2", "45", "0", "0", "", "", "alla", "2026-01-12", "2026-03-27", "100", "100"],
      ["7A", "IDH", "2", "60", "10", "20", "karin.ek@example.com", "", "alla", "", "", "100", "100"],
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
 * becoming text that no longer sums.
 */
function neutralizeFormula(value: string): string {
  if (!/^[\s\t]*[=+\-@\t\r]/.test(value)) return value;
  if (value.trim() !== "" && Number.isFinite(Number(value.trim()))) return value;
  return `'${value}`;
}

/** Semicolon + CRLF + BOM: exactly what Swedish Excel round-trips cleanly. */
export function serializeCsv(headers: string[], rows: string[][]): string {
  const lines = [headers, ...rows].map((row) => row.map(escapeField).join(";"));
  return BOM + lines.join("\r\n") + "\r\n";
}

export function templateCsvContent(kind: ImportKind): string {
  const template = CSV_TEMPLATES[kind];
  return serializeCsv(template.headers, template.exampleRows);
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

export function downloadTemplate(kind: ImportKind): void {
  const template = CSV_TEMPLATES[kind];
  const blob = new Blob([templateCsvContent(kind)], {
    type: "text/csv;charset=utf-8",
  });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = template.filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

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

export function classesToCsv(
  groups: { name: string; kind: string; gradeLevel: number | null }[],
): string {
  return serializeCsv(
    CSV_TEMPLATES.classes.headers,
    groups
      // Teaching groups have their own file, and a class list containing them
      // would re-import them as classes.
      .filter((group) => group.kind === "CLASS")
      .map((group) => [group.name, group.gradeLevel === null ? "" : String(group.gradeLevel)]),
  );
}

/**
 * The teachers, with their post for the year the caller hands in.
 *
 * `employmentOf` is optional so a page that has not loaded the posts still
 * exports a list — with the four post columns EMPTY, which the importer reads
 * as "no post stated" and leaves alone. Never "0": a zero in tjanst_procent is
 * a row the API refuses, and a file that cannot import back is not an export.
 * The percentages are written with a point; the mapper takes both.
 */
export function teachersToCsv(
  people: { id?: string; role: string; firstName: string; lastName: string; email: string }[],
  employmentOf?: (userId: string) =>
    | {
        employmentPercent: number;
        reductionPercent: number;
        contractKind: TeacherContractKind;
        signature: string | null;
      }
    | undefined,
): string {
  return serializeCsv(
    CSV_TEMPLATES.teachers.headers,
    people
      .filter((person) => person.role === "TEACHER")
      .map((person) => {
        const post = person.id !== undefined ? employmentOf?.(person.id) : undefined;
        return [
          person.firstName,
          person.lastName,
          person.email,
          post ? String(post.employmentPercent) : "",
          post && post.reductionPercent > 0 ? String(post.reductionPercent) : "",
          post ? CONTRACT_WORD[post.contractKind] : "",
          post?.signature ?? "",
        ];
      }),
  );
}

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
  people: { id: string; email: string }[],
  subjects: { id: string; name: string; code: string | null }[],
): string {
  const email = new Map(people.map((person) => [person.id, person.email]));
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
    studentGroupId: string | null;
  }[],
  className: (groupId: string | null) => string,
): string {
  return serializeCsv(
    CSV_TEMPLATES.students.headers,
    people
      .filter((person) => person.role === "STUDENT")
      .map((person) => [
        person.firstName,
        person.lastName,
        person.email,
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
  people: { id: string; email: string }[],
  memberships: { studentGroupId: string; studentId: string }[],
): string {
  const groupName = new Map(groups.map((group) => [group.id, group.name]));
  const email = new Map(people.map((person) => [person.id, person.email]));

  const rows: string[][] = [];
  for (const row of memberships) {
    const name = groupName.get(row.studentGroupId);
    const address = email.get(row.studentId);
    if (name && address) rows.push([name, address]);
  }

  return serializeCsv(CSV_TEMPLATES.teachingGroups.headers, rows);
}
