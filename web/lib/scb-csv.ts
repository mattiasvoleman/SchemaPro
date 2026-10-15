/**
 * SCB:s Pedagogisk personal as a CSV for Excel: the gateway's rows under
 * SCB's variable names, through serializeCsv (BOM, `;`, CRLF, formulas
 * neutralised), for reviewing the rows or pasting them into SCB's Excelmall.
 * Imported on the click, like the rest of the report tab's exports.
 */

import { downloadCsv, serializeCsv } from "@/lib/csv-export";
import type { ScbFile } from "@/lib/scb-file";

export function scbCsv(file: Pick<ScbFile, "columns" | "rows">): string {
  return serializeCsv(file.columns, file.rows);
}

export function downloadScbCsv(file: Pick<ScbFile, "filename" | "columns" | "rows">): void {
  downloadCsv(file.filename.replace(/\.txt$/, "") + ".csv", scbCsv(file));
}
