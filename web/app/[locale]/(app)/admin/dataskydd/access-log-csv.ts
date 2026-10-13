import type { AccessLogEntry } from "./use-access-log";

/** One row of the export per entry, in the table's order, as the reader wrote it. */
export interface AccessLogCsvLabels {
  headers: string[];
  when: (entry: AccessLogEntry) => string;
  reader: (entry: AccessLogEntry) => string;
  role: (entry: AccessLogEntry) => string;
  kind: (entry: AccessLogEntry) => string;
  channel: (entry: AccessLogEntry) => string;
}

export function accessLogRows(entries: AccessLogEntry[], labels: AccessLogCsvLabels): string[][] {
  return entries.map((entry) => [
    labels.when(entry),
    labels.reader(entry),
    labels.role(entry),
    labels.kind(entry),
    labels.channel(entry),
    String(entry.others),
  ]);
}

/**
 * Builds and downloads the export. lib/csv-export.ts (its quoting and its
 * guard against a name that a spreadsheet would run as a formula) is
 * imported when the button is pressed, so the page does not carry the
 * import templates for an export it may never make.
 */
export async function downloadAccessLog(filename: string, entries: AccessLogEntry[], labels: AccessLogCsvLabels): Promise<void> {
  const { downloadCsv, serializeCsv } = await import("@/lib/csv-export");
  downloadCsv(filename, serializeCsv(labels.headers, accessLogRows(entries, labels)));
}
