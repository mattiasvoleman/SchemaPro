/**
 * CSV parsing and template generation for the import flows.
 *
 * Swedish reality dictates the details: Excel with a Swedish locale writes
 * SEMICOLON-separated "CSV" (comma is the decimal separator), needs a UTF-8
 * BOM to read å/ä/ö back correctly, and ends lines with CRLF. Templates are
 * therefore `;`-separated with a BOM, and the parser auto-detects `;` vs `,`
 * instead of trusting the file extension.
 */

import { parseDecimal } from "@/lib/staffing-forms";
import type {
  LessonRecurrence,
  TeacherContractKind,
  TeacherDutyKind,
  TeacherQualificationKind,
} from "@/lib/types";

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
    ],
    // The examples exist to show the columns nobody guesses right. Row two is
    // 120 minutes on ODD weeks with a second teacher — the slöjd/hemkunskap
    // shape, where a group reads a long pass every other week; row three is a
    // subject read for one term only, which is what the date pair is for; row
    // four is the idrott the minute pair exists for, ten minutes of ombyte
    // before and twenty of dusch after, which are minutes OUTSIDE the 60 the
    // same row teaches in. A template of identical "alla veckor, hela läsåret,
    // noll minuter" rows would teach an administrator that the last five
    // columns are decoration.
    exampleRows: [
      ["7A", "MA", "3", "60", "0", "0", "karin.ek@example.com", "", "alla", "", ""],
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
      ],
      ["7A", "SV", "2", "45", "0", "0", "", "", "alla", "2026-01-12", "2026-03-27"],
      ["7A", "IDH", "2", "60", "10", "20", "karin.ek@example.com", "", "alla", "", ""],
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
  /**
   * The 1-based file row each entry of `rows` came from, aligned by index. A
   * mapper that checks a cell AFTER this pass (a yes/no column, say) needs it
   * to name the right line, and cannot recover it from `rows` once a required
   * field has dropped a line in between.
   */
  rowNumbers: number[];
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
      rowNumbers: [],
    };
  }

  const rows: Record<string, string>[] = [];
  const rowNumbers: number[] = [];
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
    if (valid) {
      rows.push(row);
      rowNumbers.push(index + 1);
    }
  });
  return { rows, errors, rowNumbers };
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
  // As the template's header spells them, so a complaint about a cell names the
  // column an administrator can actually find in the file.
  minutesBefore: "minutesBefore",
  minutesAfter: "minutesAfter",
  teacherEmail: "larare",
  coTeacherEmail: "medlarare",
  recurrence: "veckor",
  startDate: "fran",
  endDate: "till",
  nationalCode: "nationell_kod",
  countsTowardTimplan: "undervisningstid",
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

/**
 * One row of larare.csv after mapping — ImportTeacherRowDto's shape.
 *
 * The post fields are PRESENT ONLY WHEN THE CELL HAS SOMETHING IN IT. A file
 * without the four columns, or a row leaving them blank, produces the same
 * three-field row it always did, and the gateway then treats the person as a
 * person and nothing more. Sending `employmentPercent: null` instead would
 * state "no post" about every teacher in a plain staff list — which the
 * gateway reads as a post being stated, and refuses when the other three
 * columns say nothing either.
 */
export type TeacherRow = {
  firstName: string;
  lastName: string;
  email: string;
  employmentPercent?: number;
  reductionPercent?: number;
  contractKind?: TeacherContractKind;
  signature?: string;
};

const TEACHER_POST_COLUMNS = {
  employmentPercent: [
    "tjanstprocent",
    "tjanst",
    "tjanstgoringsgrad",
    "tjanstgoringsgradprocent",
    "employmentpercent",
  ],
  reductionPercent: ["nedsattningprocent", "nedsattning", "reductionpercent"],
  contractKind: ["avtal", "avtalsform", "contractkind", "tjanstetyp"],
  signature: ["signatur", "signature", "sign", "lararsignatur"],
} satisfies Record<string, string[]>;

/** "ferie", "semester", the enum names, and the two Swedish compounds. */
const CONTRACT_BY_WORD: Record<string, TeacherContractKind> = {
  ferie: "FERIE",
  ferietjanst: "FERIE",
  semester: "SEMESTER",
  semestertjanst: "SEMESTER",
};

const CONTRACT_WORD: Record<TeacherContractKind, string> = {
  FERIE: "ferie",
  SEMESTER: "semester",
};

/**
 * Teacher rows: name and e-mail, plus the optional post.
 *
 * The bounds are UpsertTeacherEmploymentDto's — (0, 100] with three decimals,
 * nedsättning inside the post, a signature of one to eight visible characters
 * — checked here so a cell the API would refuse becomes a row-numbered
 * message instead of one 400 for the whole upload. The one rule the gateway
 * has and this mapper repeats is that the other three columns mean nothing
 * without tjanst_procent: half a post cannot be read.
 */
export function mapTeacherRows(parsed: ParsedCsv): MappedRows<TeacherRow> {
  const normalized = parsed.headers.map(normalizeHeader);
  const find = (aliases: string[]) => normalized.findIndex((header) => aliases.includes(header));
  const columns = {
    firstName: find(["fornamn", "firstname"]),
    lastName: find(["efternamn", "lastname"]),
    email: find(["epost", "email", "epostadress"]),
    employmentPercent: find(TEACHER_POST_COLUMNS.employmentPercent),
    reductionPercent: find(TEACHER_POST_COLUMNS.reductionPercent),
    contractKind: find(TEACHER_POST_COLUMNS.contractKind),
    signature: find(TEACHER_POST_COLUMNS.signature),
  };
  const missing = (["firstName", "lastName", "email"] as const).filter(
    (field) => columns[field] === -1,
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
      rowNumbers: [],
    };
  }

  const rows: TeacherRow[] = [];
  const rowNumbers: number[] = [];
  const errors: RowError[] = [];
  parsed.rows.forEach((raw, index) => {
    const rowNumber = index + 1;
    const cell = (column: number) => (column === -1 ? "" : raw[column]);
    const fail = (message: string) => {
      errors.push({ row: rowNumber, message });
    };

    const row: TeacherRow = {
      firstName: cell(columns.firstName),
      lastName: cell(columns.lastName),
      email: cell(columns.email),
    };
    for (const field of ["firstName", "lastName", "email"] as const) {
      if (row[field] === "") return fail(requiredMessage(field, rowNumber));
    }

    const rawPercent = cell(columns.employmentPercent);
    const rawReduction = cell(columns.reductionPercent);
    const rawContract = cell(columns.contractKind);
    const rawSignature = cell(columns.signature);
    const statesPost = [rawPercent, rawReduction, rawContract, rawSignature].some(
      (value) => value !== "",
    );
    if (!statesPost) {
      rows.push(row);
      rowNumbers.push(rowNumber);
      return;
    }

    if (rawPercent === "") {
      return fail(
        `Rad ${rowNumber}: nedsättning, avtal eller signatur utan tjanst_procent. Ange tjänstgöringsgraden, eller lämna alla fyra tomma.`,
      );
    }
    const percent = parseDecimal(rawPercent, 3);
    if (percent === null || percent <= 0 || percent > 100) {
      return fail(
        `Rad ${rowNumber}: tjanst_procent "${rawPercent}" är inte ett tal över 0 och högst 100 med högst tre decimaler.`,
      );
    }
    row.employmentPercent = percent;

    if (rawReduction !== "") {
      const reduction = parseDecimal(rawReduction, 3);
      if (reduction === null || reduction > 100) {
        return fail(
          `Rad ${rowNumber}: nedsattning_procent "${rawReduction}" är inte ett tal mellan 0 och 100 med högst tre decimaler.`,
        );
      }
      if (reduction > percent) {
        return fail(
          `Rad ${rowNumber}: nedsättningen (${rawReduction} %) är större än tjänsten (${rawPercent} %).`,
        );
      }
      row.reductionPercent = reduction;
    }

    if (rawContract !== "") {
      const contract = CONTRACT_BY_WORD[normalizeHeader(rawContract)];
      if (contract === undefined) {
        return fail(
          `Rad ${rowNumber}: avtal "${rawContract}" känns inte igen. Skriv "ferie" eller "semester", eller lämna cellen tom.`,
        );
      }
      row.contractKind = contract;
    }

    if (rawSignature !== "") {
      if (rawSignature.length > 8) {
        return fail(`Rad ${rowNumber}: signatur "${rawSignature}" är längre än åtta tecken.`);
      }
      row.signature = rawSignature;
    }

    rows.push(row);
    rowNumbers.push(rowNumber);
  });
  return { rows, errors, rowNumbers };
}

/**
 * One row of behorigheter.csv after mapping — ImportTeacherQualificationRowDto.
 * Minutes and dates are absent: a behörighet is a subject, a span and a kind.
 */
export type TeacherQualificationRow = {
  teacherEmail: string;
  /** Code or name, resolved server-side. */
  subject: string;
  minGrade: number;
  maxGrade: number;
  kind: TeacherQualificationKind;
};

const QUALIFICATION_COLUMNS = {
  teacherEmail: ["larareepost", "larare", "epost", "email", "epostadress", "teacheremail"],
  subject: ["amne", "amneskod", "subject", "subjectcode", "kod", "code"],
  minGrade: ["franarskurs", "fran", "lagstaarskurs", "minarskurs", "mingrade", "from"],
  maxGrade: ["tillarskurs", "till", "hogstaarskurs", "maxarskurs", "maxgrade", "to"],
  kind: ["behorighet", "slag", "kind", "typ"],
} satisfies Record<string, string[]>;

type QualificationField = keyof typeof QUALIFICATION_COLUMNS;

/**
 * The kind, read for humans like `veckor`: case, spacing and diacritics
 * dropped, so "Legitimation", "legitimerad", "behörig", "BEHORIG" and
 * "tillåten" all land. No empty-cell default — see the template.
 */
const KIND_BY_WORD: Record<string, TeacherQualificationKind> = {
  legitimation: "LEGITIMATION",
  legitimerad: "LEGITIMATION",
  behorig: "BEHORIG",
  tillaten: "TILLATEN",
};

const KIND_WORD: Record<TeacherQualificationKind, string> = {
  LEGITIMATION: "legitimation",
  BEHORIG: "behörig",
  TILLATEN: "tillåten",
};

/**
 * Behörighet rows. Bounds are the DTO's (0..12, max ≥ min); the one check
 * only the whole file can make — two rows for one teacher and subject — is
 * here for the same reason the timplan's duplicate check is: the upload is
 * cut into batches, and a pair straddling the cut would be two clean
 * requests whose later row silently overwrote the earlier.
 */
export function mapTeacherQualificationRows(parsed: ParsedCsv): MappedRows<TeacherQualificationRow> {
  const normalized = parsed.headers.map(normalizeHeader);
  const columnOf = new Map<QualificationField, number>();
  for (const [field, aliases] of Object.entries(QUALIFICATION_COLUMNS)) {
    const index = normalized.findIndex((header) => aliases.includes(header));
    if (index !== -1) columnOf.set(field as QualificationField, index);
  }
  const labels: Record<QualificationField, string> = {
    teacherEmail: "larare_epost",
    subject: "amne",
    minGrade: "fran_arskurs",
    maxGrade: "till_arskurs",
    kind: "behorighet",
  };
  const missing = (Object.keys(QUALIFICATION_COLUMNS) as QualificationField[]).filter(
    (field) => !columnOf.has(field),
  );
  if (missing.length > 0) {
    return {
      rows: [],
      errors: [
        {
          row: 0,
          message: `Kolumner saknas: ${missing.map((field) => labels[field]).join(", ")}. Ladda ner mallen och utgå från den.`,
        },
      ],
      rowNumbers: [],
    };
  }

  const rows: TeacherQualificationRow[] = [];
  const rowNumbers: number[] = [];
  const errors: RowError[] = [];
  const seenAtRow = new Map<string, number>();
  parsed.rows.forEach((raw, index) => {
    const rowNumber = index + 1;
    const cell = (field: QualificationField) => raw[columnOf.get(field)!];
    const fail = (message: string) => {
      errors.push({ row: rowNumber, message });
    };

    const teacherEmail = cell("teacherEmail");
    if (teacherEmail === "") return fail(`Rad ${rowNumber}: kolumnen "larare_epost" är tom.`);
    const subject = cell("subject");
    if (subject === "") return fail(`Rad ${rowNumber}: kolumnen "amne" är tom.`);

    const grade = (field: "minGrade" | "maxGrade"): number | null => {
      const value = cell(field);
      const parsed = Number(value);
      if (value === "" || !Number.isInteger(parsed) || parsed < 0 || parsed > 12) {
        fail(`Rad ${rowNumber}: ${labels[field]} "${value}" är inte ett heltal mellan 0 och 12.`);
        return null;
      }
      return parsed;
    };
    const minGrade = grade("minGrade");
    if (minGrade === null) return;
    const maxGrade = grade("maxGrade");
    if (maxGrade === null) return;
    if (maxGrade < minGrade) {
      return fail(
        `Rad ${rowNumber}: till_arskurs (${maxGrade}) är lägre än fran_arskurs (${minGrade}). Ett spann skrivs som 7–9, inte 9–7.`,
      );
    }

    const rawKind = cell("kind");
    const kind = KIND_BY_WORD[normalizeHeader(rawKind)];
    if (kind === undefined) {
      return fail(
        `Rad ${rowNumber}: behorighet "${rawKind}" känns inte igen. Skriv "legitimation", "behörig" eller "tillåten".`,
      );
    }

    const duplicateKey = `${teacherEmail.toLowerCase()}\u0000${subject.toLowerCase()}`;
    const firstSeenAt = seenAtRow.get(duplicateKey);
    if (firstSeenAt !== undefined) {
      return fail(
        `Rad ${rowNumber}: ${teacherEmail} och ${subject} står redan på rad ${firstSeenAt}. En behörighet per ämne — skriv spannet som ett.`,
      );
    }
    seenAtRow.set(duplicateKey, rowNumber);

    rows.push({ teacherEmail, subject, minGrade, maxGrade, kind });
    rowNumbers.push(rowNumber);
  });
  return { rows, errors, rowNumbers };
}

/**
 * One row of uppdrag.csv after mapping — ImportTeacherDutyRowDto. The four
 * optional fields are present only when the file had their column.
 */
export type TeacherDutyRow = {
  teacherEmail: string;
  kind: TeacherDutyKind;
  label: string;
  minutesPerWeek: number;
  countsAsTeaching?: boolean;
  /** Code or name, resolved server-side. */
  subject?: string | null;
  /** A group of the dialog's läsår, by name. */
  groupName?: string | null;
  note?: string | null;
};

const DUTY_COLUMNS = {
  teacherEmail: ["larareepost", "larare", "epost", "email", "teacheremail"],
  kind: ["typ", "uppdragstyp", "kind"],
  label: ["benamning", "namn", "uppdrag", "label"],
  minutesPerWeek: ["minuterpervecka", "minuter", "minutesperweek", "minutes"],
  countsAsTeaching: ["raknassomundervisning", "raknas", "countsasteaching"],
  subject: ["amne", "amneskod", "subject"],
  groupName: ["grupp", "klass", "group", "groupname"],
  note: ["anteckning", "kommentar", "note"],
} satisfies Record<string, string[]>;

type DutyField = keyof typeof DUTY_COLUMNS;
const DUTY_REQUIRED: DutyField[] = ["teacherEmail", "kind", "label", "minutesPerWeek"];
const DUTY_LABELS: Record<DutyField, string> = {
  teacherEmail: "larare_epost",
  kind: "typ",
  label: "benamning",
  minutesPerWeek: "minuter_per_vecka",
  countsAsTeaching: "raknas_som_undervisning",
  subject: "amne",
  groupName: "grupp",
  note: "anteckning",
};

/**
 * The typ, read like `behorighet`: case, spacing and diacritics dropped, so
 * "Mentorskap", "mentor", "APT/konferens" and "Ämnesansvar" all land, and so
 * does the gateway's own enum name.
 */
const DUTY_KIND_BY_WORD: Record<string, TeacherDutyKind> = {
  mentorskap: "MENTORSKAP",
  mentor: "MENTORSKAP",
  amnesansvar: "AMNESANSVAR",
  amnesansvarig: "AMNESANSVAR",
  forstelarare: "FORSTELARARE",
  rastvakt: "RASTVAKT",
  pedagogisklunch: "PEDAGOGISK_LUNCH",
  apt: "APT_KONFERENS",
  konferens: "APT_KONFERENS",
  aptkonferens: "APT_KONFERENS",
  vfu: "VFU_HANDLEDNING",
  vfuhandledning: "VFU_HANDLEDNING",
  apl: "APL",
  annat: "ANNAT",
};

/**
 * Uppdrag rows. Bounds are the DTO's (label 1..80, minutes 1..2400, note
 * ≤ 500). Two rows for one teacher, typ and benämning are refused here as the
 * behörigheter's duplicates are: the gateway identifies an uppdrag by exactly
 * those three, and a pair straddling a batch cut would be two clean requests
 * whose second silently overwrote the first.
 */
export function mapTeacherDutyRows(parsed: ParsedCsv): MappedRows<TeacherDutyRow> & {
  columns: string[];
} {
  const normalized = parsed.headers.map(normalizeHeader);
  const columnOf = new Map<DutyField, number>();
  for (const [field, aliases] of Object.entries(DUTY_COLUMNS)) {
    const index = normalized.findIndex((header) => aliases.includes(header));
    if (index !== -1) columnOf.set(field as DutyField, index);
  }
  const missing = DUTY_REQUIRED.filter((field) => !columnOf.has(field));
  if (missing.length > 0) {
    return {
      rows: [],
      errors: [
        {
          row: 0,
          message: `Kolumner saknas: ${missing.map((field) => DUTY_LABELS[field]).join(", ")}. Ladda ner mallen och utgå från den.`,
        },
      ],
      rowNumbers: [],
      columns: [],
    };
  }

  const rows: TeacherDutyRow[] = [];
  const rowNumbers: number[] = [];
  const errors: RowError[] = [];
  const seenAtRow = new Map<string, number>();
  parsed.rows.forEach((raw, index) => {
    const rowNumber = index + 1;
    const cell = (field: DutyField) => {
      const column = columnOf.get(field);
      return column === undefined ? "" : (raw[column] ?? "").trim();
    };
    const fail = (message: string) => {
      errors.push({ row: rowNumber, message });
    };

    for (const field of DUTY_REQUIRED) {
      if (cell(field) === "") return fail(`Rad ${rowNumber}: kolumnen "${DUTY_LABELS[field]}" är tom.`);
    }
    const teacherEmail = cell("teacherEmail");
    const rawKind = cell("kind");
    const kind = DUTY_KIND_BY_WORD[normalizeHeader(rawKind)];
    if (kind === undefined) {
      return fail(
        `Rad ${rowNumber}: typ "${rawKind}" känns inte igen. Skriv till exempel "mentorskap", "ämnesansvar", "förstelärare", "rastvakt", "pedagogisk lunch", "apt", "vfu", "apl" eller "annat".`,
      );
    }
    const label = cell("label");
    if ([...label].length > 80) {
      return fail(`Rad ${rowNumber}: benamning är längre än 80 tecken.`);
    }
    const rawMinutes = cell("minutesPerWeek");
    const minutesPerWeek = /^\d+$/.test(rawMinutes) ? Number(rawMinutes) : NaN;
    if (!Number.isInteger(minutesPerWeek) || minutesPerWeek < 1 || minutesPerWeek > 2400) {
      return fail(
        `Rad ${rowNumber}: minuter_per_vecka "${rawMinutes}" är inte ett heltal mellan 1 och 2400.`,
      );
    }

    const row: TeacherDutyRow = { teacherEmail, kind, label, minutesPerWeek };
    if (columnOf.has("countsAsTeaching")) {
      const counts = parseYesNoCell(cell("countsAsTeaching"));
      if (counts === undefined) {
        return fail(
          `Rad ${rowNumber}: raknas_som_undervisning "${cell("countsAsTeaching")}" är varken ja eller nej.`,
        );
      }
      // Empty is "no" here: the column's default, as the gateway reads it.
      row.countsAsTeaching = counts ?? false;
    }
    if (columnOf.has("subject")) row.subject = cell("subject") || null;
    if (columnOf.has("groupName")) row.groupName = cell("groupName") || null;
    if (columnOf.has("note")) {
      const note = cell("note");
      if ([...note].length > 500) return fail(`Rad ${rowNumber}: anteckning är längre än 500 tecken.`);
      row.note = note || null;
    }

    const duplicateKey = `${teacherEmail.toLowerCase()}\u0000${kind}\u0000${label.toLowerCase()}`;
    const firstSeenAt = seenAtRow.get(duplicateKey);
    if (firstSeenAt !== undefined) {
      return fail(
        `Rad ${rowNumber}: samma lärare, typ och benämning står redan på rad ${firstSeenAt}. Ett uppdrag skrivs en gång — ändra minuterna där.`,
      );
    }
    seenAtRow.set(duplicateKey, rowNumber);

    rows.push(row);
    rowNumbers.push(rowNumber);
  });
  return { rows, errors, rowNumbers, columns: [...columnOf.keys()] };
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
 * One row of amnen.csv after mapping — the body ImportSubjectRowDto expects.
 *
 * A type alias, not an interface: the import dialog's mapper table wants rows
 * as `Record<string, unknown>`, which an interface (no index signature) is not
 * assignable to and an object type alias is.
 */
export type SubjectRow = {
  name: string;
  code: string;
  color: string;
  /** The room type's NAME, resolved server-side. */
  roomType: string;
  /**
   * The Skolverket code exactly as written — the server trims and upper-cases
   * it, and refuses the row if it is not a known code. Null for an empty cell:
   * the subject is outside the national timplan.
   */
  nationalCode: string | null;
  /**
   * Null for an empty cell, which the server reads as its default (true). The
   * DTO types this as a boolean, so a cell that is neither ja nor nej has to be
   * refused HERE, per row — sent as text it would 400 the whole upload.
   */
  countsTowardTimplan: boolean | null;
};

const YES_CELLS = ["ja", "j", "true", "sant", "1", "x"];
const NO_CELLS = ["nej", "n", "false", "falskt", "0"];

/**
 * Reads a yes/no cell the way a Swedish spreadsheet writes one.
 *
 * Empty is null (not decided here), ja/nej and their obvious spellings are the
 * booleans, and anything else is `undefined` — a value the caller must turn
 * into a row error rather than guess at. "kanske" is not false.
 */
export function parseYesNoCell(cell: string): boolean | null | undefined {
  const value = cell.trim().toLowerCase();
  if (value === "") return null;
  if (YES_CELLS.includes(value)) return true;
  if (NO_CELLS.includes(value)) return false;
  return undefined;
}

/**
 * Subject rows. The room type is a NAME here, resolved server-side against the
 * school's own list — a CSV never carries uuids.
 *
 * Only the name is required: colour and code are cosmetic, most subjects need
 * no particular kind of room, and the two timplan columns are the defaults
 * when absent — outside the timplan, counts as teaching time — which is what
 * every subject was before the columns existed, so an old file imports as it
 * always did.
 */
export function mapSubjectRows(parsed: ParsedCsv): { rows: SubjectRow[]; errors: RowError[] } {
  const mapped = mapRows(
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
      {
        field: "nationalCode",
        aliases: [
          "nationellkod",
          "nationellamneskod",
          "nationalcode",
          "skolverketskod",
          "skolverketkod",
        ],
        required: false,
      },
      {
        field: "countsTowardTimplan",
        aliases: [
          "undervisningstid",
          "raknassomundervisningstid",
          "countstowardtimplan",
          "undervisningsamne",
        ],
        required: false,
      },
    ],
    requiredMessage,
  );

  const rows: SubjectRow[] = [];
  const errors = [...mapped.errors];
  mapped.rows.forEach((row, index) => {
    const rowNumber = mapped.rowNumbers[index]!;
    const rawFlag = row.countsTowardTimplan ?? "";
    const countsTowardTimplan = parseYesNoCell(rawFlag);
    if (countsTowardTimplan === undefined) {
      errors.push({
        row: rowNumber,
        message:
          `Rad ${rowNumber}: kolumnen "${FIELD_LABELS.countsTowardTimplan}" ska vara ` +
          `ja eller nej, inte "${rawFlag}".`,
      });
      return;
    }
    const nationalCode = (row.nationalCode ?? "").trim();
    rows.push({
      name: row.name ?? "",
      code: row.code ?? "",
      color: row.color ?? "",
      roomType: row.roomType ?? "",
      nationalCode: nationalCode === "" ? null : nationalCode,
      countsTowardTimplan,
    });
  });
  // Two sources of row errors; the reader expects them in file order.
  errors.sort((a, b) => a.row - b.row);
  return { rows, errors };
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
 * One row of timplansposter.csv after mapping — the body the API's DTO expects.
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
  /**
   * The pupils' own minutes on either side of the lesson — ombyte before
   * idrotten, dusch after it. Optional in the file, like the teachers and the
   * dates: absent means the key is left out and the requirement keeps whatever
   * it carries, an empty cell means 0.
   */
  minutesBefore?: number;
  minutesAfter?: number;
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
  // The template writes the API's field name; the Swedish spellings are here
  // because an administrator who adds the column by hand writes what the
  // timplan page calls it — "Ombyte före (minuter)" — and not a camelCase
  // identifier. "minuter" alone is taken by minutesPerLesson above, so neither
  // side may claim it.
  // A bare "fore" and "efter" are deliberately NOT accepted: they are the words
  // a school also writes over a pair of date or time columns, and a mistaken
  // match here would read a date as minutes and refuse the whole row.
  minutesBefore: ["minutesbefore", "ombytefore", "minuterfore"],
  minutesAfter: ["minutesafter", "duschefter", "ombyteefter", "minuterefter"],
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

    /*
     * The pupils' own minutes on either side, 0..60 as the requirement's own
     * CHECK constraints and DTO have them.
     *
     * OPTIONAL, and empty means 0 — unlike the two numbers above, where an
     * empty cell is a row the API would reject. Zero is the honest reading here
     * and the only one the column can have: minutesBefore is not nullable, 0 is
     * what nearly every row in a school's timplan carries, and a blank cell in a
     * column of minutes says "none" rather than "unknown". Which is also what
     * csvImport.updatesNotDeletes already promises the administrator about an
     * empty cell in a column the file has.
     */
    const pupilMinutes = (field: "minutesBefore" | "minutesAfter"): number | null => {
      const raw = cell(field);
      const minutes = raw === "" ? 0 : Number(raw);
      if (!Number.isInteger(minutes) || minutes < 0 || minutes > 60) {
        fail(
          `Rad ${rowNumber}: ${FIELD_LABELS[field]} "${raw}" är inte ett heltal mellan 0 och 60.`,
        );
        return null;
      }
      return minutes;
    };
    const minutesBefore = pupilMinutes("minutesBefore");
    if (minutesBefore === null) return;
    const minutesAfter = pupilMinutes("minutesAfter");
    if (minutesAfter === null) return;

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
    // Same distinction for the pupils' minutes, and the same reason: a school's
    // own spreadsheet predates these two columns, and uploading it to fix a
    // lesson count must not silently zero the ombyte on every idrott it touches.
    // A NEW requirement made from a file without them gets the column default,
    // which is 0 — so "absent means 0" still holds wherever there is nothing to
    // leave alone.
    if (columnOf.has("minutesBefore")) row.minutesBefore = minutesBefore;
    if (columnOf.has("minutesAfter")) row.minutesAfter = minutesAfter;
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
    minutesBefore: number;
    minutesAfter: number;
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
      // Always written, zeroes included. A blank cell would import as 0 anyway,
      // so it would be the same number said less clearly; and a file whose
      // columns are all present is the one an administrator can edit in place
      // without wondering whether an empty cell means "none" or "leave it".
      String(requirement.minutesBefore),
      String(requirement.minutesAfter),
      teacher,
      coTeacher,
      RECURRENCE_WORD[requirement.recurrence],
      requirement.startDate ?? "",
      requirement.endDate ?? "",
    ]);
  }

  return serializeCsv(CSV_TEMPLATES.requirements.headers, rows);
}
