/**
 * CSV parsing and template generation for the import flows.
 *
 * Swedish reality dictates the details: Excel with a Swedish locale writes
 * SEMICOLON-separated "CSV" (comma is the decimal separator), needs a UTF-8
 * BOM to read å/ä/ö back correctly, and ends lines with CRLF. Templates are
 * therefore `;`-separated with a BOM, and the parser auto-detects `;` vs `,`
 * instead of trusting the file extension.
 */

import type { LessonRecurrence } from "@/lib/types";

const BOM = "﻿";

export interface ParsedCsv {
  headers: string[];
  /** Data rows (header excluded), each padded/truncated to headers.length. */
  rows: string[][];
  delimiter: ";" | ",";
}

/**
 * Header matching that survives humans: case-insensitive, trimmed, and
 * diacritic-free, so "Förnamn", "FÖRNAMN" and "fornamn" all resolve alike.
 * A mis-encoded header ("FÃ¶rnamn", UTF-8 read as Latin-1) is NOT rescued —
 * the mojibake decomposes to the wrong base letter — and fails loudly with a
 * missing-column message, which is the right outcome: the file's DATA is
 * equally mangled and silently importing it would corrupt names.
 */
export function normalizeHeader(header: string): string {
  return header
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]/gi, "")
    .toLowerCase();
}

/** Pick the delimiter that splits the header row into the most fields. */
function detectDelimiter(headerLine: string): ";" | "," {
  let semicolons = 0;
  let commas = 0;
  let inQuotes = false;
  for (const char of headerLine) {
    if (char === '"') inQuotes = !inQuotes;
    else if (!inQuotes && char === ";") semicolons += 1;
    else if (!inQuotes && char === ",") commas += 1;
  }
  return semicolons >= commas ? ";" : ",";
}

/**
 * RFC 4180-style parse: quoted fields may contain the delimiter, newlines and
 * doubled quotes (""). Blank lines are dropped; short rows are padded so
 * column lookups never go out of bounds.
 */
export function parseCsv(text: string): ParsedCsv {
  const input = text.startsWith(BOM) ? text.slice(BOM.length) : text;
  // The header "line" ends at the first UNQUOTED line break — a quoted header
  // cell may legally contain newlines, and slicing inside it would hide every
  // delimiter from detection.
  let headerEnd = input.length;
  let scanQuotes = false;
  for (let i = 0; i < input.length; i++) {
    const char = input[i];
    if (char === '"') scanQuotes = !scanQuotes;
    else if (!scanQuotes && (char === "\n" || char === "\r")) {
      headerEnd = i;
      break;
    }
  }
  const delimiter = detectDelimiter(input.slice(0, headerEnd));

  const records: string[][] = [];
  let field = "";
  let record: string[] = [];
  let inQuotes = false;

  const pushField = () => {
    record.push(readFormulaGuard(field));
    field = "";
  };
  const pushRecord = () => {
    pushField();
    // A record of nothing but empty fields is a blank line, not data.
    if (record.some((value) => value.trim() !== "")) records.push(record);
    record = [];
  };

  for (let i = 0; i < input.length; i++) {
    const char = input[i];
    if (inQuotes) {
      if (char === '"') {
        if (input[i + 1] === '"') {
          field += '"';
          i += 1; // escaped quote
        } else {
          inQuotes = false;
        }
      } else {
        field += char;
      }
    } else if (char === '"' && field === "") {
      inQuotes = true;
    } else if (char === delimiter) {
      pushField();
    } else if (char === "\n") {
      pushRecord();
    } else if (char === "\r") {
      if (input[i + 1] === "\n") i += 1;
      pushRecord();
    } else {
      field += char;
    }
  }
  if (field !== "" || record.length > 0) pushRecord();

  if (records.length === 0) return { headers: [], rows: [], delimiter };

  const headers = records[0].map((header) => header.trim());
  const rows = records.slice(1).map((row) => {
    const padded = [...row.map((value) => value.trim())];
    while (padded.length < headers.length) padded.push("");
    return padded.slice(0, headers.length);
  });
  return { headers, rows, delimiter };
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
  | "requirements";

interface CsvTemplate {
  filename: string;
  /** ASCII-safe headers — diacritics in headers are the #1 encoding casualty. */
  headers: string[];
  exampleRows: string[][];
}

export const CSV_TEMPLATES: Record<ImportKind, CsvTemplate> = {
  subjects: {
    filename: "amnen.csv",
    headers: ["namn", "kod", "farg", "salstyp"],
    exampleRows: [
      ["Matematik", "MA", "#4f46e5", ""],
      ["Textilslöjd", "SLTX", "#db2777", "Textilslöjd"],
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
    headers: ["fornamn", "efternamn", "epost"],
    exampleRows: [["Karin", "Ek", "karin.ek@example.com"]],
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
    filename: "timplan.csv",
    headers: [
      "grupp",
      "amne",
      "lektioner_per_vecka",
      "minuter_per_lektion",
      "larare",
      "medlarare",
      "veckor",
      "fran",
      "till",
    ],
    // The examples exist to show the two columns nobody guesses right. Row two
    // is 120 minutes on ODD weeks with a second teacher — the slöjd/hemkunskap
    // shape, where a group reads a long pass every other week; row three is a
    // subject read for one term only, which is what the date pair is for. A
    // template of three identical "alla veckor, hela läsåret" rows would teach
    // an administrator that the last three columns are decoration.
    exampleRows: [
      ["7A", "MA", "3", "60", "karin.ek@example.com", "", "alla", "", ""],
      [
        "Sl71",
        "SLTX",
        "1",
        "120",
        "karin.ek@example.com",
        "bo.alm@example.com",
        "udda",
        "",
        "",
      ],
      ["7A", "SV", "2", "45", "", "", "alla", "2026-01-12", "2026-03-27"],
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

/**
 * Undoes `neutralizeFormula` on the way back in.
 *
 * Only before a character that would have been guarded — an apostrophe is a
 * legitimate first character of a name (O'Brien is not one, but 'Anna' with
 * quotes typed by hand is), and stripping it unconditionally would quietly
 * rename people.
 */
function readFormulaGuard(value: string): string {
  return /^'[\s\t]*[=+\-@\t\r]/.test(value) ? value.slice(1) : value;
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
// Row mapping: parsed CSV -> typed API rows + row-numbered errors
// ---------------------------------------------------------------------------

export interface RowError {
  /** 1-based data-row number (header row not counted) — matches the API. */
  row: number;
  message: string;
}

interface MappedRows<T> {
  rows: T[];
  errors: RowError[];
}

/**
 * Column resolution by normalized header, with per-row required-field checks.
 * `spec` maps output fields to accepted header spellings.
 */
function mapRows<T>(
  parsed: ParsedCsv,
  spec: { field: keyof T & string; aliases: string[]; required: boolean }[],
  requiredMessage: (field: string, row: number) => string,
): MappedRows<Record<string, string>> {
  const normalized = parsed.headers.map(normalizeHeader);
  const columnOf = new Map<string, number>();
  for (const { field, aliases } of spec) {
    const index = normalized.findIndex((header) => aliases.includes(header));
    if (index !== -1) columnOf.set(field, index);
  }

  const missing = spec.filter(
    ({ field, required }) => required && !columnOf.has(field),
  );
  if (missing.length > 0) {
    return {
      rows: [],
      errors: [
        {
          row: 0,
          message: `Kolumner saknas: ${missing
            .map(({ aliases }) => aliases[0])
            .join(", ")}. Ladda ner mallen och utgå från den.`,
        },
      ],
    };
  }

  const rows: Record<string, string>[] = [];
  const errors: RowError[] = [];
  parsed.rows.forEach((raw, index) => {
    const row: Record<string, string> = {};
    let valid = true;
    for (const { field, required } of spec) {
      const column = columnOf.get(field);
      const value = column !== undefined ? raw[column] : "";
      if (required && value === "") {
        errors.push({ row: index + 1, message: requiredMessage(field, index + 1) });
        valid = false;
        break;
      }
      row[field] = value;
    }
    if (valid) rows.push(row);
  });
  return { rows, errors };
}

const FIELD_LABELS: Record<string, string> = {
  firstName: "fornamn",
  lastName: "efternamn",
  email: "epost",
  className: "klass",
  name: "namn",
  gradeLevel: "arskurs",
  groupName: "grupp",
  subject: "amne",
  lessonsPerWeek: "lektioner_per_vecka",
  minutesPerLesson: "minuter_per_lektion",
  teacherEmail: "larare",
  coTeacherEmail: "medlarare",
  recurrence: "veckor",
  startDate: "fran",
  endDate: "till",
};

const requiredMessage = (field: string, row: number) =>
  `Rad ${row}: kolumnen "${FIELD_LABELS[field] ?? field}" är tom.`;

export function mapStudentRows(parsed: ParsedCsv) {
  return mapRows(
    parsed,
    [
      { field: "firstName", aliases: ["fornamn", "firstname"], required: true },
      { field: "lastName", aliases: ["efternamn", "lastname"], required: true },
      { field: "email", aliases: ["epost", "email", "epostadress"], required: true },
      { field: "className", aliases: ["klass", "class"], required: true },
    ],
    requiredMessage,
  );
}

export function mapTeacherRows(parsed: ParsedCsv) {
  return mapRows(
    parsed,
    [
      { field: "firstName", aliases: ["fornamn", "firstname"], required: true },
      { field: "lastName", aliases: ["efternamn", "lastname"], required: true },
      { field: "email", aliases: ["epost", "email", "epostadress"], required: true },
    ],
    requiredMessage,
  );
}

export function mapClassRows(parsed: ParsedCsv): {
  rows: { name: string; gradeLevel?: number }[];
  errors: RowError[];
} {
  const normalized = parsed.headers.map(normalizeHeader);
  const nameColumn = normalized.findIndex((header) =>
    ["namn", "name", "klass"].includes(header),
  );
  const gradeColumn = normalized.findIndex((header) =>
    ["arskurs", "gradelevel", "ak"].includes(header),
  );
  if (nameColumn === -1) {
    return {
      rows: [],
      errors: [
        { row: 0, message: 'Kolumner saknas: namn. Ladda ner mallen och utgå från den.' },
      ],
    };
  }

  const rows: { name: string; gradeLevel?: number }[] = [];
  const errors: RowError[] = [];
  parsed.rows.forEach((raw, index) => {
    const rowNumber = index + 1;
    const name = raw[nameColumn];
    if (name === "") {
      errors.push({ row: rowNumber, message: requiredMessage("name", rowNumber) });
      return;
    }
    const rawGrade = gradeColumn === -1 ? "" : raw[gradeColumn];
    if (rawGrade === "") {
      rows.push({ name });
      return;
    }
    const grade = Number(rawGrade);
    if (!Number.isInteger(grade) || grade < 0 || grade > 12) {
      errors.push({
        row: rowNumber,
        message: `Rad ${rowNumber}: årskurs "${rawGrade}" är inte ett tal mellan 0 och 12.`,
      });
      return;
    }
    rows.push({ name, gradeLevel: grade });
  });
  return { rows, errors };
}

/**
 * Subject rows. The room type is a NAME here, resolved server-side against the
 * school's own list — a CSV never carries uuids.
 *
 * Only the name is required: colour and code are cosmetic, and most subjects
 * need no particular kind of room.
 */
export function mapSubjectRows(parsed: ParsedCsv) {
  return mapRows(
    parsed,
    [
      { field: "name", aliases: ["namn", "name", "amne"], required: true },
      { field: "code", aliases: ["kod", "code", "forkortning"], required: false },
      { field: "color", aliases: ["farg", "color"], required: false },
      {
        field: "roomType",
        aliases: ["salstyp", "kraver_salstyp", "roomtype"],
        required: false,
      },
    ],
    requiredMessage,
  );
}

export function mapRoomTypeRows(parsed: ParsedCsv) {
  return mapRows(
    parsed,
    [{ field: "name", aliases: ["namn", "name", "salstyp", "typ"], required: true }],
    requiredMessage,
  );
}

export function mapMembershipRows(parsed: ParsedCsv) {
  return mapRows(
    parsed,
    [
      { field: "groupName", aliases: ["grupp", "group", "undervisningsgrupp"], required: true },
      { field: "email", aliases: ["epost", "email", "epostadress", "elev"], required: true },
    ],
    requiredMessage,
  );
}

// ---------------------------------------------------------------------------
// Teaching requirements (timplanen)
//
// The one import whose rows carry numbers and dates rather than names only, so
// it does not go through `mapRows`: everything below can be decided without the
// database, and deciding it here turns a 400 from the API — which arrives as
// one opaque failure for the whole upload — into a row-numbered message next to
// the row that caused it. What is NOT checked here is everything that needs the
// school's own data: whether the group, the subject and the teachers exist.
// ---------------------------------------------------------------------------

/**
 * One row of timplan.csv after mapping — the body the API's DTO expects.
 *
 * A type alias and not an interface: the import dialog collects every mapper
 * into one `Record<ImportKind, (parsed) => { rows: Record<string, unknown>[] }>`
 * for its preview table, and only an alias gets TypeScript's implicit index
 * signature. An interface here fails to assign there for no reason a reader
 * would ever guess.
 */
export type RequirementRow = {
  groupName: string;
  /** The subject's CODE or NAME, exactly as written; resolved server-side. */
  subject: string;
  lessonsPerWeek: number;
  minutesPerLesson: number;
  teacherEmail?: string | null;
  coTeacherEmail?: string | null;
  recurrence: LessonRecurrence;
  /** "yyyy-mm-dd" */
  startDate?: string | null;
  endDate?: string | null;
};

const REQUIREMENT_COLUMNS = {
  groupName: ["grupp", "group", "undervisningsgrupp", "klass", "class"],
  subject: ["amne", "amneskod", "subject", "subjectcode", "kod", "code"],
  lessonsPerWeek: [
    "lektionerpervecka",
    "lektionervecka",
    "lektioner",
    "antallektioner",
    "lessonsperweek",
  ],
  minutesPerLesson: [
    "minuterperlektion",
    "minuterlektion",
    "minuter",
    "lektionslangd",
    "minutesperlesson",
  ],
  teacherEmail: [
    "larare",
    "undervisandelarare",
    "lararepost",
    "teacher",
    "teacheremail",
  ],
  coTeacherEmail: [
    "medlarare",
    "medlararepost",
    "andralarare",
    "larare2",
    "coteacher",
    "coteacheremail",
  ],
  recurrence: ["veckor", "vecka", "weeks", "recurrence"],
  // "Fr.o.m." normalizes to "from", not "fom" — the dots are stripped, not the
  // letters between them. Both spellings are listed rather than one being
  // reasoned about at a glance.
  startDate: [
    "fran",
    "franochmed",
    "from",
    "fom",
    "start",
    "startdatum",
    "startdate",
  ],
  endDate: ["till", "tillochmed", "tom", "slut", "slutdatum", "enddate"],
} satisfies Record<string, string[]>;

/**
 * A column the timplan file may carry. Exported because the API has to be told
 * which of them a file actually HAD — see `mapRequirementRows`.
 */
export type RequirementField = keyof typeof REQUIREMENT_COLUMNS;

const REQUIRED_REQUIREMENT_FIELDS: RequirementField[] = [
  "groupName",
  "subject",
  "lessonsPerWeek",
  "minutesPerLesson",
];

/**
 * The `veckor` column is written for humans, so it is read for humans: the
 * value goes through `normalizeHeader` — case, spacing and diacritics dropped —
 * because the cell is filled in by the same hand that types the headers and
 * deserves the same forgiveness. "Jämna veckor", "jamna" and the enum name all
 * land on the same key.
 */
const RECURRENCE_BY_WORD: Record<string, LessonRecurrence> = {
  // An empty cell is the overwhelmingly common case and means "every week" —
  // an administrator only fills this in for the exceptions. A missing COLUMN
  // reads the same, which is the one place this mapper cannot keep "absent"
  // and "empty" apart: recurrence is not nullable on the requirement, so there
  // is no value that means "leave it as it was".
  "": "ALL_WEEKS",
  alla: "ALL_WEEKS",
  allaveckor: "ALL_WEEKS",
  varje: "ALL_WEEKS",
  varjevecka: "ALL_WEEKS",
  allweeks: "ALL_WEEKS",
  udda: "ODD_WEEKS",
  uddaveckor: "ODD_WEEKS",
  oddweeks: "ODD_WEEKS",
  jamna: "EVEN_WEEKS",
  jamnaveckor: "EVEN_WEEKS",
  evenweeks: "EVEN_WEEKS",
};

/** What export writes, and the first spelling an error message suggests. */
const RECURRENCE_WORD: Record<LessonRecurrence, string> = {
  ALL_WEEKS: "alla",
  ODD_WEEKS: "udda",
  EVEN_WEEKS: "jamna",
};

/**
 * A date that EXISTS, not merely one shaped like a date.
 *
 * A copy of `isCalendarDate` from src/resources/dto/is-calendar-date.ts, whose
 * comment is worth reading: `new Date('2026-02-30')` does not fail, it rolls
 * over to 2026-03-02, so a shape check alone lets a typo through as a period
 * that silently starts two days into March. Copied rather than imported — the
 * web app cannot pull in a module that lives behind NestJS decorators and
 * @prisma/client — and it must stay identical, because the point is that the
 * client rejects exactly what the API would have rejected, with a row number
 * attached instead of a 400 for the whole file.
 */
function isCalendarDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime())) return false;
  return parsed.toISOString().slice(0, 10) === value;
}

/**
 * Timplan rows. Bounds are the API's own (see
 * src/resources/dto/teaching-requirement.dto.ts): 1–40 lessons a week, 15–240
 * minutes a lesson.
 *
 * The academic year is not read from the file — it comes from the dialog, the
 * same way teaching-group memberships do. A läsår column would let a file
 * import into a year the administrator is not looking at.
 */
/**
 * Rows, errors, AND which columns the file had.
 *
 * The third one is not a nicety. The import updates rather than skips, so a
 * value it writes replaces what a school already entered — and a school's own
 * spreadsheet is usually four columns wide, because the teachers and the terms
 * were set in the app, not in Excel. Uploading that file to fix one lesson
 * count must not strip the teachers off every requirement it touches.
 *
 * The row objects below already leave a key out when its column is absent, and
 * that is precisely the distinction the API cannot see: the global
 * ValidationPipe runs class-transformer, which materialises every declared
 * property, so an omitted `teacherEmail` arrives at the service as an own key
 * holding `undefined` — indistinguishable from a cell the school emptied on
 * purpose. Measured, not assumed: a row posted without the key logs
 * `own: [... "teacherEmail" ...]` inside the service.
 *
 * So the column set travels as data of its own, and the server writes only the
 * columns the file actually had.
 */
export function mapRequirementRows(parsed: ParsedCsv): {
  rows: RequirementRow[];
  errors: RowError[];
  columns: RequirementField[];
} {
  const normalized = parsed.headers.map(normalizeHeader);
  const columnOf = new Map<RequirementField, number>();
  for (const [field, aliases] of Object.entries(REQUIREMENT_COLUMNS)) {
    const index = normalized.findIndex((header) => aliases.includes(header));
    if (index !== -1) columnOf.set(field as RequirementField, index);
  }

  const missing = REQUIRED_REQUIREMENT_FIELDS.filter(
    (field) => !columnOf.has(field),
  );
  if (missing.length > 0) {
    return {
      rows: [],
      errors: [
        {
          row: 0,
          message: `Kolumner saknas: ${missing
            .map((field) => FIELD_LABELS[field])
            .join(", ")}. Ladda ner mallen och utgå från den.`,
        },
      ],
      columns: [],
    };
  }

  const rows: RequirementRow[] = [];
  const errors: RowError[] = [];
  /** Identifying pair -> the file line that claimed it first. */
  const seenAtRow = new Map<string, number>();

  parsed.rows.forEach((raw, index) => {
    const rowNumber = index + 1;
    const cell = (field: RequirementField): string => {
      const column = columnOf.get(field);
      return column === undefined ? "" : raw[column];
    };
    // One error per row, like every other mapper: an administrator fixes the
    // row, not the cell, and five complaints about the same row read as five
    // problems.
    const fail = (message: string) => {
      errors.push({ row: rowNumber, message });
    };

    const groupName = cell("groupName");
    if (groupName === "") return fail(requiredMessage("groupName", rowNumber));
    const subject = cell("subject");
    if (subject === "") return fail(requiredMessage("subject", rowNumber));

    const rawLessons = cell("lessonsPerWeek");
    const lessonsPerWeek = Number(rawLessons);
    if (!Number.isInteger(lessonsPerWeek) || lessonsPerWeek < 1 || lessonsPerWeek > 40) {
      return fail(
        `Rad ${rowNumber}: lektioner_per_vecka "${rawLessons}" är inte ett heltal mellan 1 och 40.`,
      );
    }

    const rawMinutes = cell("minutesPerLesson");
    const minutesPerLesson = Number(rawMinutes);
    if (
      !Number.isInteger(minutesPerLesson) ||
      minutesPerLesson < 15 ||
      minutesPerLesson > 240
    ) {
      return fail(
        `Rad ${rowNumber}: minuter_per_lektion "${rawMinutes}" är inte ett heltal mellan 15 och 240.`,
      );
    }

    const rawRecurrence = cell("recurrence");
    const recurrence = RECURRENCE_BY_WORD[normalizeHeader(rawRecurrence)];
    if (recurrence === undefined) {
      return fail(
        `Rad ${rowNumber}: veckor "${rawRecurrence}" känns inte igen. Skriv "alla", "udda" eller "jämna", eller lämna kolumnen tom.`,
      );
    }

    const rawStart = cell("startDate");
    if (rawStart !== "" && !isCalendarDate(rawStart)) {
      return fail(
        `Rad ${rowNumber}: fran "${rawStart}" är inte ett datum som finns. Skriv det som åååå-mm-dd.`,
      );
    }
    const rawEnd = cell("endDate");
    if (rawEnd !== "" && !isCalendarDate(rawEnd)) {
      return fail(
        `Rad ${rowNumber}: till "${rawEnd}" är inte ett datum som finns. Skriv det som åååå-mm-dd.`,
      );
    }
    // Both are yyyy-mm-dd by now, which sorts as text.
    if (rawStart !== "" && rawEnd !== "" && rawStart > rawEnd) {
      return fail(
        `Rad ${rowNumber}: fran "${rawStart}" ligger efter till "${rawEnd}".`,
      );
    }

    const row: RequirementRow = {
      groupName,
      subject,
      lessonsPerWeek,
      minutesPerLesson,
      recurrence,
    };
    // Present-but-empty and absent are different answers, and the API already
    // makes that distinction (see UpdateTeachingRequirementDto): null CLEARS a
    // teacher or a date, omitting the key leaves whatever the row carries.
    // Since this import updates, a file that never had a `larare` column must
    // not strip the teacher off every requirement it touches — only an empty
    // cell in a column the school did write is an instruction to clear.
    if (columnOf.has("teacherEmail")) row.teacherEmail = cell("teacherEmail") || null;
    if (columnOf.has("coTeacherEmail")) {
      row.coTeacherEmail = cell("coTeacherEmail") || null;
    }
    if (columnOf.has("startDate")) row.startDate = rawStart || null;
    if (columnOf.has("endDate")) row.endDate = rawEnd || null;

    /*
     * Two rows for the same class and subject, caught here because here is the
     * only place the WHOLE file exists.
     *
     * The API refuses a duplicate too, and its refusal is per request — while
     * `importCsvInBatches` cuts the file into requests of IMPORT_MAX_ROWS. A
     * pair straddling that cut lands in two different requests, each of which
     * looks clean, and the later row silently overwrites the earlier: the
     * import is an upsert, so nothing errors and nothing is skipped. The admin
     * reads "600 rows imported" and one class quietly has the wrong number of
     * lessons in a subject.
     *
     * Raising the cap moves the boundary; it does not remove it. The browser
     * holds every row at once and knows the line number in the file the admin
     * is actually editing, so the check belongs here and the server's stays as
     * the backstop for anything that did not come through this dialog.
     *
     * Case-folded on the same pair the server keys on. The comparison is
     * deliberately looser than the server's lookup, which resolves a subject by
     * code OR name: "MA" and "Matematik" are one subject there and two keys
     * here, so this catches a subset. Better a duplicate that slips through to
     * the server's own check than a false accusation about a file that is fine.
     */
    const duplicateKey = `${row.groupName.toLowerCase()}\u0000${row.subject.toLowerCase()}`;
    const firstSeenAt = seenAtRow.get(duplicateKey);
    if (firstSeenAt !== undefined) {
      fail(
        `Rad ${rowNumber}: ${row.groupName} och ${row.subject} står redan på rad ` +
          `${firstSeenAt}. Ta bort den ena raden — annars avgör ordningen i filen ` +
          `vilken som gäller.`,
      );
      return;
    }
    seenAtRow.set(duplicateKey, rowNumber);

    rows.push(row);
  });

  // The keys of `columnOf` are exactly the columns the header carried, which is
  // what the server needs and all it needs — the header is read once, and a row
  // cannot introduce a column the header did not declare.
  return { rows, errors, columns: [...columnOf.keys()] };
}

/**
 * A school's subjects as a CSV in exactly the shape the importer accepts.
 *
 * Round-tripping is the point: export, edit in Excel, upload again. That only
 * holds if the columns match the template and the room type is written as its
 * NAME — the same thing the importer resolves — so the two are built from one
 * definition here rather than kept in step by hand.
 */
export function subjectsToCsv(
  subjects: { name: string; code: string | null; color: string | null; requiredRoomTypeId: string | null }[],
  roomTypeName: (id: string | null) => string,
): string {
  return serializeCsv(
    CSV_TEMPLATES.subjects.headers,
    subjects.map((subject) => [
      subject.name,
      subject.code ?? "",
      subject.color ?? "",
      roomTypeName(subject.requiredRoomTypeId),
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

export function teachersToCsv(
  people: { role: string; firstName: string; lastName: string; email: string }[],
): string {
  return serializeCsv(
    CSV_TEMPLATES.teachers.headers,
    people
      .filter((person) => person.role === "TEACHER")
      .map((person) => [person.firstName, person.lastName, person.email]),
  );
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

/**
 * The timplan as the school's own file: names, codes and e-mail addresses,
 * never ids.
 *
 * Takes the four lists the timplan page already holds rather than looking
 * anything up itself — the page has them loaded to render the grid, and a
 * fetch in here would make an export depend on the network while the grid it
 * mirrors does not.
 *
 * The subject is written as its CODE when it has one, exactly as the grid
 * shows it (`subject.code ?? subject.name`) and exactly as a school's own
 * timplan is written; the importer accepts either. A code that is present but
 * blank falls back to the name — `??` would write an empty cell, and an empty
 * ämne is the one thing re-import rejects.
 */
export function requirementsToCsv(
  requirements: {
    studentGroupId: string;
    subjectId: string;
    teacherId: string | null;
    coTeacherId: string | null;
    lessonsPerWeek: number;
    minutesPerLesson: number;
    recurrence: LessonRecurrence;
    startDate: string | null;
    endDate: string | null;
  }[],
  groups: { id: string; name: string }[],
  subjects: { id: string; name: string; code: string | null }[],
  people: { id: string; email: string }[],
): string {
  const groupName = new Map(groups.map((group) => [group.id, group.name]));
  const subjectLabel = new Map(
    subjects.map((subject) => [subject.id, subject.code?.trim() || subject.name]),
  );
  const email = new Map(people.map((person) => [person.id, person.email]));

  const rows: string[][] = [];
  for (const requirement of requirements) {
    const group = groupName.get(requirement.studentGroupId);
    const subject = subjectLabel.get(requirement.subjectId);
    if (!group || !subject) continue;

    // A teacher the loaded roster cannot name is a reason to leave the whole
    // row out, not to write a blank cell. Blank does not mean "unknown" to the
    // importer — it means "no teacher" — and since the import UPDATES, that
    // row would come back and strip the teacher off a requirement that has
    // one. Dropping the row loses nothing instead: a row absent from the file
    // is a row the import does not touch.
    const teacher = requirement.teacherId ? email.get(requirement.teacherId) : "";
    const coTeacher = requirement.coTeacherId
      ? email.get(requirement.coTeacherId)
      : "";
    if (teacher === undefined || coTeacher === undefined) continue;

    rows.push([
      group,
      subject,
      String(requirement.lessonsPerWeek),
      String(requirement.minutesPerLesson),
      teacher,
      coTeacher,
      RECURRENCE_WORD[requirement.recurrence],
      requirement.startDate ?? "",
      requirement.endDate ?? "",
    ]);
  }

  return serializeCsv(CSV_TEMPLATES.requirements.headers, rows);
}
