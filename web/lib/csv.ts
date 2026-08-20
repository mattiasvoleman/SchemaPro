/**
 * CSV parsing and template generation for the import flows.
 *
 * Swedish reality dictates the details: Excel with a Swedish locale writes
 * SEMICOLON-separated "CSV" (comma is the decimal separator), needs a UTF-8
 * BOM to read å/ä/ö back correctly, and ends lines with CRLF. Templates are
 * therefore `;`-separated with a BOM, and the parser auto-detects `;` vs `,`
 * instead of trusting the file extension.
 */

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
    record.push(field);
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
  | "roomTypes";

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
};

/**
 * Quotes a field only when it needs it, per RFC 4180.
 *
 * Export carries a school's real data, where a subject may legitimately be
 * called "Idrott; hälsa" — unquoted, that semicolon would split it into two
 * columns and the file would no longer import back.
 */
function escapeField(value: string): string {
  if (!/[";\r\n]/.test(value)) return value;
  return `"${value.replace(/"/g, '""')}"`;
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
