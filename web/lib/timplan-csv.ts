/**
 * The lokal timplan as a file: one row per (ämne, årskurs) cell.
 *
 * A module of its own rather than a ninth kind in lib/csv.ts, because the
 * kinds there are keyed by Record<ImportKind, …> tables that lib/queries.ts
 * repeats (endpoint, year, batch size, update flag) — and lib/queries.ts is in
 * every route. This file is imported by /admin/timplan and the import dialog
 * it opens, and by nothing else. The parser, the BOM/semicolon/CRLF
 * serialiser and the formula guard are lib/csv.ts's own, so a timplan file
 * reads and writes exactly like every other file the product hands out.
 *
 * The columns are the gateway's ImportTimplanRowDto:
 *
 *   amne               subject CODE or NAME, resolved on the server like every
 *                      other kind (an unknown or ambiguous one is a row error
 *                      in the report, not here — the browser does not hold the
 *                      authority on which names are taken)
 *   arskurs            F (förskoleklass) or 0..10
 *   minuter_per_vecka  0..1200, any integer — a target, not a lesson, so not
 *                      on the five-minute grid
 *   notering           optional; a file WITHOUT the column leaves every stored
 *                      note as it is, a file with it and an empty cell clears
 *                      that cell's note (the requirements import's rule)
 *
 * A file of more than 400 rows is refused here, before upload: 400 is both the
 * endpoint's cap and the plan's (PUT /entries), so such a file cannot be one
 * plan and splitting it into batches would only write half of it.
 */

import { normalizeHeader, serializeCsv, type ParsedCsv, type RowError } from "@/lib/csv";
import type { TimplanImportRow } from "@/lib/timplan-queries";

export const TIMPLAN_CSV_TEMPLATE = {
  // Not timplan.csv: that was the requirements file's name for years (it is
  // timplansposter.csv since the page took that label), and a school has old
  // copies on disk. The mapper would refuse one for want of an årskurs
  // column, but a name of its own avoids the mix-up before it starts.
  filename: "lokal_timplan.csv",
  headers: ["amne", "arskurs", "minuter_per_vecka", "notering"],
  // Matematik 236 + 236 + 235 is lågstadiets 420 h at 35.6 weeks, half an
  // hour short — the case the grid exists to show; F shows how förskoleklass
  // is written; the third row is skolans val placed in a mapped subject.
  exampleRows: [
    ["MA", "F", "120", ""],
    ["MA", "1", "236", ""],
    ["MA", "2", "236", ""],
    ["MA", "3", "235", ""],
    ["Programmering", "8", "40", "Skolans val"],
  ],
};

export const TIMPLAN_MAX_ROWS = 400;

/** The import's field names, as ImportTimplanDto's `columns` takes them. */
export type TimplanFileColumn = "subject" | "gradeLevel" | "minutesPerWeek" | "note";

const COLUMNS: Record<TimplanFileColumn, string[]> = {
  subject: ["amne", "subject", "amneskod"],
  gradeLevel: ["arskurs", "ak", "grade", "gradelevel"],
  minutesPerWeek: ["minuterpervecka", "minpervecka", "minuter", "minutesperweek"],
  note: ["notering", "anteckning", "note", "kommentar"],
};

const REQUIRED: TimplanFileColumn[] = ["subject", "gradeLevel", "minutesPerWeek"];

/** As the template's header spells each column, for a message naming it. */
const LABEL: Record<TimplanFileColumn, string> = {
  subject: "amne",
  gradeLevel: "arskurs",
  minutesPerWeek: "minuter_per_vecka",
  note: "notering",
};

/** "F" or "f" → 0, "0".."10" → the number, anything else → null. */
export function parseTimplanGrade(cell: string): number | null {
  const text = cell.trim();
  if (/^f$/i.test(text)) return 0;
  if (!/^\d{1,2}$/.test(text)) return null;
  const grade = Number(text);
  return grade <= 10 ? grade : null;
}

/** The file's spelling of an årskurs: F for förskoleklass. */
export function formatTimplanGrade(grade: number): string {
  return grade === 0 ? "F" : String(grade);
}

export function mapTimplanRows(parsed: ParsedCsv): {
  rows: TimplanImportRow[];
  errors: RowError[];
  columns: TimplanFileColumn[];
} {
  const normalized = parsed.headers.map(normalizeHeader);
  const columnOf = new Map<TimplanFileColumn, number>();
  for (const [field, aliases] of Object.entries(COLUMNS) as [TimplanFileColumn, string[]][]) {
    const index = normalized.findIndex((header) => aliases.includes(header));
    if (index !== -1) columnOf.set(field, index);
  }

  const missing = REQUIRED.filter((field) => !columnOf.has(field));
  if (missing.length > 0) {
    return {
      rows: [],
      errors: [
        {
          row: 0,
          message: `Kolumner saknas: ${missing
            .map((field) => LABEL[field])
            .join(", ")}. Ladda ner mallen och utgå från den.`,
        },
      ],
      columns: [],
    };
  }
  if (parsed.rows.length > TIMPLAN_MAX_ROWS) {
    return {
      rows: [],
      errors: [
        {
          row: 0,
          message: `Filen har ${parsed.rows.length} rader. En timplan rymmer högst ${TIMPLAN_MAX_ROWS} — en rad per ämne och årskurs.`,
        },
      ],
      columns: [],
    };
  }

  const columns = (Object.keys(COLUMNS) as TimplanFileColumn[]).filter((field) =>
    columnOf.has(field),
  );
  const rows: TimplanImportRow[] = [];
  const errors: RowError[] = [];

  parsed.rows.forEach((raw, index) => {
    const rowNumber = index + 1;
    const cell = (field: TimplanFileColumn): string => {
      const column = columnOf.get(field);
      return column === undefined ? "" : raw[column].trim();
    };
    // One error per row, like every mapper in lib/csv.ts.
    const fail = (message: string) => {
      errors.push({ row: rowNumber, message });
    };

    const subject = cell("subject");
    if (subject === "") return fail(`Rad ${rowNumber}: amne saknas.`);

    const rawGrade = cell("gradeLevel");
    const gradeLevel = parseTimplanGrade(rawGrade);
    if (gradeLevel === null) {
      return fail(`Rad ${rowNumber}: arskurs "${rawGrade}" är inte F eller ett heltal 0–10.`);
    }

    const rawMinutes = cell("minutesPerWeek");
    const minutesPerWeek = Number(rawMinutes);
    if (
      rawMinutes === "" ||
      !Number.isInteger(minutesPerWeek) ||
      minutesPerWeek < 0 ||
      minutesPerWeek > 1200
    ) {
      return fail(
        `Rad ${rowNumber}: minuter_per_vecka "${rawMinutes}" är inte ett heltal mellan 0 och 1200.`,
      );
    }

    const row: TimplanImportRow = { subject, gradeLevel, minutesPerWeek };
    if (columnOf.has("note")) {
      const note = cell("note");
      if (note.length > 500) {
        return fail(`Rad ${rowNumber}: notering är längre än 500 tecken.`);
      }
      row.note = note;
    }
    rows.push(row);
  });

  return { rows, errors, columns };
}

/**
 * The plan as the file its import reads: one row per stored cell, subjects in
 * the order the grid shows them, then by årskurs. The subject is written as
 * its CODE where it has one — the name is the school's to change, and a file
 * kept on disk should still import after a rename — and by name otherwise.
 */
export function timplanToCsv(
  entries: { subjectId: string; gradeLevel: number; minutesPerWeek: number; note: string | null }[],
  subjects: { id: string; name: string; code: string | null }[],
): string {
  const order = new Map(subjects.map((subject, index) => [subject.id, index]));
  const byId = new Map(subjects.map((subject) => [subject.id, subject]));
  const rows = entries
    .filter((entry) => byId.has(entry.subjectId))
    .sort(
      (a, b) =>
        order.get(a.subjectId)! - order.get(b.subjectId)! || a.gradeLevel - b.gradeLevel,
    )
    .map((entry) => {
      const subject = byId.get(entry.subjectId)!;
      return [
        subject.code?.trim() ? subject.code : subject.name,
        formatTimplanGrade(entry.gradeLevel),
        String(entry.minutesPerWeek),
        entry.note ?? "",
      ];
    });
  return serializeCsv(TIMPLAN_CSV_TEMPLATE.headers, rows);
}

export function timplanTemplateCsv(): string {
  return serializeCsv(TIMPLAN_CSV_TEMPLATE.headers, TIMPLAN_CSV_TEMPLATE.exampleRows);
}
