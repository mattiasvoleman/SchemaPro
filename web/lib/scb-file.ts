/**
 * SCB:s Pedagogisk personal, as GET /api/v1/staffing/scb-file answers it.
 *
 * The gateway builds the file (src/staffing/scb/scb-pedpers.ts): the .txt SCB
 * takes in `text`, the same rows in `rows` for a CSV, and what the school
 * still has to fill in. The browser only saves what it is handed — the .txt
 * as it came (UTF-8, no byte order mark, as the gateway wrote it), the CSV
 * with SCB's variable names as its header row through serializeCsv, which is
 * what Swedish Excel opens — and lists `missing` and `notices` beside the
 * button. Nothing here computes a figure.
 *
 * Each download is one read of every teacher's post and name, in the
 * läslogg; the CSV is written from the answer already held, so it is no
 * second read.
 *
 * Imports nothing: the report tab names its types and path statically, and
 * the CSV half (lib/scb-csv.ts, which brings lib/csv-export) is imported on
 * the click.
 */

/** What a row still lacks beyond PersonNr, which every row lacks. */
export const SCB_MISSING_FIELDS = [
  "ANSTFORM",
  "OMFATTNING",
  "VERKSAMHETSTYP",
  "SKOLENHETSKOD",
  "AMNEN",
  "FORSTELARARE_ANDEL",
] as const;
export type ScbMissingField = (typeof SCB_MISSING_FIELDS)[number];

export type ScbNoticeCode =
  | "NOT_HT2026"
  | "NO_POST"
  | "INACTIVE"
  | "NO_TEACHING"
  | "LEAVE"
  | "SHORT_LEAVE"
  | "LONG_ABSENCE"
  | "POST_CHANGES"
  | "REDUCTION"
  | "ADMIN"
  | "LEFT_OUT"
  | "NO_SPAN"
  | "GRADE_OUT_OF_SCOPE"
  | "FORM_WITHOUT_CODE"
  | "GRADE_WITHOUT_TIMPLAN"
  | "NO_SCHOOL_UNIT"
  | "UNIT_WITHOUT_CODE"
  | "GRADE_WITHOUT_UNIT";

export interface ScbNotice {
  code: ScbNoticeCode;
  params: Record<string, string | number>;
}

export interface ScbMissing {
  /** The row's line in the .txt, from 1. */
  line: number;
  name: string;
  unit: string;
  /** "" for a row SchemaPro could not code. */
  verksamhetstyp: string;
  fields: ScbMissingField[];
}

export interface ScbFile {
  filename: string;
  /** SCB's mätdatum, 15 oktober of the läsår's autumn. */
  matdatum: string;
  specVersionDate: string;
  columns: string[];
  rows: string[][];
  text: string;
  missing: ScbMissing[];
  notices: ScbNotice[];
}

export function scbFilePath(academicYearId: string): string {
  return `/api/v1/staffing/scb-file?academicYearId=${encodeURIComponent(academicYearId)}`;
}

/** Hands the browser the .txt exactly as the gateway wrote it. */
export function downloadScbText(file: Pick<ScbFile, "filename" | "text">): void {
  const blob = new Blob([file.text], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = file.filename;
  anchor.click();
  URL.revokeObjectURL(url);
}
